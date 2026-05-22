import { Cli, Typegen, z } from 'incur'
import fs from 'node:fs/promises'

import { app, spec } from '../test/fixtures/hono-openapi-app.js'

describe('fromCli', () => {
  test('simple commands with args and options', () => {
    const cli = Cli.create('test')
      .command('get', {
        args: z.object({ id: z.number() }),
        run: () => ({}),
      })
      .command('list', {
        options: z.object({ limit: z.number() }),
        run: () => ({}),
      })

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "get". */
        "get": { args: { id: number }; options: {} }
        /** Generated command "list". */
        "list": { args: {}; options: { limit: number } }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('command with no args or options', () => {
    const cli = Cli.create('test').command('ping', { run: () => ({}) })

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "ping". */
        "ping": { args: {}; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('sub-commands use full path', () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr')
      .command('list', {
        options: z.object({ state: z.string() }),
        run: () => ({}),
      })
      .command('create', {
        args: z.object({ title: z.string() }),
        run: () => ({}),
      })
    cli.command(pr)

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "pr create". */
        "pr create": { args: { title: string }; options: {} }
        /** Generated command "pr list". */
        "pr list": { args: {}; options: { state: string } }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('deeply nested sub-commands', () => {
    const cli = Cli.create('test')
    const review = Cli.create('review').command('approve', {
      args: z.object({ id: z.number() }),
      run: () => ({}),
    })
    const pr = Cli.create('pr')
    pr.command(review)
    cli.command(pr)

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "pr review approve". */
        "pr review approve": { args: { id: number }; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('enum types fromCli union of literals', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ state: z.enum(['open', 'closed', 'merged']) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"open" | "closed" | "merged"')
  })

  test('boolean types', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ verbose: z.boolean() }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('verbose: boolean')
  })

  test('array types', () => {
    const cli = Cli.create('test').command('list', {
      options: z.object({ tags: z.array(z.string()) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('tags: string[]')
  })

  test('commands are sorted alphabetically', () => {
    const cli = Cli.create('test')
      .command('zebra', { run: () => ({}) })
      .command('alpha', { run: () => ({}) })
      .command('middle', { run: () => ({}) })

    const output = Typegen.fromCli(cli)
    const commandOrder = [...output.matchAll(/^  "(\w+)":/gm)].map((m) => m[1])
    expect(commandOrder).toEqual(['alpha', 'middle', 'zebra'])
  })

  test('const schema via z.literal', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ mode: z.literal('strict') }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('mode: "strict"')
  })

  test('array of union items gets parens', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ values: z.array(z.union([z.string(), z.number()])) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('values: (string | number)[]')
  })

  test('null type', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ empty: z.null() }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('empty: null')
  })

  test('nested object with properties', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({ config: z.object({ host: z.string(), port: z.number() }) }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('config: { host: string; port: number }')
  })

  test('optional properties include undefined for exactOptionalPropertyTypes', () => {
    const cli = Cli.create('test').command('create', {
      args: z.object({ name: z.string() }),
      options: z.object({
        verbose: z.boolean().optional(),
        nullable: z.string().nullable().optional(),
        output: z.string(),
      }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('verbose?: boolean | undefined')
    expect(output).toContain('nullable?: string | null | undefined')
    expect(output).toContain('output: string')
  })

  test('dense object schema', () => {
    const cli = Cli.create('test').command('build', {
      options: z.object({
        name: z.string(),
        count: z.number(),
        active: z.boolean(),
        mode: z.literal('strict'),
        state: z.enum(['open', 'closed']),
        target: z.union([z.string(), z.number()]),
        values: z.array(z.union([z.literal('a'), z.literal(1), z.boolean()])),
        nested: z.object({
          label: z.string().optional(),
          flags: z.array(z.enum(['on', 'off'])),
        }),
      }),
      run: () => ({}),
    })

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "build". */
        "build": { args: {}; options: { name: string; count: number; active: boolean; mode: "strict"; state: "open" | "closed"; target: string | number; values: ("a" | 1 | boolean)[]; nested: { label?: string | undefined; flags: ("on" | "off")[] } } }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('command output schema', () => {
    const cli = Cli.create('test').command('cmd', {
      output: z.object({ ok: z.boolean() }),
      run: () => ({ ok: true }),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"cmd": { args: {}; options: {}; output: { ok: boolean } }')
  })

  test('output schemas for non-object top-level types', () => {
    const cli = Cli.create('test')
      .command('text', {
        output: z.string(),
        run: () => 'ok',
      })
      .command('values', {
        output: z.array(z.union([z.string(), z.number()])),
        run: () => ['ok', 1],
      })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"text": { args: {}; options: {}; output: string }')
    expect(output).toContain('"values": { args: {}; options: {}; output: (string | number)[] }')
  })

  test('output schemas for records and tuples', () => {
    const cli = Cli.create('test')
      .command('record', {
        output: z.record(z.string(), z.number()),
        run: () => ({ count: 1 }),
      })
      .command('enum-record', {
        output: z.record(z.enum(['left', 'right']), z.number()),
        run: () => ({ left: 1, right: 2 }),
      })
      .command('tuple', {
        output: z.tuple([z.string(), z.number(), z.boolean()]),
        run: () => ['ok', 1, true] as [string, number, boolean],
      })
      .command('rest-tuple', {
        output: z.tuple([z.string()]).rest(z.number()),
        run: () => ['ok', 1, 2] as [string, ...number[]],
      })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"record": { args: {}; options: {}; output: Record<string, number> }')
    expect(output).toContain(
      '"enum-record": { args: {}; options: {}; output: Record<"left" | "right", number> }',
    )
    expect(output).toContain(
      '"rest-tuple": { args: {}; options: {}; output: [string, ...number[]] }',
    )
    expect(output).toContain(
      '"tuple": { args: {}; options: {}; output: [string, number, boolean] }',
    )
  })

  test('unknown output schemas fall back to unknown', () => {
    const cli = Cli.create('test').command('cmd', {
      output: z.any(),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"cmd": { args: {}; options: {}; output: unknown }')
  })

  test('object keys that are not identifiers are quoted', () => {
    const cli = Cli.create('test').command('cmd', {
      options: z.object({
        '1x': z.number(),
        'foo-bar': z.string(),
      }),
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('"1x": number')
    expect(output).toContain('"foo-bar": string')
  })

  test('command keys are escaped', () => {
    const cli = Cli.create('test').command('quote\'s "cmd" \\ slash */ end', {
      run: () => ({}),
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain('Generated command "quote\'s \\"cmd\\" \\\\ slash *\\/ end"')
    expect(output).toContain('"quote\'s \\"cmd\\" \\\\ slash */ end": { args: {}; options: {} }')
  })

  test('catchall output widens the index signature for known properties', () => {
    const cli = Cli.create('test').command('cmd', {
      output: z.object({ name: z.string() }).catchall(z.number()),
      run: () => ({ name: 'test' }) as never,
    })

    expect(Typegen.fromCli(cli)).toContain(
      '"cmd": { args: {}; options: {}; output: { name: string; [key: string]: number | string } }',
    )
  })

  test('unsupported schemas throw a clear typegen error', () => {
    const cli = Cli.create('test').command('cmd', {
      output: z.string().transform((value) => value.length),
      run: () => 1,
    })

    expect(() => Typegen.fromCli(cli)).toThrow(
      'Cannot generate TypeScript type for schema unsupported by JSON Schema',
    )
  })

  test('streaming command', () => {
    const cli = Cli.create('test').command('logs', {
      output: z.object({ line: z.string() }),
      async *run() {
        yield { line: 'one' }
      },
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain(
      '"logs": { args: {}; options: {}; output: { line: string }; stream: true }',
    )
  })

  test('skips commands that cannot be called by RPC client', () => {
    const cli = Cli.create('test')
      .command('deploy', {
        aliases: ['ship'],
        run: () => ({}),
      })
      .command('api', { fetch: () => new Response('ok') })

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "deploy". */
        "deploy": { args: {}; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('includes OpenAPI mounted operations without serving first', () => {
    const cli = Cli.create('test').command('api', {
      fetch: app.fetch,
      openapi: spec,
    })

    const output = Typegen.fromCli(cli)
    expect(output).toContain(
      '"api getUser": { args: { id: number }; options: {}; output: { id: number; name: string; [key: string]: unknown } }',
    )
    expect(output).toContain(
      '"api createUser": { args: {}; options: { name: string }; output: { created: boolean; name: string; [key: string]: unknown } }',
    )
    expect(output).not.toContain('"api": { args')
  })

  test('mixed top-level and grouped commands', () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({}) })
    const pr = Cli.create('pr').command('list', { run: () => ({}) })
    cli.command(pr)

    expect(Typegen.fromCli(cli)).toMatchInlineSnapshot(`
      "/** Command map generated from your incur CLI. */
      export type Commands = {
        /** Generated command "ping". */
        "ping": { args: {}; options: {} }
        /** Generated command "pr list". */
        "pr list": { args: {}; options: {} }
      }

      declare module 'incur' {
        interface Register {
          commands: Commands
        }
      }
      "
    `)
  })

  test('generated client type fixture matches fromCli output', async () => {
    const output = await fs.readFile(new URL('./Client.test-d.ts', import.meta.url), 'utf8')
    const fixture = extractGeneratedClientFixture(output)
    expect(normalizeDeclaration(Typegen.fromCli(createClientRoundTripCli()))).toBe(
      normalizeDeclaration(fixture),
    )
  })
})

function extractGeneratedClientFixture(value: string): string {
  const start = '// BEGIN generated client round-trip fixture'
  const end = '// END generated client round-trip fixture'
  return value.slice(value.indexOf(start) + start.length, value.indexOf(end)).trimStart()
}

function normalizeDeclaration(value: string): string {
  let output = ''
  let quote = ''
  let escaping = false

  for (const char of value) {
    if (quote) {
      if (escaping) {
        output += char
        escaping = false
        continue
      }
      if (char === '\\') {
        output += char
        escaping = true
        continue
      }
      if (char === quote) {
        output += '"'
        quote = ''
        continue
      }
      output += char
      continue
    }

    if (char === "'" || char === '"') {
      output += '"'
      quote = char
      continue
    }
    if (char === ';' || /\s/.test(char)) continue
    output += char
  }

  return output.replace(/"([A-Za-z_$][\w$]*)":/g, '$1:')
}

function createClientRoundTripCli() {
  const spec = {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {
      '/users/{id}': {
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'number' },
          },
        ],
        get: {
          operationId: 'getUser',
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'number' }, name: { type: 'string' } },
                    required: ['id', 'name'],
                  },
                },
              },
            },
          },
        },
      },
    },
  } as const
  const status = Cli.create('status', {
    output: z.object({ ok: z.boolean() }),
    run: () => ({ ok: true }),
  })
  const project = Cli.create('project')
    .command('deploy', {
      aliases: ['ship'],
      args: z.object({ id: z.string() }),
      options: z.object({ dryRun: z.boolean() }),
      output: z.object({
        deployId: z.string(),
        status: z.enum(['queued', 'done']),
      }),
      run: () => ({ deployId: 'dep_123', status: 'queued' as const }),
    })
    .command('inspect', {
      args: z.object({
        id: z.string(),
        includeLogs: z.boolean().optional(),
      }),
      output: z.object({
        id: z.string(),
        logs: z.array(z.string()).optional(),
      }),
      run: (c) => ({ id: c.args.id }),
    })
    .command('list', {
      options: z.object({
        cursor: z.string().optional(),
        limit: z.number().optional(),
      }),
      output: z.object({
        items: z.array(z.string()),
        nextCursor: z.string().optional(),
      }),
      run: () => ({ items: [] }),
    })
  const users = Cli.create('users').command('get', {
    args: z.object({ id: z.number() }),
    options: z.object({ verbose: z.boolean().optional() }),
    output: z.object({ id: z.number() }),
    run: (c) => ({ id: c.args.id }),
  })

  return Cli.create('test')
    .command(status)
    .command(project)
    .command(Cli.create('admin').command(users))
    .command('auth', {
      options: z.object({ token: z.string() }),
      output: z.void(),
      run: () => undefined,
    })
    .command('logs', {
      output: z.object({ line: z.string() }),
      async *run() {
        yield { line: 'one' }
      },
    })
    .command('api', {
      fetch: () => new Response(),
      openapi: spec,
    })
}
