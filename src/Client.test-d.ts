import { Cli, ClientError, createClient, isClientRpcError, isClientRpcErrorEnvelope } from 'incur'
import type { ClientRpcError, ClientRpcErrorEnvelope } from 'incur'
import { expectTypeOf, test } from 'vitest'

type GeneratedCommands = {
  ping: {
    args: {}
    options: {}
    output: { ok: boolean }
  }
  'project deploy': {
    args: { id: string }
    options: { dryRun: boolean }
    output: { deployId: string; status: 'queued' | 'done' }
  }
  'project inspect': {
    args: { id: string; includeLogs?: boolean | undefined }
    options: {}
    output: { id: string; logs?: string[] | undefined }
  }
  'project list': {
    args: {}
    options: { cursor?: string | undefined; limit?: number | undefined }
    output: { items: string[]; nextCursor?: string | undefined }
  }
  'auth login': {
    args: {}
    options: { token: string }
    output: void
  }
  'config set': {
    args: { key: string; value: number | string }
    options: { force: boolean; scope?: 'project' | 'user' | undefined }
    output: { saved: true }
  }
  raw: {
    args: unknown
    options: unknown
    output: unknown
  }
}

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
  const ping = client('ping')

  expectTypeOf<Awaited<ReturnType<typeof ping>>>().toEqualTypeOf<{ ok: boolean }>()
  ping()
  ping({})
  ping({ args: {}, options: {} })
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
  const login = client('auth login')

  type Input = {
    args?: {} | undefined
    options: { token: string }
  }
  expectTypeOf<Parameters<typeof login>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof login>[0]>()

  login({ options: { token: 'secret' } })
  login({ args: {}, options: { token: 'secret' } })

  // @ts-expect-error options are required
  login()

  // @ts-expect-error required option key is missing
  login({ options: {} })
})

test('createClient preserves mixed required and optional fields', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const set = client('config set')

  type Input = {
    args: { key: string; value: number | string }
    options: { force: boolean; scope?: 'project' | 'user' | undefined }
  }
  expectTypeOf<Parameters<typeof set>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof set>[0]>()

  set({ args: { key: 'theme', value: 'dark' }, options: { force: false } })
  set({ args: { key: 'retries', value: 3 }, options: { force: true, scope: 'user' } })

  // @ts-expect-error optional option still narrows to known values
  set({ args: { key: 'theme', value: 'dark' }, options: { force: true, scope: 'org' } })
})

test('createClient keeps unknown args, options, and output unknown', () => {
  const client = createClient<GeneratedCommands>({ baseUrl: 'https://api.example.com' })
  const raw = client('raw')

  type Input = { args?: unknown; options?: unknown } | undefined
  expectTypeOf<Parameters<typeof raw>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof raw>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof raw>>>().toEqualTypeOf<unknown>()

  raw()
  raw({ args: 'anything', options: 123 })
})

test('createClient defaults to a permissive unknown command map without registration', () => {
  const client = createClient({ baseUrl: 'https://api.example.com' })
  const call = client('anything')

  type Input = { args?: unknown; options?: unknown } | undefined
  expectTypeOf<Parameters<typeof call>[0]>().toExtend<Input>()
  expectTypeOf<Input>().toExtend<Parameters<typeof call>[0]>()
  expectTypeOf<Awaited<ReturnType<typeof call>>>().toEqualTypeOf<unknown>()

  call()
  call({ args: { any: 'value' }, options: ['also accepted'] })
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
