import type * as Cli from '../Cli.js'
import * as Client from './Client.js'
import * as MemoryTransport from './transports/MemoryTransport.js'

/** Memory client instance. */
export type MemoryClient<
  commands = Client.Commands,
  defaults extends Client.Defaults = {},
> = Client.Client<commands, MemoryTransport.MemoryTransport, defaults>

/** Creates a memory typed client and infers commands from a concrete CLI. */
export function create<
  const commands extends Cli.CommandsMap,
  const defaults extends Client.Defaults = {},
>(
  cli: Cli.Cli<commands, any, any>,
  options?: (MemoryTransport.Options & defaults & Client.Defaults) | undefined,
): MemoryClient<commands, defaults>
/** Creates a memory typed client with an explicit command map. */
export function create<
  const commands = Client.Commands,
  const defaults extends Client.Defaults = {},
>(
  cli: Cli.Cli<any, any, any>,
  options?: (MemoryTransport.Options & defaults & Client.Defaults) | undefined,
): MemoryClient<commands, defaults>
export function create(
  cli: Cli.Cli<any, any, any>,
  options: MemoryTransport.Options & Client.Defaults = {},
): MemoryClient<any, any> {
  const { env, ...defaults } = options
  return Client.create({
    ...defaults,
    transport: MemoryTransport.create(cli, { env }),
  })
}
