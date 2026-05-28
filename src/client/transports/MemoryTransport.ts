import * as Cli from '../../Cli.js'
import { createLocalHandler } from '../../internal/handlers/local.js'
import { createResourcesHandler } from '../../internal/handlers/resources.js'
import { createRpcHandler } from '../../internal/handlers/rpc.js'
import * as RuntimeContext from '../../internal/runtime-context.js'
import { ClientError } from '../ClientError.js'
import type * as Local from '../Local.js'
import type * as Resources from '../Resources.js'
import type * as Rpc from '../Rpc.js'
import type * as Transport from './Transport.js'

/** Memory transport factory. */
export type MemoryTransport = Transport.Factory<
  'memory',
  {
    request(request: Rpc.Request): Promise<Rpc.Response | Rpc.StreamResponse>
    discover(request: Resources.Request): Promise<Resources.Response>
    local: Local.Methods
  }
>

/** Memory transport options. */
export type Options = {
  /** Explicit environment source. */
  env?: Record<string, string | undefined> | undefined
}

/** Creates an in-process memory transport. */
export function create(cli: Cli.Cli<any, any, any>, options: Options = {}): MemoryTransport {
  return () => {
    const ctx = RuntimeContext.fromCli(cli)
    const { request } = createRpcHandler(ctx, { env: options.env })
    const { discover } = createResourcesHandler(ctx)
    const { local } = createLocalHandler(ctx)
    return {
      config: { key: 'memory', name: 'Memory', type: 'memory' },
      request,
      async discover(request) {
        try {
          return await discover(request)
        } catch (error) {
          throw toClientError('Discover request failed.', error)
        }
      },
      local: {
        skills: {
          async add(options) {
            try {
              return await local.skills.add(options)
            } catch (error) {
              throw toClientError('Local skills sync failed.', error)
            }
          },
          async list(options) {
            try {
              return await local.skills.list(options)
            } catch (error) {
              throw toClientError('Local skills list failed.', error)
            }
          },
        },
        mcp: {
          async add(options) {
            try {
              return await local.mcp.add(options)
            } catch (error) {
              throw toClientError('Local MCP registration failed.', error)
            }
          },
        },
      },
    }
  }
}

function toClientError(message: string, error: unknown) {
  if (error instanceof ClientError) return error
  const cause = error instanceof Error ? error : new Error(String(error))
  return new ClientError(message, {
    cause,
    code: 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined,
    status: 'status' in cause && typeof cause.status === 'number' ? cause.status : undefined,
  })
}
