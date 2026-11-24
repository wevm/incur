import type { McpServer } from '@modelcontextprotocol/server'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

import type { ValidationError } from './Errors.js'
import * as Command from './internal/command.js'
import { formatCtaBlock, type FormattedCtaBlock, renderCtaText } from './internal/cta.js'
import * as Json from './internal/json.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Parser from './Parser.js'
import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. Serves the 2026-07-28 protocol and the 2025 `initialize` handshake. */
export async function serve<const globals extends z.ZodObject<any> | undefined = undefined>(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options<globals> = {},
): Promise<void> {
  // Lazy: only runs when actually serving MCP, so plain command runs don't pay for the SDK import.
  const [mcp, { serveStdio, StdioServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
  ])
  // Instances are created on the first message, so surface tool registration errors now.
  collectTools(commands, [], [], options.tools, options.globals, options.defaults?.options)
  for (const template of options.resourceTemplates ?? []) templatePattern(template.uriTemplate)
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  serveStdio(
    () =>
      createServer(mcp, name, version, commands, {
        defaults: options.defaults,
        env: options.env,
        globals: options.globals,
        cache: options.cache,
        instructions: options.instructions,
        middlewares: options.middlewares as MiddlewareHandler[] | undefined,
        prompts: options.prompts,
        resources: options.resources,
        resourceTemplates: options.resourceTemplates,
        title: options.title,
        tools: options.tools,
        vars: options.vars,
      }),
    { transport: new StdioServerTransport(input as any, output as any) },
  )
}

/** @internal Creates an MCP server instance with every command tool registered. Stdio serves one per connection; HTTP serves one per request. */
export function createServer(
  mcp: typeof import('@modelcontextprotocol/server'),
  name: string,
  version: string,
  commands: Map<string, any>,
  options: createServer.Options = {},
): McpServer {
  const { fromJsonSchema, McpServer } = mcp
  const server = new McpServer(
    { name, ...(options.title ? { title: options.title } : undefined), version },
    {
      // Registers `tools/list` up front so a CLI without tools answers with an empty list.
      capabilities: { tools: {} },
      ...(options.instructions ? { instructions: options.instructions } : undefined),
      ...(options.cache ? { cacheHints: cacheHints(options.cache) } : undefined),
    },
  )
  registerTools(server, commands, {
    defaults: options.defaults,
    env: options.env,
    fromJsonSchema,
    globals: options.globals,
    middlewares: options.middlewares,
    name,
    request: options.request,
    sendNotification: (notification) => server.server.notification(notification),
    tools: options.tools,
    vars: options.vars,
    version,
  })
  registerFeatures(mcp, server, options)
  return server
}

function cacheHints({ ttlMs, cacheScope }: CacheHint) {
  const hint = {
    ...(ttlMs !== undefined ? { ttlMs } : undefined),
    ...(cacheScope ? { cacheScope } : undefined),
  }
  return {
    'tools/list': hint,
    'prompts/list': hint,
    'resources/list': hint,
    'resources/templates/list': hint,
    'server/discover': hint,
  }
}

/** A resource's contents, as `resources/read` returns them. `uri` defaults to the URI read, and `mimeType` to the resource's. */
export type ResourceContents =
  | {
      /** The URI of these contents. */
      uri?: string | undefined
      /** The MIME type. */
      mimeType?: string | undefined
      /** The text. */
      text: string
    }
  | {
      /** The URI of these contents. */
      uri?: string | undefined
      /** The MIME type. */
      mimeType?: string | undefined
      /** The bytes, base64-encoded. */
      blob: string
    }

/** What a resource read returns: text, one set of contents, or several. */
export type ReadResult = string | ResourceContents | ResourceContents[]

/** Suggests values for a prompt argument or URI template variable from its partial `value`. `context.arguments` holds the values already chosen. Clients receive the first 100. */
export type Completer = (
  value: string,
  context: { arguments: Record<string, string> },
) => string[] | Promise<string[]>

/** A resource at a fixed URI. */
export type Resource = {
  /** The URI clients read, matched exactly. */
  uri: string
  /** Programmatic name. */
  name: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** MIME type of the contents. */
  mimeType?: string | undefined
  /** Icons clients may show. */
  icons?: Icon[] | undefined
  /** Reads the contents. */
  read: () => ReadResult | Promise<ReadResult>
}

