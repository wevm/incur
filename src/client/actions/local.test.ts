import { beforeEach, describe, expect, test, vi } from 'vitest'

import * as Cli from '../../Cli.js'
import * as MemoryClient from '../MemoryClient.js'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  register: vi.fn(),
  sync: vi.fn(),
}))

vi.mock('../../SyncSkills.js', () => ({
  list: mocks.list,
  sync: mocks.sync,
}))

vi.mock('../../SyncMcp.js', () => ({
  register: mocks.register,
}))

beforeEach(() => {
  mocks.list.mockReset()
  mocks.register.mockReset()
  mocks.sync.mockReset()
})

describe('local actions', () => {
  test('memory local actions use the real memory client and coexist with resources namespaces', async () => {
    const cli = Cli.create('app', {
      description: 'App',
      mcp: { agents: ['codex'], command: 'pnpm app --mcp' },
      sync: { cwd: '/workspace/app', depth: 2 },
    }).command('deploy', {
      description: 'Deploy app',
      run: () => ({ ok: true }),
    })
    mocks.list.mockResolvedValueOnce([
      { description: 'Deploy app', installed: false, name: 'app-deploy' },
    ])
    mocks.sync.mockResolvedValueOnce({
      agents: [],
      paths: ['/workspace/app/.agents/skills/app-deploy'],
      skills: [{ description: 'Deploy app', name: 'app-deploy' }],
    })
    mocks.register.mockResolvedValueOnce({ agents: ['Codex'], command: 'pnpm app --mcp' })
    const client = MemoryClient.create(cli)

    await expect(client.skills.index()).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: 'deploy' })],
    })
    await expect(client.skills.list({ depth: 3 })).resolves.toEqual({
      skills: [{ description: 'Deploy app', installed: false, name: 'app-deploy' }],
    })
    await expect(client.skills.add({ depth: 4, global: false })).resolves.toMatchObject({
      skills: [{ description: 'Deploy app', name: 'app-deploy' }],
    })
    await expect(client.mcp.add({ agents: ['cursor'], global: false })).resolves.toEqual({
      agents: ['Codex'],
      command: 'pnpm app --mcp',
    })

    expect(mocks.list).toHaveBeenCalledWith('app', expect.any(Map), {
      cwd: '/workspace/app',
      depth: 3,
      description: 'App',
      include: undefined,
      rootCommand: undefined,
    })
    expect(mocks.sync).toHaveBeenCalledWith('app', expect.any(Map), {
      cwd: '/workspace/app',
      depth: 4,
      description: 'App',
      global: false,
      include: undefined,
      rootCommand: undefined,
    })
    expect(mocks.register).toHaveBeenCalledWith('app', {
      agents: ['cursor'],
      command: 'pnpm app --mcp',
      global: false,
    })
  })
})
