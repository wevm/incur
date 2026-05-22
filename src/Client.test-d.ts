import { Cli, ClientError, createClient, isClientRpcError, isClientRpcErrorEnvelope } from 'incur'
import type { ClientRpcError, ClientRpcErrorEnvelope } from 'incur'
import { expectTypeOf, test } from 'vitest'

// BEGIN generated client round-trip fixture
/** Command map generated from your incur CLI. */
export type Commands = {
  /** Generated command "admin users get". */
  'admin users get': {
    args: { id: number }
    options: { verbose?: boolean | undefined }
    output: { id: number }
  }
  /** Generated command "api getUser". */
  'api getUser': {
    args: { id: number }
    options: {}
    output: { id: number; name: string; [key: string]: unknown }
  }
  /** Generated command "auth". */
  auth: { args: {}; options: { token: string }; output: void }
  /** Generated command "logs". */
  logs: {
    args: {}
    options: {}
    output: { line: string }
    stream: true
  }
  /** Generated command "project deploy". */
  'project deploy': {
    args: { id: string }
    options: { dryRun: boolean }
    output: { deployId: string; status: 'queued' | 'done' }
  }
  /** Generated command "project inspect". */
  'project inspect': {
    args: { id: string; includeLogs?: boolean | undefined }
    options: {}
    output: { id: string; logs?: string[] | undefined }
  }
  /** Generated command "project list". */
  'project list': {
    args: {}
    options: { cursor?: string | undefined; limit?: number | undefined }
    output: { items: string[]; nextCursor?: string | undefined }
  }
  /** Generated command "status". */
  status: { args: {}; options: {}; output: { ok: boolean } }
}

declare module 'incur' {
  interface Register {
    commands: Commands
  }
}
// END generated client round-trip fixture

type GeneratedCommands = Commands

test('createClient selects args, options, and output by command string', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const deploy = client('project deploy')

  expectTypeOf<Parameters<typeof deploy>[0]>().toExtend<{
    args: { id: string }
    options: { dryRun: boolean }
  }>()
  expectTypeOf<{
    args: { id: string }
    options: { dryRun: boolean }
  }>().toExtend<Parameters<typeof deploy>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof deploy>>>().toEqualTypeOf<{
    deployId: string
    status: 'queued' | 'done'
  }>()

  deploy({ args: { id: 'p1' }, options: { dryRun: true } })

  // @ts-expect-error missing required args
  deploy({ options: { dryRun: true } })

  // @ts-expect-error missing required options
  deploy({ args: { id: 'p1' } })

  // @ts-expect-error arg property has the wrong type
  deploy({ args: { id: 1 }, options: { dryRun: true } })

  // @ts-expect-error unknown option property
  deploy({ args: { id: 'p1' }, options: { dryRun: true, verbose: true } })

  // @ts-expect-error unknown command
  client('project destroy')
})

test('createClient allows omitted input when args and options are empty', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const status = client('status')

  expectTypeOf<Awaited<ReturnType<typeof status>>>().toEqualTypeOf<{ ok: boolean }>()
  status()
  status({})
  status({ args: {}, options: {} })
})

test('createClient requires input when args are required and options are empty', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const inspect = client('project inspect')

  type Input = {
    args: { id: string; includeLogs?: boolean | undefined }
    options?: {} | undefined
  }
  expectTypeOf<Parameters<typeof inspect>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof inspect>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof inspect>>>().toEqualTypeOf<{
    id: string
    logs?: string[] | undefined
  }>()

  inspect({ args: { id: 'p1' } })
  inspect({ args: { id: 'p1', includeLogs: true }, options: {} })

  // @ts-expect-error input is required when args has a required key
  inspect()

  // @ts-expect-error required arg key is missing
  inspect({ args: {} })
})

test('createClient allows optional input when args and options have no required keys', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const list = client('project list')

  type Input =
    | {
        args?: {} | undefined
        options?: { cursor?: string | undefined; limit?: number | undefined } | undefined
      }
    | undefined
  expectTypeOf<Parameters<typeof list>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof list>[0]>()

  list()
  list({})
  list({ options: { limit: 10 } })
  list({ args: {}, options: { cursor: 'next' } })

  // @ts-expect-error optional option has the wrong type
  list({ options: { limit: '10' } })
})

test('createClient requires input when only options are required', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const auth = client('auth')

  type Input = {
    args?: {} | undefined
    options: { token: string }
  }
  expectTypeOf<Parameters<typeof auth>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof auth>[0]>()

  auth({ options: { token: 'secret' } })
  auth({ args: {}, options: { token: 'secret' } })

  // @ts-expect-error options are required
  auth()

  // @ts-expect-error required option key is missing
  auth({ options: {} })
})

test('createClient preserves mounted sub-CLI groups', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const get = client('admin users get')

  type Input = {
    args: { id: number }
    options?: { verbose?: boolean | undefined } | undefined
  }
  expectTypeOf<Parameters<typeof get>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof get>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof get>>>().toEqualTypeOf<{ id: number }>()

  get({ args: { id: 1 } })
  get({ args: { id: 1 }, options: { verbose: true } })

  // @ts-expect-error mounted sub-CLI args keep their generated types
  get({ args: { id: '1' } })
})