/** Resources whose URIs match a template such as `docs://{section}/{page}`. Templates support `{name}` expressions, which match one or more characters other than `/` and `,`. */
export type ResourceTemplate = {
  /** The URI template. */
  uriTemplate: string
  /** Programmatic name. */
  name: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** MIME type of the contents. */
  mimeType?: string | undefined
  /** Icons clients may show. */
  icons?: Icon[] | undefined
  /** Completers keyed by template variable. */
  complete?: Record<string, Completer> | undefined
  /** Reads the contents of a matching URI. */
  read: (uri: string, variables: Record<string, string>) => ReadResult | Promise<ReadResult>
}

/** A content block in a prompt message, passed to clients as is. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string | undefined }
  | { type: 'resource'; resource: ResourceContents & { uri: string } }

/** A message a prompt renders. */
export type PromptMessage = {
  /** Who speaks the message. */
  role: 'user' | 'assistant'
  /** The message content. */
  content: ContentBlock
}

/** A prompt template clients can list and render. */
export type Prompt<args extends z.ZodObject<any> | undefined = z.ZodObject<any> | undefined> = {
  /** Programmatic name. */
  name: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** Icons clients may show. */
  icons?: Icon[] | undefined
  /** Arguments schema. MCP clients send every argument as a string. */
  args?: args | undefined
  /** Completers keyed by argument name. */
  complete?:
    | (args extends z.ZodObject<any>
        ? Partial<Record<keyof z.output<args>, Completer>>
        : Record<string, Completer>)
    | undefined
  /** Renders the prompt: text becomes one user message. */
  get: (
    args: args extends z.ZodObject<any> ? z.output<args> : Record<string, string>,
  ) => string | PromptMessage[] | Promise<string | PromptMessage[]>
}

/** Resources, resource templates, and prompts served next to tools. */
export type Features = {
  /** Prompts. */
  prompts?: Prompt<any>[] | undefined
  /** Resources at fixed URIs. */
  resources?: Resource[] | undefined
  /** Resource templates. */
  resourceTemplates?: ResourceTemplate[] | undefined
}

