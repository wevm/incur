import {
  McpServer,
  StdioServerTransport,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/server'
import { PassThrough, type Readable, type Writable } from 'node:stream'
import { z } from 'zod'

import * as Elicitation from './Elicitation.js'
import * as Command from './internal/command.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Schema from './Schema.js'

/** MCP 2026 release-candidate protocol version advertised by incur. */
export const DRAFT_PROTOCOL_VERSION = 'DRAFT-2026-v1'

/** MCP 2026 final protocol version planned by the release candidate. */
export const PROTOCOL_VERSION_2026 = '2026-07-28'

/** Protocol versions supported by incur's MCP server implementation. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  DRAFT_PROTOCOL_VERSION,
  PROTOCOL_VERSION_2026,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

/** Canonical MCP Apps extension identifier. */
export const APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'

/** MCP Apps compatibility extension identifier used by the draft lifecycle examples. */
export const APPS_EXTENSION_ALIAS = 'io.modelcontextprotocol/apps'

/** MCP Tasks extension identifier. */
export const TASKS_EXTENSION_ID = 'io.modelcontextprotocol/tasks'

/** OAuth client credentials authorization extension identifier. */
export const OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID =
  'io.modelcontextprotocol/oauth-client-credentials'

/** Enterprise-managed authorization extension identifier. */
export const ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID =
  'io.modelcontextprotocol/enterprise-managed-authorization'

/** MCP Apps HTML resource MIME type. */
export const APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options = {},
): Promise<void> {
  const server = new McpServer({ name, version })

  for (const tool of collectTools(commands, [])) {
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
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
      } as never,
      async (...callArgs: any[]) => {
        // registerTool passes (args, extra) when inputSchema is set, (extra) when not
        const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
        const extra = hasInput ? callArgs[1] : callArgs[0]
        return callTool(tool, params, {
          extra,
          clientCapabilities: server.server.getClientCapabilities(),
          sendNotification: (n) => server.server.notification(n),
          name,
          version,
          middlewares: options.middlewares,
          env: options.env,
          vars: options.vars,
        })
      },
    )
  }

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
  return { input: routed.input, modern: is2026Message(message) }
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
      ? DRAFT_PROTOCOL_VERSION
      : String(
          metaFrom(message)?.['io.modelcontextprotocol/protocolVersion'] ?? DRAFT_PROTOCOL_VERSION,
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
    name?: string | undefined
    version?: string | undefined
    middlewares?: MiddlewareHandler[] | undefined
    env?: z.ZodObject<any> | undefined
    vars?: z.ZodObject<any> | undefined
  } = {},
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
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
      options.elicitation ?? createElicitationAdapter(options.extra, options.clientCapabilities),
    format: 'json',
    formatExplicit: true,
    inputOptions: params,
    middlewares: allMiddleware,
    name: options.name ?? tool.name,
    parseMode: 'flat',
    path: tool.name,
    rethrowErrors: (error) => isUrlElicitationRequiredError(error) || isInputRequiredError(error),
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
            params: { progressToken, progress: ++i, message: JSON.stringify(chunk) },
          })
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(chunks) }] }
  }

  if (!result.ok)
    return {
      content: [{ type: 'text', text: result.error.message ?? 'Command failed' }],
      isError: true,
    }

  const data = result.data ?? null
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    ...(data !== null && tool.outputSchema
      ? { structuredContent: data as Record<string, unknown> }
      : undefined),
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
  let message: JsonRpcRequest
  try {
    message = (await req.json()) as JsonRpcRequest
  } catch {
    return json(error(null, -32700, 'Parse error'), 400)
  }

  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return json(error(message?.id ?? null, -32600, 'Invalid Request'), 400)

  if (message.method !== 'server/discover') {
    const protocolVersion = protocolVersionFrom(req, message)
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion))
      return json(
        error(message.id, -32001, `Unsupported protocol version: ${protocolVersion}`, {
          supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        }),
        400,
      )

    const headerMethod = req.headers.get('Mcp-Method')
    if (headerMethod && headerMethod !== message.method)
      return json(
        error(message.id, -32600, 'Mcp-Method header does not match JSON-RPC method.'),
        400,
      )

    const headerName = req.headers.get('Mcp-Name')
    if (headerName && message.method === 'tools/call' && headerName !== toolName(message.params))
      return json(error(message.id, -32600, 'Mcp-Name header does not match tool name.'), 400)
    if (headerName && isTaskMethod(message.method) && headerName !== taskIdFrom(message.params))
      return json(error(message.id, -32600, 'Mcp-Name header does not match taskId.'), 400)

    if (options.authorization?.authorize) {
      const authorized = await options.authorization.authorize({
        request: req,
        bearerToken: bearerToken(req),
        method: message.method,
        params: isObject(message.params) ? message.params : undefined,
      })
      if (!authorized)
        return json(
          error(message.id, -32004, 'Unauthorized', {
            extensions: advertisedAuthorizationExtensions(options.authorization),
          }),
          401,
        )
    }
  }

  try {
    const result = await handle2026Message(message, name, version, commands, options)
    if (result instanceof Response) return result
    if (message.id === undefined) return new Response(null, { status: 202 })
    return json({ jsonrpc: '2.0', id: message.id, result })
  } catch (err) {
    if (message.id === undefined) return new Response(null, { status: 202 })
    if (err instanceof InputRequiredError)
      return json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          resultType: 'input_required',
          inputRequests: err.inputRequests,
          requestState: err.requestState,
        },
      })
    if (err instanceof JsonRpcError)
      return json(error(message.id, err.code, err.message, err.data), err.status)
    return json(error(message.id, -32603, err instanceof Error ? err.message : String(err)), 500)
  }
}

