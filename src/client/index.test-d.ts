import { Cli, z } from 'incur'
import {
  HttpTransport,
  MemoryTransport,
  createClient,
  createHttpClient,
  createMemoryClient,
} from 'incur/client'
import type {
  Client,
  ClientRunResult,
  ClientStreamResponse,
  HttpClient,
  MemoryClient,
} from 'incur/client'
import { expectTypeOf, test } from 'vitest'

type Commands = {
  status: { args: {}; options: {}; output: { ok: boolean } }
  'project report': {
    args: { projectId: string }
    options: { includeClosed?: boolean | undefined }
    output: { summary: string }
  }
  'project deploy': {
    args: { projectId: string }
    options: { environment: 'production' | 'staging' }
    output: { deployed: boolean }
  }
  'logs tail': {
    args: { service: string }
    options: {}
    output: { line: string }
    stream: true
  }
}

test('client creation preserves transport type and defaults', () => {
  const http = createHttpClient<Commands>({
    baseUrl: 'https://example.com',
    outputFormat: 'toon',
  })
  expectTypeOf(http).toMatchTypeOf<HttpClient<Commands>>()
  expectTypeOf(http.transport.type).toEqualTypeOf<'http'>()

  const primitive = createClient<Commands>({
    transport: HttpTransport.create({ baseUrl: 'https://example.com' }),
  })
  expectTypeOf(primitive).toMatchTypeOf<Client<Commands>>()
})

test('memory clients infer commands and allow explicit override', () => {
  const cli = Cli.create('app').command('status', {
    args: z.object({ id: z.string() }),
    run: () => ({ ok: true }),
  })
  const inferred = createMemoryClient(cli)
  expectTypeOf(inferred).toMatchTypeOf<
    MemoryClient<{ status: { args: { id: string }; options: {} } }>
  >()

  const explicit = createMemoryClient<Commands>(cli)
  expectTypeOf(explicit).toMatchTypeOf<MemoryClient<Commands>>()
})

test('local actions are memory-only and unavailable on HTTP or broad transports', () => {
  const http = createHttpClient<Commands>({ baseUrl: 'https://example.com' })
  // @ts-expect-error HTTP clients do not expose local skills.add.
  http.skills.add()
  // @ts-expect-error HTTP clients do not expose local mcp.add.
  http.mcp.add()

  const cli = Cli.create('app')
  const memory = createMemoryClient<Commands>(cli)
  expectTypeOf(memory.skills.add).toBeFunction()
  expectTypeOf(memory.skills.list).toBeFunction()
  expectTypeOf(memory.mcp.add).toBeFunction()

  const broad = createClient<
    Commands,
    HttpTransport.HttpTransport | MemoryTransport.MemoryTransport
  >({
    transport: MemoryTransport.create(cli),
  })
  // @ts-expect-error broad Transport clients do not expose local actions.
  broad.skills.add()
})

test('run input and return types follow command map', async () => {
  const client = createHttpClient<Commands>({ baseUrl: 'https://example.com' })
  await client.run('status')
  // @ts-expect-error required args make input required.
  await client.run('project report')
  await client.run('project report', { args: { projectId: 'p1' } })
  // @ts-expect-error required options make input required.
  await client.run('project deploy', { args: { projectId: 'p1' } })

  const report = await client.run('project report', { args: { projectId: 'p1' } })
  expectTypeOf(report).toEqualTypeOf<ClientRunResult<{ summary: string }, Commands>>()
  const selected = await client.run('project report', {
    args: { projectId: 'p1' },
    selection: ['summary'],
  })
  expectTypeOf(selected.data).toEqualTypeOf<unknown>()

  const stream = await client.run('logs tail', { args: { service: 'api' } })
  expectTypeOf(stream).toEqualTypeOf<ClientStreamResponse<{ line: string }, unknown, Commands>>()
  // @ts-expect-error streaming commands reject token pagination controls.
  await client.run('logs tail', { args: { service: 'api' }, outputTokenLimit: 1 })
})

test('selection defaults and clearing affect data inference', async () => {
  const selectedClient = createClient<
    Commands,
    HttpTransport.HttpTransport,
    { selection: string[] }
  >({
    selection: ['summary'],
    transport: HttpTransport.create({ baseUrl: 'https://example.com' }),
  })
  const selected = await selectedClient.run('project report', { args: { projectId: 'p1' } })
  expectTypeOf(selected.data).toEqualTypeOf<unknown>()

  const cleared = await selectedClient.run('project report', {
    args: { projectId: 'p1' },
    selection: undefined,
  })
  expectTypeOf(cleared.data).toEqualTypeOf<{ summary: string }>()

  const maybeSelection = undefined as string[] | undefined
  const conservative = await selectedClient.run('project report', {
    args: { projectId: 'p1' },
    selection: maybeSelection,
  })
  expectTypeOf(conservative.data).toEqualTypeOf<unknown>()
})

test('discovery overloads and permissive command maps', async () => {
  const client = createHttpClient<Commands>({ baseUrl: 'https://example.com' })
  expectTypeOf(await client.llms()).toMatchTypeOf<{ commands: unknown[] }>()
  expectTypeOf(await client.llms({ format: 'md' })).toEqualTypeOf<string>()
  const format = undefined as 'md' | undefined
  expectTypeOf(await client.llms({ format })).toMatchTypeOf<string | { commands: unknown[] }>()
  await client.llmsFull({ command: 'project' })
  // @ts-expect-error unknown discovery scope.
  await client.llmsFull({ command: 'unknown' })
  await client.schema('project')
  await client.help('project report')

  type UnknownCommands = Record<string, { args: unknown; options: unknown; output: unknown }>
  const loose = createHttpClient<UnknownCommands>({ baseUrl: 'https://example.com' })
  await loose.run('runtime-only command', { args: { any: 'value' }, options: ['accepted'] })
})
