import type * as Client from '../Client.js'
import type * as Local from '../Local.js'
import type * as Resources from '../Resources.js'
import type * as Rpc from '../Rpc.js'

/** Client implementation shape used by actions. */
export type ActionClient = {
  defaults: Client.Defaults
  transport: {
    request(request: Rpc.Request): Promise<Rpc.Response | Rpc.StreamResponse>
    discover(request: Resources.Request): Promise<Resources.Response>
    local?: Local.Methods | undefined
  } & Client.ResolvedTransport<Client.Transport>
}
