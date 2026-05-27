import { Cli } from 'incur'
import {
  ClientError,
  HttpTransport,
  MemoryTransport,
  createClient,
  createHttpClient,
  createMemoryClient,
} from 'incur/client'
import { expectTypeOf, test } from 'vitest'

type Commands = {
  'project report': {
    args: { projectId: string }
    options: { includeClosed?: boolean | undefined }
    output: {
      summary: string
      items: { id: string; title: string }[]
      nextCursor?: string | undefined
    }
  }
  'project status': {
    args: { projectId: string }
    options: {}
    output: { status: 'open' | 'blocked' | 'done' }
  }
  'project unblock': {
    args: { taskId: string }
    options: {}
    output: { ok: boolean }
  }
  'project deploy': {
    args: { projectId: string; environment: 'production' | 'staging' }
    options: {}
    output: { deployId: string }
  }
  'auth login': {
    args: {}
    options: {}
    output: { authenticated: boolean }
  }
  'logs tail': {
    args: { service: string }
    options: {}
    output: { timestamp: string; level: string; message: string }
    stream: true
  }
}

test('docs api example client surface typechecks conceptually', async () => {
  const fetcher = (() => Promise.resolve(new Response('{}'))) as typeof fetch
  const client = createHttpClient<Commands>({
    baseUrl: 'https://ops.acme.test',
    fetch: fetcher,
    outputFormat: 'toon',
  })

  createClient<Commands>({
    transport: HttpTransport.create({ baseUrl: 'https://ops.acme.test' }),
    outputFormat: 'toon',
  })

  const cli = Cli.create({ name: 'acme' })
  const memoryClient = createMemoryClient<Commands>(cli, {
    env: { ACME_TOKEN: 'dev_secret_123' },
  })
  createClient<Commands>({
    transport: MemoryTransport.create(cli, { env: { ACME_TOKEN: 'dev_secret_123' } }),
  })

  const report = await client.run('project report', {
    args: { projectId: 'proj_web_2026' },
    options: { includeClosed: false },
    selection: ['summary', 'items[0:3]', 'nextCursor'],
    outputFormat: 'md',
    outputTokenCount: true,
    outputTokenLimit: 24,
  })
  expectTypeOf(report.data).toEqualTypeOf<unknown>()
  await report.output?.next?.()

  const status = await client.run('project status', { args: { projectId: 'proj_web_2026' } })
  expectTypeOf(status.data.status).toEqualTypeOf<'open' | 'blocked' | 'done'>()

  const cta = report.meta.cta?.commands[0]
  if (cta) {
    expectTypeOf(cta.command).toEqualTypeOf<string>()
    await cta.run({ outputFormat: 'toon' })
  }

  try {
    await client.run('project deploy', {
      args: { projectId: 'proj_web_2026', environment: 'production' },
    })
  } catch (error) {
    if (error instanceof ClientError) {
      expectTypeOf(error.error?.code).toEqualTypeOf<string | undefined>()
    }
  }

  const stream = await client.run('logs tail', { args: { service: 'checkout-api' } })
  for await (const chunk of stream) expectTypeOf(chunk.message).toEqualTypeOf<string>()
  expectTypeOf((await stream.final).meta.command).toEqualTypeOf<string>()
  for await (const record of stream.records())
    if (record.type === 'chunk') expectTypeOf(record.data.message).toEqualTypeOf<string>()

  const llmsFull = await client.llmsFull({ command: 'project' })
  expectTypeOf(llmsFull.commands[0]?.name).toMatchTypeOf<keyof Commands | undefined>()
  const llmsMd = await client.llms({ command: 'project', format: 'md' })
  expectTypeOf(llmsMd).toEqualTypeOf<string>()
  const schema = await client.schema('project report')
  expectTypeOf(schema.args).toMatchTypeOf<Record<string, unknown> | undefined>()
  expectTypeOf(await client.help('project report')).toEqualTypeOf<string>()
  expectTypeOf((await client.openapi()).info).toMatchTypeOf<Record<string, unknown> | undefined>()
  expectTypeOf((await client.skills.index()).skills[0]?.name).toEqualTypeOf<string | undefined>()
  expectTypeOf(await client.skills.get('deploy')).toEqualTypeOf<string>()
  expectTypeOf((await client.mcp.tools()).tools[0]).toMatchTypeOf<
    Record<string, unknown> | undefined
  >()

  await memoryClient.skills.list()
  await memoryClient.skills.add({ depth: 1, global: true })
  await memoryClient.mcp.add({ agents: ['codex'] })
  // @ts-expect-error local actions are memory-only.
  client.skills.add()
})
