import { describe, expect, test, vi } from 'vitest'

import * as Cli from '../Cli.js'
import type {
  Request as RpcRequest,
  Response as RpcResponse,
  StreamResponse as RpcStreamResponse,
} from './Rpc.js'
import { ClientError } from './ClientError.js'
import { createClient, createHttpClient, createMemoryClient } from './createClient.js'
import * as HttpTransport from './transports/HttpTransport.js'

function mockTransport(): HttpTransport.HttpTransport {
  return (ctx) => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover: vi.fn(),
    request: vi.fn(
      async (_request: RpcRequest): Promise<RpcResponse | RpcStreamResponse> => ({
        ok: true,
        data: { uid: ctx.uid },
        meta: { command: 'status', duration: '1ms' },
      }),
    ),
  })
}

describe('createClient', () => {
  test('resolves transport, assigns uid, preserves defaults, and binds actions', async () => {
    const client = createClient({
      outputFormat: 'toon',
      transport: mockTransport(),
    })

    expect(client).toMatchObject({
      defaults: { outputFormat: 'toon' },
      transport: { key: 'mock', name: 'Mock', type: 'http' },
      type: 'client',
    })
    expect(client.uid).toEqual(expect.any(String))
    await expect(client.run('status' as never)).resolves.toMatchObject({
      ok: true,
      data: { uid: client.uid },
    })
  })

  test('createHttpClient is a thin wrapper over HttpTransport.create', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, data: 1, meta: { command: 'status', duration: '1ms' } }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof globalThis.fetch

    const client = createHttpClient({ baseUrl: 'https://example.com/api', fetch })
    expect(client.transport.baseUrl.href).toBe('https://example.com/api')
    await client.run('status' as never)
    expect(fetch).toHaveBeenCalledWith(
      new URL('https://example.com/api/_incur/rpc'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  test('createMemoryClient uses memory transport and exposes local actions', () => {
    const cli = Cli.create('app')
    const client = createMemoryClient(cli)

    expect(client.transport.type).toBe('memory')
    expect(typeof client.skills.add).toBe('function')
    expect(typeof client.skills.list).toBe('function')
    expect(typeof client.mcp.add).toBe('function')
  })

  test('http client has no runtime local action methods', () => {
    const client = createClient({
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
      expect(() => createHttpClient({ baseUrl: 'https://example.com' })).toThrow(ClientError)
    } finally {
      Object.defineProperty(globalThis, 'fetch', { configurable: true, value: original })
    }
  })
})
