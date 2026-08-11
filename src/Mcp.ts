import type { McpServer, Transport } from '@modelcontextprotocol/server'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { z } from 'zod'

import * as Elicitation from './Elicitation.js'
import * as Command from './internal/command.js'
import { formatCtaBlock, type FormattedCtaBlock, renderCtaText } from './internal/cta.js'
import * as Json from './internal/json.js'
import * as Mcp2026 from './Mcp2026.js'
import type { JsonRpcRequest } from './Mcp2026.js'
import { draftProtocolVersion } from './Mcp2026Types.js'
import type { ToolAnnotations } from './Mcp2026Types.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options = {},
): Promise<void> {
  // Lazy: only runs when actually serving MCP, so plain command runs don't pay for the SDK import.
  const stdio = importStdioModule()
  const mcp = await import('@modelcontextprotocol/server')
  const { fromJsonSchema, McpServer, UrlElicitationRequiredError } = mcp
  const StdioServerTransport = await importStdioServerTransport(mcp, stdio)

  const server = new McpServer(
    { name, ...(options.title ? { title: options.title } : undefined), version },
    options.instructions ? { instructions: options.instructions } : undefined,
  )

  registerTools(server, commands, {
    clientCapabilities: () => server.server.getClientCapabilities(),
    env: options.env,
    fromJsonSchema,
    middlewares: options.middlewares,
    name,
    sendNotification: (notification) => server.server.notification(notification),
    tools: options.tools,
    urlElicitationRequiredError: UrlElicitationRequiredError,
    vars: options.vars,
    version,
  })

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const routed = await routeStdio(input as Readable)
  if (routed.modern) {
    await serve2026Stdio(routed.input, output as Writable, name, version, commands, options)
    return
  }
  const transport = new StdioServerTransport(routed.input as any, output as any)
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
  return importModule('@modelcontextprotocol/server/stdio')
    .then((module) => ({ module }))
    .catch((error: unknown) => ({ error }))
}

const importModule = (specifier: string): Promise<unknown> => import(specifier)

export declare namespace serve {
  /** Options for the MCP server. */
  type Options = {
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Override input stream. Defaults to `process.stdin`. */
    input?: Readable | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
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

async function routeStdio(input: Readable): Promise<{ input: Readable; modern: boolean }> {
  const routed = await replayFirstLine(input)
  let message: JsonRpcRequest | undefined
  try {
    message = JSON.parse(routed.firstLine) as JsonRpcRequest
  } catch {
    return { input: routed.input, modern: false }
  }
  return { input: routed.input, modern: Mcp2026.is2026Message(message) }
}

async function replayFirstLine(input: Readable) {
  return new Promise<{ firstLine: string; input: Readable }>((resolve) => {
    const buffers: Buffer[] = []
    const replay = new PassThrough()

    function done(buffer: Buffer, newline: number) {
      input.off('data', onData)
      input.off('end', onEnd)
      const first = newline === -1 ? buffer : buffer.subarray(0, newline + 1)
      const rest = newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline + 1)
      replay.write(first)
      if (rest.length > 0) replay.write(rest)
      input.pipe(replay)
      resolve({ firstLine: first.toString('utf8').trim(), input: replay })
    }

    function onData(chunk: Buffer | string) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const buffer = Buffer.concat(buffers)
      const newline = buffer.indexOf('\n')
      if (newline !== -1) done(buffer, newline)
    }

    function onEnd() {
      const buffer = Buffer.concat(buffers)
      replay.end(buffer)
      resolve({ firstLine: buffer.toString('utf8').trim(), input: replay })
    }

    input.on('data', onData)
    input.on('end', onEnd)
  })
}

async function serve2026Stdio(
  input: Readable,
  output: Writable,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options,
) {
  let buffer = ''
  for await (const chunk of input) {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines)
      await handle2026StdioLine(line, output, name, version, commands, options)
  }
  if (buffer.trim()) await handle2026StdioLine(buffer, output, name, version, commands, options)
}

