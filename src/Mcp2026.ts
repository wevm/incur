import { z } from 'zod'

import * as Elicitation from './Elicitation.js'
import * as Json from './internal/json.js'
import type { ToolEntry } from './Mcp.js'
import {
  appsExtensionAlias,
  appsExtensionId,
  appResourceMimeType,
  draftProtocolVersion,
  enterpriseManagedAuthorizationExtensionId,
  oauthClientCredentialsExtensionId,
  protocolVersion2026,
  supportedProtocolVersions,
  tasksExtensionId,
} from './Mcp2026Types.js'
import type {
  AppDefinition,
  AuthorizationContext,
  AuthorizationOptions,
  CacheOptions,
  CompletionContext,
  ExtensionSettings,
  PromptDefinition,
  ResourceDefinition,
  ResourceTemplateDefinition,
  TaskOptions,
  ToolMetadata,
} from './Mcp2026Types.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Schema from './Schema.js'

export * from './Mcp2026Types.js'

/** Shared operations supplied by the MCP facade without creating a runtime module cycle. */
export type Runtime = {
  /** Executes a resolved command tool. */
  callTool: typeof import('./Mcp.js').callTool
  /** Resolves command definitions into MCP tools. */
  collectTools: typeof import('./Mcp.js').collectTools
}

/** Handles a stateless MCP 2026 Streamable HTTP request. */
export async function handle2026Http(
  req: Request,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: handle2026Http.Options,
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
    if (!supportedProtocolVersions.includes(protocolVersion))
      return json(
        error(message.id, -32001, `Unsupported protocol version: ${protocolVersion}`, {
          supportedVersions: supportedProtocolVersions,
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
  if (version === draftProtocolVersion || version === protocolVersion2026) return true

  try {
    const message = (await req.clone().json()) as JsonRpcRequest
    return is2026Message(message)
  } catch {
    return false
  }
}

export function is2026Message(message: JsonRpcRequest) {
  if (message.method === 'server/discover') return true
  const meta = metaFrom(message)
  return (
    meta?.['io.modelcontextprotocol/protocolVersion'] === draftProtocolVersion ||
    meta?.['io.modelcontextprotocol/protocolVersion'] === protocolVersion2026
  )
}

export declare namespace handle2026Http {
  /** Options passed to the stateless MCP 2026 handler. */
  type Options = {
    /** Shared tool execution and discovery operations. */
    runtime: Runtime
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

async function handle2026Message(
  message: JsonRpcRequest,
  name: string,
  version: string,
  commands: Map<string, any>,
  options: handle2026Http.Options,
): Promise<Record<string, unknown> | Response> {
  if (message.method === 'server/discover')
    return complete({
      supportedVersions: supportedProtocolVersions,
      capabilities: capabilities(commands, options),
      serverInfo: { name, version },
    })

  if (message.method === 'tools/list')
    return withCache(
      {
        tools: options.runtime.collectTools(commands, []).map(toolDescriptor),
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

  const tool = options.runtime.collectTools(commands, []).find((t) => t.name === nameParam)
  if (!tool) throw new JsonRpcError(-32602, `Unknown tool: ${nameParam}`)

  const args = isObject(params.arguments) ? params.arguments : {}
  const meta = tool.command.mcpTool as ToolMetadata | undefined
  if (meta?.task?.required) {
    if (!hasClientExtension(message, tasksExtensionId))
      throw missingRequiredClientCapability(tasksExtensionId)
    return createTask(tool, args, name, version, options, meta.task)
  }

  const inputResponses = isObject(params.inputResponses) ? params.inputResponses : {}
  const result = await options.runtime.callTool(tool, args, {
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
      [appsExtensionId]: { mimeTypes: [appResourceMimeType] },
      [appsExtensionAlias]: { mimeTypes: [appResourceMimeType] },
    }
  if (hasTaskTools(commands, options)) {
    result.extensions = {
      ...(result.extensions as Record<string, unknown>),
      [tasksExtensionId]: {},
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
    extensions[oauthClientCredentialsExtensionId] = extensionSettings(
      options.oauthClientCredentials,
    )
  if (options?.enterpriseManagedAuthorization)
    extensions[enterpriseManagedAuthorizationExtensionId] = extensionSettings(
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
      mimeType: appResourceMimeType,
      icons: app.icons,
      async read() {
        const html = typeof app.html === 'function' ? await app.html() : app.html
        return { uri: app.resourceUri, mimeType: appResourceMimeType, text: html }
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
      const result = await options.runtime.callTool(tool, args, {
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

function hasTaskTools(commands: Map<string, any>, options: handle2026Http.Options) {
  return options.runtime
    .collectTools(commands, [])
    .some((tool) => Boolean((tool.command.mcpTool as ToolMetadata | undefined)?.task))
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

export function metaFrom(message: JsonRpcRequest) {
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

export function isInputRequiredError(error: unknown) {
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

export type JsonRpcRequest = {
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
