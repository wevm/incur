import { describe, expect, test, vi } from 'vitest'

import * as Cli from '../Cli.js'
import * as Client from './Client.js'
import * as HttpClient from './HttpClient.js'
import * as MemoryClient from './MemoryClient.js'
import * as HttpTransport from './transports/HttpTransport.js'

describe('Client.create', () => {
  test('resolves the transport factory exactly once and keeps resolved capabilities', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (init?.method === 'POST' && url.pathname === '/_incur/rpc')
        return new Response(
          JSON.stringify({ ok: true, data: { ok: true }, meta: { command: 'status' } }),
          { headers: { 'content-type': 'application/json' } },
        )
      return new Response('help', { headers: { 'content-type': 'text/plain' } })
    }) as typeof globalThis.fetch
    const transport = vi.fn(
      HttpTransport.create({ baseUrl: 'https://example.com', fetch }),
    ) satisfies HttpTransport.HttpTransport

    const client = Client.create({ transport })

    expect(transport).toHaveBeenCalledTimes(1)
    await client.run('status' as never)
    await client.help()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      new URL('https://example.com/_incur/rpc'),
      expect.objectContaining({ method: 'POST' }),
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL('https://example.com/_incur/help'),
      expect.objectContaining({ method: 'GET' }),
    )
  })

  test('propagates transport factory errors', () => {
    const transport = (() => {
      throw new Error('cannot connect')
    }) as HttpTransport.HttpTransport

    expect(() => Client.create({ transport })).toThrow('cannot connect')
  })

  test('resolves memory transport, preserves defaults, and binds actions', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { ok: true }
      },
    })
    const client = MemoryClient.create(cli, {
      outputFormat: 'toon',
    })

    expect(client).toMatchObject({
      defaults: { outputFormat: 'toon' },
      transport: { key: 'memory', name: 'Memory', type: 'memory' },
      type: 'client',
    })
    await expect(client.run('status')).resolves.toMatchObject({
      ok: true,
      data: { ok: true },
    })
  })

  test('HttpClient.create is a thin wrapper over HttpTransport.create', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, data: 1, meta: { command: 'status', duration: '1ms' } }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof globalThis.fetch

    const client = HttpClient.create({ baseUrl: 'https://example.com/api', fetch })
    expect(client.transport.baseUrl.href).toBe('https://example.com/api')
    await client.run('status' as never)
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://example.com/api/_incur/rpc'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('MemoryClient.create uses memory transport and exposes local actions', () => {
    const cli = Cli.create('app')
    const client = MemoryClient.create(cli)

    expect(client.transport.type).toBe('memory')
    expect(typeof client.skills.add).toBe('function')
    expect(typeof client.skills.list).toBe('function')
    expect(typeof client.mcp.add).toBe('function')
  })

  test('http client has no runtime local action methods', () => {
    const client = Client.create({
      transport: HttpTransport.create({ baseUrl: 'https://example.com' }),
    })
    expect('add' in client.skills).toBe(false)
    expect('list' in client.skills).toBe(false)
    expect('add' in client.mcp).toBe(false)
  })

  test('memory clients merge resource and local methods in shared namespaces', async () => {
    const cli = Cli.create('app').command('status', {
      description: 'Show status',
      run() {
        return { ok: true }
      },
    })
    const client = MemoryClient.create(cli)

    await expect(client.skills.index()).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: 'status' })],
    })
    expect(typeof client.skills.add).toBe('function')
    expect(typeof client.skills.list).toBe('function')
    expect(typeof client.mcp.tools).toBe('function')
    expect(typeof client.mcp.add).toBe('function')
  })

  test('missing fetch implementation throws ClientError', () => {
    const original = globalThis.fetch
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: undefined })
    try {
      expect(() => HttpClient.create({ baseUrl: 'https://example.com' })).toThrow(
        Client.ClientError,
      )
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: original })
    }
  })
})