/** Returns true when a request should use incur's stateless MCP 2026 dispatcher. */
export async function is2026HttpRequest(req: Request): Promise<boolean> {
  const version = req.headers.get('MCP-Protocol-Version') ?? req.headers.get('mcp-protocol-version')
  if (version === DRAFT_PROTOCOL_VERSION || version === PROTOCOL_VERSION_2026) return true

  try {
    const message = (await req.clone().json()) as JsonRpcRequest
    return is2026Message(message)
  } catch {
    return false
  }
}

function is2026Message(message: JsonRpcRequest) {
  if (message.method === 'server/discover') return true
  const meta = metaFrom(message)
  return (
    meta?.['io.modelcontextprotocol/protocolVersion'] === DRAFT_PROTOCOL_VERSION ||
    meta?.['io.modelcontextprotocol/protocolVersion'] === PROTOCOL_VERSION_2026
  )
}

export declare namespace handle2026Http {
  /** Options passed to the stateless MCP 2026 handler. */
  type Options = {
    /** Cache hints for cacheable list/read results. */
    cache?: CacheOptions | undefined
    /** MCP Apps registered by the CLI. */
    apps?: AppDefinition[] | undefined
    /** Optional authorization extensions and request validator. */
    authorization?: AuthorizationOptions | undefined
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
    /** MCP prompts registered by the CLI. */
    prompts?: PromptDefinition[] | undefined
    /** MCP resources registered by the CLI. */
    resources?: ResourceDefinition[] | undefined
    /** MCP resource templates registered by the CLI. */
    resourceTemplates?: ResourceTemplateDefinition[] | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
  }
}

/** Authorization extension options for remote MCP deployments. */
export type AuthorizationOptions = {
  /** Advertise and accept OAuth client credentials bearer-token authentication. */
  oauthClientCredentials?: ExtensionSettings | undefined
  /** Advertise and accept enterprise-managed authorization bearer-token authentication. */
  enterpriseManagedAuthorization?: ExtensionSettings | undefined
  /** Validate a request before MCP handling. */
  authorize?: ((context: AuthorizationContext) => boolean | Promise<boolean>) | undefined
}

/** Extension settings object advertised in MCP capabilities. */
export type ExtensionSettings = boolean | Record<string, unknown>

/** Context supplied to the MCP authorization hook. */
export type AuthorizationContext = {
  /** Incoming HTTP request. */
  request: Request
  /** Bearer token from the Authorization header, if present. */
  bearerToken?: string | undefined
  /** MCP method being handled. */
  method: string
  /** Parsed JSON-RPC params. */
  params?: Record<string, unknown> | undefined
}

/** Cache hint fields required on MCP 2026 cacheable results. */
export type CacheOptions = {
  /** Freshness hint in milliseconds. */
  ttlMs: number
  /** Whether the result may be cached across users. */
  cacheScope: 'public' | 'private'
}

/** Icon metadata for MCP tools, prompts, resources, and apps. */
export type Icon = {
  /** Icon URL. */
  src: string
  /** Optional MIME type, such as `image/svg+xml`. */
  mimeType?: string | undefined
  /** Optional size hints, such as `48x48` or `any`. */
  sizes?: string[] | undefined
}

/** MCP content annotations shared by resources and tool results. */
export type Annotations = {
  /** Intended audience for this content. */
  audience?: ('user' | 'assistant')[] | undefined
  /** Relative priority from 0 to 1. */
  priority?: number | undefined
  /** ISO timestamp for the last modification time. */
  lastModified?: string | undefined
}

