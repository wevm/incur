import type { McpServer, Transport } from '@modelcontextprotocol/server'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

import type { ValidationError } from './Errors.js'
import * as Command from './internal/command.js'
import { formatCtaBlock, type FormattedCtaBlock, renderCtaText } from './internal/cta.js'
import * as Json from './internal/json.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Parser from './Parser.js'
import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve<const globals extends z.ZodObject<any> | undefined = undefined>(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options<globals> = {},
): Promise<void> {
  // Lazy: only runs when actually serving MCP, so plain command runs don't pay for the SDK import.
  const stdio = importStdioModule()
  const mcp = await import('@modelcontextprotocol/server')
  const { fromJsonSchema, McpServer } = mcp
  const StdioServerTransport = await importStdioServerTransport(mcp, stdio)

  const server = new McpServer(
    { name, ...(options.title ? { title: options.title } : undefined), version },
    {
      // Registers `tools/list` up front so a CLI without tools answers with an empty list.
      capabilities: { tools: {} },
      ...(options.instructions ? { instructions: options.instructions } : undefined),
    },
  )

  registerTools(server, commands, {
    defaults: options.defaults,
    env: options.env,
    fromJsonSchema,
    globals: options.globals,
    middlewares: options.middlewares as MiddlewareHandler[] | undefined,
    name,
    sendNotification: (notification) => server.server.notification(notification),
    tools: options.tools,
    vars: options.vars,
    version,
  })

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const transport = new StdioServerTransport(input as any, output as any)
  await server.connect(transport)
}

type StdioServerTransport = new (
  input?: Readable,
  output?: Writable,
  options?: { maxBufferSize?: number | undefined },
) => Transport

type StdioModule = {
  StdioServerTransport: StdioServerTransport
}

type StdioImportResult =
  | { module: unknown; error?: undefined }
  | { module?: undefined; error: unknown }

async function importStdioServerTransport(
  mcp: unknown,
  stdio: Promise<StdioImportResult>,
): Promise<StdioServerTransport> {
  const transport = (mcp as Partial<StdioModule>).StdioServerTransport
  if (transport) return transport

  const result = await stdio
  if (result.error) throw result.error
  return (result.module as StdioModule).StdioServerTransport
}

function importStdioModule(): Promise<StdioImportResult> {
  // Literal specifier so bundlers (`bun build --compile`, esbuild) can include the subpath.
  return import('@modelcontextprotocol/server/stdio')
    .then((module) => ({ module }))
    .catch((error: unknown) => ({ error }))
}

export declare namespace serve {
  /** Options for the MCP server. */
  type Options<globals extends z.ZodObject<any> | undefined = undefined> = {
    /** Values that apply to every tool call that does not pass its own, e.g. the server's global flags and config file. */
    defaults?: Defaults | undefined
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** CLI-level global options schema. Merged into every tool's input schema and passed to commands and middleware as `globals`. A global wins over a command option of the same name. */
    globals?: globals | undefined
    /** Override input stream. Defaults to `process.stdin`. */
    input?: Readable | undefined
    /** Middleware handlers registered on the root CLI. Their `c.globals` is typed from `globals`. */
    middlewares?: MiddlewareHandler<undefined, undefined, globals>[] | undefined
    /** Override output stream. Defaults to `process.stdout`. */
    output?: Writable | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    /** CLI version string. */
    version?: string | undefined
    /** Instructions describing how to use the server and its features. */
    instructions?: string | undefined
    /** Human-readable MCP server title. */
    title?: string | undefined
    /** Filters which command tools are exposed to MCP clients. */
    tools?: ToolFilter | undefined
  }
}

/** Values that apply to every tool call that does not pass its own. */
export type Defaults = {
  /** Global option values, already parsed with the globals schema (e.g. from the server's argv). A call's own global arguments override them. */
  globals?: Record<string, unknown> | undefined
  /** Returns the raw option defaults for a command path (e.g. `['audio', 'record']`), such as its config file section. A call's own arguments override them, and they override the schema defaults. */
  options?: ((path: string[]) => unknown) | undefined
}

