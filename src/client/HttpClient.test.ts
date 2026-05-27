import { describe, expect, test, vi } from 'vitest'

import * as Client from './Client.js'
import * as HttpClient from './HttpClient.js'

describe('HttpClient.create', () => {
  test('creates an HTTP client, strips transport options from defaults, and forwards run defaults', async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            ok: true,
            data: { ok: true },
            meta: { command: 'status', duration: '1ms' },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    )

    const client = HttpClient.create({
      baseUrl: 'https://example.com/api',
      fetch,
      headers: { authorization: 'Bearer token' },
      outputFormat: 'toon',
      outputTokenCount: true,
      selection: ['ok'],
    })

    expect(client).toMatchObject({
      defaults: {
        outputFormat: 'toon',
        outputTokenCount: true,
        selection: ['ok'],
      },
      transport: {
        key: 'http',
        name: 'HTTP',
        type: 'http',
      },
      type: 'client',
    })
    expect(client.defaults).not.toHaveProperty('baseUrl')
    expect(client.defaults).not.toHaveProperty('fetch')
    expect(client.defaults).not.toHaveProperty('headers')

    await expect(client.run('status' as never)).resolves.toMatchObject({
      data: { ok: true },
      ok: true,
    })
    const [input, init] = fetch.mock.calls[0]!
    expect(input).toEqual(new URL('https://example.com/api/_incur/rpc'))
    expect(init).toMatchObject({ method: 'POST' })
    expect(JSON.parse(String(init?.body))).toEqual({
      args: {},
      command: 'status',
      options: {},
      outputFormat: 'toon',
      outputTokenCount: true,
      selection: ['ok'],
    })
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token')
  })

  test('does not expose memory-only local methods', () => {
    const client = HttpClient.create({
      baseUrl: 'https://example.com',
    })

    expect('add' in client.skills).toBe(false)
    expect('list' in client.skills).toBe(false)
    expect('add' in client.mcp).toBe(false)
  })

  test('throws when neither an explicit fetch nor global fetch exists', () => {
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