/** MCP tool behavior annotations. */
export type ToolAnnotations = {
  /** Human-readable title. */
  title?: string | undefined
  /** Whether the tool only reads state. */
  readOnlyHint?: boolean | undefined
  /** Whether the tool may modify state. */
  destructiveHint?: boolean | undefined
  /** Whether repeated calls with the same input are expected to be idempotent. */
  idempotentHint?: boolean | undefined
  /** Whether the tool interacts with open external systems. */
  openWorldHint?: boolean | undefined
}

/** MCP tool metadata supplied by a command definition. */
export type ToolMetadata = {
  /** Human-readable display title. */
  title?: string | undefined
  /** Tool icons. */
  icons?: Icon[] | undefined
  /** Tool behavior annotations. */
  annotations?: ToolAnnotations | undefined
  /** HTTP header mappings keyed by input property name. */
  headers?: Record<string, string> | undefined
  /** MCP Apps UI resource for this tool. */
  app?: { resourceUri: string } | undefined
  /** Cache hints for list results involving this tool. */
  cache?: CacheOptions | undefined
  /** Task execution options for long-running tools. */
  task?: TaskOptions | undefined
}

/** MCP task execution options. */
export type TaskOptions = {
  /** Whether the tool should always return a task handle. */
  required?: boolean | undefined
  /** Time-to-live for task state in milliseconds. */
  ttlMs?: number | undefined
  /** Suggested polling interval in milliseconds. */
  pollIntervalMs?: number | undefined
}

/** Text resource content. */
export type TextResourceContent = {
  /** Resource URI. */
  uri: string
  /** MIME type. */
  mimeType?: string | undefined
  /** Text content. */
  text: string
  /** Optional annotations. */
  annotations?: Annotations | undefined
}

/** Binary resource content. */
export type BlobResourceContent = {
  /** Resource URI. */
  uri: string
  /** MIME type. */
  mimeType?: string | undefined
  /** Base64-encoded binary content. */
  blob: string
  /** Optional annotations. */
  annotations?: Annotations | undefined
}

/** MCP resource content. */
export type ResourceContent = TextResourceContent | BlobResourceContent

/** MCP resource definition. */
export type ResourceDefinition = {
  /** Programmatic name. */
  name: string
  /** Resource URI. */
  uri: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** MIME type. */
  mimeType?: string | undefined
  /** Resource size in bytes. */
  size?: number | undefined
  /** Icons. */
  icons?: Icon[] | undefined
  /** Annotations. */
  annotations?: Annotations | undefined
  /** Cache hints for reads. */
  cache?: CacheOptions | undefined
  /** Reads resource contents. */
  read: () => ResourceContent | ResourceContent[] | Promise<ResourceContent | ResourceContent[]>
}

/** MCP resource template definition. */
export type ResourceTemplateDefinition = {
  /** Programmatic name. */
  name: string
  /** URI template. */
  uriTemplate: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** MIME type. */
  mimeType?: string | undefined
  /** Icons. */
  icons?: Icon[] | undefined
  /** Annotations. */
  annotations?: Annotations | undefined
  /** Completion handlers keyed by template variable. */
  complete?:
    | Record<string, (value: string, context: CompletionContext) => string[] | Promise<string[]>>
    | undefined
}

/** Context supplied to MCP completion callbacks. */
export type CompletionContext = {
  /** Already resolved variables or arguments. */
  arguments?: Record<string, string> | undefined
}

/** MCP prompt message. */
export type PromptMessage = {
  /** Message role. */
  role: 'user' | 'assistant'
  /** Message content block. */
  content: ContentBlock
}

/** MCP prompt definition. */
export type PromptDefinition = {
  /** Programmatic name. */
  name: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** Arguments schema. */
  args?: z.ZodObject<any> | undefined
  /** Icons. */
  icons?: Icon[] | undefined
  /** Completion handlers keyed by argument name. */
  complete?:
    | Record<string, (value: string, context: CompletionContext) => string[] | Promise<string[]>>
    | undefined
  /** Renders prompt messages. */
  get: (args: Record<string, string>) => PromptMessage[] | Promise<PromptMessage[]>
}

/** MCP App definition. */
export type AppDefinition = {
  /** Programmatic app name. */
  name: string
  /** UI resource URI, typically `ui://...`. */
  resourceUri: string
  /** HTML text served as the app resource. */
  html: string | (() => string | Promise<string>)
  /** Display title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** Icons. */
  icons?: Icon[] | undefined
}

/** MCP content block returned by tools and prompts. */
export type ContentBlock =
  | { type: 'text'; text: string; annotations?: Annotations | undefined }
  | { type: 'image'; data: string; mimeType: string; annotations?: Annotations | undefined }
  | { type: 'audio'; data: string; mimeType: string; annotations?: Annotations | undefined }
  | {
      type: 'resource_link'
      uri: string
      name: string
      description?: string | undefined
      mimeType?: string | undefined
      annotations?: Annotations | undefined
    }
  | { type: 'resource'; resource: ResourceContent }

