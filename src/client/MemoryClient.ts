import type * as Cli from '../Cli.js'
import * as Client from './Client.js'
import * as MemoryTransport from './transports/MemoryTransport.js'
import type { AnyCli, ClientDefaults, Commands, MemoryClient } from './types.js'

export type { MemoryClient }

/** Creates a memory typed client and infers commands from a concrete CLI. */
export function create<
  const commands extends Cli.CommandsMap,
  const defaults extends ClientDefaults = {},
>(
  cli: Cli.Cli<commands, any, any>,
  options?: (MemoryTransport.Options & defaults & ClientDefaults) | undefined,
): MemoryClient<commands, defaults>
/** Creates a memory typed client with an explicit command map. */
export function create<const commands = Commands, const defaults extends ClientDefaults = {}>(
  cli: AnyCli,
  options?: (MemoryTransport.Options & defaults & ClientDefaults) | undefined,
): MemoryClient<commands, defaults>
export function create(
  cli: AnyCli,
  options: MemoryTransport.Options & ClientDefaults = {},
): MemoryClient<any, any> {
  const { env, ...defaults } = options
  return Client.create({
    ...defaults,
    transport: MemoryTransport.create(cli, { env }),
  })
}
