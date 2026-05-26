import * as Cli from '../../Cli.js'
import {
  discoverClientResource,
  type DiscoveryRequest,
  type DiscoveryResponse,
} from '../../internal/client-discovery.js'
import { createLocalRuntime, type LocalRuntime } from '../../internal/client-local.js'
import {
  executeClientCommand,
  type RpcRequest,
  type RpcResponse,
  type RpcStreamResponse,
} from '../../internal/client-runtime.js'
import * as CommandTree from '../../internal/command-tree.js'
import type { TransportFactory } from './createTransport.js'

/** Memory transport factory. */
export type MemoryTransport = TransportFactory<
  'memory',
  {
    request(request: RpcRequest): Promise<RpcResponse | RpcStreamResponse>
    discover(request: DiscoveryRequest): Promise<DiscoveryResponse>
    local: LocalRuntime
  }
>

/** Memory transport options. */
export type MemoryTransportOptions = {
  /** Explicit environment source. */
  env?: Record<string, string | undefined> | undefined
}

/** Creates an in-process memory transport. */
export function memoryTransport(
  cli: Cli.Cli<any, any, any>,
  options: MemoryTransportOptions = {},
): MemoryTransport {
  return () => {
    const ctx = CommandTree.fromCli(cli)
    return {
      config: { key: 'memory', name: 'Memory', type: 'memory' },
      request(request) {
        return executeClientCommand(ctx, request, { env: options.env })
      },
      discover(request) {
        return discoverClientResource(ctx, request)
      },
      local: createLocalRuntime(ctx),
    }
  }
}
