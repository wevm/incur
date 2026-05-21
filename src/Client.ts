/** Per-call options for generated client methods. */
export type RequestOptions = {
  /** Headers merged into the transport request. */
  headers?: HeadersInit | undefined
  /** Abort signal passed to the transport request. */
  signal?: AbortSignal | undefined
}

/** Metadata included in every incur RPC envelope. */
export type Meta = {
  /** Resolved command path. */
  command: string
  /** Command execution duration formatted by incur. */
  duration: string
  /** Optional call-to-action payload emitted by the command. */
  cta?: unknown | undefined
}

/** Error payload included in failed incur RPC envelopes. */
export type RpcError = {
  /** Stable error code. */
  code?: string | number | undefined
  /** Human-readable error message. */
  message: string
  /** Whether the command error is retryable. */
  retryable?: boolean | undefined
  /** Structured validation errors when available. */
  fieldErrors?: unknown | undefined
  /** Additional error data. */
  data?: unknown | undefined
}

/** Successful incur RPC envelope. */
export type Success<data = unknown> = {
  /** Success discriminator. */
  ok: true
  /** Command output. */
  data: data
  /** Envelope metadata. */
  meta: Meta
}

/** Failed incur RPC envelope. */
export type Failure<error extends RpcError = RpcError> = {
  /** Failure discriminator. */
  ok: false
  /** Command error payload. */
  error: error
  /** Envelope metadata. */
  meta: Meta
}

/** Full incur RPC result envelope. */
export type Result<data = unknown, error extends RpcError = RpcError> =
  | Success<data>
  | Failure<error>

/** Alias for an incur RPC result envelope. */
export type Envelope<data = unknown, error extends RpcError = RpcError> = Result<data, error>

/** Structured RPC request body sent by generated clients. */
export type RpcRequest = {
  /** Exact command path segments. */
  path: string[]
  /** Structured positional arguments. */
  args: Record<string, unknown>
  /** Structured command options. */
  options: Record<string, unknown>
}

/** Transport used by generated clients. */
export type Transport = (
  request: RpcRequest,
  options?: RequestOptions | undefined,
) => Envelope | Promise<Envelope>

/** Runtime context shared by generated client methods. */
export type Context = {
  /** Transport used for each generated method call. */
  transport: Transport
}

/** Error thrown by data-mode generated client methods. */
export class ClientError<error = unknown> extends Error {
  /** Error class name. */
  override name = 'ClientError'
  /** Error code from the incur envelope or transport. */
  code: string | number | undefined
  /** Additional error data or malformed response payload. */
  data: unknown
  /** Original error payload. */
  error: error | undefined
  /** HTTP status for transport-level errors. */
  status: number | undefined

  constructor(message: string, options: ClientError.Options<error> = {}) {
    super(message)
    this.code = options.code
    this.data = options.data
    this.error = options.error
    this.status = options.status
  }
}

export declare namespace ClientError {
  /** Options for constructing a client error. */
  export type Options<error = unknown> = {
    /** Error code from the incur envelope or transport. */
    code?: string | number | undefined
    /** Additional error data or malformed response payload. */
    data?: unknown | undefined
    /** Original error payload. */
    error?: error | undefined
    /** HTTP status for transport-level errors. */
    status?: number | undefined
  }
}

/** Creates a generated-client runtime context. */
export function create(options: create.Options): Context {
  return { transport: options.transport }
}

export declare namespace create {
  /** Options for creating a generated-client runtime context. */
  export type Options = {
    /** Transport used for each generated method call. */
    transport: Transport
  }
}

/** Calls an incur command and returns its unwrapped data, throwing on command errors. */
export async function call<data = unknown, error extends RpcError = RpcError>(
  context: Context,
  path: string[],
  input: call.Input = {},
  options: RequestOptions = {},
): Promise<data> {
  const result = await envelope<data, error>(context, path, input, options)
  if (result.ok) return result.data
  throw new ClientError(result.error.message, {
    code: result.error.code,
    data: result.error.data,
    error: result.error,
  })
}

