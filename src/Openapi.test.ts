import { describe, expect, test, vi } from 'vitest'
import { parse as yamlParse } from 'yaml'
import { z } from 'zod'

vi.mock('./SyncSkills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SyncSkills.js')>()
  return { ...actual, readHash: () => undefined }
})

import { app as prefixedApp } from '../test/fixtures/hono-api-prefixed.js'
import { app } from '../test/fixtures/hono-api.js'
import { app as openapiApp, spec as openapiSpec } from '../test/fixtures/hono-openapi-app.js'
import { spec } from '../test/fixtures/openapi-spec.js'
import * as Cli from './Cli.js'
import * as Openapi from './Openapi.js'

function serve(cli: { serve: Cli.Cli['serve'] }, argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  return cli
    .serve(argv, {
      stdout: (s) => (output += s),
      exit: (c) => {
        exitCode = c
      },
    })
    .then(() => ({
      output,
      exitCode,
    }))
}

function json(output: string) {
  return JSON.parse(output.replace(/"duration": "[^"]+"/g, '"duration": "<stripped>"'))
}

describe('fromCli', () => {
  test('generates OpenAPI 3.2 paths with inferred methods', () => {
    const cli = Cli.create('api', { description: 'API', version: '1.2.3' })
      .command('users list', {
        description: 'List users',
        options: z.object({ limit: z.coerce.number().optional() }),
        output: z.object({ users: z.array(z.object({ id: z.string() })) }),
        run() {
          return { users: [] }
        },
      })
      .command('users update', {
        description: 'Update a user',
        args: z.object({ id: z.string() }),
        options: z.object({ name: z.string() }),
        run() {
          return { ok: true }
        },
      })
      .command('users delete', {
        args: z.object({ id: z.string() }),
        run() {
          return { ok: true }
        },
      })

    const spec = Openapi.fromCli(cli)
    expect(spec.openapi).toBe('3.2.0')
    expect(spec.info).toEqual({ title: 'api', version: '0.0.0', description: 'API' })
    expect(spec.paths?.['/users/list']?.get).toMatchObject({
      operationId: 'getUsersList',
      summary: 'List users',
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'number' } }],
    })
    expect(spec.paths?.['/users/update/{id}']?.patch).toMatchObject({
      operationId: 'patchUsersUpdateId',
      summary: 'Update a user',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
          },
        },
      },
    })
    expect(spec.paths?.['/users/delete/{id}']?.delete).toMatchObject({
      operationId: 'deleteUsersDeleteId',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    })
  })

  test('serves generated OpenAPI schema', async () => {
    const cli = Cli.create('api', { description: 'API' }).command('status', {
      run() {
        return { ok: true }
      },
    })

    const jsonResponse = await cli.fetch(new Request('http://localhost/openapi.json'))
    const json = await jsonResponse.json()
    expect(json.openapi).toBe('3.2.0')
    expect(json.paths['/status'].get.operationId).toBe('getStatus')

    const wellKnownResponse = await cli.fetch(
      new Request('http://localhost/.well-known/openapi.json'),
    )
    expect(await wellKnownResponse.json()).toMatchObject(json)

    const ymlResponse = await cli.fetch(new Request('http://localhost/openapi.yml'))
    expect(ymlResponse.headers.get('content-type')).toBe('application/yaml')
    expect(yamlParse(await ymlResponse.text()).paths['/status'].get.operationId).toBe('getStatus')

    const yamlResponse = await cli.fetch(new Request('http://localhost/openapi.yaml'))
    expect(yamlParse(await yamlResponse.text()).openapi).toBe('3.2.0')
  })
})

