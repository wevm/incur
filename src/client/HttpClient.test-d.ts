import { HttpClient, Run } from 'incur/client'
import { expectTypeOf, test } from 'vitest'

type Commands = {
  status: { args: {}; options: {}; output: { ok: boolean } }
  report: {
    args: { id: string }
    options: { verbose?: boolean | undefined }
    output: { title: string }
  }
  deploy: {
    args: { id: string }
    options: { environment: 'production' | 'staging' }
    output: { deployId: string }
  }
  logs: {
    args: { service: string }
    options: {}
    output: { line: string }
    stream: true
  }
}

test('http client preserves transport, defaults, and command types', async () => {
  const fetch = (() => Promise.resolve(new Response('{}'))) as typeof globalThis.fetch
  const client = HttpClient.create<Commands, { selection: string[]; outputFormat: 'toon' }>({
    baseUrl: 'https://example.com',
    fetch,
    headers: { authorization: 'Bearer token' },
    outputFormat: 'toon',
    selection: ['title'],
  })

  expectTypeOf(client).toExtend<
    HttpClient.HttpClient<Commands, { selection: string[]; outputFormat: 'toon' }>
  >()
  expectTypeOf(client.defaults).toEqualTypeOf<{ selection: string[]; outputFormat: 'toon' }>()
  expectTypeOf(client.transport.type).toEqualTypeOf<'http'>()
  expectTypeOf(client.transport.baseUrl).toEqualTypeOf<URL>()
  // @ts-expect-error HTTP clients do not expose memory-local methods.
  client.skills.add()
  // @ts-expect-error transport options are not client defaults.
  void client.defaults.baseUrl
  // @ts-expect-error transport options are not client defaults.
  void client.defaults.headers

  expectTypeOf(await client.run('report', { args: { id: 'p1' } })).toEqualTypeOf<
    Run.Result<unknown, Commands>
  >()
  expectTypeOf(
    await client.run('report', {
      args: { id: 'p1' },
      selection: undefined,
    }),
  ).toEqualTypeOf<Run.Result<{ title: string }, Commands>>()
  expectTypeOf(await client.run('logs', { args: { service: 'api' } })).toEqualTypeOf<
    Run.StreamResponse<unknown, unknown, Commands>
  >()
  expectTypeOf(
    await client.run('logs', { args: { service: 'api' }, selection: undefined }),
  ).toEqualTypeOf<Run.StreamResponse<{ line: string }, unknown, Commands>>()
  // @ts-expect-error required options make input required.
  await client.run('deploy', { args: { id: 'p1' } })
  // @ts-expect-error unknown commands are rejected.
  await client.run('missing')
})

test('http client can use registered commands without explicit generics', async () => {
  const client = HttpClient.create({ baseUrl: 'https://example.com' })
  const result = await client.run('registered')

  expectTypeOf(result).toEqualTypeOf<Run.Result<{ ok: true }, RegisteredCommands>>()
})

type RegisteredCommands = {
  registered: { args: {}; options: {}; output: { ok: true } }
}

declare module 'incur/client' {
  interface Register {
    commands: RegisteredCommands
  }
}
