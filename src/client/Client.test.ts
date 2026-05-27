import { describe, expect, test, vi } from 'vitest'

import * as Cli from '../Cli.js'
import * as Client from './Client.js'
import * as HttpClient from './HttpClient.js'
import * as MemoryClient from './MemoryClient.js'
import type {
  Request as RpcRequest,
  Response as RpcResponse,
  StreamResponse as RpcStreamResponse,
} from './Rpc.js'
import * as HttpTransport from './transports/HttpTransport.js'

function mockTransport(): HttpTransport.HttpTransport {
  return () => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover: vi.fn(),
    request: vi.fn(
      async (_request: RpcRequest): Promise<RpcResponse | RpcStreamResponse> => ({
        ok: true,
        data: { ok: true },
        meta: { command: 'status', duration: '1ms' },
      }),
    ),
  })
}

describe('Client.create', () => {
  test('resolves transport, assigns uid, preserves defaults, and binds actions', async () => {
    const client = Client.create({
      outputFormat: 'toon',
      transport: mockTransport(),
    })

    expect(client).toMatchObject({
      defaults: { outputFormat: 'toon' },
      transport: { key: 'mock', name: 'Mock', type: 'http' },
      type: 'client',
    })
    await expect(client.run('status' as never)).resolves.toMatchObject({
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