/** Creates a text MCP content block. */
export function text(text: string, annotations?: Annotations | undefined): ContentBlock {
  return annotations ? { type: 'text', text, annotations } : { type: 'text', text }
}

/** Creates an image MCP content block. */
export function image(
  data: string,
  mimeType: string,
  annotations?: Annotations | undefined,
): ContentBlock {
  return annotations
    ? { type: 'image', data, mimeType, annotations }
    : { type: 'image', data, mimeType }
}

/** Creates an audio MCP content block. */
export function audio(
  data: string,
  mimeType: string,
  annotations?: Annotations | undefined,
): ContentBlock {
  return annotations
    ? { type: 'audio', data, mimeType, annotations }
    : { type: 'audio', data, mimeType }
}

/** Creates a resource link MCP content block. */
export function resourceLink(
  uri: string,
  name: string,
  options: {
    description?: string | undefined
    mimeType?: string | undefined
    annotations?: Annotations | undefined
  } = {},
): ContentBlock {
  return { type: 'resource_link', uri, name, ...options }
}

/** Creates an embedded resource MCP content block. */
export function embeddedResource(resource: ResourceContent): ContentBlock {
  return { type: 'resource', resource }
}

async function handle2026Message(
  message: JsonRpcRequest,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: handle2026Http.Options,
): Promise<Record<string, unknown> | Response> {
  if (message.method === 'server/discover')
    return complete({
      supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
      capabilities: capabilities(commands, options),
      serverInfo: { name, version },
    })

  if (message.method === 'tools/list')
    return withCache(
      {
        tools: collectTools(commands, []).map(toolDescriptor),
      },
      options.cache,
    )

  if (message.method === 'tools/call')
    return call2026Tool(message, name, version, commands, options)

  if (message.method === 'resources/list')
    return withCache({ resources: resources(options).map(resourceDescriptor) }, options.cache)

  if (message.method === 'resources/templates/list')
    return withCache(
      { resourceTemplates: (options.resourceTemplates ?? []).map(resourceTemplateDescriptor) },
      options.cache,
    )

  if (message.method === 'resources/read') return read2026Resource(message, options)

  if (message.method === 'prompts/list')
    return withCache({ prompts: (options.prompts ?? []).map(promptDescriptor) }, options.cache)

  if (message.method === 'prompts/get') return get2026Prompt(message, options)

  if (message.method === 'completion/complete') return complete2026(message, options)

  if (message.method === 'subscriptions/listen') return subscriptionResponse(message)

  if (message.method === 'tasks/get') return getTask(message)

  if (message.method === 'tasks/update') return updateTask(message)

  if (message.method === 'tasks/cancel') return cancelTask(message)

  throw new JsonRpcError(-32601, `Method not found: ${message.method}`, 404)
}

async function call2026Tool(
  message: JsonRpcRequest,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: handle2026Http.Options,
) {
  const params = objectParams(message)
  const nameParam = params.name
  if (typeof nameParam !== 'string') throw new JsonRpcError(-32602, 'Tool name is required.')

  const tool = collectTools(commands, []).find((t) => t.name === nameParam)
  if (!tool) throw new JsonRpcError(-32602, `Unknown tool: ${nameParam}`)

  const args = isObject(params.arguments) ? params.arguments : {}
  const meta = tool.command.mcpTool as ToolMetadata | undefined
  if (meta?.task?.required) {
    if (!hasClientExtension(message, TASKS_EXTENSION_ID))
      throw missingRequiredClientCapability(TASKS_EXTENSION_ID)
    return createTask(tool, args, name, version, options, meta.task)
  }

  const inputResponses = isObject(params.inputResponses) ? params.inputResponses : {}
  const result = await callTool(tool, args, {
    elicitation: createMrtrAdapter(inputResponses),
    env: options.env,
    middlewares: options.middlewares,
    name,
    vars: options.vars,
    version,
  })
  return complete(result as unknown as Record<string, unknown>)
}

function createMrtrAdapter(inputResponses: Record<string, unknown>): Elicitation.Adapter {
  let i = 0
  function respond(
    key: string,
    params: Elicitation.FormRequestParams | Elicitation.UrlRequestParams,
  ) {
    const existing = inputResponses[key]
    if (isObject(existing))
      return existing as {
        action: Elicitation.Action
        content?: Record<string, Elicitation.ContentValue>
      }
    throw new InputRequiredError(
      { [key]: { method: 'elicitation/create', params } },
      encodeState({ key }),
    )
  }
  return {
    async form(params, options) {
      return respond(options?.key ?? `input_${++i}`, params)
    },
    requireUrl(params, options) {
      respond(options?.key ?? `input_${++i}`, params)
      throw new Error('unreachable')
    },
    async url(params, options) {
      return respond(options?.key ?? `input_${++i}`, params)
    },
  }
}

