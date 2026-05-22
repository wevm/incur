import { ClientError, createClient, isClientRpcError, isClientRpcErrorEnvelope } from 'incur'

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
      accept: 'application/json',
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