describe('generateCommands', () => {
  const fetch = () => new Response('{}')

  test('generates command entries from spec', async () => {
    const commands = await Openapi.generateCommands(spec, app.fetch)
    expect(commands.has('listUsers')).toBe(true)
    expect(commands.has('createUser')).toBe(true)
    expect(commands.has('getUser')).toBe(true)
    expect(commands.has('deleteUser')).toBe(true)
    expect(commands.has('healthCheck')).toBe(true)
  })

  test('command has description from summary', async () => {
    const commands = await Openapi.generateCommands(spec, app.fetch)
    const cmd = commands.get('listUsers')!
    expect(cmd.description).toBe('List users')
  })

  test('coerced number params preserve description', async () => {
    const commands = await Openapi.generateCommands(spec, app.fetch)
    const cmd = commands.get('listUsers')!
    const limitSchema = cmd.options!.shape.limit
    expect(limitSchema.description).toBe('Max results')
  })

  test('attaches output from 200 JSON response schema', async () => {
    const commands = await Openapi.generateCommands(
      {
        paths: {
          '/users': {
            get: {
              operationId: 'listUsers',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['users'],
                        properties: { users: { type: 'array', items: { type: 'string' } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      fetch,
    )

    const output = commands.get('listUsers')!.output
    expect(output).toBeDefined()
    expect(output!.safeParse({ users: ['Alice'] }).success).toBe(true)
    expect(output!.safeParse({ users: [1] }).success).toBe(false)
  })

  test('prefers 200 over other 2xx JSON response schemas', async () => {
    const commands = await Openapi.generateCommands(
      {
        paths: {
          '/choice': {
            get: {
              operationId: 'choice',
              responses: {
                '201': {
                  description: 'Created',
                  content: { 'application/json': { schema: { type: 'number' } } },
                },
                '200': {
                  description: 'OK',
                  content: { 'application/json': { schema: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      fetch,
    )

    const output = commands.get('choice')!.output!
    expect(output.safeParse('ok').success).toBe(true)
    expect(output.safeParse(1).success).toBe(false)
  })

  test('falls back to first 2xx JSON response schema', async () => {
    const commands = await Openapi.generateCommands(
      {
        paths: {
          '/users': {
            post: {
              operationId: 'createUser',
              responses: {
                '201': {
                  description: 'Created',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['created'],
                        properties: { created: { type: 'boolean' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      fetch,
    )

    const output = commands.get('createUser')!.output
    expect(output).toBeDefined()
    expect(output!.safeParse({ created: true }).success).toBe(true)
    expect(output!.safeParse({ created: 'yes' }).success).toBe(false)
  })

  test('uses default response only when it has a JSON schema', async () => {
    const commands = await Openapi.generateCommands(
      {
        paths: {
          '/fallback': {
            get: {
              operationId: 'fallback',
              responses: {
                default: {
                  description: 'Default',
                  content: { 'application/json': { schema: { type: 'boolean' } } },
                },
              },
            },
          },
          '/download': {
            get: {
              operationId: 'download',
              responses: {
                default: {
                  description: 'Default',
                  content: { 'text/plain': { schema: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      fetch,
    )

    expect(commands.get('fallback')!.output!.safeParse(true).success).toBe(true)
    expect(commands.get('download')!.output).toBeUndefined()
  })
})

describe('cli integration', () => {
  function createCli() {
    return Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
      openapi: spec,
    })
  }

  test('GET /users via operationId', async () => {
    const { output } = await serve(createCli(), ['api', 'listUsers'])
    expect(output).toContain('Alice')
  })

  test('GET /users?limit=5 via options', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'listUsers',
      '--limit',
      '5',
      '--format',
      'json',
    ])
    expect(json(output).limit).toBe(5)
  })

  test('GET /users/:id via positional arg', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('POST /users via createUser with body options', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--name', 'Bob'])
    expect(output).toMatchInlineSnapshot(`
      "created: true
      name: Bob
      "
    `)
  })

  test('DELETE /users/:id via deleteUser', async () => {
    const { output } = await serve(createCli(), ['api', 'deleteUser', '1'])
    expect(output).toMatchInlineSnapshot(`
      "deleted: true
      id: 1
      "
    `)
  })

  test('GET /health via healthCheck', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      "
    `)
  })

  test('--help on api shows subcommands', async () => {
    const { output } = await serve(createCli(), ['api', '--help'])
    expect(output).toContain('listUsers')
    expect(output).toContain('createUser')
    expect(output).toContain('getUser')
    expect(output).toContain('deleteUser')
    expect(output).toContain('healthCheck')
  })

  test('--help on specific command shows typed args/options', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '--help'])
    expect(output).toContain('id')
    expect(output).toContain('Get a user by ID')
  })

  test('--help on createUser shows body options', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--help'])
    expect(output).toContain('name')
    expect(output).toContain('Create a user')
  })

  test('--format json', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck', '--format', 'json'])
    expect(json(output)).toEqual({ ok: true })
  })

  test('--full-output wraps in envelope', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'healthCheck',
      '--full-output',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ ok: true })
    expect(parsed.meta.command).toContain('api')
  })

  test('missing required path param shows validation error', async () => {
    const { exitCode } = await serve(createCli(), ['api', 'getUser'])
    expect(exitCode).toBe(1)
  })
})

describe('@hono/zod-openapi integration', () => {
  function createCli() {
    return Cli.create('test', { description: 'test' }).command('api', {
      fetch: openapiApp.fetch,
      openapi: openapiSpec,
    })
  }

  test('GET /users via listUsers', async () => {
    const { output } = await serve(createCli(), ['api', 'listUsers'])
    expect(output).toContain('Alice')
  })

  test('GET /users?limit=5', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'listUsers',
      '--limit',
      '5',
      '--format',
      'json',
    ])
    expect(json(output).limit).toBe(5)
  })

  test('GET /users/:id via getUser', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('POST /users via createUser', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--name', 'Bob'])
    expect(output).toMatchInlineSnapshot(`
      "created: true
      name: Bob
      "
    `)
  })

  test('DELETE /users/:id via deleteUser', async () => {
    const { output } = await serve(createCli(), ['api', 'deleteUser', '1'])
    expect(output).toMatchInlineSnapshot(`
      "deleted: true
      id: 1
      "
    `)
  })

  test('GET /health via healthCheck', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      "
    `)
  })

  test('--help shows operationId commands', async () => {
    const { output } = await serve(createCli(), ['api', '--help'])
    expect(output).toContain('listUsers')
    expect(output).toContain('getUser')
    expect(output).toContain('createUser')
    expect(output).toContain('deleteUser')
    expect(output).toContain('healthCheck')
    expect(output).toContain('updateUser')
  })

  test('--help on getUser shows path param', async () => {
    const { output } = await serve(createCli(), ['api', 'getUser', '--help'])
    expect(output).toContain('id')
  })

  test('--help on createUser shows body options', async () => {
    const { output } = await serve(createCli(), ['api', 'createUser', '--help'])
    expect(output).toContain('name')
  })

  test('--help on updateUser shows path param and body options', async () => {
    const { output } = await serve(createCli(), ['api', 'updateUser', '--help'])
    expect(output).toContain('id')
    expect(output).toContain('name')
    expect(output).toContain('Update a user')
  })

  test('--format json', async () => {
    const { output } = await serve(createCli(), ['api', 'healthCheck', '--format', 'json'])
    expect(json(output)).toEqual({ ok: true })
  })

  test('--full-output wraps in envelope', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'healthCheck',
      '--full-output',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ ok: true })
    expect(parsed.meta.command).toContain('api')
  })

  test('missing required path param shows validation error', async () => {
    const { exitCode } = await serve(createCli(), ['api', 'getUser'])
    expect(exitCode).toBe(1)
  })

  test('PUT /users/:id with path param + body options', async () => {
    const { output } = await serve(createCli(), ['api', 'updateUser', '1', '--name', 'Updated'])
    expect(output).toMatchInlineSnapshot(`
      "id: 1
      name: Updated
      "
    `)
  })

  test('PUT /users/:id with optional boolean body option', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'updateUser',
      '1',
      '--name',
      'Updated',
      '--active',
      'true',
      '--format',
      'json',
    ])
    const parsed = json(output)
    expect(parsed.id).toBe(1)
    expect(parsed.name).toBe('Updated')
    expect(parsed.active).toBe(true)
  })

  test('query param coercion with zod-openapi generated spec', async () => {
    const { output } = await serve(createCli(), [
      'api',
      'listUsers',
      '--limit',
      '3',
      '--format',
      'json',
    ])
    expect(json(output).limit).toBe(3)
  })

  test('generated commands include output schemas from zod-openapi responses', async () => {
    const commands = await Openapi.generateCommands(openapiSpec, openapiApp.fetch)

    const listUsers = commands.get('listUsers')!.output
    expect(listUsers).toBeDefined()
    expect(listUsers!.safeParse({ users: [{ id: 1, name: 'Alice' }], limit: 10 }).success).toBe(
      true,
    )
    expect(listUsers!.safeParse({ users: [{ id: '1', name: 'Alice' }], limit: 10 }).success).toBe(
      false,
    )

    const createUser = commands.get('createUser')!.output
    expect(createUser).toBeDefined()
    expect(createUser!.safeParse({ created: true, name: 'Bob' }).success).toBe(true)
  })
})

describe('basePath', () => {
  test('fetch gateway prepends basePath to request path', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'users'])
    expect(output).toContain('Alice')
  })

  test('fetch gateway basePath with query params', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'users', '--limit', '5', '--format', 'json'])
    expect(json(output).limit).toBe(5)
  })

  test('fetch gateway basePath with POST', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'users', '-X', 'POST', '-d', '{"name":"Bob"}'])
    expect(output).toContain('Bob')
    expect(output).toContain('created')
  })

  test('openapi with basePath prepends to spec paths', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'listUsers'])
    expect(output).toContain('Alice')
  })

  test('openapi basePath with path params', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'getUser', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('openapi basePath with body options', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'createUser', '--name', 'Bob'])
    expect(output).toContain('created')
    expect(output).toContain('Bob')
  })

  test('openapi basePath with health check', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: prefixedApp.fetch,
      openapi: spec,
      basePath: '/api',
    })
    const { output } = await serve(cli, ['api', 'healthCheck', '--format', 'json'])
    expect(json(output)).toEqual({ ok: true })
  })
})
