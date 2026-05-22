import * as Cli from './Cli.js'
import { ClientError } from './Errors.js'
import { isRecord } from './internal/helpers.js'
import * as Rpc from './internal/rpc.js'
import type { Register } from './Register.js'

type DefaultCommand = {
  args: unknown
  options: unknown
  output: unknown
}

type Commands = Register extends { commands: infer commands }
  ? commands
  : Record<string, DefaultCommand>

type Args<command> = command extends { args: infer args } ? args : unknown
type Options<command> = command extends { options: infer options } ? options : unknown
type Output<command> = command extends { output: infer output } ? output : unknown

type RequiredKeys<value> = value extends object
  ? {
      [key in keyof value]-?: {} extends Pick<value, key> ? never : key
    }[keyof value]
  : never

type Field<key extends string, value> = value extends object
  ? RequiredKeys<value> extends never
    ? { [field in key]?: value | undefined }
    : { [field in key]: value }
  : { [field in key]?: value | undefined }

type Input<command> = Field<'args', Args<command>> & Field<'options', Options<command>>
type Result<command> = command extends { stream: true }
  ? AsyncIterable<Output<command>>
  : Output<command>

type Caller<command> =
  RequiredKeys<Input<command>> extends never
    ? (input?: Input<command>) => Promise<Result<command>>
    : (input: Input<command>) => Promise<Result<command>>

type RuntimeInput = {
  args?: unknown | undefined
  options?: unknown | undefined
}

type Executor = (command: string, input: RuntimeInput) => Promise<unknown>

type Envelope = {
  data?: unknown | undefined
  error?: unknown | undefined
  ok: boolean
}

/**
 * Typed incur RPC client backed by the commands registered through declaration merging.
 */
export type Client<commands = Commands> = <const command extends Extract<keyof commands, string>>(
  command: command,
) => Caller<commands[command]>

/** Options for creating an incur RPC client. */
type ClientOptions = {
  /** Base URL for the incur server. */
  baseUrl: string | URL
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch | undefined
}

/** Options for creating an in-memory incur RPC client. */
type MemoryClientOptions = {
  /** Environment source used for CLI-level and command-level env parsing. */
  env?: Record<string, string | undefined> | undefined
}

/** Creates a typed incur RPC client. */
export function createClient<const commands = Commands>(options: ClientOptions): Client<commands> {
  const fetch = options.fetch ?? globalThis.fetch
  if (!fetch) throw new ClientError('Incur clients require a fetch implementation')

  return createCurriedClient(async (command, input) => {
    let response: Response
    try {
      response = await fetch(endpoint(options.baseUrl), {
        body: JSON.stringify({
          command,
          args: input.args ?? {},
          options: input.options ?? {},
        }),
        headers: {
          accept: 'application/json, application/x-ndjson',
          'content-type': 'application/json',
        },
        method: 'POST',
      })
    } catch (error) {
      throw new ClientError('RPC request failed', { cause: error })
    }

    if (isStreamingResponse(response)) return parseStreamingResponse(response)

    const envelope = await parseResponse(response)
    return unwrapEnvelope(envelope, response.status)
  })
}

/** Creates a typed incur RPC client that executes commands against a CLI instance in memory. */
export function createMemoryClient<const commands extends Cli.CommandsMap>(
  cli: Cli.Cli<commands, any, any>,
  options?: MemoryClientOptions | undefined,
): Client<commands>
/** Creates a typed incur RPC client that executes commands against a CLI instance in memory. */
export function createMemoryClient<const commands = Commands>(
  cli: Cli.Cli<any, any, any>,
  options?: MemoryClientOptions | undefined,
): Client<commands>
export function createMemoryClient<const commands = Commands>(
  cli: Cli.Cli<any, any, any>,
  options: MemoryClientOptions = {},
): Client<commands> {
  return createCurriedClient(async (command, input) => {
    const result = await Rpc.executeCli(
      cli,
      {
        command,
        args: input.args ?? {},
        options: input.options ?? {},
      },
      { env: options.env },
    )

    if (result.kind === 'stream') return parseMemoryStream(result.stream, result.status)
    return unwrapEnvelope(result.body, result.status)
  })
}

function createCurriedClient<const commands>(execute: Executor): Client<commands> {
  return ((command: string) =>
    async (input: RuntimeInput = {}) =>
      execute(command, input)) as Client<commands>
}

function endpoint(base: string | URL): URL {
  const url = new URL(base)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL('_incur/rpc', url)
}

function isStreamingResponse(response: Response): boolean {
  return response.headers.get('content-type')?.includes('application/x-ndjson') ?? false
}

async function parseResponse(response: Response): Promise<Envelope> {
  const text = await response.text()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ClientError('Expected a JSON RPC envelope', {
      cause: error,
      data: text,
      status: response.status,
    })
  }

  if (!isRecord(value) || typeof value.ok !== 'boolean')
    throw new ClientError('Malformed RPC envelope', {
      data: value,
      status: response.status,
    })
  return value as Envelope
}

function unwrapEnvelope(envelope: Envelope, status: number | undefined): unknown {
  if (envelope.ok) return envelope.data

  const message = errorMessage(envelope.error, 'RPC command failed')
  throw new ClientError(message, {
    data: envelope,
    error: envelope.error,
    status,
  })
}

async function* parseStreamingResponse(response: Response): AsyncGenerator<unknown, void, unknown> {
  if (!response.body)
    throw new ClientError('Expected an RPC stream body', {
      status: response.status,
    })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  let eof = false

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        eof = true
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          const result = readStreamRecord(line, response.status)
          if (result.done) {
            completed = true
            return
          }
          yield result.data
        }
      }
    }

    const remaining = buffer.trim()
    if (remaining) {
      const result = readStreamRecord(remaining, response.status)
      if (result.done) {
        completed = true
        return
      }
      yield result.data
    }
  } finally {
    if (!completed && !eof) await reader.cancel()
    reader.releaseLock()
  }

  throw new ClientError('RPC stream ended before done', {
    status: response.status,
  })
}

async function* parseMemoryStream(
  stream: AsyncGenerator<Rpc.StreamRecord, void, unknown>,
  status: number,
): AsyncGenerator<unknown, void, unknown> {
  for await (const record of stream) {
    const result = readStreamValue(record, status)
    if (result.done) return
    yield result.data
  }

  throw new ClientError('RPC stream ended before done', {
    status,
  })
}

function readStreamRecord(
  line: string,
  status: number,
): { data: unknown; done?: false | undefined } | { done: true } {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new ClientError('Expected a JSON RPC stream record', {
      cause: error,
      data: line,
      status,
    })
  }

  if (!isRecord(value) || typeof value.type !== 'string')
    throw new ClientError('Malformed RPC stream record', {
      data: value,
      status,
    })

  return readStreamValue(value, status)
}

function readStreamValue(
  value: unknown,
  status: number,
): { data: unknown; done?: false | undefined } | { done: true } {
  if (!isRecord(value) || typeof value.type !== 'string')
    throw new ClientError('Malformed RPC stream record', {
      data: value,
      status,
    })

  if (value.type === 'chunk') return { data: value.data }
  if (value.type === 'done' && value.ok === true) return { done: true }
  if (value.type === 'error' && value.ok === false) {
    throw new ClientError(errorMessage(value.error, 'RPC stream failed'), {
      data: value,
      error: value.error,
      status,
    })
  }

  throw new ClientError('Malformed RPC stream record', {
    data: value,
    status,
  })
}

function errorMessage(error: unknown, fallback: string): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : fallback
}