export declare namespace call {
  /** Structured method input passed by generated clients. */
  export type Input = {
    /** Structured positional arguments. */
    args?: Record<string, unknown> | undefined
    /** Structured command options. */
    options?: Record<string, unknown> | undefined
  }
}

/** Calls an incur command and returns the full result envelope. */
export async function result<data = unknown, error extends RpcError = RpcError>(
  context: Context,
  path: string[],
  input: call.Input = {},
  options: RequestOptions = {},
): Promise<Result<data, error>> {
  return envelope(context, path, input, options)
}

/** Creates a null-prototype object for generated exact-key client trees. */
export function object<objectType extends object>(): objectType {
  return Object.create(null) as objectType
}

/** Defines an enumerable own property on a generated exact-key client tree. */
export function define(object: object, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

/** Returns a custom transport unchanged. */
export function custom(transport: Transport): Transport {
  return transport
}

/** Returns an in-process transport unchanged. */
export function local(transport: Transport): Transport {
  return transport
}

/** Creates an HTTP transport for generated clients. */
export function http(baseUrl: string | URL, options: http.Options = {}): Transport {
  const fetch = options.fetch ?? globalThis.fetch
  if (!fetch) throw new Error('Client.http requires a fetch implementation')

  return async (request, requestOptions = {}) => {
    const url = new URL('/_incur/rpc', baseUrl)
    const headers = mergeHeaders(options.headers, requestOptions.headers)
    headers.set('accept', 'application/json')
    headers.set('content-type', 'application/json')

    const init: RequestInit = {
      body: JSON.stringify(request),
      headers,
      method: 'POST',
    }
    if (requestOptions.signal) init.signal = requestOptions.signal

    const response = await fetch(url, init)
    return parseEnvelopeResponse(response)
  }
}

export declare namespace http {
  /** Fetch implementation used by the HTTP transport. */
  export type Fetch = (
    input: RequestInfo | URL,
    init?: RequestInit | undefined,
  ) => Promise<Response>

  /** Options for the HTTP transport. */
  export type Options = {
    /** Fetch implementation. Defaults to `globalThis.fetch`. */
    fetch?: Fetch | undefined
    /** Default headers sent with every request. */
    headers?: HeadersInit | undefined
  }
}

/** Parses an HTTP response as an incur RPC envelope. */
export async function parseEnvelopeResponse(response: Response): Promise<Envelope> {
  if (response.headers.get('content-type')?.startsWith('application/x-ndjson'))
    throw new ClientError('Streaming RPC responses are not supported by this client', {
      status: response.status,
    })

  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ClientError('Expected a JSON RPC envelope', { data: text, status: response.status })
  }

  assertEnvelope(value, response.status)
  return value
}

/** Asserts that a value is an incur RPC envelope. */
export function assertEnvelope(
  value: unknown,
  status?: number | undefined,
): asserts value is Envelope {
  if (!isObject(value)) throw malformedEnvelope(status, value)
  if (typeof value.ok !== 'boolean') throw malformedEnvelope(status, value)
  if (!isObject(value.meta)) throw malformedEnvelope(status, value)
  if (typeof value.meta.command !== 'string') throw malformedEnvelope(status, value)
  if (typeof value.meta.duration !== 'string') throw malformedEnvelope(status, value)

  if (value.ok) {
    if (!('data' in value)) throw malformedEnvelope(status, value)
    return
  }

  if (!isObject(value.error) || typeof value.error.message !== 'string')
    throw malformedEnvelope(status, value)
}

async function envelope<data = unknown, error extends RpcError = RpcError>(
  context: Context,
  path: string[],
  input: call.Input,
  options: RequestOptions,
): Promise<Envelope<data, error>> {
  const result = await context.transport(
    {
      args: input.args ?? {},
      options: input.options ?? {},
      path,
    },
    options,
  )
  assertEnvelope(result)
  return result as Envelope<data, error>
}

function malformedEnvelope(status: number | undefined, data: unknown): ClientError {
  return new ClientError('Malformed RPC envelope', { data, status })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeHeaders(base: HeadersInit | undefined, override: HeadersInit | undefined): Headers {
  const headers = new Headers(base)
  if (!override) return headers
  new Headers(override).forEach((value, key) => headers.set(key, value))
  return headers
}
