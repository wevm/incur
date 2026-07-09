import { Cli, z } from 'incur'
import { MemoryClient, Run } from 'incur/client'
import { expectTypeOf, test } from 'vitest'

type Commands = {
  report: {
    args: { id: string }
    options: { verbose?: boolean | undefined }
    output: { title: string }
  }
  logs: {
    args: { service: string }
    options: {}
    output: { line: string }
    stream: true
  }
}

test('memory client infers command maps from concrete CLIs', async () => {
  const cli = Cli.create('app')
    .command('status', {
      args: z.object({ id: z.string() }),
      options: z.object({ verbose: z.boolean().optional() }),
      run(c) {
        expectTypeOf(c.args).toEqualTypeOf<{ id: string }>()
        expectTypeOf(c.options).toEqualTypeOf<{ verbose?: boolean | undefined }>()
        return { ok: true as const }
      },
    })
    .command('logs', {
      args: z.object({ service: z.string() }),
      async *run() {
        yield { line: 'ready' }
      },
    })

  const client = MemoryClient.create(cli, { outputFormat: 'json' })
  type InferredCommands =
    typeof client extends MemoryClient.MemoryClient<infer commands, any> ? commands : never

  expectTypeOf(client).toExtend<
    MemoryClient.MemoryClient<{
      logs: { args: { service: string }; options: {}; output: { line: string }; stream: true }
      status: {
        args: { id: string }
        options: { verbose?: boolean | undefined }
        output: { ok: true }
      }
    }>
  >()
  expectTypeOf(client.defaults).toExtend<{ outputFormat?: 'json' | undefined }>()
  expectTypeOf(client.transport.type).toEqualTypeOf<'memory'>()
  expectTypeOf(client.skills.add).toBeFunction()
  expectTypeOf(client.skills.list).toBeFunction()
  expectTypeOf(client.mcp.add).toBeFunction()

  expectTypeOf(await client.run('status', { args: { id: 'p1' } })).toEqualTypeOf<
    Run.Result<unknown, InferredCommands>
  >()
  expectTypeOf(await client.run('logs', { args: { service: 'api' } })).toEqualTypeOf<
    Run.Result<unknown, InferredCommands>
  >()
  // @ts-expect-error inferred args are required.
  await client.run('status')
  // @ts-expect-error unknown options are rejected.
  await client.run('status', { args: { id: 'p1' }, options: { extra: true } })
})

test('memory client supports explicit command maps and keeps env out of defaults', async () => {
  const client = MemoryClient.create<Commands, { outputTokenLimit: number }>(Cli.create('app'), {
    env: { TOKEN: 'secret' },
    outputTokenLimit: 32,
  })

  expectTypeOf(client).toExtend<MemoryClient.MemoryClient<Commands, { outputTokenLimit: number }>>()
  expectTypeOf(client.defaults).toEqualTypeOf<{ outputTokenLimit: number }>()
  // @ts-expect-error transport env is not a client default.
  void client.defaults.env
  expectTypeOf(await client.run('report', { args: { id: 'p1' } })).toEqualTypeOf<
    Run.Result<{ title: string }, Commands>
  >()
  expectTypeOf(await client.run('logs', { args: { service: 'api' } })).toEqualTypeOf<
    Run.StreamResponse<{ line: string }, unknown, Commands>
  >()
})
