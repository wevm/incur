import { describe, expect, test } from 'vitest'
import { parse as yamlParse } from 'yaml'
import { z } from 'zod'

import * as Cli from '../../Cli.js'
import type * as Resources from '../../client/Resources.js'
import * as RuntimeContext from '../runtime-context.js'
import { createResourcesHandler, ResourcesError } from './resources.js'

function createFixture() {
  const project = Cli.create('project', { description: 'Project commands' })
    .command('list', {
      description: 'List projects',
      args: z.object({ org: z.string() }),
      options: z.object({ limit: z.number().default(10) }),
      output: z.object({ projects: z.array(z.object({ id: z.string() })) }),
      run() {
        return { projects: [{ id: 'p1' }] }
      },
    })
    .command('empty', {
      description: 'Empty schema command',
      run() {
        return { ok: true }
      },
    })

  const cli = Cli.create('app', {
    description: 'App CLI',
    version: '1.2.3',
    args: z.object({ workspace: z.string().optional() }),
    options: z.object({ verbose: z.boolean().default(false) }),
    output: z.object({ ok: z.boolean() }),
    run() {
      return { ok: true }
    },
  })
    .command('status', {
      description: 'Show status',
      aliases: ['st'],
      args: z.object({ id: z.string() }),
      options: z.object({ verbose: z.boolean().default(false) }),
      output: z.object({ id: z.string(), verbose: z.boolean() }),
      examples: [
        {
          args: { id: '123' },
          description: 'Verbose status',
          options: { verbose: true },
        },
      ],
      hint: 'Use status wisely',
      env: z.object({ TOKEN: z.string().optional() }),
      run(c) {
        return { id: c.args.id, verbose: c.options.verbose }
      },
    })
    .command(project)
    .command('api', {
      description: 'Proxy API',
      fetch: () => new Response('{}'),
    })

  return createResourcesHandler(RuntimeContext.fromCli(cli))
}

async function body(response: Resources.Response) {
  if (!('body' in response)) throw new Error('expected body response')
  return response.body
}

async function data(response: Resources.Response) {
  if (!('data' in response)) throw new Error('expected data response')
  return response.data
}

