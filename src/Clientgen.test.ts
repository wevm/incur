import { Cli, Clientgen, z } from 'incur'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

describe('fromCli', () => {
  test('generates nested clients with exact quoted segment keys', () => {
    const cli = Cli.create('my-cli')
    const project = Cli.create('project').command('deploy-create', {
      args: z.object({ 'project-id': z.string() }),
      options: z.object({ dryRun: z.boolean().optional() }),
      output: z.object({ deployId: z.string(), status: z.enum(['queued', 'done']) }),
      run: () => ({ deployId: 'd1', status: 'queued' as const }),
    })
    cli.command(project)

    expect(Clientgen.fromCli(cli)).toMatchInlineSnapshot(`
      "import { Client } from 'incur'

      export type MyCliClient = { "project": { "deploy-create": (args: { "project-id": string }, options?: { "dryRun"?: boolean | undefined } | undefined, request?: Client.RequestOptions | undefined) => Promise<{ "deployId": string; "status": "queued" | "done" }> } }

      export type MyCliResultClient = { "project": { "deploy-create": (args: { "project-id": string }, options?: { "dryRun"?: boolean | undefined } | undefined, request?: Client.RequestOptions | undefined) => Promise<Client.Result<{ "deployId": string; "status": "queued" | "done" }>> } }

      export function createMyCliClient(options: Client.create.Options): MyCliClient {
        const context = Client.create(options)
        const client = Client.object<MyCliClient>()
        const client_0 = Client.object<MyCliClient["project"]>()
        Client.define(client_0, "deploy-create", ((args, options, request) => Client.call(context, ["project","deploy-create"], { args, options }, request)) as MyCliClient["project"]["deploy-create"])
        Client.define(client, "project", client_0)
        return client
      }

      export function createMyCliResultClient(options: Client.create.Options): MyCliResultClient {
        const context = Client.create(options)
        const client = Client.object<MyCliResultClient>()
        const client_0 = Client.object<MyCliResultClient["project"]>()
        Client.define(client_0, "deploy-create", ((args, options, request) => Client.result(context, ["project","deploy-create"], { args, options }, request)) as MyCliResultClient["project"]["deploy-create"])
        Client.define(client, "project", client_0)
        return client
      }
      "
    `)
  })

  test('preserves command aliases as exact sibling keys', () => {
    const cli = Cli.create('test').command('login', {
      aliases: ['sign-in'],
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    })

    const output = Clientgen.fromCli(cli)
    expect(output).toContain('Client.define(client, "login"')
    expect(output).toContain('Client.define(client, "sign-in"')
    expect(output).not.toContain('$call')
  })

  test('generates signatures for args, options, args plus options, and no inputs', () => {
    const cli = Cli.create('test')
      .command('args', {
        args: z.object({ id: z.string() }),
        run: () => ({}),
      })
      .command('options', {
        options: z.object({ limit: z.number() }),
        run: () => ({}),
      })
      .command('both', {
        args: z.object({ id: z.string() }),
        options: z.object({ limit: z.number() }),
        run: () => ({}),
      })
      .command('none', { run: () => ({}) })

    const output = Clientgen.fromCli(cli)
    expect(output).toContain(
      '"args": (args: { "id": string }, request?: Client.RequestOptions | undefined) => Promise<unknown>',
    )
    expect(output).toContain(
      '"options": (options: { "limit": number }, request?: Client.RequestOptions | undefined) => Promise<unknown>',
    )
    expect(output).toContain(
      '"both": (args: { "id": string }, options: { "limit": number }, request?: Client.RequestOptions | undefined) => Promise<unknown>',
    )
    expect(output).toContain(
      '"none": (request?: Client.RequestOptions | undefined) => Promise<unknown>',
    )
  })

  test('uses define calls so hazardous names stay exact properties', () => {
    const cli = Cli.create('test')
      .command('__proto__', { run: () => 'proto' })
      .command('constructor', { run: () => 'constructor' })
      .command('then', { run: () => 'then' })

    const output = Clientgen.fromCli(cli)
    expect(output).toContain('Client.object<TestClient>()')
    expect(output).toContain('Client.define(client, "__proto__"')
    expect(output).toContain('Client.define(client, "constructor"')
    expect(output).toContain('Client.define(client, "then"')
  })

  test('generates separate root clients without making the main client callable', () => {
    const cli = Cli.create('test', {
      options: z.object({ verbose: z.boolean().optional() }),
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    }) as Cli.Cli
    cli.command('status', {
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    })

    const output = Clientgen.fromCli(cli)
    expect(output).toContain('export type TestRootClient =')
    expect(output).toContain('export function createTestRootClient')
    expect(output).toContain('Client.call(context, [], { options }, request)')
    expect(output).toContain('export type TestClient = { "status":')
  })

  test('generated clients typecheck under strict TypeScript', async () => {
    const cli = Cli.create('my-cli')
    cli.command('__proto__', {
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    })
    cli.command('users', {
      options: z.object({ limit: z.number().optional() }),
      output: z.object({ users: z.array(z.string()) }),
      run: () => ({ users: [] }),
    })

    const dir = await fs.mkdtemp(path.join(tmpdir(), 'incur-clientgen-'))
    try {
      const file = path.join(dir, 'incur.client.ts')
      await fs.writeFile(file, Clientgen.fromCli(cli))

      const program = ts.createProgram([file], {
        baseUrl: process.cwd(),
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        paths: { incur: ['src/index.ts'] },
        skipLibCheck: true,
        strict: true,
        target: ts.ScriptTarget.ESNext,
        types: ['node'],
      })
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))

      expect(diagnostics).toEqual([])
    } finally {
      await fs.rm(dir, { force: true, recursive: true })
    }
  })
})
