import { ClientError } from './Errors.js'
import { isRecord } from './internal/helpers.js'
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

type Caller<command> =
  RequiredKeys<Input<command>> extends never
    ? (input?: Input<command>) => Promise<Output<command>>
    : (input: Input<command>) => Promise<Output<command>>

type RuntimeInput = {
  args?: unknown | undefined
  options?: unknown | undefined
}

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

/** Creates a typed incur RPC client. */
export function createClient<const commands = Commands>(options: ClientOptions): Client<commands> {
  const fetch = options.fetch ?? globalThis.fetch
  if (!fetch) throw new ClientError('Incur clients require a fetch implementation')

  return ((command: string) =>
    async (input: RuntimeInput = {}) => {
      let response: Response
      try {
        response = await fetch(endpoint(options.baseUrl), {
          body: JSON.stringify({
            command,
            args: input.args ?? {},
            options: input.options ?? {},
          }),
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          method: 'POST',
        })
      } catch (error) {
        throw new ClientError('RPC request failed', { cause: error })
      }

      const envelope = await parseResponse(response)
      if (envelope.ok) return envelope.data

      const message =
        isRecord(envelope.error) && typeof envelope.error.message === 'string'
          ? envelope.error.message
          : 'RPC command failed'
      throw new ClientError(message, {
        data: envelope,
        error: envelope.error,
        status: response.status,
      })
    }) as Client<commands>
}

function endpoint(base: string | URL): URL {
  const url = new URL(base)
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  return new URL('_incur/rpc', url)
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