describe('createResourcesHandler', () => {
  test('rejects invalid requests, unknown scopes, fetch scopes, and unsafe skill names', async () => {
    const { discover } = createFixture()
    const cases: {
      request: unknown
      code: string
      status: number
    }[] = [
      { request: {}, code: 'VALIDATION_ERROR', status: 400 },
      { request: { resource: 'help', command: 1 }, code: 'VALIDATION_ERROR', status: 400 },
      { request: { resource: 'help', command: 'missing' }, code: 'COMMAND_NOT_FOUND', status: 404 },
      { request: { resource: 'schema', command: 'api' }, code: 'FETCH_GATEWAY', status: 400 },
      {
        request: { resource: 'skill', name: '../status' },
        code: 'INVALID_SKILL_NAME',
        status: 400,
      },
      { request: { resource: 'skill', name: 'missing' }, code: 'SKILL_NOT_FOUND', status: 404 },
    ]

    for (const item of cases)
      await expect(discover(item.request)).rejects.toMatchObject({
        code: item.code,
        name: 'Incur.ResourcesError',
        status: item.status,
      })
  })

  test('returns llms resources across root, group, leaf, and non-markdown formats', async () => {
    const { discover } = createFixture()

    await expect(discover({ resource: 'llms' })).resolves.toMatchObject({
      contentType: 'text/markdown',
      body: expect.stringContaining('| `app status <id>` | Show status |'),
    })
    await expect(discover({ resource: 'llms', command: 'project' })).resolves.toMatchObject({
      contentType: 'text/markdown',
      body: expect.stringContaining('| `app project project list <org>` | List projects |'),
    })
    await expect(discover({ resource: 'llms', command: 'status' })).resolves.toMatchObject({
      contentType: 'text/markdown',
      body: expect.stringContaining('| `app status <id>` | Show status |'),
    })

    await expect(discover({ resource: 'llms', format: 'json' })).resolves.toMatchObject({
      contentType: 'application/json',
      data: {
        version: 'incur.v1',
        commands: expect.arrayContaining([
          expect.objectContaining({ name: 'api', description: 'Proxy API' }),
          expect.objectContaining({ name: 'project list', description: 'List projects' }),
          expect.objectContaining({
            name: 'project empty',
            description: 'Empty schema command',
          }),
          expect.objectContaining({ name: 'status', description: 'Show status' }),
        ]),
      },
    })

    const yaml = yamlParse(await body(await discover({ resource: 'llms', format: 'yaml' })))
    expect(yaml).toMatchObject({
      version: 'incur.v1',
      commands: expect.arrayContaining([
        expect.objectContaining({ name: 'api' }),
        expect.objectContaining({ name: 'project list' }),
        expect.objectContaining({ name: 'project empty' }),
        expect.objectContaining({ name: 'status' }),
      ]),
    })

    const jsonl = JSON.parse(await body(await discover({ resource: 'llms', format: 'jsonl' })))
    expect(jsonl).toMatchObject({
      version: 'incur.v1',
      commands: expect.arrayContaining([
        expect.objectContaining({ name: 'api' }),
        expect.objectContaining({ name: 'project list' }),
        expect.objectContaining({ name: 'project empty' }),
        expect.objectContaining({ name: 'status' }),
      ]),
    })
  })

  test('returns full manifests with schemas, examples, output, and fetch gateway guidance', async () => {
    const { discover } = createFixture()
    const full = await discover({ resource: 'llmsFull', format: 'json' })
    const manifest = await data(full)
    const commands = (manifest as { commands: any[] }).commands

    expect(full).toMatchObject({
      contentType: 'application/json',
      data: { version: 'incur.v1' },
    })
    expect(commands.map((command) => command.name)).toEqual([
      'api',
      'project empty',
      'project list',
      'status',
    ])
    expect(commands.find((command) => command.name === 'api')).toMatchObject({
      description: 'Proxy API',
    })
    expect(commands.find((command) => command.name === 'project list')).toMatchObject({
      schema: {
        args: { properties: { org: { type: 'string' } }, required: ['org'] },
        output: { properties: { projects: { type: 'array' } }, required: ['projects'] },
      },
    })
    expect(commands.find((command) => command.name === 'project empty')).toMatchObject({
      description: 'Empty schema command',
    })
    expect(commands.find((command) => command.name === 'status')).toMatchObject({
      examples: [{ command: 'status 123 --verbose true', description: 'Verbose status' }],
      schema: {
        args: { properties: { id: { type: 'string' } }, required: ['id'] },
        env: { properties: { TOKEN: { type: 'string' } } },
        options: {
          properties: { verbose: { default: false, type: 'boolean' } },
          required: ['verbose'],
        },
        output: {
          properties: { id: { type: 'string' }, verbose: { type: 'boolean' } },
          required: ['id', 'verbose'],
        },
      },
    })

    const markdown = await body(await discover({ resource: 'llmsFull' }))
    expect(markdown).toContain('Verbose status')
    expect(markdown).toContain('## Output')
    expect(markdown).toContain('Fetch gateway. Pass path segments')
    expect(markdown).not.toMatch(/^# app st$/m)
  })

  test('returns schemas for root, group, leaf, and schemaless commands', async () => {
    const { discover } = createFixture()
    const rootSchema = await data(await discover({ resource: 'schema' }))

    expect((rootSchema as { commands: any[] }).commands.map((command) => command.name)).toEqual([
      'api',
      'project empty',
      'project list',
      'status',
    ])
    await expect(discover({ resource: 'schema', command: 'project' })).resolves.toMatchObject({
      contentType: 'application/json',
      data: { commands: [{ name: 'project empty' }, { name: 'project list' }] },
    })
    await expect(discover({ resource: 'schema', command: 'status' })).resolves.toMatchObject({
      contentType: 'application/json',
      data: {
        args: { properties: { id: { type: 'string' } }, required: ['id'] },
        output: {
          properties: { id: { type: 'string' }, verbose: { type: 'boolean' } },
          required: ['id', 'verbose'],
        },
      },
    })
    await expect(discover({ resource: 'schema', command: 'project empty' })).resolves.toEqual({
      contentType: 'application/json',
      data: {},
    })
  })

  test('returns help for root, group, and leaf command scopes', async () => {
    const { discover } = createFixture()

    expect(await body(await discover({ resource: 'help' }))).toContain('Commands:')
    expect(await body(await discover({ resource: 'help', command: 'project' }))).toContain('list')
    const help = await body(await discover({ resource: 'help', command: 'status' }))
    expect(help).toContain('Usage: status <id> [options]')
    expect(help).toContain('--verbose')
    expect(help).toContain('TOKEN')
  })

  test('returns OpenAPI JSON and YAML with CLI metadata', async () => {
    const { discover } = createFixture()

    await expect(discover({ resource: 'openapi' })).resolves.toMatchObject({
      contentType: 'application/json',
      data: {
        openapi: '3.2.0',
        info: { title: 'app', version: '1.2.3' },
        paths: {
          '/': { post: expect.any(Object) },
          '/status/{id}': { get: expect.any(Object) },
          '/project/list/{org}': { get: expect.any(Object) },
        },
      },
    })

    const yaml = yamlParse(await body(await discover({ resource: 'openapi', format: 'yaml' })))
    expect(yaml).toMatchObject({
      openapi: '3.2.0',
      info: { title: 'app', version: '1.2.3' },
      paths: { '/status/{id}': { get: expect.any(Object) } },
    })
  })

  test('returns skills index, individual skill markdown, and MCP tools', async () => {
    const { discover } = createFixture()

    await expect(discover({ resource: 'skillsIndex' })).resolves.toMatchObject({
      contentType: 'application/json',
      data: {
        skills: expect.arrayContaining([
          {
            description: 'App CLI. Run `app --help` for usage details.',
            files: ['SKILL.md'],
            name: 'app',
          },
          {
            description: 'Show status. Run `app status --help` for usage details.',
            files: ['SKILL.md'],
            name: 'status',
          },
        ]),
      },
    })

    const rootSkill = await body(await discover({ resource: 'skill', name: 'app' }))
    expect(rootSkill).toContain('# app')
    expect(rootSkill).toContain('## Arguments')
    expect(rootSkill).toContain('## Output')

    const statusSkill = await body(await discover({ resource: 'skill', name: 'status' }))
    expect(statusSkill).toContain('# app status')
    expect(statusSkill).toContain('## Arguments')
    expect(statusSkill).toContain('## Options')

    const tools = (await data(await discover({ resource: 'mcpTools' }))) as { tools: any[] }
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'api',
      'project_empty',
      'project_list',
      'status',
    ])
    expect(tools.tools.find((tool) => tool.name === 'status')).toMatchObject({
      description: 'Show status',
      inputSchema: {
        properties: {
          id: { type: 'string' },
          verbose: { default: false, type: 'boolean' },
        },
      },
      outputSchema: {
        properties: {
          id: { type: 'string' },
          verbose: { type: 'boolean' },
        },
      },
    })
  })

  test('ResourcesError exposes stable metadata', () => {
    const error = new ResourcesError('NOPE', 'Nope.', 418)
    expect(error).toMatchObject({
      code: 'NOPE',
      message: 'Nope.',
      name: 'Incur.ResourcesError',
      status: 418,
    })
  })
})