/** @internal Executes a tool call and returns a CallToolResult. */
export async function callTool(
  tool: ToolEntry,
  params: Record<string, unknown>,
  options: {
    extra?: {
      mcpReq?: { _meta?: { progressToken?: string | number } }
    }
    /** The inbound HTTP request when invoked via HTTP MCP. */
    request?: Request | undefined
    sendNotification?: (n: ProgressNotification) => Promise<void>
    name?: string | undefined
    version?: string | undefined
    middlewares?: MiddlewareHandler[] | undefined
    env?: z.ZodObject<any> | undefined
    /** CLI-level global options schema. Its keys are split out of `params`, parsed with it, and passed to the command and middleware as `globals`. A global wins over a command option of the same name; a positional of the same name receives the value too. */
    globals?: z.ZodObject<any> | undefined
    /** Whether `params` were already parsed with the tool's merged input schema, as with direct discovery. Globals are then used as-is instead of being parsed again. */
    parsed?: boolean | undefined
    vars?: z.ZodObject<any> | undefined
  } = {},
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  _meta?: { cta?: FormattedCtaBlock | undefined; error?: ErrorMeta | undefined } | undefined
  isError?: boolean
}> {
  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...((tool.middlewares as MiddlewareHandler[] | undefined) ?? []),
    ...((tool.command.middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  // Globals share the tool arguments with args and options, so split them out and validate them
  // before middleware runs. As on the CLI and over HTTP, a global wins over a command option of
  // the same name. A positional of the same name keeps the value too: the CLI reads it from its
  // own token, but MCP has a single key for both.
  let globals: Record<string, unknown> = {}
  let inputOptions = params
  if (options.globals) {
    const argKeys = new Set(Object.keys(tool.command.args?.shape ?? {}))
    const globalKeys = new Set(Object.keys(options.globals.shape))
    const rawGlobals: Record<string, unknown> = {}
    inputOptions = {}
    for (const [key, value] of Object.entries(params)) {
      if (globalKeys.has(key)) rawGlobals[key] = value
      if (!globalKeys.has(key) || argKeys.has(key)) inputOptions[key] = value
    }
    try {
      globals = options.parsed ? rawGlobals : Parser.zodParse(options.globals, rawGlobals)
    } catch (error) {
      const { fieldErrors, message } = error as ValidationError
      const text = JSON.stringify({ code: 'VALIDATION_ERROR', message, fieldErrors })
      return { content: [{ type: 'text', text }], isError: true }
    }
  }

  const result = await Command.execute(tool.command, {
    agent: true,
    argv: [],
    env: options.env,
    format: 'json',
    formatExplicit: true,
    globals,
    inputOptions,
    middlewares: allMiddleware,
    name: options.name ?? tool.name,
    parseMode: 'flat',
    path: tool.name,
    request: options.request,
    vars: options.vars,
    version: options.version,
  })

  if ('stream' in result) {
    // Streaming: send progress notifications per chunk, then return buffered result
    const chunks: unknown[] = []
    const progressToken = options.extra?.mcpReq?._meta?.progressToken
    let i = 0
    let returned: unknown
    try {
      while (true) {
        const { done, value } = await result.stream.next()
        if (done) {
          returned = value
          break
        }
        if (Command.isError(value)) {
          await result.stream.return(undefined)
          return toolFailure(Command.failure(value), options.name ?? tool.name)
        }
        chunks.push(value)
        if (progressToken !== undefined && options.sendNotification)
          await options.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress: ++i, message: Json.stringify(value) },
          })
      }
    } catch (err) {
      return toolFailure(Command.fromError(err), options.name ?? tool.name)
    }
    if (Command.isError(returned))
      return toolFailure(Command.failure(returned), options.name ?? tool.name)
    const cta = Command.isOk(returned)
      ? formatCtaBlock(options.name ?? tool.name, returned.cta)
      : undefined
    const text = Json.stringify(chunks)
    return {
      content: [{ type: 'text', text: cta ? `${text}\n\n${renderCtaText(cta)}` : text }],
      ...(cta ? { _meta: { cta } } : undefined),
    }
  }

  if (!result.ok) return toolFailure(result, options.name ?? tool.name)

  const data = result.data ?? null
  const jsonData = Json.normalize(data)
  const cta = formatCtaBlock(options.name ?? tool.name, result.cta as Command.CtaBlock | undefined)
  const text = Json.stringify(jsonData)
  return {
    // Append rendered suggestions to the text so models see them (most clients drop _meta).
    content: [{ type: 'text', text: cta ? `${text}\n\n${renderCtaText(cta)}` : text }],
    ...(data !== null && tool.outputSchema
      ? { structuredContent: jsonData as Record<string, unknown> }
      : undefined),
    ...(cta ? { _meta: { cta } } : undefined),
  }
}

