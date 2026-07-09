import { z } from 'zod'

import type * as Fetch from './Fetch.js'
import * as Openapi from './Openapi.js'

const protocolVersion = '2025-06-18'

/** A remote MCP streamable-HTTP server source. */
export type Source =
  | string
  | URL
  | {
      /** Streamable-HTTP MCP endpoint URL. */
      url: string | URL
      /** Headers merged into every MCP request. */
      headers?: HeadersInit | undefined
      /** Fetch handler used for MCP requests. Defaults to `globalThis.fetch`. */
      fetch?: Fetch.Handler | undefined
    }

/** A resolved remote MCP server. */
export type Resolved = {
  /** Tools returned by `tools/list`. */
  tools: Tool[]
  /** Session state reused for later MCP calls. */
  session: Session
}

/** Remote MCP session state. */
export type Session = {
  /** Fetch handler used for MCP requests. */
  fetch: Fetch.Handler
  /** Headers merged into every MCP request. */
  headers?: HeadersInit | undefined
  /** Last captured MCP session ID. */
  id?: string | undefined
  /** Whether the server completed initialization. */
  initialized?: boolean | undefined
  /** Streamable-HTTP MCP endpoint URL. */
  url: URL
}

/** Remote MCP tool metadata. */
export type Tool = {
  /** Tool name. */
  name: string
  /** Tool description. */
  description?: string | undefined
  /** JSON Schema for tool input. */
  inputSchema?: Record<string, unknown> | undefined
  /** JSON Schema for tool output. */
  outputSchema?: Record<string, unknown> | undefined
}

type Message = { id?: number | string; result?: any; error?: { message?: string; code?: unknown } }
type ContentItem = { type?: string; text?: string }

/** Resolves a remote MCP server by initializing it and listing its tools. */
export async function resolve(source: Source, options: resolve.Options = {}): Promise<Resolved> {
  const session = sourceSession(source)
  await request(session, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'incur', version: options.version ?? '1.0.0' },
  })
  session.initialized = true
  await request(session, 'notifications/initialized')
  const result = await request(session, 'tools/list')
  return { tools: (result.tools ?? []) as Tool[], session }
}

/** Options for resolving a remote MCP server. */
export declare namespace resolve {
  /** Remote MCP resolve options. */
  type Options = {
    /** Client version reported during MCP initialization. */
    version?: string | undefined
  }
}

/** Generates incur command entries from remote MCP tools. */
export function generateCommands(resolved: Resolved): Map<string, GeneratedEntry> {
  const commands = new Map<string, GeneratedEntry>()

  for (const tool of resolved.tools) {
    const options = tool.inputSchema ? inputOptions(tool.inputSchema) : undefined
    const output = outputSchema(tool.outputSchema)
    commands.set(tool.name, {
      description: tool.description,
      ...(options ? { options } : undefined),
      ...(output ? { output } : undefined),
      async run(context) {
        const result = await request(resolved.session, 'tools/call', {
          name: tool.name,
          arguments: { ...context.args, ...context.options },
        })
        if (result.isError)
          return context.error({ code: 'MCP_TOOL_ERROR', message: resultText(result) })
        return resultValue(result)
      },
    })
  }

  return commands
}

/** Generated command entry for a remote MCP tool. */
export type GeneratedEntry = {
  /** Command description. */
  description?: string | undefined
  /** Options schema generated from the MCP tool input schema. */
  options?: z.ZodObject<any> | undefined
  /** Output schema generated from the MCP tool output schema. */
  output?: z.ZodType | undefined
  /** Proxies a command invocation to `tools/call`. */
  run(context: any): Promise<unknown>
}

function sourceSession(source: Source): Session {
  if (typeof source === 'string' || source instanceof URL)
    return { url: new URL(source), fetch: globalThis.fetch.bind(globalThis) }
  return {
    url: new URL(source.url),
    fetch: source.fetch ?? globalThis.fetch.bind(globalThis),
    ...(source.headers ? { headers: source.headers } : undefined),
  }
}

async function request(session: Session, method: string, params?: unknown) {
  const notification = method.startsWith('notifications/')
  const id = notification ? undefined : crypto.randomUUID()
  const headers = new Headers(session.headers)
  headers.set('content-type', 'application/json')
  headers.set('accept', 'application/json, text/event-stream')
  if (session.id) headers.set('mcp-session-id', session.id)
  if (session.initialized) headers.set('MCP-Protocol-Version', protocolVersion)

  const body = JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : undefined), method, params })
  const response = await session.fetch(new Request(session.url, { method: 'POST', headers, body }))
  const sessionId = response.headers.get('mcp-session-id')
  if (sessionId) session.id = sessionId
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  if (notification && response.status === 202) return {}
  const text = await response.text()
  if (!text) return {}
  const contentType = response.headers.get('content-type') ?? ''
  const message = contentType.includes('text/event-stream')
    ? parseSse(text, id)
    : (JSON.parse(text) as Message)
  if (message.error) throw new Error(message.error.message ?? 'MCP request failed')
  return message.result ?? {}
}

function parseSse(text: string, id: string | undefined): Message {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    const message = JSON.parse(data) as Message
    if (id === undefined || message.id === id) return message
  }
  throw new Error('MCP SSE response did not include the matching JSON-RPC message')
}

function inputOptions(schema: Record<string, unknown>) {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema.required as string[] | undefined) ?? [])
  const shape: Record<string, z.ZodType> = {}
  for (const [key, property] of Object.entries(properties)) {
    let zodType = Openapi.toZod(property)
    if (!required.has(key)) zodType = zodType.optional()
    if (typeof property.description === 'string') zodType = zodType.describe(property.description)
    shape[key] = Openapi.coerceIfNeeded(zodType)
  }
  return Object.keys(shape).length > 0 ? z.object(shape) : undefined
}

function outputSchema(schema: Record<string, unknown> | undefined) {
  if (!schema || schema.type !== 'object') return undefined
  try {
    return z.fromJSONSchema(schema)
  } catch {
    return undefined
  }
}

function resultText(result: any) {
  const content = Array.isArray(result.content) ? (result.content as ContentItem[]) : []
  return content
    .map((item) => (item.type === 'text' ? item.text : ''))
    .filter(Boolean)
    .join('\n')
}

function resultValue(result: any) {
  if (result.structuredContent !== undefined) return result.structuredContent
  const content = Array.isArray(result.content) ? (result.content as ContentItem[]) : []
  const textItems = content
    .filter((item): item is { type?: string; text: string } => item.type === 'text')
    .map((item) => item.text)
  if (textItems.length === 1) {
    try {
      return JSON.parse(textItems[0]!)
    } catch {
      return textItems[0]!
    }
  }
  return textItems
}
