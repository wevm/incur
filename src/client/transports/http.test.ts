import { describe, expect, test, vi } from 'vitest'

import { ClientError } from '../errors.js'
import { httpTransport } from './http.js'

function resolve(fetch: typeof globalThis.fetch) {
  return httpTransport({ baseUrl: 'https://example.com/api/', fetch })()
}

function ndjson(lines: string[], options: { cancel?: () => void } = {}) {
  const encoder = new TextEncoder()
  const source: UnderlyingDefaultSource<Uint8Array> = {
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  }
  if (options.cancel) source.cancel = options.cancel
  return new Response(new ReadableStream(source), {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  })
}

describe('httpTransport', () => {
  test('normalizes base URL, serializes omitted args/options, and merges headers', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://example.com/api/_incur/rpc')
      expect(init?.method).toBe('POST')
      const headers = new Headers(init?.headers)
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('accept')).toBe('application/json, application/x-ndjson')
      expect(headers.get('x-custom')).toBe('yes')
      expect(JSON.parse(String(init?.body))).toEqual({ command: 'status', args: {}, options: {} })
      return new Response(
        JSON.stringify({ ok: true, data: 1, meta: { command: 'status', duration: '1ms' } }),
        {
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof globalThis.fetch
    const transport = httpTransport({
      baseUrl: 'https://example.com/api',
      fetch,
      headers: { 'x-custom': 'yes' },
    })()
    await expect(transport.request({ command: 'status' })).resolves.toMatchObject({
      ok: true,
      data: 1,
    })
  })

  test('wraps fetch rejection and rejects malformed JSON envelopes', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof globalThis.fetch
    await expect(resolve(failing).request({ command: 'status' })).rejects.toThrow(ClientError)

    const invalidJson = vi.fn(
      async () => new Response('nope', { headers: { 'content-type': 'application/json' } }),
    ) as typeof globalThis.fetch
    await expect(resolve(invalidJson).request({ command: 'status' })).rejects.toThrow(
      'Invalid RPC JSON',
    )

    const malformed = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { 'content-type': 'application/json' },
        }),
    ) as typeof globalThis.fetch
    await expect(resolve(malformed).request({ command: 'status' })).rejects.toThrow(
      'Malformed RPC envelope',
    )
  })

  test('parses NDJSON split records, blanks, final line without newline, and truncated streams', async () => {
    const fetch = vi.fn(async () =>
      ndjson([
        '{"type":"chunk","data":{"a":',
        '1}}\n\n',
        '{"type":"done","ok":true,"data":null,"meta":{"command":"status","duration":"1ms"}}',
      ]),
    ) as typeof globalThis.fetch
    const response = await resolve(fetch).request({ command: 'status' })
    if (!('stream' in response)) throw new Error('expected stream')
    const records: unknown[] = []
    for await (const record of response.records()) records.push(record)
    expect(records).toEqual([
      { type: 'chunk', data: { a: 1 } },
      { type: 'done', ok: true, data: null, meta: { command: 'status', duration: '1ms' } },
    ])

    const truncated = vi.fn(async () =>
      ndjson(['{"type":"chunk","data":1}\n']),
    ) as typeof globalThis.fetch
    const truncatedResponse = await resolve(truncated).request({ command: 'status' })
    if (!('stream' in truncatedResponse)) throw new Error('expected stream')
    await expect(async () => {
      for await (const _ of truncatedResponse.records()) {
      }
    }).rejects.toThrow('terminal record')
  })

  test('cancels the HTTP reader when the consumer stops early', async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () =>
      ndjson(
        [
          '{"type":"chunk","data":1}\n',
          '{"type":"done","ok":true,"data":null,"meta":{"command":"status","duration":"1ms"}}\n',
        ],
        { cancel },
      ),
    ) as typeof globalThis.fetch
    const response = await resolve(fetch).request({ command: 'status' })
    if (!('stream' in response)) throw new Error('expected stream')
    const iterator = response.records()
    await iterator.next()
    await iterator.return(undefined as any)
    expect(cancel).toHaveBeenCalled()
  })

  test('routes discovery requests', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://example.com/api/_incur/help?command=status')
      return new Response('help', { headers: { 'content-type': 'text/plain' } })
    }) as typeof globalThis.fetch
    await expect(resolve(fetch).discover({ resource: 'help', command: 'status' })).resolves.toEqual(
      {
        contentType: 'text/plain',
        body: 'help',
      },
    )
  })

  test('routes OpenAPI discovery to the public OpenAPI route', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://example.com/api/openapi.json')
      return new Response(JSON.stringify({ openapi: '3.2.0' }), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch
    await expect(resolve(fetch).discover({ resource: 'openapi' })).resolves.toMatchObject({
      contentType: 'application/json',
      data: { openapi: '3.2.0' },
    })
  })
})