/** @internal Machine-readable error fields in `_meta.error` of a failed tool result. */
type ErrorMeta = {
  /** Machine-readable error code. */
  code: string
  /** Process exit code the CLI would exit with. */
  exitCode?: number | undefined
  /** Whether the operation can be retried. */
  retryable?: boolean | undefined
}

/** @internal Renders a failed command result as an MCP tool error. */
function toolFailure(failure: Command.execute.Failure, name: string) {
  const { error, exitCode } = failure
  const cta = formatCtaBlock(name, failure.cta)
  let text = error.fieldErrors ? JSON.stringify(error) : (error.message ?? 'Command failed')
  if (error.hint) text += `\nHint: ${error.hint}`
  if (cta) text += `\n\n${renderCtaText(cta)}`
  return {
    content: [{ type: 'text' as const, text }],
    _meta: {
      ...(cta ? { cta } : undefined),
      error: {
        code: error.code,
        ...(exitCode !== undefined ? { exitCode } : undefined),
        ...(error.retryable !== undefined ? { retryable: error.retryable } : undefined),
      },
    },
    isError: true,
  }
}

/** @internal A progress notification sent during streaming tool calls. */
type ProgressNotification = {
  method: 'notifications/progress'
  params: { progressToken: string | number; progress: number; message: string }
}

/** @internal A resolved tool entry from the command tree. */
export type ToolEntry = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  outputSchema?: Record<string, unknown> | undefined
  annotations?: ToolAnnotations | undefined
  instructions?: string | undefined
  command: any
  middlewares?: MiddlewareHandler[] | undefined
}

/** MCP tool annotations that describe tool behavior to clients. */
export type ToolAnnotations = {
  /** A human-readable title for the tool. */
  title?: string | undefined
  /** If true, the tool does not modify its environment. Default: false. */
  readOnlyHint?: boolean | undefined
  /** If true, the tool may perform destructive updates to its environment. Meaningful only when readOnlyHint is false. Default: true. */
  destructiveHint?: boolean | undefined
  /** If true, calling the tool repeatedly with the same arguments has no additional effect. Meaningful only when readOnlyHint is false. Default: false. */
  idempotentHint?: boolean | undefined
  /** If true, the tool may interact with an open world of external entities. Default: true. */
  openWorldHint?: boolean | undefined
}

/** MCP tool exposure options. */
export type ToolFilter = {
  /** Tool discovery strategy. Progressive discovery exposes search, inspect, and execution tools instead of every command schema. Defaults to `'progressive'`. */
  discovery?: 'direct' | 'progressive' | undefined
  /** Tool name patterns to expose. Omitted means all tools. `*` matches any characters. */
  include?: string[] | undefined
  /** Tool name patterns to hide. Excludes win over includes. `*` matches any characters. */
  exclude?: string[] | undefined
}

