import { describe, expect, test, vi } from 'vitest'
import { parse as yamlParse } from 'yaml'
import { z } from 'zod'

import * as Cli from '../../Cli.js'
import { ClientError } from '../ClientError.js'
import type * as Resources from '../Resources.js'
import * as HttpTransport from './HttpTransport.js'

function resolve(fetch: typeof globalThis.fetch) {
  return HttpTransport.create({ baseUrl: 'https://example.com/api/', fetch })()
}

function connect(cli: Cli.Cli<any, any, any>, options: Partial<HttpTransport.Options> = {}) {
  const requests: { input: RequestInfo | URL; init: RequestInit | undefined }[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init })
    return cli.fetch(new Request(input, init))
  }
  return {
    requests,
    transport: HttpTransport.create({
      baseUrl: 'https://example.com/',
      ...options,
      fetch,
    })(),
  }
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

describe('HttpTransport', () => {
  test('requests commands through the CLI HTTP route', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { ok: true }
      },
    })
    const { requests, transport } = connect(cli, { headers: { 'x-custom': 'yes' } })

    await expect(transport.request({ command: 'status' })).resolves.toMatchObject({
      ok: true,
      data: { ok: true },
    })

    const request = requests[0]!
    expect(String(request.input)).toBe('https://example.com/_incur/rpc')
    expect(request.init?.method).toBe('POST')
    const headers = new Headers(request.init?.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json, application/x-ndjson')
    expect(headers.get('x-custom')).toBe('yes')
    expect(JSON.parse(String(request.init?.body))).toEqual({
      command: 'status',
      args: {},
      options: {},
    })
  })

  test('sends args and options to the CLI HTTP route', async () => {
    const cli = Cli.create('app').command('sum', {
      args: z.object({ left: z.number(), right: z.number() }),
      options: z.object({ label: z.string() }),
      run(c) {
        return { label: c.options.label, total: c.args.left + c.args.right }
      },
    })
    const { transport } = connect(cli)

    await expect(
      transport.request({
        command: 'sum',
        args: { left: 2, right: 3 },
        options: { label: 'result' },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { label: 'result', total: 5 },
    })
  })

  test('preserves rendered output metadata from JSON envelopes', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { items: [{ id: 'a' }, { id: 'b' }] }
      },
    })
    const { transport } = connect(cli)

    await expect(
      transport.request({
        command: 'status',
        outputFormat: 'json',
        outputTokenCount: true,
        outputTokenLimit: 1,
        outputTokenOffset: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        format: 'json',
        nextOffset: expect.any(Number),
        tokenCount: expect.any(Number),
        tokenLimit: 1,
        tokenOffset: 1,
        truncated: true,
      },
    })
  })

  test('preserves HTTP status on failed RPC envelopes', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { ok: true }
      },
    })
    const { transport } = connect(cli)

    await expect(transport.request({ command: 'missing' })).resolves.toMatchObject({
      ok: false,
      status: 404,
      error: { code: 'COMMAND_NOT_FOUND' },
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

  test('wraps discovery route errors with response metadata', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { ok: true }
      },
    })
    const { transport } = connect(cli)

    await expect(transport.discover({ resource: 'skill', name: 'missing' })).rejects.toMatchObject({
      code: 'SKILL_NOT_FOUND',
      data: {
        error: { code: 'SKILL_NOT_FOUND', message: "Unknown skill 'missing'." },
        ok: false,
      },
      error: { code: 'SKILL_NOT_FOUND', message: "Unknown skill 'missing'." },
      message: expect.stringContaining("Unknown skill 'missing'."),
      status: 404,
    })
  })

  test('preserves structured discovery error details', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              fieldErrors: [
                {
                  code: 'invalid_type',
                  expected: 'string',
                  message: 'Expected string',
                  path: 'command',
                  received: 'number',
                },
              ],
              message: 'Invalid discovery request.',
              retryable: false,
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    ) as typeof globalThis.fetch
    const transport = resolve(fetch)

    await expect(transport.discover({ resource: 'help' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      error: { code: 'VALIDATION_ERROR', message: 'Invalid discovery request.' },
      fieldErrors: [expect.objectContaining({ path: 'command' })],
      retryable: false,
      status: 400,
    })
  })

  test('streams records from the CLI HTTP route', async () => {
    const cli = Cli.create('app').command('stream', {
      async *run() {
        yield { step: 1 }
        yield { step: 2 }
      },
    })
    const { transport } = connect(cli)

    const response = await transport.request({ command: 'stream' })
    if (!('stream' in response)) throw new Error('expected stream')
    const records: unknown[] = []
    for await (const record of response.records()) records.push(record)
    expect(records).toEqual([
      { type: 'chunk', data: { step: 1 } },
      { type: 'chunk', data: { step: 2 } },
      {
        type: 'done',
        ok: true,
        data: undefined,
        meta: expect.objectContaining({ command: 'stream' }),
      },
    ])
  })

  test('parses split NDJSON records and rejects truncated streams', async () => {
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

  test('discovers every resource through the CLI HTTP route', async () => {
    const cli = Cli.create('app', { description: 'App', version: '1.2.3' }).command('status', {
      description: 'Show status',
      args: z.object({ id: z.string() }),
      options: z.object({ verbose: z.boolean().default(false) }),
      run(c) {
        return { id: c.args.id, verbose: c.options.verbose, version: c.version }
      },
    })
    const { requests, transport } = connect(cli)

    const cases: {
      request: Resources.Request
      url: string
      assert(response: Awaited<ReturnType<typeof transport.discover>>): void
    }[] = [
      {
        request: { resource: 'llms' },
        url: 'https://example.com/_incur/llms',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('| `app status <id>` | Show status |'),
          })
        },
      },
      {
        request: { resource: 'llms', command: 'status' },
        url: 'https://example.com/_incur/llms?command=status',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('| `app status <id>` | Show status |'),
          })
        },
      },
      {
        request: { resource: 'llms', format: 'yaml' },
        url: 'https://example.com/_incur/llms?format=yaml',
        assert(response) {
          if (!('body' in response)) throw new Error('expected body')
          expect(response.contentType).toBe('text/plain')
          expect(yamlParse(response.body)).toMatchObject({
            version: 'incur.v1',
            commands: [{ name: 'status', description: 'Show status' }],
          })
        },
      },
      {
        request: { resource: 'llmsFull' },
        url: 'https://example.com/_incur/llms-full',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('## Arguments'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('`id`') })
        },
      },
      {
        request: { resource: 'llmsFull', command: 'status', format: 'json' },
        url: 'https://example.com/_incur/llms-full?command=status&format=json',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              version: 'incur.v1',
              commands: [
                {
                  name: 'status',
                  description: 'Show status',
                  schema: {
                    args: { properties: { id: { type: 'string' } }, required: ['id'] },
                    options: {
                      properties: { verbose: { default: false, type: 'boolean' } },
                      required: ['verbose'],
                    },
                  },
                },
              ],
            },
          })
        },
      },
      {
        request: { resource: 'llmsFull', command: 'status', format: 'jsonl' },
        url: 'https://example.com/_incur/llms-full?command=status&format=jsonl',
        assert(response) {
          if (!('body' in response)) throw new Error('expected body')
          expect(response.contentType).toBe('text/plain')
          expect(JSON.parse(response.body)).toMatchObject({
            version: 'incur.v1',
            commands: [
              {
                name: 'status',
                description: 'Show status',
                schema: {
                  args: { properties: { id: { type: 'string' } }, required: ['id'] },
                  options: {
                    properties: { verbose: { default: false, type: 'boolean' } },
                    required: ['verbose'],
                  },
                },
              },
            ],
          })
        },
      },
      {
        request: { resource: 'schema' },
        url: 'https://example.com/_incur/schema',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              version: 'incur.v1',
              commands: [
                {
                  name: 'status',
                  schema: {
                    args: { properties: { id: { type: 'string' } } },
                    options: { properties: { verbose: { default: false, type: 'boolean' } } },
                  },
                },
              ],
            },
          })
        },
      },
      {
        request: { resource: 'schema', command: 'status' },
        url: 'https://example.com/_incur/schema?command=status',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              args: { properties: { id: { type: 'string' } }, required: ['id'] },
              options: {
                properties: { verbose: { default: false, type: 'boolean' } },
                required: ['verbose'],
              },
            },
          })
        },
      },
      {
        request: { resource: 'help' },
        url: 'https://example.com/_incur/help',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/plain',
            body: expect.stringContaining('Commands:'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('status') })
        },
      },
      {
        request: { resource: 'help', command: 'status' },
        url: 'https://example.com/_incur/help?command=status',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/plain',
            body: expect.stringContaining('Usage: status <id> [options]'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('--verbose') })
        },
      },
      {
        request: { resource: 'openapi' },
        url: 'https://example.com/openapi.json',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              openapi: '3.2.0',
              info: { title: 'app', version: '1.2.3' },
              paths: { '/status/{id}': { get: expect.any(Object) } },
            },
          })
        },
      },
      {
        request: { resource: 'openapi', format: 'yaml' },
        url: 'https://example.com/openapi.yaml',
        assert(response) {
          if (!('body' in response)) throw new Error('expected body')
          expect(response.contentType).toBe('application/yaml')
          expect(yamlParse(response.body)).toMatchObject({
            openapi: '3.2.0',
            info: { title: 'app', version: '1.2.3' },
            paths: { '/status/{id}': { get: expect.any(Object) } },
          })
        },
      },
      {
        request: { resource: 'skillsIndex' },
        url: 'https://example.com/_incur/skills',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              skills: [
                {
                  name: 'status',
                  description: 'Show status. Run `app status --help` for usage details.',
                  files: ['SKILL.md'],
                },
              ],
            },
          })
        },
      },
      {
        request: { resource: 'skill', name: 'status' },
        url: 'https://example.com/_incur/skill?name=status',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('# app status'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('## Arguments') })
          expect(response).toMatchObject({ body: expect.stringContaining('## Options') })
        },
      },
      {
        request: { resource: 'mcpTools' },
        url: 'https://example.com/_incur/mcp/tools',
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              tools: [
                {
                  name: 'status',
                  description: 'Show status',
                  inputSchema: {
                    properties: {
                      id: expect.any(Object),
                      verbose: expect.any(Object),
                    },
                  },
                },
              ],
            },
          })
        },
      },
    ]

    for (const item of cases) {
      const response = await transport.discover(item.request)
      item.assert(response)
    }

    expect(requests.map((request) => String(request.input))).toEqual(cases.map((item) => item.url))
  })
})