function capabilities(commands: Map<string, any>, options: handle2026Http.Options) {
  const result: Record<string, unknown> = {
    tools: { listChanged: false },
    extensions: {},
  }
  if (resources(options).length > 0 || (options.resourceTemplates?.length ?? 0) > 0)
    result.resources = { listChanged: false, subscribe: true }
  if ((options.prompts?.length ?? 0) > 0) result.prompts = { listChanged: false }
  if (hasCompletions(options)) result.completions = {}
  if ((options.apps?.length ?? 0) > 0)
    result.extensions = {
      ...(result.extensions as Record<string, unknown>),
      [APPS_EXTENSION_ID]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] },
      [APPS_EXTENSION_ALIAS]: { mimeTypes: [APP_RESOURCE_MIME_TYPE] },
    }
  if (hasTaskTools(commands)) {
    result.extensions = {
      ...(result.extensions as Record<string, unknown>),
      [TASKS_EXTENSION_ID]: {},
    }
  }
  result.extensions = {
    ...(result.extensions as Record<string, unknown>),
    ...advertisedAuthorizationExtensions(options.authorization),
  }
  return result
}

function advertisedAuthorizationExtensions(options: AuthorizationOptions | undefined) {
  const extensions: Record<string, unknown> = {}
  if (options?.oauthClientCredentials)
    extensions[OAUTH_CLIENT_CREDENTIALS_EXTENSION_ID] = extensionSettings(
      options.oauthClientCredentials,
    )
  if (options?.enterpriseManagedAuthorization)
    extensions[ENTERPRISE_MANAGED_AUTHORIZATION_EXTENSION_ID] = extensionSettings(
      options.enterpriseManagedAuthorization,
    )
  return extensions
}

function extensionSettings(settings: ExtensionSettings) {
  return settings === true ? {} : settings
}

function toolDescriptor(tool: ToolEntry) {
  const meta = tool.command.mcpTool as ToolMetadata | undefined
  const inputSchema = addHeaders(tool.inputSchema, meta?.headers)
  return {
    name: tool.name,
    ...(meta?.title ? { title: meta.title } : undefined),
    ...(tool.description ? { description: tool.description } : undefined),
    inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
    ...(meta?.icons ? { icons: meta.icons } : undefined),
    ...(meta?.annotations ? { annotations: meta.annotations } : undefined),
    ...(meta?.app ? { _meta: { ui: { resourceUri: meta.app.resourceUri } } } : undefined),
    ...(meta?.task
      ? { execution: { taskSupport: meta.task.required ? 'required' : 'optional' } }
      : undefined),
  }
}

function addHeaders(
  schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] },
  headers?: Record<string, string> | undefined,
) {
  if (!headers) return schema
  const properties = { ...schema.properties }
  for (const [key, value] of Object.entries(headers)) {
    const property = properties[key]
    if (isObject(property)) properties[key] = { ...property, 'x-mcp-header': value }
  }
  return { ...schema, properties }
}

function resources(options: handle2026Http.Options): ResourceDefinition[] {
  const apps = (options.apps ?? []).map(
    (app): ResourceDefinition => ({
      name: app.name,
      uri: app.resourceUri,
      title: app.title,
      description: app.description,
      mimeType: APP_RESOURCE_MIME_TYPE,
      icons: app.icons,
      async read() {
        const html = typeof app.html === 'function' ? await app.html() : app.html
        return { uri: app.resourceUri, mimeType: APP_RESOURCE_MIME_TYPE, text: html }
      },
    }),
  )
  return [...(options.resources ?? []), ...apps]
}

function resourceDescriptor(resource: ResourceDefinition) {
  return {
    uri: resource.uri,
    name: resource.name,
    ...(resource.title ? { title: resource.title } : undefined),
    ...(resource.description ? { description: resource.description } : undefined),
    ...(resource.mimeType ? { mimeType: resource.mimeType } : undefined),
    ...(resource.size !== undefined ? { size: resource.size } : undefined),
    ...(resource.icons ? { icons: resource.icons } : undefined),
    ...(resource.annotations ? { annotations: resource.annotations } : undefined),
  }
}