/** @internal Registers direct or progressively discovered MCP tools. */
export function registerTools(
  server: McpServer,
  commands: Map<string, any>,
  options: registerTools.Options,
) {
  // Server-level values become schema defaults, so they apply below a call's own arguments in
  // both discovery modes, including when the MCP SDK has already parsed the arguments.
  const globals = withDefaults(options.globals, options.defaults?.globals, 'default')
  const resolved = { ...options, globals }
  const tools = collectTools(commands, [], [], options.tools, globals, options.defaults?.options)
  if (tools.length === 0) return
  if ((options.tools?.discovery ?? 'progressive') === 'direct') {
    for (const tool of tools) registerDirectTool(server, tool, resolved)
    return
  }
  registerDiscoveryTools(server, tools, resolved)
}

export declare namespace registerTools {
  /** Options shared by stdio and HTTP MCP tool registration. */
  type Options = {
    /** Values that apply to every tool call that does not pass its own. */
    defaults?: Defaults | undefined
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Converts JSON Schema output definitions for the MCP SDK. */
    fromJsonSchema: typeof import('@modelcontextprotocol/server').fromJsonSchema
    /** CLI-level global options schema. */
    globals?: z.ZodObject<any> | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
    /** MCP server name. */
    name: string
    /** Resolves the inbound HTTP request from MCP call metadata. */
    request?: ((extra: any) => Request | undefined) | undefined
    /** Sends MCP progress notifications. */
    sendNotification?: ((notification: ProgressNotification) => Promise<void>) | undefined
    /** Tool exposure options. */
    tools?: ToolFilter | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    /** MCP server version. */
    version: string
  }
}

function registerDirectTool(
  server: Parameters<typeof registerTools>[0],
  tool: ToolEntry,
  options: registerTools.Options,
) {
  const mergedShape: Record<string, any> = {
    ...tool.command.args?.shape,
    ...tool.command.options?.shape,
    ...options.globals?.shape,
  }
  const hasInput = Object.keys(mergedShape).length > 0

  server.registerTool(
    tool.name,
    {
      ...(tool.description ? { description: tool.description } : undefined),
      ...(hasInput ? { inputSchema: z.object(mergedShape) } : undefined),
      ...(tool.outputSchema
        ? { outputSchema: options.fromJsonSchema(tool.outputSchema) }
        : undefined),
      ...(tool.annotations ? { annotations: tool.annotations } : undefined),
      ...(tool.instructions ? { _meta: { instructions: tool.instructions } } : undefined),
    },
    async (...callArgs: any[]) => {
      // registerTool passes (args, extra) when inputSchema is set, (extra) when not.
      const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
      const extra = hasInput ? callArgs[1] : callArgs[0]
      // The SDK has already parsed `params` with `mergedShape`, so globals are not parsed again.
      return callTool(tool, params, { ...callOptions(options, extra), parsed: true })
    },
  )
}

