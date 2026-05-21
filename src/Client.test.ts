import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as Client from './Client.js'

const meta = { command: 'test', duration: '1ms' }

describe('call', () => {
  test('sends exact path, args, options, and request options to transport', async () => {
    const transport = vi.fn<Client.Transport>().mockResolvedValue({ ok: true, data: 123, meta })
    const context = Client.create({ transport })
    const request = { headers: { authorization: 'Bearer token' } }

    await expect(
      Client.call(
        context,
        ['Exact Name', 'sub-command'],
        {
          args: { id: 1 },
          options: { verbose: true },
        },
        request,
      ),
    ).resolves.toBe(123)

    expect(transport).toHaveBeenCalledWith(
      {
        path: ['Exact Name', 'sub-command'],
        args: { id: 1 },
        options: { verbose: true },
      },
      request,
    )
  })

  test('throws ClientError in data mode for failed envelopes', async () => {
    const error = { message: 'Denied', code: 'DENIED', data: { retry: false } }
    const context = Client.create({
      transport: Client.local(() => ({ ok: false, error, meta })),
    })

    await expect(Client.call(context, ['secret'])).rejects.toMatchObject({
      name: 'ClientError',
      message: 'Denied',
      code: 'DENIED',
      data: { retry: false },
      error,
    })
  })

  test('rejects malformed transport envelopes', async () => {
    const context = Client.create({
      transport: Client.local(() => ({ ok: true, data: 'pong' }) as any),
    })

    await expect(Client.call(context, ['ping'])).rejects.toThrow('Malformed RPC envelope')
  })
})

describe('result', () => {
  test('returns failed envelopes without throwing', async () => {
    const error = { message: 'Nope', code: 'NOPE' }
    const context = Client.create({
      transport: Client.local(() => ({ ok: false, error, meta })),
    })

    await expect(Client.result(context, ['fail'])).resolves.toEqual({ ok: false, error, meta })
  })
})

describe('object', () => {
  test('defines hazardous names as own properties on null-prototype objects', () => {
    const client = Client.object<Record<string, unknown>>()
    const method = () => 'ok'

    Client.define(client, '__proto__', method)
    Client.define(client, 'constructor', method)
    Client.define(client, 'then', method)

    expect(Object.getPrototypeOf(client)).toBe(null)
    expect(client.__proto__).toBe(method)
    expect(client.constructor).toBe(method)
    expect(client.then).toBe(method)
    expect(Object.keys(client)).toEqual(['__proto__', 'constructor', 'then'])
  })
})

describe('http', () => {
  test('integrates with Cli.fetch over /_incur/rpc', async () => {
    const cli = Cli.create('test').command('sum', {
      args: z.object({ left: z.number(), right: z.number() }),
      options: z.object({ double: z.boolean().default(false) }),
      run(c) {
        const value = c.args.left + c.args.right
        return { value: c.options.double ? value * 2 : value }
      },
    })
    const context = Client.create({
      transport: Client.http('http://localhost', {
        fetch: (input, init) => cli.fetch(new Request(input, init)),
      }),
    })

    await expect(
      Client.call(context, ['sum'], {
        args: { left: 2, right: 3 },
        options: { double: true },
      }),
    ).resolves.toEqual({ value: 10 })
  })

  test('POSTs to /_incur/rpc with JSON body and request options', async () => {
    const signal = AbortSignal.abort()
    const fetch = vi.fn<Client.http.Fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: { created: true }, meta }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    const transport = Client.http('https://example.com/api/', {
      fetch,
      headers: { authorization: 'Bearer default', 'x-default': '1' },
    })

    await expect(
      transport(
        { path: ['users', 'create'], args: { name: 'Ada' }, options: {} },
        { headers: { authorization: 'Bearer call' }, signal },
      ),
    ).resolves.toEqual({ ok: true, data: { created: true }, meta })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toBe('https://example.com/_incur/rpc')
    expect(init?.method).toBe('POST')
    expect(init?.signal).toBe(signal)
    expect(JSON.parse(init?.body as string)).toEqual({
      path: ['users', 'create'],
      args: { name: 'Ada' },
      options: {},
    })

    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer call')
    expect(headers.get('x-default')).toBe('1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
  })

  test('throws ClientError for non-JSON responses', async () => {
    await expect(
      Client.http('https://example.com', {
        fetch: async () => new Response('plain text', { status: 200 }),
      })({ path: ['ping'], args: {}, options: {} }),
    ).rejects.toMatchObject({
      name: 'ClientError',
      message: 'Expected a JSON RPC envelope',
      status: 200,
      data: 'plain text',
    })
  })

  test('returns HTTP error envelopes so result clients can avoid throwing', async () => {
    const envelope = {
      ok: false,
      error: { message: 'Bad request' },
      meta: { command: 'ping', duration: '1ms' },
    }

    await expect(
      Client.http('https://example.com', {
        fetch: async () => new Response(JSON.stringify(envelope), { status: 400 }),
      })({ path: ['ping'], args: {}, options: {} }),
    ).resolves.toEqual(envelope)
  })
})

describe('parseEnvelopeResponse', () => {
  test('requires ok true envelopes to contain data', async () => {
    await expect(
      Client.parseEnvelopeResponse(new Response(JSON.stringify({ ok: true, meta }))),
    ).rejects.toThrow('Malformed RPC envelope')
  })

  test('requires ok false envelopes to contain an error message', async () => {
    await expect(
      Client.parseEnvelopeResponse(new Response(JSON.stringify({ ok: false, error: {}, meta }))),
    ).rejects.toThrow('Malformed RPC envelope')
  })
})