function resourceTemplateDescriptor(template: ResourceTemplateDefinition) {
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(template.title ? { title: template.title } : undefined),
    ...(template.description ? { description: template.description } : undefined),
    ...(template.mimeType ? { mimeType: template.mimeType } : undefined),
    ...(template.icons ? { icons: template.icons } : undefined),
    ...(template.annotations ? { annotations: template.annotations } : undefined),
  }
}

async function read2026Resource(message: JsonRpcRequest, options: handle2026Http.Options) {
  const uri = objectParams(message).uri
  if (typeof uri !== 'string') throw new JsonRpcError(-32602, 'Resource uri is required.')
  const resource = resources(options).find((r) => r.uri === uri)
  if (!resource) throw new JsonRpcError(-32602, 'Resource not found', 400, { uri })
  const contents = await resource.read()
  return withCache(
    { contents: Array.isArray(contents) ? contents : [contents] },
    resource.cache ?? options.cache,
  )
}

function promptDescriptor(prompt: PromptDefinition) {
  const args = prompt.args ? Schema.toJsonSchema(prompt.args) : undefined
  const properties = isObject(args?.properties) ? args.properties : {}
  const required = new Set(Array.isArray(args?.required) ? (args.required as string[]) : [])
  return {
    name: prompt.name,
    ...(prompt.title ? { title: prompt.title } : undefined),
    ...(prompt.description ? { description: prompt.description } : undefined),
    arguments: Object.entries(properties).map(([name, schema]) => ({
      name,
      ...(isObject(schema) && typeof schema.description === 'string'
        ? { description: schema.description }
        : undefined),
      required: required.has(name),
    })),
    ...(prompt.icons ? { icons: prompt.icons } : undefined),
  }
}

async function get2026Prompt(message: JsonRpcRequest, options: handle2026Http.Options) {
  const params = objectParams(message)
  const name = params.name
  if (typeof name !== 'string') throw new JsonRpcError(-32602, 'Prompt name is required.')
  const prompt = (options.prompts ?? []).find((p) => p.name === name)
  if (!prompt) throw new JsonRpcError(-32602, `Unknown prompt: ${name}`)
  const rawArgs = isObject(params.arguments) ? params.arguments : {}
  let parsed: Record<string, unknown>
  try {
    parsed = prompt.args ? prompt.args.parse(rawArgs) : rawArgs
  } catch (error) {
    if (error instanceof z.ZodError) throw new JsonRpcError(-32602, error.message)
    throw error
  }
  return complete({
    ...(prompt.description ? { description: prompt.description } : undefined),
    messages: await prompt.get(parsed as Record<string, string>),
  })
}

async function complete2026(message: JsonRpcRequest, options: handle2026Http.Options) {
  const params = objectParams(message)
  const argument = isObject(params.argument) ? params.argument : {}
  const ref = isObject(params.ref) ? params.ref : {}
  const name = typeof argument.name === 'string' ? argument.name : ''
  const value = typeof argument.value === 'string' ? argument.value : ''
  const context =
    isObject(params.context) && isObject(params.context.arguments)
      ? { arguments: params.context.arguments as Record<string, string> }
      : {}

  let values: string[] = []
  if (ref.type === 'ref/prompt' && typeof ref.name === 'string') {
    const prompt = (options.prompts ?? []).find((p) => p.name === ref.name)
    values = prompt?.complete?.[name] ? await prompt.complete[name]!(value, context) : []
  } else if (ref.type === 'ref/resource' && typeof ref.uri === 'string') {
    const template = (options.resourceTemplates ?? []).find((t) => t.uriTemplate === ref.uri)
    values = template?.complete?.[name] ? await template.complete[name]!(value, context) : []
  }

  return complete({
    completion: {
      values: values.slice(0, 100),
      total: values.length,
      hasMore: values.length > 100,
    },
  })
}

function subscriptionResponse(message: JsonRpcRequest) {
  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/subscriptions/acknowledged',
            params: { subscriptionId: String(message.id ?? crypto.randomUUID()) },
          })}\n`,
        ),
      )
      if (message.id !== undefined)
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: complete({}) })}\n`,
          ),
        )
      controller.close()
    },
  })
  return new Response(body, {
    headers: { 'Content-Type': 'application/json-seq' },
  })
}

async function createTask(
  tool: ToolEntry,
  args: Record<string, unknown>,
  name: string,
  version: string,
  options: handle2026Http.Options,
  taskOptions: TaskOptions,
) {
  const taskId = crypto.randomUUID()
  const ttlMs = taskOptions.ttlMs ?? 300000
  const now = new Date().toISOString()
  const task: TaskState = {
    id: taskId,
    status: 'working',
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs,
    pollIntervalMs: taskOptions.pollIntervalMs ?? 5000,
    expiresAt: Date.now() + ttlMs,
    inputRequests: {},
    waiters: new Map(),
  }
  tasks.set(taskId, task)
  void (async () => {
    try {
      const result = await callTool(tool, args, {
        elicitation: createTaskElicitationAdapter(task),
        env: options.env,
        middlewares: options.middlewares,
        name,
        vars: options.vars,
        version,
      })
      if (task.status === 'cancelled') return
      task.result = result
      task.status = 'completed'
      task.inputRequests = {}
      touchTask(task)
    } catch (error) {
      if (task.status === 'cancelled') return
      task.status = 'failed'
      task.error = {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      }
      touchTask(task)
    }
  })()
  return { resultType: 'task', ...taskResult(task) }
}