function registerDiscoveryTools(
  server: Parameters<typeof registerTools>[0],
  tools: ToolEntry[],
  options: registerTools.Options,
) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  server.registerTool(
    'search_tools',
    {
      description:
        'Search or page through available tools by capability. Returns names and descriptions without loading their schemas. Inspect a result before calling it.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(5).describe('Maximum matches.'),
        offset: z.number().int().min(0).default(0).describe('Matches to skip.'),
        query: z.string().default('').describe('Capability to find. Empty lists all tools.'),
      }),
      annotations: catalogAnnotations,
    },
    async (params: { limit: number; offset: number; query: string }) => {
      const matches = searchTools(tools, params.query)
      const page = matches.slice(params.offset, params.offset + params.limit)
      return toolResult({
        tools: page.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : undefined),
          ...(tool.annotations ? { annotations: tool.annotations } : undefined),
        })),
        ...(params.offset + page.length < matches.length
          ? { nextOffset: params.offset + page.length }
          : undefined),
      })
    },
  )

  server.registerTool(
    'get_tool_details',
    {
      description:
        'Inspect one tool returned by search_tools. Returns its complete input schema and metadata.',
      inputSchema: z.object({ name: z.string().min(1).describe('Exact tool name.') }),
      annotations: catalogAnnotations,
    },
    async (params: { name: string }) => {
      const tool = byName.get(params.name)
      if (!tool) return toolError(`Unknown tool: ${params.name}`)
      return toolResult({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : undefined),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
        ...(tool.annotations ? { annotations: tool.annotations } : undefined),
        ...(tool.instructions ? { instructions: tool.instructions } : undefined),
      })
    },
  )

  server.registerTool(
    'call_read_tool',
    {
      description:
        'Execute a tool marked read-only after inspecting its schema with get_tool_details.',
      inputSchema: callSchema,
      annotations: readAnnotations,
    },
    async (params: CallParams, extra: any) => {
      const tool = byName.get(params.name)
      if (!tool) return toolError(`Unknown tool: ${params.name}`)
      if (tool.annotations?.readOnlyHint !== true)
        return toolError(`Tool is not read-only: ${params.name}`)
      return callTool(tool, params.arguments, callOptions(options, extra))
    },
  )

  server.registerTool(
    'call_write_tool',
    {
      description:
        'Execute a writable or unclassified tool after inspecting its schema with get_tool_details.',
      inputSchema: callSchema,
      annotations: writeAnnotations,
    },
    async (params: CallParams, extra: any) => {
      const tool = byName.get(params.name)
      if (!tool) return toolError(`Unknown tool: ${params.name}`)
      if (tool.annotations?.readOnlyHint === true)
        return toolError(`Tool is read-only: ${params.name}`)
      return callTool(tool, params.arguments, callOptions(options, extra))
    },
  )
}

type CallParams = {
  name: string
  arguments: Record<string, unknown>
}

const callSchema = z.object({
  name: z.string().min(1).describe('Exact tool name.'),
  arguments: z.record(z.string(), z.unknown()).default({}).describe('Arguments from its schema.'),
})

const catalogAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
}

const readAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  readOnlyHint: true,
}

const writeAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  readOnlyHint: false,
}

function callOptions(options: registerTools.Options, extra: any) {
  return {
    env: options.env,
    extra,
    globals: options.globals,
    middlewares: options.middlewares,
    name: options.name,
    request: options.request?.(extra),
    ...(options.sendNotification ? { sendNotification: options.sendNotification } : undefined),
    vars: options.vars,
    version: options.version,
  }
}

