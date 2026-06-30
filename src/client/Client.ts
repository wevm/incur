import * as LocalActions from './actions/LocalActions.js'
import * as ResourcesActions from './actions/ResourcesActions.js'
import * as RunActions from './actions/RunActions.js'
export { ClientError } from './ClientError.js'
import type * as Formatter from '../Formatter.js'
import type { ActionClient } from './actions/ActionClient.js'
import type * as Local from './Local.js'
import type * as Resources from './Resources.js'
import type * as Run from './Run.js'
import type { HttpTransport } from './transports/HttpTransport.js'
import type { MemoryTransport } from './transports/MemoryTransport.js'

/** Type-safe client registration interface populated by generated client maps. */
// biome-ignore lint/suspicious/noEmptyInterface: populated via declaration merging
export interface Register {}

/** Default command map registered for typed clients. */
export type Commands = Register extends { commands: infer commands extends CommandsMap }
  ? commands
  : {}

/** Command map entry shape. */
export type CommandEntry = {
  /** Structured positional arguments. */
  args: unknown
  /** Structured named options. */
  options: unknown
  /** Structured command output. */
  output?: unknown | undefined
  /** Whether the command streams chunk outputs. */
  stream?: true | undefined
}

/** Command map shape used by typed clients. */
export type CommandsMap = Record<string, CommandEntry>

/** Supported client transport factories. */
export type Transport = HttpTransport | MemoryTransport

/** Resolved transport value attached to a client. */
export type ResolvedTransport<transport extends Transport> = ReturnType<transport>['config'] &
  Omit<ReturnType<transport>, 'config'>

/** Defaults used by run actions. */
export type Defaults = {
  /** Rendered output format for command output text. */
  outputFormat?: Formatter.Format | undefined
  /** Structured output selection paths. */
  selection?: string[] | undefined
  /** Whether token metadata should be included. */
  outputTokenCount?: boolean | undefined
  /** Maximum rendered output tokens. */
  outputTokenLimit?: number | undefined
  /** Rendered output token offset. */
  outputTokenOffset?: number | undefined
}

/** Base client fields. */
export type Base<transport extends Transport, defaults extends Defaults> = {
  /** Defaults applied by actions before transport requests. */
  defaults: defaults
  /** Resolved transport metadata and capabilities. */
  transport: ResolvedTransport<transport>
  /** Client discriminator. */
  type: 'client'
}

/** Typed client instance. */
export type Client<
  commands = Commands,
  transport extends Transport = Transport,
  defaults extends Defaults = {},
> = Base<transport, defaults> &
  Run.Actions<commands, defaults> &
  Resources.Actions<commands> &
  ([transport] extends [MemoryTransport] ? Local.Methods : {})

/** Options for `Client.create()`. */
export type CreateOptions<transport extends Transport, defaults extends Defaults> = defaults &
  Defaults & {
    /** Transport factory to resolve. */
    transport: transport
  }

/** Canonical command id. */
export type CommandId<commands> = keyof commands & string

/** Command prefix usable by resources actions. */
export type CommandPrefix<command extends string> = command extends `${infer head} ${infer tail}`
  ? head | `${head} ${CommandPrefix<tail>}`
  : never

/** Command or command-group scope usable by resources actions. */
export type CommandScope<commands> = CommandId<commands> | CommandPrefix<CommandId<commands>>

/** Creates a typed client from a transport factory. */
export function create<
  const commands = Commands,
  const transport extends Transport = Transport,
  const defaults extends Defaults = {},
>(options: CreateOptions<transport, defaults>): Client<commands, transport, defaults> {
  const { transport, ...defaults } = options
  const resolved = transport()
  const { config, ...capabilities } = resolved
  const client = {
    defaults,
    transport: { ...config, ...capabilities },
    type: 'client',
  } satisfies ActionClient & { type: 'client' }

  return {
    ...client,
    ...actions(client),
  } as unknown as Client<commands, transport, defaults>
}

function actions(client: ActionClient) {
  const base = {
    ...RunActions.actions(client),
    ...ResourcesActions.actions(client),
  }

  if (!client.transport.local) return base
  const memory = LocalActions.actions(client)

  return {
    ...base,
    ...memory,
    skills: {
      ...base.skills,
      ...memory.skills,
    },
    mcp: {
      ...base.mcp,
      ...memory.mcp,
    },
  }
}
