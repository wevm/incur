import * as Cli from '../../Cli.js'
import { createClientDiscover } from '../../internal/client-discover.js'
import { createClientLocal } from '../../internal/client-local.js'
import { createClientRequest } from '../../internal/client-request.js'
import * as CommandTree from '../../internal/command-tree.js'
import { ClientError } from '../ClientError.js'
import type * as Discover from '../Discover.js'
import type * as Local from '../Local.js'
import type * as ClientRequest from '../Request.js'
import type * as Transport from './Transport.js'

/** Memory transport factory. */
export type MemoryTransport = Transport.Factory<
  'memory',
  {
    request(
      request: ClientRequest.Request,
    ): Promise<ClientRequest.Response | ClientRequest.StreamResponse>
    discover(request: Discover.Request): Promise<Discover.Response>
    local: Local.Runtime
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
    const ctx = CommandTree.fromCli(cli)
    const { request } = createClientRequest(ctx, { env: options.env })
    const { discover } = createClientDiscover(ctx)
    const { local } = createClientLocal(ctx)
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