test('createClient keeps unknown args, options, and output unknown', () => {
  type RuntimeCommands = Record<string, { args: unknown; options: unknown; output: unknown }>
  const client = createClient<RuntimeCommands>({ baseUrl: 'https://api.example.com' })
  const raw = client('raw')

  type Input = { args?: unknown; options?: unknown } | undefined
  expectTypeOf<Parameters<typeof raw>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof raw>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof raw>>>().toEqualTypeOf<unknown>()

  raw()
  raw({ args: 'anything', options: 123 })
})

test('createClient can be made permissive with an explicit unknown command map', () => {
  type RuntimeCommands = Record<string, { args: unknown; options: unknown; output: unknown }>
  const client = createClient<RuntimeCommands>({ baseUrl: 'https://api.example.com' })
  const call = client('anything')

  type Input = { args?: unknown; options?: unknown } | undefined
  expectTypeOf<Parameters<typeof call>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof call>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof call>>>().toEqualTypeOf<unknown>()

  call()
  call({ args: { any: 'value' }, options: ['also accepted'] })
})

test('createClient returns async iterables for streaming commands', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const logs = client('logs')

  expectTypeOf<Awaited<ReturnType<typeof logs>>>().toEqualTypeOf<AsyncIterable<{ line: string }>>()

  async function read() {
    const stream = await logs()
    for await (const chunk of stream) expectTypeOf(chunk).toEqualTypeOf<{ line: string }>()
  }
  void read
})

test('ClientError can be imported and RPC payloads can be narrowed', () => {
  const error = new ClientError('Invalid input', {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid input',
      retryable: false,
      fieldErrors: [
        {
          path: 'id',
          expected: 'string',
          received: 'number',
          message: 'Expected string, received number',
        },
      ],
    } satisfies ClientRpcError,
    status: 400,
  })
  const caught: unknown = error

  if (caught instanceof ClientError) {
    expectTypeOf(caught.data).toEqualTypeOf<unknown>()
    expectTypeOf(caught.error).toEqualTypeOf<unknown>()
    expectTypeOf(caught.status).toEqualTypeOf<number | undefined>()

    if (isClientRpcError(caught.error)) {
      expectTypeOf(caught.error).toEqualTypeOf<ClientRpcError>()
      expectTypeOf(caught.error.code).toEqualTypeOf<string>()
      expectTypeOf(caught.error.retryable).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(caught.error.fieldErrors?.[0]?.path).toEqualTypeOf<string | undefined>()
    }

    if (isClientRpcErrorEnvelope(caught.data)) {
      expectTypeOf(caught.data).toEqualTypeOf<ClientRpcErrorEnvelope>()
      expectTypeOf(caught.data.error.code).toEqualTypeOf<string>()
      expectTypeOf(caught.data.meta?.command).toEqualTypeOf<string | undefined>()
    }
  }
})

test('generated command map preserves exact optional properties', () => {
  expectTypeOf<GeneratedCommands['project list']['options']>().toEqualTypeOf<{
    cursor?: string | undefined
    limit?: number | undefined
  }>()
  expectTypeOf<GeneratedCommands['project list']['output']>().toEqualTypeOf<{
    items: string[]
    nextCursor?: string | undefined
  }>()
})

test('generated command map works with required input and output inference', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const deploy = client('project deploy')

  type Input = {
    args: { id: string }
    options: { dryRun: boolean }
  }
  expectTypeOf<Parameters<typeof deploy>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof deploy>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof deploy>>>().toEqualTypeOf<{
    deployId: string
    status: 'queued' | 'done'
  }>()
})

test('generated command map allows optional input with explicit undefined values', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const list = client('project list')

  list({ options: { cursor: undefined, limit: undefined } })
})

test('generated command map includes mounted root CLIs and omits aliases', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const status = client('status')

  expectTypeOf<Awaited<ReturnType<typeof status>>>().toEqualTypeOf<{ ok: boolean }>()
  status()

  // @ts-expect-error aliases are intentionally absent from generated command maps
  client('ship')
})

test('createClient consumes OpenAPI mounted command maps inferred from Cli instances', () => {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'number' },
          },
        ],
        get: {
          operationId: 'getUser',
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'number' }, name: { type: 'string' } },
                    required: ['id', 'name'],
                  },
                },
              },
            },
          },
        },
      },
    },
  } as const
  const cli = Cli.create('test').command('api', {
    fetch: () => new Response(),
    openapi: spec,
  })
  type Commands = typeof cli extends Cli.Cli<infer commands> ? commands : never
  const client = createClient<Commands>({ baseUrl: 'https://api.example.com' })
  const getUser = client('api getUser')

  expectTypeOf<Parameters<typeof getUser>[0]>().toExtend<{
    args: { id: number }
    options?: {} | undefined
  }>()
  expectTypeOf<Awaited<ReturnType<typeof getUser>>>().toExtend<{
    id: number
    name: string
  }>()

  getUser({ args: { id: 1 } })

  // @ts-expect-error OpenAPI path args are required
  getUser()

  // @ts-expect-error raw fetch gateway is not generated as a command
  client('api')
})
