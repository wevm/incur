import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import * as Cli from '../Cli.js'
import * as MemoryClient from './MemoryClient.js'

describe('MemoryClient.create', () => {
  test('creates a memory client, strips transport options from defaults, and executes in process', async () => {
    const cli = Cli.create('app', {
      env: z.object({ TOKEN: z.string() }),
    }).command('status', {
      env: z.object({ TOKEN: z.string() }),
      run(c) {
        return { token: c.env.TOKEN }
      },
    })
    cli.fetch = async () => {
      throw new Error('fetch should not be called')
    }

    const client = MemoryClient.create(cli, {
      env: { TOKEN: 'secret' },
      outputFormat: 'json',
      outputTokenCount: true,
    })

    expect(client).toMatchObject({
      defaults: {
        outputFormat: 'json',
        outputTokenCount: true,
      },
      transport: {
        key: 'memory',
        name: 'Memory',
        type: 'memory',
      },
      type: 'client',
    })
    expect(client.defaults).not.toHaveProperty('env')
    await expect(client.run('status')).resolves.toMatchObject({
      data: { token: 'secret' },
      ok: true,
    })
  })

  test('exposes memory-only local methods alongside shared resource methods', () => {
    const client = MemoryClient.create(Cli.create('app'))

    expect(typeof client.run).toBe('function')
    expect(typeof client.llms).toBe('function')
    expect(typeof client.llmsFull).toBe('function')
    expect(typeof client.schema).toBe('function')
    expect(typeof client.help).toBe('function')
    expect(typeof client.openapi).toBe('function')
    expect(typeof client.skills.index).toBe('function')
    expect(typeof client.skills.get).toBe('function')
    expect(typeof client.skills.add).toBe('function')
    expect(typeof client.skills.list).toBe('function')
    expect(typeof client.mcp.tools).toBe('function')
    expect(typeof client.mcp.add).toBe('function')
  })

  test('works without options', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { ok: true }
      },
    })
    const client = MemoryClient.create(cli)

    expect(client.defaults).toEqual({})
    await expect(client.run('status')).resolves.toMatchObject({
      data: { ok: true },
      ok: true,
    })
  })
})
