import {
  Cli,
  ClientError,
  createClient,
  isClientRpcError,
  isClientRpcErrorEnvelope,
  z,
} from 'incur'

type RuntimeCommands = Record<string, { args: unknown; options: unknown; output: unknown }>

describe('createClient', () => {
  test('posts command calls to the RPC route and unwraps ok data', async () => {
    const calls: { init: RequestInit | undefined; url: string }[] = []
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async (input, init) => {
        calls.push({ init, url: String(input) })
        return Response.json({
          ok: true,
          data: { deployId: 'd1', status: 'queued' },
          meta: { command: 'project deploy', duration: '1ms' },
        })
      },
    })

    await expect(
      client('project deploy')({
        args: { id: 'p1' },
        options: { dryRun: true },
      }),
    ).resolves.toEqual({ deployId: 'd1', status: 'queued' })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.example.com/_incur/rpc')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({
      accept: 'application/json, application/x-ndjson',
      'content-type': 'application/json',
    })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      command: 'project deploy',
      args: { id: 'p1' },
      options: { dryRun: true },
    })
  })

  test('normalizes base URL paths and URL instances', async () => {
    const urls: string[] = []
    const fetch = async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return Response.json({ ok: true, data: null })
    }

    await createClient<RuntimeCommands>({ baseUrl: 'https://api.example.com/v1', fetch })('ping')()
    await createClient<RuntimeCommands>({ baseUrl: 'https://api.example.com/v1/', fetch })('ping')()
    await createClient<RuntimeCommands>({ baseUrl: new URL('https://api.example.com/v2'), fetch })(
      'ping',
    )()

    expect(urls).toEqual([
      'https://api.example.com/v1/_incur/rpc',
      'https://api.example.com/v1/_incur/rpc',
      'https://api.example.com/v2/_incur/rpc',
    ])
  })

  test('defaults omitted args and options to empty objects', async () => {
    const bodies: unknown[] = []
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true, data: 'pong' })
      },
    })

    await client('ping')()
    await client('ping')({ args: { id: 'p1' } })
    await client('ping')({ options: { dryRun: true } })

    expect(bodies).toEqual([
      { command: 'ping', args: {}, options: {} },
      { command: 'ping', args: { id: 'p1' }, options: {} },
      { command: 'ping', args: {}, options: { dryRun: true } },
    ])
  })

  test('throws failed RPC envelopes', async () => {
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: { code: 'NOPE', message: 'Nope' },
            meta: { command: 'project deploy', duration: '1ms' },
          },
          { status: 500 },
        ),
    })

    await expect(
      client('project deploy')({
        args: { id: 'p1' },
        options: { dryRun: true },
      }),
    ).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Nope',
      error: { code: 'NOPE', message: 'Nope' },
      status: 500,
    })
  })

  test('throws exported ClientError with narrowable RPC fields', async () => {
    const fieldErrors = [
      {
        code: 'invalid_type',
        missing: false,
        path: 'id',
        expected: 'string',
        received: 'number',
        message: 'Expected string, received number',
      },
    ]
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'Invalid input',
              retryable: false,
              fieldErrors,
            },
            meta: { command: 'project deploy', duration: '2ms' },
          },
          { status: 400 },
        ),
    })

    await expect(client('project deploy')()).rejects.toBeInstanceOf(ClientError)

    try {
      await client('project deploy')()
      throw new Error('Expected client call to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError)
      if (!(error instanceof ClientError)) throw error

      expect(error.status).toBe(400)
      expect(isClientRpcError(error.error)).toBe(true)
      if (isClientRpcError(error.error)) {
        expect(error.error.code).toBe('VALIDATION_ERROR')
        expect(error.error.retryable).toBe(false)
        expect(error.error.fieldErrors).toEqual(fieldErrors)
      }
      expect(isClientRpcErrorEnvelope(error.data)).toBe(true)
      if (isClientRpcErrorEnvelope(error.data)) {
        expect(error.data.error.code).toBe('VALIDATION_ERROR')
        expect(error.data.meta?.command).toBe('project deploy')
      }
    }
  })

  test('returns async iterable for streaming RPC responses', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(
          [
            JSON.stringify({ type: 'chunk', data: { line: 'one' } }),
            JSON.stringify({ type: 'chunk', data: { line: 'two' } }),
            JSON.stringify({ type: 'done', ok: true, meta: { command: 'logs' } }),
          ].join('\n') + '\n',
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
    })

    const stream = await client('logs')()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks).toEqual([{ line: 'one' }, { line: 'two' }])
  })

  test('calls a real CLI RPC server and unwraps non-streaming responses', async () => {
    const cli = Cli.create('test').command('sum', {
      args: z.object({ left: z.number() }),
      options: z.object({ right: z.number() }),
      run: (c) => ({ value: c.args.left + c.options.right }),
    })
    const client = createClient<{
      sum: { args: { left: number }; options: { right: number }; output: { value: number } }
    }>({
      baseUrl: 'http://localhost',
      fetch: (input, init) => cli.fetch(new Request(input, init)),
    })

    await expect(
      client('sum')({
        args: { left: 1 },
        options: { right: 2 },
      }),
    ).resolves.toEqual({ value: 3 })
  })

  test('calls a real CLI RPC server and iterates streaming responses', async () => {
    const cli = Cli.create('test').command('logs', {
      args: z.object({ prefix: z.string() }),
      options: z.object({ count: z.number() }),
      output: z.object({ line: z.string() }),
      async *run(c) {
        yield { line: `${c.args.prefix}-1` }
        yield { line: `${c.args.prefix}-${c.options.count}` }
      },
    })
    const client = createClient<{
      logs: {
        args: { prefix: string }
        options: { count: number }
        output: { line: string }
        stream: true
      }
    }>({
      baseUrl: 'http://localhost',
      fetch: (input, init) => cli.fetch(new Request(input, init)),
    })

    const stream = await client('logs')({
      args: { prefix: 'line' },
      options: { count: 2 },
    })
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks).toEqual([{ line: 'line-1' }, { line: 'line-2' }])
  })

  test('throws failed streaming RPC records', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            ok: false,
            error: { code: 'NOPE', message: 'Nope' },
          }) + '\n',
          { headers: { 'content-type': 'application/x-ndjson' }, status: 500 },
        ),
    })

    const stream = await client('logs')()
    await expect(async () => {
      for await (const chunk of stream) void chunk
    }).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Nope',
      error: { code: 'NOPE', message: 'Nope' },
      status: 500,
    })
  })

  test('throws invalid JSON streaming RPC records', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response('{bad json}\n', {
          headers: { 'content-type': 'application/x-ndjson' },
          status: 502,
        }),
    })

    const stream = await client('logs')()
    await expect(async () => {
      for await (const chunk of stream) void chunk
    }).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Expected a JSON RPC stream record',
      data: '{bad json}',
      status: 502,
    })
  })

  test('parses streaming RPC records split across chunks', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"chunk","data":{"line":"'))
        controller.enqueue(encoder.encode('one"}}\n{"type":"chunk","data":{"line":"two"}}\n'))
        controller.enqueue(encoder.encode('{"type":"done","ok":true}\n'))
        controller.close()
      },
    })
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    })

    const stream = await client('logs')()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks).toEqual([{ line: 'one' }, { line: 'two' }])
  })

  test('ignores blank lines in streaming RPC responses', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(
          [
            '',
            '  ',
            JSON.stringify({ type: 'chunk', data: { line: 'one' } }),
            '',
            JSON.stringify({ type: 'done', ok: true }),
          ].join('\n') + '\n',
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
    })

    const stream = await client('logs')()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    expect(chunks).toEqual([{ line: 'one' }])
  })

  test('throws when streaming RPC responses have no body', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(null, {
          headers: { 'content-type': 'application/x-ndjson' },
          status: 204,
        }),
    })

    const stream = await client('logs')()
    await expect(async () => {
      for await (const chunk of stream) void chunk
    }).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Expected an RPC stream body',
      status: 204,
    })
  })

  test('throws malformed streaming RPC records', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(JSON.stringify({ type: 'done', ok: false }) + '\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    })

    const stream = await client('logs')()
    await expect(async () => {
      for await (const chunk of stream) void chunk
    }).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Malformed RPC stream record',
      data: { type: 'done', ok: false },
    })
  })

  test('throws when streaming RPC responses end before done', async () => {
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(JSON.stringify({ type: 'chunk', data: { line: 'one' } }) + '\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    })

    const stream = await client('logs')()
    await expect(async () => {
      for await (const chunk of stream) void chunk
    }).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'RPC stream ended before done',
    })
  })

  test('cancels streaming RPC responses when consumers stop early', async () => {
    let cancelled = false
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ type: 'chunk', data: { line: 'one' } }) + '\n'),
        )
      },
      cancel() {
        cancelled = true
      },
    })
    const client = createClient<{
      logs: { args: {}; options: {}; output: { line: string }; stream: true }
    }>({
      baseUrl: 'https://api.example.com',
      fetch: async () =>
        new Response(body, {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    })

    const stream = await client('logs')()
    for await (const chunk of stream) {
      void chunk
      break
    }

    expect(cancelled).toBe(true)
  })

  test('uses a fallback message for failed RPC envelopes without error messages', async () => {
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async () => Response.json({ ok: false, error: 'NOPE' }, { status: 400 }),
    })

    await expect(client('project deploy')()).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'RPC command failed',
      data: { ok: false, error: 'NOPE' },
      error: 'NOPE',
      status: 400,
    })
  })

  test('wraps fetch failures', async () => {
    const cause = new Error('network down')
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async () => {
        throw cause
      },
    })

    await expect(client('ping')()).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'RPC request failed',
      cause,
    })
  })

  test('throws for non-json responses', async () => {
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async () => new Response('not json', { status: 502 }),
    })

    await expect(client('ping')()).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Expected a JSON RPC envelope',
      data: 'not json',
      status: 502,
    })
  })

  test('throws for malformed RPC envelopes', async () => {
    const client = createClient<RuntimeCommands>({
      baseUrl: 'https://api.example.com',
      fetch: async () => Response.json({ data: 'missing ok' }, { status: 200 }),
    })

    await expect(client('ping')()).rejects.toMatchObject({
      name: 'Incur.ClientError',
      message: 'Malformed RPC envelope',
      data: { data: 'missing ok' },
      status: 200,
    })
  })

  test('requires fetch to exist', () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', undefined)
    try {
      expect(() => createClient({ baseUrl: 'https://api.example.com' })).toThrow(
        'Incur clients require a fetch implementation',
      )
    } finally {
      vi.stubGlobal('fetch', original)
    }
  })
})