function searchTools(tools: ToolEntry[], query: string) {
  const normalized = normalizeSearch(query)
  const terms = normalized.split(' ').filter(Boolean)
  return tools
    .map((tool) => ({ tool, score: toolScore(tool, normalized, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .map(({ tool }) => tool)
}

function toolScore(tool: ToolEntry, query: string, terms: string[]) {
  const name = normalizeSearch(tool.name)
  const description = normalizeSearch(tool.description ?? '')
  if (name === query) return 1_000
  let score = name.startsWith(query) ? 100 : name.includes(query) ? 50 : 0
  for (const term of terms) {
    if (name.split(' ').includes(term)) score += 20
    else if (name.includes(term)) score += 10
    if (description.includes(term)) score += 2
  }
  return score
}

function normalizeSearch(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function toolResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: Json.stringify(value) }] }
}

function toolError(message: string) {
  return { ...toolResult({ error: message }), isError: true }
}

/** @internal Recursively collects leaf commands as tool entries. */
export function collectTools(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[] = [],
  filter?: ToolFilter | undefined,
  globals?: z.ZodObject<any> | undefined,
  optionDefaults?: Defaults['options'],
): ToolEntry[] {
  const tools = filterTools(
    collectToolEntries(commands, prefix, parentMiddlewares, globals, optionDefaults),
    filter,
  )
  assertUniqueToolNames(tools)
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

function collectToolEntries(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[] = [],
  globals?: z.ZodObject<any> | undefined,
  optionDefaults?: Defaults['options'],
): ToolEntry[] {
  const result: ToolEntry[] = []
  for (const [name, entry] of commands) {
    if ('_alias' in entry) continue
    if (entry.mcp === false) continue
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      const groupMw = [
        ...parentMiddlewares,
        ...((entry.middlewares as MiddlewareHandler[] | undefined) ?? []),
      ]
      if (entry.root && entry.root.mcp !== false)
        result.push(toToolEntry(entry.root, path, groupMw, globals, optionDefaults))
      result.push(...collectToolEntries(entry.commands, path, groupMw, globals, optionDefaults))
    } else result.push(toToolEntry(entry, path, parentMiddlewares, globals, optionDefaults))
  }
  return result
}

function toToolEntry(
  entry: any,
  path: string[],
  middlewares: MiddlewareHandler[],
  globals: z.ZodObject<any> | undefined,
  optionDefaults: Defaults['options'],
): ToolEntry {
  const mcp = entry.mcp === false ? undefined : entry.mcp
  const outputSchema = entry.output ? mcpOutputSchema(entry.output) : undefined
  // As on the CLI, option defaults are schema input and override the schema's own defaults
  const defaults = optionDefaults
    ? Parser.normalizeDefaults(optionDefaults(path), entry.options)
    : undefined
  const options = withDefaults(entry.options, defaults, 'prefault')
  const command = options === entry.options ? entry : { ...entry, options }
  return {
    name: mcp?.name ?? path.join('_'),
    description: mcp?.description ?? entry.description,
    inputSchema: buildToolSchema(command.args, command.options, globals),
    ...(outputSchema ? { outputSchema } : undefined),
    ...(mcp?.annotations ? { annotations: mcp.annotations } : undefined),
    ...(mcp?.instructions ? { instructions: mcp.instructions } : undefined),
    command,
    ...(middlewares.length > 0 ? { middlewares } : undefined),
  }
}

/**
 * @internal Returns `schema` with `values` as the defaults of their keys. `'default'` values are
 * parsed output and are used as-is; `'prefault'` values are schema input and are parsed.
 */
function withDefaults(
  schema: z.ZodObject<any> | undefined,
  values: Record<string, unknown> | undefined,
  kind: 'default' | 'prefault',
): z.ZodObject<any> | undefined {
  if (!schema || !values) return schema
  const shape: Record<string, z.ZodType> = {}
  for (const [key, value] of Object.entries(values)) {
    const field = schema.shape[key]
    if (!field || value === undefined) continue
    shape[key] = kind === 'default' ? field.default(value) : field.prefault(value)
  }
  if (Object.keys(shape).length === 0) return schema
  // `safeExtend` keeps object-level refinements, which `extend` rejects
  return schema.safeExtend(shape)
}

/** Filters MCP tools by include and exclude patterns. */
export function filterTools(tools: ToolEntry[], filter?: ToolFilter | undefined): ToolEntry[] {
  if (!filter) return tools
  const includes = filter.include?.map(patternToRegExp)
  const excludes = filter.exclude?.map(patternToRegExp) ?? []
  return tools.filter((tool) => {
    if (excludes.some((pattern) => pattern.test(tool.name))) return false
    if (!includes || includes.length === 0) return true
    return includes.some((pattern) => pattern.test(tool.name))
  })
}

function patternToRegExp(pattern: string) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function assertUniqueToolNames(tools: ToolEntry[]) {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`)
    seen.add(tool.name)
  }
}

function mcpOutputSchema(output: any): Record<string, unknown> | undefined {
  const schema = Schema.toJsonSchema(output) as Record<string, unknown>
  if (schema.type === 'object') return schema
  return undefined
}

/** @internal Builds a merged JSON Schema from args, options, and globals Zod schemas. */
function buildToolSchema(
  args: any | undefined,
  options: any | undefined,
  globals: z.ZodObject<any> | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const schema of [args, options, globals]) {
    if (!schema) continue
    const json = Schema.toJsonSchema(schema)
    Object.assign(properties, (json.properties as Record<string, unknown>) ?? {})
    required.push(...((json.required as string[]) ?? []))
  }

  if (required.length > 0) return { type: 'object', properties, required }
  return { type: 'object', properties }
}