/** Registers `resources/*`, `prompts/*`, and `completion/complete` for configured features. */
function registerFeatures(
  mcp: typeof import('@modelcontextprotocol/server'),
  server: McpServer,
  { prompts = [], resources = [], resourceTemplates = [] }: Features,
) {
  const { ProtocolError, ResourceNotFoundError } = mcp
  const invalid = (message: string, data?: unknown) =>
    new ProtocolError(-32602 as any, message, data)
  const templates = resourceTemplates.map((template) => ({
    template,
    pattern: templatePattern(template.uriTemplate),
  }))
  const low = server.server
  const icons = (value: { icons?: Icon[] | undefined }) =>
    value.icons ? { icons: value.icons } : undefined
  if (resources.length > 0 || templates.length > 0) {
    low.registerCapabilities({ resources: { listChanged: true } })
    low.setRequestHandler('resources/list', () => ({
      resources: resources.map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        ...describe(resource),
        ...(resource.mimeType ? { mimeType: resource.mimeType } : undefined),
        ...icons(resource),
      })),
    }))
    low.setRequestHandler('resources/templates/list', () => ({
      resourceTemplates: resourceTemplates.map((template) => ({
        uriTemplate: template.uriTemplate,
        name: template.name,
        ...describe(template),
        ...(template.mimeType ? { mimeType: template.mimeType } : undefined),
        ...icons(template),
      })),
    }))
    low.setRequestHandler('resources/read', async (request: any) => {
      const { uri } = request.params as { uri: string }
      const resource = resources.find((resource) => resource.uri === uri)
      if (resource) return { contents: contents(await resource.read(), uri, resource.mimeType) }
      for (const { template, pattern } of templates) {
        const variables = matchTemplate(pattern, uri)
        if (!variables) continue
        return { contents: contents(await template.read(uri, variables), uri, template.mimeType) }
      }
      throw new ResourceNotFoundError(uri)
    })
  }
  if (prompts.length > 0) {
    low.registerCapabilities({ prompts: { listChanged: true } })
    low.setRequestHandler('prompts/list', () => ({
      prompts: prompts.map((prompt) => ({
        name: prompt.name,
        ...describe(prompt),
        ...(prompt.args ? { arguments: promptArguments(prompt.args) } : undefined),
        ...icons(prompt),
      })),
    }))
    low.setRequestHandler('prompts/get', async (request: any) => {
      const { name, arguments: raw = {} } = request.params as {
        name: string
        arguments?: Record<string, string>
      }
      const prompt = prompts.find((prompt) => prompt.name === name)
      if (!prompt) throw invalid(`Prompt ${name} not found`)
      let args: any = raw
      if (prompt.args) {
        const parsed = prompt.args.safeParse(raw)
        if (!parsed.success)
          throw invalid(`Invalid arguments for prompt ${name}: ${issues(parsed.error.issues)}`)
        args = parsed.data
      }
      const rendered = await prompt.get(args)
      return {
        ...(prompt.description ? { description: prompt.description } : undefined),
        messages:
          typeof rendered === 'string'
            ? [{ role: 'user', content: { type: 'text', text: rendered } }]
            : rendered,
      }
    })
  }
  if (prompts.length > 0 || templates.length > 0) {
    low.registerCapabilities({ completions: {} })
    low.setRequestHandler('completion/complete', async (request: any) => {
      const { ref, argument, context } = request.params as {
        ref: { type: string; name?: string; uri?: string }
        argument: { name: string; value: string }
        context?: { arguments?: Record<string, string> }
      }
      const completer = (() => {
        // A prompt argument.
        if (ref.type === 'ref/prompt') {
          const prompt = prompts.find((prompt) => prompt.name === ref.name)
          if (!prompt) throw invalid(`Prompt ${ref.name} not found`)
          return own(prompt.complete, argument.name)
        }
        // A template variable; a fixed resource has nothing to complete.
        const template = resourceTemplates.find((template) => template.uriTemplate === ref.uri)
        if (template) return own(template.complete, argument.name)
        if (resources.some((resource) => resource.uri === ref.uri)) return undefined
        throw invalid(`Resource template ${ref.uri} not found`)
      })()
      const values = completer
        ? await completer(argument.value, { arguments: context?.arguments ?? {} })
        : []
      return {
        completion: {
          values: values.slice(0, 100),
          ...(completer ? { total: values.length } : undefined),
          hasMore: values.length > 100,
        },
      }
    })
  }
}

/** The title and description of a feature, when set. */
function describe(value: { title?: string | undefined; description?: string | undefined }) {
  return {
    ...(value.title ? { title: value.title } : undefined),
    ...(value.description ? { description: value.description } : undefined),
  }
}

/** Returns a completer the definition itself declares, ignoring inherited properties such as `toString`. */
function own(complete: Partial<Record<string, Completer>> | undefined, name: string) {
  return complete && Object.hasOwn(complete, name) ? complete[name] : undefined
}

/** Normalizes what a read returned into `resources/read` contents. */
function contents(result: ReadResult, uri: string, mimeType: string | undefined) {
  const list =
    typeof result === 'string' ? [{ text: result }] : Array.isArray(result) ? result : [result]
  return list.map((item) => {
    const { uri: own, mimeType: type, ...body } = item as ResourceContents
    return {
      uri: own ?? uri,
      ...((type ?? mimeType) ? { mimeType: type ?? mimeType } : undefined),
      ...body,
    }
  })
}

/** Lists a prompt's arguments as `prompts/list` shows them. */
function promptArguments(args: z.ZodObject<any>) {
  return Object.entries(args.shape as Record<string, z.ZodType>).map(([name, schema]) => ({
    name,
    ...(schema.description ? { description: schema.description } : undefined),
    required: !schema.safeParse(undefined).success,
  }))
}

/** Formats validation issues as tool input errors do. */
function issues(list: readonly { path: PropertyKey[]; message: string }[]) {
  return list
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.map(String).join('.')}: ${issue.message}`
        : issue.message,
    )
    .join(', ')
}

/** Splits a level 1 URI template such as `docs://{section}` into the literals around its variables and their names. */
function templatePattern(template: string) {
  if (!/^(?:[^{}]|\{\w+\})*$/.test(template))
    throw new Error(`Unsupported URI template: ${template}`)
  const parts = template.split(/\{(\w+)\}/)
  return {
    literals: parts.filter((_, i) => i % 2 === 0),
    names: parts.filter((_, i) => i % 2 === 1),
  }
}

