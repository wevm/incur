import { Cli, z } from 'incur'
import { Client, HttpClient, HttpTransport, MemoryClient, MemoryTransport } from 'incur/client'
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

type RegisteredCommands = {
  registered: { args: {}; options: {}; output: { ok: true } }
}

declare module 'incur/client' {
  interface Register {
    commands: RegisteredCommands
  }
}

test('module registration defaults namespace creators', async () => {
  const client = HttpClient.create({ baseUrl: 'https://example.com' })
  const result = await client.run('registered')
  expectTypeOf(result).toEqualTypeOf<Client.ClientRunResult<{ ok: true }, RegisteredCommands>>()
  // @ts-expect-error unregistered commands are rejected without an explicit command map.
  await client.run('status')
})

test('client creation preserves transport type and defaults', () => {
  const http = HttpClient.create<Commands>({
    baseUrl: 'https://example.com',
    outputFormat: 'toon',
  })
  expectTypeOf(http).toMatchTypeOf<HttpClient.HttpClient<Commands>>()
  expectTypeOf(http.transport.type).toEqualTypeOf<'http'>()

  const primitive = Client.create<Commands>({
    transport: HttpTransport.create({ baseUrl: 'https://example.com' }),
  })
  expectTypeOf(primitive).toMatchTypeOf<Client.Client<Commands>>()
})

test('memory clients infer commands and allow explicit override', () => {
  const cli = Cli.create('app').command('status', {
    args: z.object({ id: z.string() }),
    run: () => ({ ok: true }),
  })
  const inferred = MemoryClient.create(cli)
  expectTypeOf(inferred).toMatchTypeOf<
    MemoryClient.MemoryClient<{ status: { args: { id: string }; options: {} } }>
  >()

  const explicit = MemoryClient.create<Commands>(cli)
  expectTypeOf(explicit).toMatchTypeOf<MemoryClient.MemoryClient<Commands>>()
})

test('local actions are memory-only and unavailable on HTTP or broad transports', () => {
  const http = HttpClient.create<Commands>({ baseUrl: 'https://example.com' })
  // @ts-expect-error HTTP clients do not expose local skills.add.
  http.skills.add()
  // @ts-expect-error HTTP clients do not expose local mcp.add.
  http.mcp.add()

  const cli = Cli.create('app')
  const memory = MemoryClient.create<Commands>(cli)
  expectTypeOf(memory.skills.add).toBeFunction()
  expectTypeOf(memory.skills.list).toBeFunction()
  expectTypeOf(memory.mcp.add).toBeFunction()

  const broad = Client.create<
    Commands,
    HttpTransport.HttpTransport | MemoryTransport.MemoryTransport
  >({
    transport: MemoryTransport.create(cli),
  })
  // @ts-expect-error broad Transport clients do not expose local actions.
  broad.skills.add()
})

test('run input and return types follow command map', async () => {
  const client = HttpClient.create<Commands>({ baseUrl: 'https://example.com' })
  await client.run('status')
  // @ts-expect-error required args make input required.
  await client.run('project report')
  await client.run('project report', { args: { projectId: 'p1' } })
  // @ts-expect-error required options make input required.
  await client.run('project deploy', { args: { projectId: 'p1' } })

  const report = await client.run('project report', { args: { projectId: 'p1' } })
  expectTypeOf(report).toEqualTypeOf<Client.ClientRunResult<{ summary: string }, Commands>>()
  const selected = await client.run('project report', {
    args: { projectId: 'p1' },
    selection: ['summary'],
  })
  expectTypeOf(selected.data).toEqualTypeOf<unknown>()

  const stream = await client.run('logs tail', { args: { service: 'api' } })
  expectTypeOf(stream).toEqualTypeOf<
    Client.ClientStreamResponse<{ line: string }, unknown, Commands>
  >()
  // @ts-expect-error streaming commands reject token pagination controls.
  await client.run('logs tail', { args: { service: 'api' }, outputTokenLimit: 1 })
})

test('selection defaults and clearing affect data inference', async () => {
  const selectedClient = Client.create<
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

test('resources overloads and permissive command maps', async () => {
  const client = HttpClient.create<Commands>({ baseUrl: 'https://example.com' })
  expectTypeOf(await client.llms()).toMatchTypeOf<{ commands: unknown[] }>()
  expectTypeOf(await client.llms({ format: undefined })).toMatchTypeOf<{ commands: unknown[] }>()
  expectTypeOf(await client.llms({ format: 'json' })).toMatchTypeOf<{ commands: unknown[] }>()
  expectTypeOf(await client.llms({ format: 'md' })).toEqualTypeOf<string>()
  expectTypeOf(await client.llmsFull()).toMatchTypeOf<{ commands: unknown[] }>()
  expectTypeOf(await client.llmsFull({ format: undefined })).toMatchTypeOf<{
    commands: unknown[]
  }>()
  const format = undefined as 'md' | undefined
  expectTypeOf(await client.llms({ format })).toMatchTypeOf<string | { commands: unknown[] }>()
  await client.llmsFull({ command: 'project' })
  // @ts-expect-error unknown resources scope.
  await client.llmsFull({ command: 'unknown' })
  await client.schema('project')
  await client.help('project report')

  type UnknownCommands = Record<string, { args: unknown; options: unknown; output: unknown }>
  const loose = HttpClient.create<UnknownCommands>({ baseUrl: 'https://example.com' })
  await loose.run('runtime-only command', { args: { any: 'value' }, options: ['accepted'] })
})

test('old flat factory functions are not exported', () => {
  // @ts-expect-error use Client.create.
  expectTypeOf(Client.createClient).toBeNever()
  // @ts-expect-error use HttpClient.create.
  expectTypeOf(HttpClient.createHttpClient).toBeNever()
  // @ts-expect-error use MemoryClient.create.
  expectTypeOf(MemoryClient.createMemoryClient).toBeNever()
})
