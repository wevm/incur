import { Client, HttpTransport, Run } from 'incur/client'
import { expectTypeOf, test } from 'vitest'

type Commands = {
  status: { args: {}; options: {}; output: { ok: boolean } }
  optional: {
    args: { id?: string | undefined }
    options: { verbose?: boolean | undefined }
    output: { ok: true }
  }
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
  missingOutput: { args: {}; options: {} }
  logs: {
    args: { service: string }
    options: {}
    output: { line: string }
    stream: true
  }
}

test('run helper types resolve command fields and input requirements', async () => {
  expectTypeOf<Run.Args<Commands, 'report'>>().toEqualTypeOf<{ id: string }>()
  expectTypeOf<Run.Options<Commands, 'deploy'>>().toEqualTypeOf<{
    environment: 'production' | 'staging'
  }>()
  expectTypeOf<Run.Data<Commands, 'missingOutput'>>().toEqualTypeOf<unknown>()
  expectTypeOf<Run.Input<Commands, 'optional'>>().toExtend<{
    args?: { id?: string | undefined } | undefined
    options?: { verbose?: boolean | undefined } | undefined
  }>()

  const client = Client.create<Commands>({
    transport: HttpTransport.create({ baseUrl: 'https://example.com' }),
  })
  await client.run('status')
  await client.run('optional')
  await client.run('report', { args: { id: 'p1' } })
  // @ts-expect-error required args make input required.
  await client.run('report')
  // @ts-expect-error invalid literal option is rejected.
  await client.run('deploy', { args: { id: 'p1' }, options: { environment: 'dev' } })
  // @ts-expect-error extra top-level input keys are rejected.
  await client.run('report', { args: { id: 'p1' }, unknown: true })
  // @ts-expect-error extra args keys are rejected.
  await client.run('report', { args: { id: 'p1', extra: true } })
})

test('run return types follow selection and streaming controls', async () => {
  const selected = Client.create<Commands, HttpTransport.HttpTransport, { selection: string[] }>({
    selection: ['title'],
    transport: HttpTransport.create({ baseUrl: 'https://example.com' }),
  })

  expectTypeOf(await selected.run('report', { args: { id: 'p1' } })).toEqualTypeOf<
    Run.Result<unknown, Commands>
  >()
  expectTypeOf(
    await selected.run('report', { args: { id: 'p1' }, selection: undefined }),
  ).toEqualTypeOf<Run.Result<{ title: string }, Commands>>()
  expectTypeOf(
    await selected.run('logs', { args: { service: 'api' }, outputFormat: 'json' }),
  ).toEqualTypeOf<Run.StreamResponse<unknown, unknown, Commands>>()
  expectTypeOf(
    await selected.run('logs', { args: { service: 'api' }, selection: undefined }),
  ).toEqualTypeOf<Run.StreamResponse<{ line: string }, unknown, Commands>>()
  // @ts-expect-error streaming commands reject token count controls.
  await selected.run('logs', { args: { service: 'api' }, outputTokenCount: true })
  // @ts-expect-error streaming commands reject token limit controls.
  await selected.run('logs', { args: { service: 'api' }, outputTokenLimit: 10 })
  // @ts-expect-error streaming commands reject token offset controls.
  await selected.run('logs', { args: { service: 'api' }, outputTokenOffset: 10 })
})

test('run output, CTA, and stream records preserve command maps', async () => {
  type Result = Run.Result<{ title: string }, Commands>
  expectTypeOf<Result['output']>().toEqualTypeOf<
    Run.Output<{ title: string }, Commands> | undefined
  >()
  expectTypeOf<NonNullable<Run.Output<{ title: string }, Commands>['next']>>().toEqualTypeOf<
    () => Promise<Run.Result<{ title: string }, Commands>>
  >()
  expectTypeOf<Run.Cta<Commands>['run']>().toBeFunction()
  expectTypeOf<Run.StreamResponse<{ line: string }, { done: true }, Commands>>().toExtend<
    AsyncIterable<{ line: string }>
  >()
  expectTypeOf<
    Awaited<Run.StreamResponse<{ line: string }, { done: true }, Commands>['final']>
  >().toEqualTypeOf<Run.StreamFinal<{ done: true }, Commands>>()
  expectTypeOf<
    ReturnType<Run.StreamResponse<{ line: string }, { done: true }, Commands>['records']>
  >().toEqualTypeOf<AsyncIterable<Run.StreamRecord<{ line: string }, { done: true }, Commands>>>()
})
