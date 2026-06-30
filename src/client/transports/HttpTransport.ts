import { ClientError } from '../ClientError.js'
import type * as Resources from '../Resources.js'
import type * as Rpc from '../Rpc.js'
import type * as Transport from './Transport.js'

/** HTTP transport factory. */
export type HttpTransport = Transport.Factory<
  'http',
  {
    baseUrl: URL
    request(request: Rpc.Request): Promise<Rpc.Response | Rpc.StreamResponse>
    discover(request: Resources.Request): Promise<Resources.Response>
  }
>

/** HTTP transport options. */
export type Options = {
  /** Base URL for the served CLI. */
  baseUrl: string | URL
  /** Fetch implementation. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch | undefined
  /** Headers merged into every request. */
  headers?: HeadersInit | undefined
}

/** Creates an HTTP transport. */
export function create(options: Options): HttpTransport {
  const fetcher = options.fetch ?? globalThis.fetch
  if (!fetcher) throw new ClientError('No fetch implementation is available.')
  const baseUrl = new URL(options.baseUrl)

  return () => ({
    config: { key: 'http', name: 'HTTP', type: 'http' },
    baseUrl,
    async request(request) {
      const response = await requestFetch(fetcher, url(baseUrl, '_incur/rpc'), {
        method: 'POST',
        headers: headers(options.headers, {
          accept: 'application/json, application/x-ndjson',
          'content-type': 'application/json',
        }),
        body: JSON.stringify({
          ...request,
          args: request.args ?? {},
          options: request.options ?? {},
        }),
      })
      return parseRpcResponse(response)
    },
    async discover(request) {
      const response = await requestFetch(fetcher, discoveryUrl(baseUrl, request), {
        method: 'GET',
        headers: headers(options.headers, {
          accept: 'application/json, text/plain, text/markdown',
        }),
      })
      return parseDiscoverResponse(response)
    },
  })
}

async function requestFetch(fetcher: typeof globalThis.fetch, input: URL, init: RequestInit) {
  try {
    return await fetcher(input, init)
  } catch (error) {
    throw new ClientError('RPC request failed', {
      cause: error instanceof Error ? error : new Error(String(error)),
    })
  }
}

async function parseRpcResponse(response: Response): Promise<Rpc.Response | Rpc.StreamResponse> {
  const contentType = essence(response.headers.get('content-type') ?? '')
  if (contentType === 'application/x-ndjson') {
    if (!response.body) throw new ClientError('Streaming RPC response is missing a body.')
    return streamResponse(response.body)
  }
  if (contentType !== 'application/json') throw new ClientError('RPC response was not JSON.')
  const value = await parseJson(response)
  if (!isEnvelope(value)) throw new ClientError('Malformed RPC envelope.')
  if (!value.ok) return { ...value, status: response.status }
  return value
}

function streamResponse(body: ReadableStream<Uint8Array>): Rpc.StreamResponse {
  return {
    stream: true,
    async *records() {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let terminal: Rpc.StreamRecord | undefined
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (const record of drainRecords(buffer)) {
            buffer = record.rest
            const parsed = parseRecord(record.line)
            terminal = parsed.type === 'done' || parsed.type === 'error' ? parsed : terminal
            yield parsed
          }
        }
        const rest = buffer.trim()
        if (rest) {
          const parsed = parseRecord(rest)
          terminal = parsed.type === 'done' || parsed.type === 'error' ? parsed : terminal
          yield parsed
        }
        if (!terminal) throw new ClientError('RPC stream ended before a terminal record.')
        return terminal
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    },
  }
}

function* drainRecords(buffer: string): Generator<{ line: string; rest: string }> {
  let current = buffer
  while (true) {
    const index = current.indexOf('\n')
    if (index === -1) return
    const line = current.slice(0, index).trim()
    current = current.slice(index + 1)
    if (line) yield { line, rest: current }
  }
}

function parseRecord(line: string): Rpc.StreamRecord {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new ClientError('Invalid RPC stream JSON.', {
      cause: error instanceof Error ? error : undefined,
    })
  }
  if (!isRecord(value)) throw new ClientError('Malformed RPC stream record.')
  return value
}

async function parseJson(response: Response) {
  try {
    return JSON.parse(await response.text())
  } catch (error) {
    throw new ClientError('Invalid RPC JSON.', {
      cause: error instanceof Error ? error : undefined,
    })
  }
}

async function parseDiscoverResponse(response: Response): Promise<Resources.Response> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) {
    const data = contentType.includes('application/json')
      ? await parseJson(response).catch(() => undefined)
      : await response.text().catch(() => undefined)
    const error = isErrorPayload(data) ? data.error : undefined
    throw new ClientError(error?.message ?? 'Discover request failed.', {
      code: error?.code,
      data,
      error,
      fieldErrors: error?.fieldErrors,
      retryable: error?.retryable,
      status: response.status,
    })
  }
  if (contentType.includes('application/json'))
    return { contentType: essence(contentType), data: await parseJson(response) }
  return { contentType: essence(contentType), body: await response.text() }
}

function discoveryUrl(baseUrl: URL, request: Resources.Request) {
  const path = (() => {
    if (request.resource === 'llms') return '_incur/llms'
    if (request.resource === 'llmsFull') return '_incur/llms-full'
    if (request.resource === 'schema') return '_incur/schema'
    if (request.resource === 'help') return '_incur/help'
    if (request.resource === 'mcpTools') return '_incur/mcp/tools'
    if (request.resource === 'skillsIndex') return '_incur/skills'
    if (request.resource === 'skill') return '_incur/skill'
    if (request.resource === 'openapi' && request.format === 'yaml') return 'openapi.yaml'
    return 'openapi.json'
  })()
  const target = url(baseUrl, path)
  if ('command' in request && request.command) target.searchParams.set('command', request.command)
  if ('format' in request && request.format && request.resource !== 'openapi')
    target.searchParams.set('format', request.format)
  if (request.resource === 'skill') target.searchParams.set('name', request.name)
  return target
}

function url(baseUrl: URL, path: string) {
  const pathname = `${baseUrl.pathname.replace(/\/$/, '')}/${path}`
  const target = new URL(baseUrl)
  target.pathname = pathname
  target.search = ''
  return target
}

function headers(custom: HeadersInit | undefined, required: Record<string, string>) {
  const result = new Headers(required)
  if (custom) new Headers(custom).forEach((value, key) => result.set(key, value))
  return result
}

function essence(value: string) {
  return value.split(';', 1)[0]!.trim().toLowerCase()
}

function isEnvelope(value: unknown): value is Rpc.Response {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    typeof (value as { meta?: { command?: unknown } }).meta?.command === 'string'
  )
}

function isRecord(value: unknown): value is Rpc.StreamRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    ((value as { type?: unknown }).type === 'chunk' ||
      ((value as { type?: unknown }).type === 'done' && isEnvelope(value)) ||
      ((value as { type?: unknown }).type === 'error' && isEnvelope(value)))
  )
}

function isErrorPayload(value: unknown): value is { error: Rpc.Error } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { error?: unknown }).error === 'object' &&
    (value as { error?: unknown }).error !== null
  )
}