/**
 * Matches a URI against a template, returning its variables. Each variable takes one or more
 * characters other than `/` and `,`: as many as still let the rest match, as a greedy regex
 * would. Failed positions are remembered, so matching stays polynomial in the URI length.
 */
function matchTemplate(
  { literals, names }: ReturnType<typeof templatePattern>,
  uri: string,
): Record<string, string> | undefined {
  const values: string[] = []
  const failed = new Set<number>()
  const from = (index: number, start: number): boolean => {
    if (index === names.length) return start === uri.length
    const key = index * (uri.length + 1) + start
    if (failed.has(key)) return false
    let end = start
    while (end < uri.length && uri[end] !== '/' && uri[end] !== ',') end++
    const literal = literals[index + 1]!
    for (let stop = end; stop > start; stop--) {
      if (!uri.startsWith(literal, stop)) continue
      values[index] = uri.slice(start, stop)
      if (from(index + 1, stop + literal.length)) return true
    }
    failed.add(key)
    return false
  }
  if (!uri.startsWith(literals[0]!) || !from(0, literals[0]!.length)) return undefined
  return Object.fromEntries(names.map((name, i) => [name, values[i]!]))
}

export declare namespace createServer {
  /** Options for an MCP server instance. */
  type Options = Features & {
    /** Values for tool calls that do not pass their own. */
    defaults?: Defaults | undefined
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** CLI-level global options schema. */
    globals?: z.ZodObject<any> | undefined
    /** Cache hints for `tools/list` and `server/discover` results under MCP 2026-07-28. */
    cache?: CacheHint | undefined
    /** Instructions describing how to use the server and its features. */
    instructions?: string | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
    /** Resolves the inbound HTTP request from MCP call metadata. */
    request?: ((extra: any) => Request | undefined) | undefined
    /** Human-readable MCP server title. */
    title?: string | undefined
    /** Filters which command tools are exposed to MCP clients. */
    tools?: ToolFilter | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
  }
}

export declare namespace serve {
  /** Options for the MCP server. */
  type Options<globals extends z.ZodObject<any> | undefined = undefined> = Features & {
    /** Values for tool calls that do not pass their own, such as the globals and config file of `my-cli --mcp`. They become the defaults of the tool input schemas. */
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
    /** Cache hints for `tools/list` and `server/discover` results under MCP 2026-07-28. */
    cache?: CacheHint | undefined
    /** Instructions describing how to use the server and its features. */
    instructions?: string | undefined
    /** Human-readable MCP server title. */
    title?: string | undefined
    /** Filters which command tools are exposed to MCP clients. */
    tools?: ToolFilter | undefined
  }
}

/** Values for tool calls that do not pass their own. A call's arguments override them, and they override the schema defaults. */
export type Defaults = {
  /** Global option values, already parsed with the globals schema. */
  globals?: Record<string, unknown> | undefined
  /** Returns the config section of a command path, such as `['project', 'list']`: raw option values keyed by option name, with kebab-case accepted. They are validated when the tools are registered. */
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
  title?: string | undefined
  icons?: Icon[] | undefined
  headers?: Record<string, string> | undefined
  command: any
  middlewares?: MiddlewareHandler[] | undefined
}

/** How long MCP 2026-07-28 clients may cache a result, and who may share it. */
export type CacheHint = {
  /** Freshness in milliseconds. Defaults to `0`. */
  ttlMs?: number | undefined
  /** Whether shared caches may store the result. Defaults to `'private'`. */
  cacheScope?: 'public' | 'private' | undefined
}