async function handle2026StdioLine(
  line: string,
  output: Writable,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options,
) {
  if (!line.trim()) return
  const message = JSON.parse(line) as JsonRpcRequest
  const protocolVersion =
    message.method === 'server/discover'
      ? draftProtocolVersion
      : String(
          Mcp2026.metaFrom(message)?.['io.modelcontextprotocol/protocolVersion'] ??
            draftProtocolVersion,
        )
  const response = await handle2026Http(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': protocolVersion,
      },
      body: JSON.stringify(message),
    }),
    name,
    version,
    commands,
    { env: options.env, middlewares: options.middlewares, vars: options.vars },
  )
  const text = await response.text()
  if (text) output.write(`${text}\n`)
}

/** @internal Executes a tool call and returns a CallToolResult. */
export async function callTool(
  tool: ToolEntry,
  params: Record<string, unknown>,
  options: {
    clientCapabilities?: ClientCapabilities | undefined
    elicitation?: Elicitation.Adapter | undefined
    extra?: Extra | undefined
    sendNotification?: ((n: ProgressNotification) => Promise<void>) | undefined
    urlElicitationRequiredError?: UrlElicitationRequiredErrorConstructor | undefined
    /** The inbound HTTP request when invoked via HTTP MCP. */
    request?: Request | undefined
    name?: string | undefined
    version?: string | undefined
    middlewares?: MiddlewareHandler[] | undefined
    env?: z.ZodObject<any> | undefined
    vars?: z.ZodObject<any> | undefined
  } = {},
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  _meta?: { cta: FormattedCtaBlock } | undefined
  isError?: boolean
}> {
  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...((tool.middlewares as MiddlewareHandler[] | undefined) ?? []),
    ...((tool.command.middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  const result = await Command.execute(tool.command, {
    agent: true,
    argv: [],
    env: options.env,
    elicitation:
      options.elicitation ??
      createElicitationAdapter(
        options.extra,
        options.clientCapabilities,
        options.urlElicitationRequiredError,
      ),
    format: 'json',
    formatExplicit: true,
    inputOptions: params,
    middlewares: allMiddleware,
    name: options.name ?? tool.name,
    parseMode: 'flat',
    path: tool.name,
    rethrowErrors: (error) =>
      isUrlElicitationRequiredError(error) || Mcp2026.isInputRequiredError(error),
    request: options.request,
    vars: options.vars,
    version: options.version,
  })

  if ('stream' in result) {
    // Streaming: send progress notifications per chunk, then return buffered result
    const chunks: unknown[] = []
    const progressToken = options.extra?.mcpReq?._meta?.progressToken
    let i = 0
    try {
      for await (const chunk of result.stream) {
        chunks.push(chunk)
        if (progressToken !== undefined && options.sendNotification)
          await options.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress: ++i, message: Json.stringify(chunk) },
          })
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: Json.stringify(chunks) }] }
  }

  if (!result.ok) {
    const cta = formatCtaBlock(options.name ?? tool.name, result.cta)
    const text = result.error.fieldErrors
      ? JSON.stringify(result.error)
      : (result.error.message ?? 'Command failed')
    return {
      content: [{ type: 'text', text: cta ? `${text}\n\n${renderCtaText(cta)}` : text }],
      ...(cta ? { _meta: { cta } } : undefined),
      isError: true,
    }
  }

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

/** Handles a stateless MCP 2026 Streamable HTTP request. */
export async function handle2026Http(
  req: Request,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: handle2026Http.Options = {},
): Promise<Response> {
  return Mcp2026.handle2026Http(req, name, version, commands, {
    ...options,
    runtime: { callTool, collectTools },
  })
}

/** Returns true when a request should use incur's stateless MCP 2026 dispatcher. */
export const is2026HttpRequest = Mcp2026.is2026HttpRequest

export declare namespace handle2026Http {
  /** Options passed to the stateless MCP 2026 handler. */
  type Options = Omit<Mcp2026.handle2026Http.Options, 'runtime'>
}

export * from './Mcp2026Types.js'

function createElicitationAdapter(
  extra: Extra | undefined,
  clientCapabilities: ClientCapabilities | undefined,
  UrlElicitationRequiredError: UrlElicitationRequiredErrorConstructor | undefined,
): Elicitation.Adapter | undefined {
  const elicitInput = extra?.mcpReq?.elicitInput
  if (!elicitInput) return undefined
  return {
    form(params) {
      return elicitInput(params) as Promise<any>
    },
    requireUrl(params) {
      if (!clientCapabilities?.elicitation?.url)
        throw new Error('Client does not support url elicitation.')
      if (!UrlElicitationRequiredError)
        throw new Error('URL elicitation requires MCP server support.')
      throw new UrlElicitationRequiredError([params])
    },
    url(params) {
      return elicitInput(params) as Promise<any>
    },
  }
}

