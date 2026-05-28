import { beforeEach, describe, expect, test, vi } from 'vitest'

import * as Cli from '../../Cli.js'
import * as RuntimeContext from '../runtime-context.js'

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

import { createLocalHandler, LocalError } from './local.js'

function createFixture() {
  const cli = Cli.create('app', {
    description: 'App CLI',
    mcp: { agents: ['claude-code'], command: 'pnpm app --mcp' },
    sync: {
      cwd: '/workspace/app',
      depth: 2,
      include: ['skills/*'],
      suggestions: ['Run app status'],
    },
  }).command('status', {
    description: 'Show status',
    run() {
      return { ok: true }
    },
  })
  const ctx = RuntimeContext.fromCli(cli)
  return { ctx, local: createLocalHandler(ctx).local }
}

beforeEach(() => {
  mocks.list.mockReset()
  mocks.register.mockReset()
  mocks.sync.mockReset()
})

describe('createLocalHandler', () => {
  test('skills.add delegates to sync with context defaults', async () => {
    const { ctx, local } = createFixture()
    const result = {
      agents: [{ agent: 'codex', path: '/agents/codex/app' }],
      paths: ['/skills/app'],
      skills: [{ description: 'App CLI', name: 'app' }],
    }
    mocks.sync.mockResolvedValueOnce(result)

    await expect(local.skills.add()).resolves.toBe(result)
    expect(mocks.sync).toHaveBeenCalledWith('app', ctx.commands, {
      cwd: '/workspace/app',
      depth: 2,
      description: 'App CLI',
      global: true,
      include: ['skills/*'],
      rootCommand: undefined,
    })
  })

  test('skills.add options override sync defaults', async () => {
    const { ctx, local } = createFixture()
    mocks.sync.mockResolvedValueOnce({ agents: [], paths: [], skills: [] })

    await local.skills.add({ depth: 4, global: false })
    expect(mocks.sync).toHaveBeenCalledWith('app', ctx.commands, {
      cwd: '/workspace/app',
      depth: 4,
      description: 'App CLI',
      global: false,
      include: ['skills/*'],
      rootCommand: undefined,
    })
  })

  test('skills.add defaults depth to 1 and global to true when context has no sync defaults', async () => {
    const cli = Cli.create('bare').command('status', {
      run() {
        return { ok: true }
      },
    })
    const ctx = RuntimeContext.fromCli(cli)
    const { local } = createLocalHandler(ctx)
    mocks.sync.mockResolvedValueOnce({ agents: [], paths: [], skills: [] })

    await local.skills.add()
    expect(mocks.sync).toHaveBeenCalledWith('bare', ctx.commands, {
      cwd: undefined,
      depth: 1,
      description: undefined,
      global: true,
      include: undefined,
      rootCommand: undefined,
    })
  })

  test('skills.add wraps sync failures in LocalError', async () => {
    const { local } = createFixture()
    const cause = new Error('disk full')
    mocks.sync.mockRejectedValueOnce(cause)

    try {
      await local.skills.add()
      throw new Error('expected local.skills.add to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalError)
      expect(error).toMatchObject({
        details: 'disk full',
        name: 'Incur.LocalError',
        shortMessage: 'Failed to sync local skills.',
      })
      expect((error as Error).cause).toBe(cause)
    }
  })

  test('skills.list delegates to list and wraps the array result', async () => {
    const { ctx, local } = createFixture()
    const skills = [{ description: 'Show status', installed: true, name: 'app-status' }]
    mocks.list.mockResolvedValueOnce(skills)

    await expect(local.skills.list()).resolves.toEqual({ skills })
    expect(mocks.list).toHaveBeenCalledWith('app', ctx.commands, {
      cwd: '/workspace/app',
      depth: 2,
      description: 'App CLI',
      include: ['skills/*'],
      rootCommand: undefined,
    })
  })

  test('skills.list option depth overrides context depth', async () => {
    const { ctx, local } = createFixture()
    mocks.list.mockResolvedValueOnce([])

    await local.skills.list({ depth: 5 })
    expect(mocks.list).toHaveBeenCalledWith('app', ctx.commands, {
      cwd: '/workspace/app',
      depth: 5,
      description: 'App CLI',
      include: ['skills/*'],
      rootCommand: undefined,
    })
  })

  test('skills.list wraps list failures in LocalError', async () => {
    const { local } = createFixture()
    const cause = new Error('bad glob')
    mocks.list.mockRejectedValueOnce(cause)

    try {
      await local.skills.list()
      throw new Error('expected local.skills.list to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalError)
      expect(error).toMatchObject({
        details: 'bad glob',
        name: 'Incur.LocalError',
        shortMessage: 'Failed to list local skills.',
      })
      expect((error as Error).cause).toBe(cause)
    }
  })

  test('mcp.add delegates to register with context defaults', async () => {
    const { local } = createFixture()
    const result = { agents: ['Claude Code'], command: 'pnpm app --mcp' }
    mocks.register.mockResolvedValueOnce(result)

    await expect(local.mcp.add()).resolves.toBe(result)
    expect(mocks.register).toHaveBeenCalledWith('app', {
      agents: ['claude-code'],
      command: 'pnpm app --mcp',
      global: true,
    })
  })

  test('mcp.add options override context defaults', async () => {
    const { local } = createFixture()
    mocks.register.mockResolvedValueOnce({ agents: ['Cursor'], command: 'node app.js --mcp' })

    await local.mcp.add({
      agents: ['cursor'],
      command: 'node app.js --mcp',
      global: false,
    })
    expect(mocks.register).toHaveBeenCalledWith('app', {
      agents: ['cursor'],
      command: 'node app.js --mcp',
      global: false,
    })
  })

  test('mcp.add defaults global to true without context defaults', async () => {
    const cli = Cli.create('bare').command('status', {
      run() {
        return { ok: true }
      },
    })
    const { local } = createLocalHandler(RuntimeContext.fromCli(cli))
    mocks.register.mockResolvedValueOnce({ agents: [], command: 'pnpm bare --mcp' })

    await local.mcp.add()
    expect(mocks.register).toHaveBeenCalledWith('bare', {
      agents: undefined,
      command: undefined,
      global: true,
    })
  })

  test('mcp.add wraps register failures in LocalError', async () => {
    const { local } = createFixture()
    const cause = new Error('missing runner')
    mocks.register.mockRejectedValueOnce(cause)

    try {
      await local.mcp.add()
      throw new Error('expected local.mcp.add to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalError)
      expect(error).toMatchObject({
        details: 'missing runner',
        name: 'Incur.LocalError',
        shortMessage: 'Failed to register local MCP server.',
      })
      expect((error as Error).cause).toBe(cause)
    }
  })

  test('LocalError exposes a stable name', () => {
    expect(new LocalError('Nope')).toMatchObject({
      message: 'Nope',
      name: 'Incur.LocalError',
    })
  })
})