/** An icon clients may show for a tool. */
export type Icon = {
  /** The icon URL, such as an `https:` or `data:` URI. */
  src: string
  /** The icon's MIME type, such as `image/png`. */
  mimeType?: string | undefined
  /** Sizes the icon suits, such as `48x48` or `any`. */
  sizes?: string[] | undefined
  /** The theme the icon suits. */
  theme?: 'light' | 'dark' | undefined
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
  // Default values become schema defaults, so a call's own arguments still win in both discovery
  // modes, including direct discovery where the MCP SDK parses the arguments first.
  const globals = withDefaults(options.globals, options.defaults?.globals)
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
    /** Values for tool calls that do not pass their own. */
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
  // `x-mcp-header` asks 2026-07-28 HTTP clients to mirror the argument into `Mcp-Param-{name}`.
  for (const [key, header] of Object.entries(tool.headers ?? {}))
    mergedShape[key] = mergedShape[key].meta({ 'x-mcp-header': header })
  const hasInput = Object.keys(mergedShape).length > 0

  server.registerTool(
    tool.name,
    {
      ...(tool.title ? { title: tool.title } : undefined),
      ...(tool.icons ? { icons: tool.icons } : undefined),
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
        ...(tool.title ? { title: tool.title } : undefined),
        ...(tool.description ? { description: tool.description } : undefined),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
        ...(tool.annotations ? { annotations: tool.annotations } : undefined),
        ...(tool.icons ? { icons: tool.icons } : undefined),
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
  config?: Defaults['options'],
): ToolEntry[] {
  const tools = filterTools(
    collectToolEntries(commands, prefix, parentMiddlewares, globals, config),
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
  config?: Defaults['options'],
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
        result.push(toToolEntry(entry.root, path, groupMw, globals, config))
      result.push(...collectToolEntries(entry.commands, path, groupMw, globals, config))
    } else result.push(toToolEntry(entry, path, parentMiddlewares, globals, config))
  }
  return result
}

function toToolEntry(
  entry: any,
  path: string[],
  middlewares: MiddlewareHandler[],
  globals: z.ZodObject<any> | undefined,
  config: Defaults['options'],
): ToolEntry {
  const mcp = entry.mcp === false ? undefined : entry.mcp
  const outputSchema = entry.output ? mcpOutputSchema(entry.output) : undefined
  const values = config ? Parser.parseDefaults(config(path), entry.options) : undefined
  const options = withDefaults(entry.options, values)
  const command = options === entry.options ? entry : { ...entry, options }
  const name = mcp?.name ?? path.join('_')
  const inputSchema = buildToolSchema(entry.args, options, globals)
  if (mcp?.headers) assertHeaders(name, mcp.headers, inputSchema)
  return {
    name,
    description: mcp?.description ?? entry.description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : undefined),
    ...(mcp?.annotations ? { annotations: mcp.annotations } : undefined),
    ...(mcp?.title ? { title: mcp.title } : undefined),
    ...(mcp?.icons ? { icons: mcp.icons } : undefined),
    ...(mcp?.headers ? { headers: mcp.headers } : undefined),
    ...(mcp?.instructions ? { instructions: mcp.instructions } : undefined),
    command,
    ...(middlewares.length > 0 ? { middlewares } : undefined),
  }
}

/** Returns `schema` with parsed `values` as the defaults of their fields. */
function withDefaults(
  schema: z.ZodObject<any> | undefined,
  values: Record<string, unknown> | undefined,
): z.ZodObject<any> | undefined {
  if (!schema || !values || Object.keys(values).length === 0) return schema
  const shape = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, schema.shape[key].default(value)]),
  )
  // `safeExtend` keeps object-level refinements, which `extend` rejects
  return schema.safeExtend(shape)
}

/** Rejects `x-mcp-header` declarations that 2026-07-28 clients would refuse, so the tool stays callable. */
function assertHeaders(
  name: string,
  headers: Record<string, string>,
  inputSchema: Record<string, unknown>,
) {
  const properties = inputSchema.properties as Record<string, { type?: unknown }>
  const seen = new Map<string, string>()
  for (const [key, header] of Object.entries(headers)) {
    const fail = (reason: string) => {
      throw new Error(`Invalid MCP header on tool ${name}: ${reason}`)
    }
    const type = properties[key]?.type
    if (type === undefined) fail(`${key} is not an input`)
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header))
      fail(`'${header}' is not a valid HTTP header name`)
    if (type !== 'string' && type !== 'integer' && type !== 'boolean')
      fail(`${key} must be a string, integer, or boolean`)
    const prior = seen.get(header.toLowerCase())
    if (prior !== undefined) fail(`'${header}' duplicates '${prior}'`)
    seen.set(header.toLowerCase(), header)
  }
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
