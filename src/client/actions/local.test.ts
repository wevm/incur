import { describe, expect, test, vi } from 'vitest'

import { createClient } from '../createClient.js'
import type * as MemoryTransport from '../transports/MemoryTransport.js'

function memoryClient() {
  const transport = (() => ({
    config: { key: 'memory', name: 'Memory', type: 'memory' as const },
    discover: vi.fn(async () => ({ contentType: 'application/json', data: {} })),
    request: vi.fn(),
    local: {
      skills: {
        add: vi.fn(async (options) => ({
          agents: [],
          paths: [],
          skills: [{ name: 'deploy' }],
          options,
        })),
        list: vi.fn(async () => [{ description: 'Deploy', installed: false, name: 'deploy' }]),
      },
      mcp: {
        add: vi.fn(async (options) => ({ agents: options?.agents ?? [], command: 'pnpm app' })),
      },
    },
  })) satisfies MemoryTransport.MemoryTransport
  return createClient<{}, MemoryTransport.MemoryTransport>({ transport })
}

describe('local actions', () => {
  test('memory local actions delegate and coexist with discovery namespaces', async () => {
    const client = memoryClient()

    await expect(client.skills.index()).resolves.toEqual({})
    await expect(client.mcp.tools()).resolves.toEqual({})
    await expect(client.skills.add({ depth: 1, global: true })).resolves.toMatchObject({
      skills: [{ name: 'deploy' }],
      options: { depth: 1, global: true },
    })
    await expect(client.skills.list()).resolves.toEqual({
      skills: [{ description: 'Deploy', installed: false, name: 'deploy' }],
    })
    await expect(client.mcp.add({ agents: ['codex'] })).resolves.toEqual({
      agents: ['codex'],
      command: 'pnpm app',
    })
  })
})