function getTask(message: JsonRpcRequest) {
  const task = taskFrom(message)
  return complete(taskResult(task))
}

function updateTask(message: JsonRpcRequest) {
  const task = taskFrom(message)
  const inputResponses = objectParams(message).inputResponses
  if (isObject(inputResponses))
    for (const [key, value] of Object.entries(inputResponses)) {
      const waiter = task.waiters.get(key)
      if (!waiter || !isObject(value)) continue
      task.waiters.delete(key)
      delete task.inputRequests[key]
      waiter(
        value as { action: Elicitation.Action; content?: Record<string, Elicitation.ContentValue> },
      )
    }
  if (Object.keys(task.inputRequests).length === 0 && task.status === 'input_required') {
    task.status = 'working'
    touchTask(task)
  }
  return complete({})
}

function cancelTask(message: JsonRpcRequest) {
  const task = taskFrom(message)
  task.status = 'cancelled'
  task.inputRequests = {}
  for (const waiter of task.waiters.values()) waiter({ action: 'cancel' })
  task.waiters.clear()
  touchTask(task)
  return complete({})
}

function taskFrom(message: JsonRpcRequest) {
  pruneTasks()
  const taskId = objectParams(message).taskId
  if (typeof taskId !== 'string') throw new JsonRpcError(-32602, 'taskId is required.')
  const task = tasks.get(taskId)
  if (!task) throw new JsonRpcError(-32602, 'Task not found.', 400, { taskId })
  return task
}

function taskResult(task: TaskState) {
  return {
    taskId: task.id,
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt: task.lastUpdatedAt,
    ttlMs: task.ttlMs,
    pollIntervalMs: task.pollIntervalMs,
    ...(task.status === 'input_required' ? { inputRequests: task.inputRequests } : undefined),
    ...(task.result ? { result: task.result } : undefined),
    ...(task.error ? { error: task.error } : undefined),
  }
}

function createTaskElicitationAdapter(task: TaskState): Elicitation.Adapter {
  let i = 0
  function wait(key: string, params: Elicitation.FormRequestParams | Elicitation.UrlRequestParams) {
    task.status = 'input_required'
    task.inputRequests[key] = { method: 'elicitation/create', params }
    touchTask(task)
    return new Promise<{
      action: Elicitation.Action
      content?: Record<string, Elicitation.ContentValue> | undefined
    }>((resolve) => {
      task.waiters.set(key, resolve)
    })
  }
  return {
    form(params, options) {
      return wait(options?.key ?? `input_${++i}`, params)
    },
    requireUrl(params, options) {
      throw new InputRequiredError(
        { [options?.key ?? `input_${++i}`]: { method: 'elicitation/create', params } },
        encodeState({ taskId: task.id }),
      )
    },
    url(params, options) {
      return wait(options?.key ?? `input_${++i}`, params)
    },
  }
}

function touchTask(task: TaskState) {
  task.lastUpdatedAt = new Date().toISOString()
}

function pruneTasks() {
  const now = Date.now()
  for (const [id, task] of tasks) if (task.expiresAt < now) tasks.delete(id)
}

function hasCompletions(options: handle2026Http.Options) {
  return (
    (options.prompts ?? []).some((p) => p.complete && Object.keys(p.complete).length > 0) ||
    (options.resourceTemplates ?? []).some((t) => t.complete && Object.keys(t.complete).length > 0)
  )
}

function hasTaskTools(commands: Map<string, any>) {
  return collectTools(commands, []).some((tool) =>
    Boolean((tool.command.mcpTool as ToolMetadata | undefined)?.task),
  )
}

function withCache(fields: Record<string, unknown>, cache: CacheOptions | undefined) {
  return complete({ ...fields, ...(cache ?? defaultCache) })
}

function complete(fields: Record<string, unknown>) {
  return { resultType: 'complete', ...fields }
}

function objectParams(message: JsonRpcRequest) {
  return isObject(message.params) ? message.params : {}
}