function isUrlElicitationRequiredError(error: unknown) {
  return (error as { code?: unknown })?.code === -32042
}

/** @internal A progress notification sent during streaming tool calls. */
type ProgressNotification = {
  method: 'notifications/progress'
  params: { progressToken: string | number; progress: number; message: string }
}

/** @internal MCP SDK callback context fields used by incur. */
type Extra = {
  mcpReq?:
    | {
        _meta?: { progressToken?: string | number } | undefined
        elicitInput?: ((params: unknown) => Promise<unknown>) | undefined
      }
    | undefined
}

/** @internal Client capability subset used by elicitation. */
type ClientCapabilities = {
  elicitation?:
    | {
        form?: object | undefined
        url?: object | undefined
      }
    | undefined
}

type UrlElicitationRequiredErrorConstructor = new (
  elicitations: Elicitation.UrlRequestParams[],
) => Error

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

export declare namespace callTool {
  /** Options passed through from MCP tool callbacks. */
  type Options = {
    /** MCP client capability subset. */
    clientCapabilities?: ClientCapabilities | undefined
    /** MCP SDK callback context. */
    extra?: Extra | undefined
  }
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
  const tools = collectTools(commands, [], [], options.tools)
  if (tools.length === 0) return
  if ((options.tools?.discovery ?? 'progressive') === 'direct') {
    for (const tool of tools) registerDirectTool(server, tool, options)
    return
  }
  registerDiscoveryTools(server, tools, options)
}

export declare namespace registerTools {
  /** Options shared by stdio and HTTP MCP tool registration. */
  type Options = {
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Resolves the current MCP client capabilities. */
    clientCapabilities?: (() => ClientCapabilities | undefined) | undefined
    /** Converts JSON Schema output definitions for the MCP SDK. */
    fromJsonSchema: typeof import('@modelcontextprotocol/server').fromJsonSchema
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
    /** SDK error constructor for URL elicitation responses. */
    urlElicitationRequiredError?: UrlElicitationRequiredErrorConstructor | undefined
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
      return callTool(tool, params, callOptions(options, extra))
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
    clientCapabilities: options.clientCapabilities?.(),
    env: options.env,
    extra,
    middlewares: options.middlewares,
    name: options.name,
    request: options.request?.(extra),
    ...(options.sendNotification ? { sendNotification: options.sendNotification } : undefined),
    urlElicitationRequiredError: options.urlElicitationRequiredError,
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
): ToolEntry[] {
  const tools = filterTools(collectToolEntries(commands, prefix, parentMiddlewares), filter)
  assertUniqueToolNames(tools)
  return tools.sort((a, b) => a.name.localeCompare(b.name))
}

function collectToolEntries(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[] = [],
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
      result.push(...collectToolEntries(entry.commands, path, groupMw))
    } else {
      const mcp = entry.mcp === false ? undefined : entry.mcp
      const outputSchema = entry.output ? mcpOutputSchema(entry.output) : undefined
      result.push({
        name: mcp?.name ?? path.join('_'),
        description: mcp?.description ?? entry.description,
        inputSchema: buildToolSchema(entry.args, entry.options),
        ...(outputSchema ? { outputSchema } : undefined),
        ...(mcp?.annotations ? { annotations: mcp.annotations } : undefined),
        ...(mcp?.instructions ? { instructions: mcp.instructions } : undefined),
        command: entry,
        ...(parentMiddlewares.length > 0 ? { middlewares: parentMiddlewares } : undefined),
      })
    }
  }
  return result
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

/** @internal Builds a merged JSON Schema from args and options Zod schemas. */
function buildToolSchema(
  args: any | undefined,
  options: any | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const schema of [args, options]) {
    if (!schema) continue
    const json = Schema.toJsonSchema(schema)
    Object.assign(properties, (json.properties as Record<string, unknown>) ?? {})
    required.push(...((json.required as string[]) ?? []))
  }

  if (required.length > 0) return { type: 'object', properties, required }
  return { type: 'object', properties }
}
