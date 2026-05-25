import type * as Cli from '../Cli.js'
import * as discovery from './actions/discovery.js'
import * as local from './actions/local.js'
import { run } from './actions/run.js'
import * as HttpTransport from './transports/HttpTransport.js'
import * as MemoryTransport from './transports/MemoryTransport.js'
import type {
  AnyCli,
  Client,
  ClientDefaults,
  Commands,
  CreateClientOptions,
  HttpClient,
  MemoryClient,
  Transport,
} from './types.js'

/** Creates a typed client from a transport factory. */
export function createClient<
  const commands = Commands,
  const transport extends Transport = Transport,
  const defaults extends ClientDefaults = {},
>(options: CreateClientOptions<transport, defaults>): Client<commands, transport, defaults> {
  const { transport, ...defaults } = options
  const uid = uidValue()
  const resolved = transport({ uid })
  const { config, ...capabilities } = resolved
  const client = {
    defaults,
    transport: { ...config, ...capabilities },
    type: 'client',
    uid,
  } as unknown as Client<commands, transport, defaults>

  return attachActions(client) as Client<commands, transport, defaults>
}

/** Creates an HTTP typed client. */
export function createHttpClient<
  const commands = Commands,
  const defaults extends ClientDefaults = {},
>(
  options: HttpTransport.Options & defaults & ClientDefaults,
): HttpClient<commands, defaults> {
  const { baseUrl, fetch, headers, ...defaults } = options
  return createClient<commands, HttpTransport.HttpTransport, defaults>({
    ...defaults,
    transport: HttpTransport.create({
      baseUrl,
      ...(fetch ? { fetch } : undefined),
      ...(headers ? { headers } : undefined),
    }),
  } as HttpTransport.Options & defaults & { transport: HttpTransport.HttpTransport })
}

/** Creates a memory typed client and infers commands from a concrete CLI. */
export function createMemoryClient<
  const commands extends Cli.CommandsMap,
  const defaults extends ClientDefaults = {},
>(
  cli: Cli.Cli<commands, any, any>,
  options?: (MemoryTransport.Options & defaults & ClientDefaults) | undefined,
): MemoryClient<commands, defaults>
/** Creates a memory typed client with an explicit command map. */
export function createMemoryClient<
  const commands = Commands,
  const defaults extends ClientDefaults = {},
>(
  cli: AnyCli,
  options?: (MemoryTransport.Options & defaults & ClientDefaults) | undefined,
): MemoryClient<commands, defaults>
export function createMemoryClient(
  cli: AnyCli,
  options: MemoryTransport.Options & ClientDefaults = {},
): MemoryClient<any, any> {
  const { env, ...defaults } = options
  return createClient({
    ...defaults,
    transport: MemoryTransport.create(cli, { env }),
  })
}

function attachActions<const client extends object>(client: client): client {
  Object.assign(client, {
    run(command: string, input?: unknown) {
      return run(client as never, command, input as never)
    },
    llms(options?: unknown) {
      return discovery.llms(client as never, options as never)
    },
    llmsFull(options?: unknown) {
      return discovery.llmsFull(client as never, options as never)
    },
    schema(command?: string | undefined) {
      return discovery.schema(client as never, command)
    },
    help(command?: string | undefined) {
      return discovery.help(client as never, command)
    },
    openapi() {
      return discovery.openapi(client as never)
    },
    skills: {
      index() {
        return discovery.skillsIndex(client as never)
      },
      get(name: string) {
        return discovery.skill(client as never, name)
      },
    },
    mcp: {
      tools() {
        return discovery.mcpTools(client as never)
      },
    },
  })

  if ('transport' in client && 'local' in (client as { transport: object }).transport) {
    Object.assign((client as unknown as { skills: object }).skills, {
      add(options?: unknown) {
        return local.skillsAdd(client as never, options as never)
      },
      list(options?: unknown) {
        return local.skillsList(client as never, options as never)
      },
    })
    Object.assign((client as unknown as { mcp: object }).mcp, {
      add(options?: unknown) {
        return local.mcpAdd(client as never, options as never)
      },
    })
  }

  return client
}

function uidValue() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `client_${Math.random().toString(36).slice(2)}`
}