function protocolVersionFrom(req: Request, message: JsonRpcRequest) {
  return (
    req.headers.get('MCP-Protocol-Version') ??
    req.headers.get('mcp-protocol-version') ??
    String(metaFrom(message)?.['io.modelcontextprotocol/protocolVersion'] ?? '')
  )
}

function metaFrom(message: JsonRpcRequest) {
  return isObject(message.params) && isObject(message.params._meta)
    ? message.params._meta
    : undefined
}

function toolName(params: unknown) {
  return isObject(params) && typeof params.name === 'string' ? params.name : ''
}

function isTaskMethod(method: string) {
  return method === 'tasks/get' || method === 'tasks/update' || method === 'tasks/cancel'
}

function taskIdFrom(params: unknown) {
  return isObject(params) && typeof params.taskId === 'string' ? params.taskId : ''
}

function bearerToken(req: Request) {
  const value = req.headers.get('Authorization') ?? req.headers.get('authorization')
  if (!value?.startsWith('Bearer ')) return undefined
  return value.slice('Bearer '.length)
}

function hasClientExtension(message: JsonRpcRequest, extensionId: string) {
  const capabilities = metaFrom(message)?.['io.modelcontextprotocol/clientCapabilities']
  if (!isObject(capabilities) || !isObject(capabilities.extensions)) return false
  return isObject(capabilities.extensions[extensionId])
}

function missingRequiredClientCapability(extensionId: string) {
  return new JsonRpcError(-32003, 'Missing required client capability', 400, {
    requiredCapabilities: { extensions: { [extensionId]: {} } },
  })
}

function encodeState(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function error(
  id: JsonRpcRequest['id'] | null | undefined,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data ? { data } : undefined) },
  }
}

function isInputRequiredError(error: unknown) {
  return error instanceof InputRequiredError
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class JsonRpcError extends Error {
  code: number
  data?: unknown | undefined
  status: number

  constructor(code: number, message: string, status = 400, data?: unknown | undefined) {
    super(message)
    this.code = code
    this.status = status
    if (data !== undefined) this.data = data
  }
}

class InputRequiredError extends Error {
  inputRequests: Record<
    string,
    { method: string; params: Elicitation.FormRequestParams | Elicitation.UrlRequestParams }
  >
  requestState: string

  constructor(
    inputRequests: Record<
      string,
      { method: string; params: Elicitation.FormRequestParams | Elicitation.UrlRequestParams }
    >,
    requestState: string,
  ) {
    super('Input required')
    this.inputRequests = inputRequests
    this.requestState = requestState
  }
}

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id?: string | number | undefined
  method: string
  params?: Record<string, unknown> | undefined
}

type TaskState = {
  id: string
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
  lastUpdatedAt: string
  ttlMs: number | null
  pollIntervalMs: number
  expiresAt: number
  inputRequests: Record<
    string,
    {
      method: 'elicitation/create'
      params: Elicitation.FormRequestParams | Elicitation.UrlRequestParams
    }
  >
  waiters: Map<
    string,
    (result: {
      action: Elicitation.Action
      content?: Record<string, Elicitation.ContentValue> | undefined
    }) => void
  >
  result?: unknown | undefined
  error?: { code: number; message: string } | undefined
}

const defaultCache: CacheOptions = { ttlMs: 300000, cacheScope: 'public' }
const tasks = new Map<string, TaskState>()

function createElicitationAdapter(
  extra: Extra | undefined,
  clientCapabilities: ClientCapabilities | undefined,
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
      throw new UrlElicitationRequiredError([params])
    },
    url(params) {
      return elicitInput(params) as Promise<any>
    },
  }
}

function isUrlElicitationRequiredError(error: unknown) {
  return (
    error instanceof UrlElicitationRequiredError || (error as { code?: unknown })?.code === -32042
  )
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

/** @internal A resolved tool entry from the command tree. */
export type ToolEntry = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  outputSchema?: Record<string, unknown> | undefined
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

/** @internal Recursively collects leaf commands as tool entries. */
export function collectTools(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[] = [],
): ToolEntry[] {
  const result: ToolEntry[] = []
  for (const [name, entry] of commands) {
    if ('_alias' in entry) continue
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      const groupMw = [
        ...parentMiddlewares,
        ...((entry.middlewares as MiddlewareHandler[] | undefined) ?? []),
      ]
      result.push(...collectTools(entry.commands, path, groupMw))
    } else {
      result.push({
        name: path.join('_'),
        description: entry.description,
        inputSchema: buildToolSchema(entry.args, entry.options),
        ...(entry.output
          ? { outputSchema: Schema.toJsonSchema(entry.output) as Record<string, unknown> }
          : undefined),
        command: entry,
        ...(parentMiddlewares.length > 0 ? { middlewares: parentMiddlewares } : undefined),
      })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
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
