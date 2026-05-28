import { describe, expect, test } from 'vitest'
import { parse as yamlParse } from 'yaml'
import { z } from 'zod'

import * as Cli from '../../Cli.js'
import { ResourcesError } from '../../internal/handlers/resources.js'
import { ClientError } from '../ClientError.js'
import type * as Resources from '../Resources.js'
import * as MemoryTransport from './MemoryTransport.js'

describe('MemoryTransport', () => {
  test('executes through shared runtime without calling cli.fetch and uses explicit env', async () => {
    const cli = Cli.create('app', {
      env: z.object({ TOKEN: z.string() }),
    }).command('status', {
      env: z.object({ TOKEN: z.string() }),
      run(c) {
        return { token: c.env.TOKEN }
      },
    })
    cli.fetch = async () => {
      throw new Error('fetch should not be called')
    }

    const transport = MemoryTransport.create(cli, { env: { TOKEN: 'secret' } })()
    await expect(transport.request({ command: 'status' })).resolves.toMatchObject({
      ok: true,
      data: { token: 'secret' },
    })
  })

  test('does not load config defaults for in-process requests', async () => {
    const cli = Cli.create('app', { config: {} }).command('status', {
      options: z.object({ name: z.string().default('runtime') }),
      run(c) {
        return c.options
      },
    })
    const transport = MemoryTransport.create(cli)()
    await expect(transport.request({ command: 'status' })).resolves.toMatchObject({
      ok: true,
      data: { name: 'runtime' },
    })
  })

  test('preserves CLI version for in-process execution', async () => {
    const cli = Cli.create('app', { version: '1.2.3' }).command('status', {
      run(c) {
        return { version: c.version }
      },
    })
    const transport = MemoryTransport.create(cli)()
    await expect(transport.request({ command: 'status' })).resolves.toMatchObject({
      ok: true,
      data: { version: '1.2.3' },
    })
  })

  test('preserves rendered output metadata for in-process execution', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { items: [{ id: 'a' }, { id: 'b' }] }
      },
    })
    const transport = MemoryTransport.create(cli)()

    await expect(
      transport.request({
        command: 'status',
        outputFormat: 'json',
        outputTokenCount: true,
        outputTokenLimit: 1,
        outputTokenOffset: 1,
      }),
    ).resolves.toMatchObject({
      ok: true,
      output: {
        format: 'json',
        nextOffset: expect.any(Number),
        tokenCount: expect.any(Number),
        tokenLimit: 1,
        tokenOffset: 1,
        truncated: true,
      },
    })
  })

  test('discovers every resource in process', async () => {
    const cli = Cli.create('app', { description: 'App', version: '1.2.3' }).command('status', {
      description: 'Show status',
      args: z.object({ id: z.string() }),
      options: z.object({ verbose: z.boolean().default(false) }),
      run(c) {
        return { id: c.args.id, verbose: c.options.verbose, version: c.version }
      },
    })
    const transport = MemoryTransport.create(cli)()
    const cases: {
      request: Resources.Request
      assert(response: Awaited<ReturnType<typeof transport.discover>>): void
    }[] = [
      {
        request: { resource: 'llms' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('| `app status <id>` | Show status |'),
          })
        },
      },
      {
        request: { resource: 'llms', command: 'status' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('| `app status <id>` | Show status |'),
          })
        },
      },
      {
        request: { resource: 'llms', format: 'yaml' },
        assert(response) {
          if (!('body' in response)) throw new Error('expected body')
          expect(response.contentType).toBe('text/plain')
          expect(yamlParse(response.body)).toMatchObject({
            version: 'incur.v1',
            commands: [{ name: 'status', description: 'Show status' }],
          })
        },
      },
      {
        request: { resource: 'llmsFull' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('## Arguments'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('`id`') })
        },
      },
      {
        request: { resource: 'llmsFull', command: 'status', format: 'json' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              version: 'incur.v1',
              commands: [
                {
                  name: 'status',
                  description: 'Show status',
                  schema: {
                    args: { properties: { id: { type: 'string' } }, required: ['id'] },
                    options: {
                      properties: { verbose: { default: false, type: 'boolean' } },
                      required: ['verbose'],
                    },
                  },
                },
              ],
            },
          })
        },
      },
      {
        request: { resource: 'llmsFull', command: 'status', format: 'jsonl' },
        assert(response) {
          if (!('body' in response)) throw new Error('expected body')
          expect(response.contentType).toBe('text/plain')
          expect(JSON.parse(response.body)).toMatchObject({
            version: 'incur.v1',
            commands: [
              {
                name: 'status',
                description: 'Show status',
                schema: {
                  args: { properties: { id: { type: 'string' } }, required: ['id'] },
                  options: {
                    properties: { verbose: { default: false, type: 'boolean' } },
                    required: ['verbose'],
                  },
                },
              },
            ],
          })
        },
      },
      {
        request: { resource: 'schema' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              version: 'incur.v1',
              commands: [
                {
                  name: 'status',
                  schema: {
                    args: { properties: { id: { type: 'string' } } },
                    options: { properties: { verbose: { default: false, type: 'boolean' } } },
                  },
                },
              ],
            },
          })
        },
      },
      {
        request: { resource: 'schema', command: 'status' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              args: { properties: { id: { type: 'string' } }, required: ['id'] },
              options: {
                properties: { verbose: { default: false, type: 'boolean' } },
                required: ['verbose'],
              },
            },
          })
        },
      },
      {
        request: { resource: 'help' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/plain',
            body: expect.stringContaining('Commands:'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('status') })
        },
      },
      {
        request: { resource: 'help', command: 'status' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/plain',
            body: expect.stringContaining('Usage: status <id> [options]'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('--verbose') })
        },
      },
      {
        request: { resource: 'openapi' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              openapi: '3.2.0',
              info: { title: 'app', version: '1.2.3' },
              paths: { '/status/{id}': { get: expect.any(Object) } },
            },
          })
        },
      },
      {
        request: { resource: 'openapi', format: 'yaml' },
        assert(response) {
          if (!('body' in response)) throw new Error('expected body')
          expect(response.contentType).toBe('application/yaml')
          expect(yamlParse(response.body)).toMatchObject({
            openapi: '3.2.0',
            info: { title: 'app', version: '1.2.3' },
            paths: { '/status/{id}': { get: expect.any(Object) } },
          })
        },
      },
      {
        request: { resource: 'skillsIndex' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              skills: [
                {
                  name: 'status',
                  description: 'Show status. Run `app status --help` for usage details.',
                  files: ['SKILL.md'],
                },
              ],
            },
          })
        },
      },
      {
        request: { resource: 'skill', name: 'status' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'text/markdown',
            body: expect.stringContaining('# app status'),
          })
          expect(response).toMatchObject({ body: expect.stringContaining('## Arguments') })
          expect(response).toMatchObject({ body: expect.stringContaining('## Options') })
        },
      },
      {
        request: { resource: 'mcpTools' },
        assert(response) {
          expect(response).toMatchObject({
            contentType: 'application/json',
            data: {
              tools: [
                {
                  name: 'status',
                  description: 'Show status',
                  inputSchema: {
                    properties: {
                      id: expect.any(Object),
                      verbose: expect.any(Object),
                    },
                  },
                },
              ],
            },
          })
        },
      },
    ]

    for (const item of cases) {
      const response = await transport.discover(item.request)
      item.assert(response)
    }
  })

  test('discovery reuses CLI manifest and skill projection behavior', async () => {
    const cli = Cli.create('app', { description: 'App' })
      .command('status', {
        description: 'Show status',
        aliases: ['st'],
        args: z.object({ id: z.string() }),
        options: z.object({ verbose: z.boolean().default(false) }),
        output: z.object({ id: z.string() }),
        examples: [
          {
            args: { id: '123' },
            options: { verbose: true },
            description: 'Verbose status',
          },
        ],
        run(c) {
          return { id: c.args.id }
        },
      })
      .command('api', {
        description: 'Proxy API',
        fetch: () => new Response('{}'),
      })

    const transport = MemoryTransport.create(cli)()

    await expect(transport.discover({ resource: 'llms', format: 'json' })).resolves.toMatchObject({
      data: {
        commands: [
          { name: 'api', description: 'Proxy API' },
          { name: 'status', description: 'Show status' },
        ],
      },
    })

    const full = await transport.discover({ resource: 'llmsFull', format: 'json' })
    expect(full).toMatchObject({
      contentType: 'application/json',
      data: {
        commands: [
          { name: 'api', description: 'Proxy API' },
          {
            name: 'status',
            description: 'Show status',
            examples: [
              {
                command: 'status 123 --verbose true',
                description: 'Verbose status',
              },
            ],
            schema: {
              output: { properties: { id: { type: 'string' } }, required: ['id'] },
            },
          },
        ],
      },
    })

    const schema = await transport.discover({ resource: 'schema', command: 'status' })
    expect(schema).toMatchObject({
      data: {
        output: { properties: { id: { type: 'string' } }, required: ['id'] },
      },
    })

    const markdown = await transport.discover({ resource: 'llmsFull' })
    if (!('body' in markdown)) throw new Error('expected markdown body')
    expect(markdown.body).toContain('Verbose status')
    expect(markdown.body).toContain('## Output')
    expect(markdown.body).toContain('Fetch gateway. Pass path segments')
    expect(markdown.body).not.toMatch(/^# app st$/m)
  })

  test('wraps discovery failures as client errors with internal cause', async () => {
    const cli = Cli.create('app').command('status', {
      run() {
        return { ok: true }
      },
    })
    const transport = MemoryTransport.create(cli)()

    await expect(transport.discover({ resource: 'skill', name: 'missing' })).rejects.toMatchObject({
      cause: expect.any(ResourcesError),
      code: 'SKILL_NOT_FOUND',
      message: expect.stringContaining('Discover request failed.'),
      status: 404,
    })
    await expect(transport.discover({ resource: 'skill', name: 'missing' })).rejects.toThrow(
      ClientError,
    )
  })

  test('exposes memory-only local capability', async () => {
    const cli = Cli.create('app', { description: 'App' }).command('status', {
      description: 'Show status',
      run() {
        return { ok: true }
      },
    })
    const transport = MemoryTransport.create(cli)()
    expect(Object.keys(transport.local)).toEqual(['skills', 'mcp'])
    expect(typeof transport.local.skills.add).toBe('function')
    expect(typeof transport.local.skills.list).toBe('function')
    expect(typeof transport.local.mcp.add).toBe('function')
    await expect(transport.local.skills.list()).resolves.toEqual({
      skills: [expect.objectContaining({ installed: false, name: 'app-status' })],
    })
  })
})
