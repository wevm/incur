import { Cli, Errors, z } from 'clac'

async function serve(cli: { serve: Cli.Cli['serve'] }, argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
  })
  return {
    output: output.replace(/duration: \d+ms/, 'duration: <stripped>'),
    exitCode,
  }
}

describe('create', () => {
  test('returns cli instance with name', () => {
    const cli = Cli.create('test')
    expect(cli.name).toBe('test')
  })

  test('accepts version and description options', () => {
    const cli = Cli.create('test', { version: '1.0.0', description: 'A test CLI' })
    expect(cli.name).toBe('test')
  })
})

describe('command', () => {
  test('registers a command and is chainable', () => {
    const cli = Cli.create('test')
    const result = cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })
    expect(result).toBe(cli)
  })
})

describe('serve', () => {
  test('outputs data only by default', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })

    const { output } = await serve(cli, ['greet', 'world'])
    expect(output).toMatchInlineSnapshot(`"message: hello world"`)
  })

  test('--verbose outputs full envelope', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })

    const { output } = await serve(cli, ['greet', 'world', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        message: hello world
      meta:
        command: greet
        duration: <stripped>"
    `)
  })

  test('parses positional args by schema key order', async () => {
    const cli = Cli.create('test')
    let receivedArgs: any
    cli.command('add', {
      args: z.object({ a: z.string(), b: z.string() }),
      run({ args }) {
        receivedArgs = args
        return {}
      },
    })

    await serve(cli, ['add', 'foo', 'bar'])
    expect(receivedArgs).toEqual({ a: 'foo', b: 'bar' })
  })

  test('serializes output as TOON', async () => {
    const cli = Cli.create('test')
    cli.command('ping', {
      run() {
        return { pong: true }
      },
    })

    const { output } = await serve(cli, ['ping'])
    expect(() => JSON.parse(output)).toThrow()
    expect(output).toMatchInlineSnapshot(`"pong: true"`)
  })

  test('outputs error details for unknown command', async () => {
    const cli = Cli.create('test')

    const { output, exitCode } = await serve(cli, ['nonexistent'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: "Unknown command: nonexistent""
    `)
  })

  test('--verbose outputs full error envelope for unknown command', async () => {
    const cli = Cli.create('test')

    const { output, exitCode } = await serve(cli, ['nonexistent', '--verbose'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "ok: false
      error:
        code: COMMAND_NOT_FOUND
        message: "Unknown command: nonexistent"
      meta:
        command: nonexistent
        duration: <stripped>"
    `)
  })

  test('wraps handler errors in error output', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })

    const { output, exitCode } = await serve(cli, ['fail'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: boom"
    `)
  })

  test('ClacError in run() populates code/retryable', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Errors.ClacError({
          code: 'NOT_AUTHENTICATED',
          message: 'Token not found',
          retryable: false,
        })
      },
    })

    const { output, exitCode } = await serve(cli, ['fail'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: NOT_AUTHENTICATED
      message: Token not found
      retryable: false"
    `)
  })

  test('ValidationError includes fieldErrors', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run({ args }) {
        return { message: `hello ${args.name}` }
      },
    })

    const { output, exitCode } = await serve(cli, ['greet'])
    expect(exitCode).toBe(1)
    expect(output).toContain('fieldErrors')
  })

  test('supports async handlers', async () => {
    const cli = Cli.create('test')
    cli.command('async', {
      async run() {
        await new Promise((r) => setTimeout(r, 10))
        return { done: true }
      },
    })

    const { output } = await serve(cli, ['async'])
    expect(output).toMatchInlineSnapshot(`"done: true"`)
  })

  test('--format json outputs JSON data', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--format', 'json'])
    expect(JSON.parse(output)).toEqual({ pong: true })
  })

  test('--json is shorthand for --format json', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--json'])
    expect(JSON.parse(output)).toEqual({ pong: true })
  })

  test('--verbose --format json outputs full envelope as JSON', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ pong: true })
    expect(parsed.meta.command).toBe('ping')
  })

  test('error output respects --format json', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })
    const { output, exitCode } = await serve(cli, ['fail', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('UNKNOWN')
    expect(parsed.message).toBe('boom')
  })
})

describe('--llms', () => {
  test('outputs manifest with version and commands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.version).toBe('clac.v1')
    expect(manifest.commands).toHaveLength(1)
    expect(manifest.commands[0].name).toBe('ping')
    expect(manifest.commands[0].description).toBe('Health check')
  })

  test('manifest includes schema.input from args and options', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      options: z.object({ loud: z.boolean().default(false) }),
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].schema.input).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        loud: { type: 'boolean', default: false },
      },
      required: ['name', 'loud'],
      additionalProperties: false,
    })
  })

  test('manifest includes schema.output when defined', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].schema.output).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    })
  })

  test('manifest omits schema when no schemas defined', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].schema).toBeUndefined()
  })

  test('manifest includes annotations when defined', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      description: 'List items',
      readOnly: true,
      openWorld: true,
      run: () => ({ items: [] }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
  })

  test('manifest omits annotations when not defined', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].annotations).toBeUndefined()
  })

  test('nested commands appear with full path in manifest', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' })
      .command('list', {
        description: 'List PRs',
        options: z.object({ state: z.enum(['open', 'closed']).default('open') }),
        run: () => ({ items: [] }),
      })
      .command('create', {
        description: 'Create PR',
        args: z.object({ title: z.string() }),
        run: ({ args }) => ({ title: args.title }),
      })
    cli.command(pr)

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands).toHaveLength(2)
    expect(manifest.commands[0].name).toBe('pr create')
    expect(manifest.commands[1].name).toBe('pr list')
  })

  test('deeply nested commands in manifest', async () => {
    const cli = Cli.create('test')
    const review = Cli.create('review', { description: 'Reviews' }).command('approve', {
      description: 'Approve a review',
      run: () => ({ approved: true }),
    })
    const pr = Cli.create('pr', { description: 'PR management' })
    pr.command(review)
    cli.command(pr)

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].name).toBe('pr review approve')
    expect(manifest.commands[0].description).toBe('Approve a review')
  })

  test('defaults to TOON format', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms'])
    expect(output).toContain('version: clac.v1')
    expect(output).toContain('ping')
  })

  test('respects --format yaml', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'yaml'])
    expect(output).toContain('version: clac.v1')
    expect(output).toContain('name: ping')
  })

  test('full manifest snapshot', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string().describe('Name to greet') }),
      options: z.object({ loud: z.boolean().default(false).describe('Shout it') }),
      output: z.object({ message: z.string() }),
      readOnly: true,
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    expect(JSON.parse(output)).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "annotations": {
              "readOnlyHint": true,
            },
            "description": "Greet someone",
            "name": "greet",
            "schema": {
              "input": {
                "additionalProperties": false,
                "properties": {
                  "loud": {
                    "default": false,
                    "description": "Shout it",
                    "type": "boolean",
                  },
                  "name": {
                    "description": "Name to greet",
                    "type": "string",
                  },
                },
                "required": [
                  "name",
                  "loud",
                ],
                "type": "object",
              },
              "output": {
                "additionalProperties": false,
                "properties": {
                  "message": {
                    "type": "string",
                  },
                },
                "required": [
                  "message",
                ],
                "type": "object",
              },
            },
          },
        ],
        "version": "clac.v1",
      }
    `)
  })
})

describe('subcommands', () => {
  test('creates a command group with name and description', () => {
    const pr = Cli.create('pr', { description: 'PR management' })
    expect(pr.name).toBe('pr')
    expect(pr.description).toBe('PR management')
  })

  test('group registers sub-commands and is chainable', () => {
    const pr = Cli.create('pr', { description: 'PR management' })
    const result = pr.command('list', { run: () => ({ count: 0 }) })
    expect(result).toBe(pr)
  })

  test('routes to sub-command', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('list', {
      run: () => ({ count: 0 }),
    })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'list'])
    expect(output).toMatchInlineSnapshot(`"count: 0"`)
  })

  test('sub-command receives parsed args and options', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('get', {
      args: z.object({ id: z.string() }),
      options: z.object({ draft: z.boolean().default(false) }),
      run: ({ args, options }) => ({ id: args.id, draft: options.draft }),
    })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'get', '42', '--draft'])
    expect(output).toMatchInlineSnapshot(`
      "id: "42"
      draft: true"
    `)
  })

  test('--verbose shows full command path in meta', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('list', {
      run: () => ({ count: 0 }),
    })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'list', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        count: 0
      meta:
        command: pr list
        duration: <stripped>"
    `)
  })

  test('routes to deeply nested sub-commands', async () => {
    const cli = Cli.create('test')
    const review = Cli.create('review', { description: 'Reviews' }).command('approve', {
      run: () => ({ approved: true }),
    })
    const pr = Cli.create('pr', { description: 'PR management' })
    pr.command(review)
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'review', 'approve'])
    expect(output).toMatchInlineSnapshot(`"approved: true"`)
  })

  test('nested group shows full path in verbose meta', async () => {
    const cli = Cli.create('test')
    const review = Cli.create('review', { description: 'Reviews' }).command('approve', {
      run: () => ({ approved: true }),
    })
    const pr = Cli.create('pr', { description: 'PR management' })
    pr.command(review)
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'review', 'approve', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        approved: true
      meta:
        command: pr review approve
        duration: <stripped>"
    `)
  })

  test('unknown subcommand lists available commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' })
      .command('list', { run: () => ({}) })
      .command('create', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'unknown'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: "Unknown subcommand: unknown. Available: create, list""
    `)
  })

  test('group without subcommand shows help', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' })
      .command('list', { run: () => ({}) })
      .command('create', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "test pr — PR management

      Usage: test pr <command>

      Commands:
        create
        list"
    `)
  })

  test('sub-commands from separate module can be mounted', async () => {
    function createPrCommands() {
      return Cli.create('pr', { description: 'PR management' }).command('list', {
        run: () => ({ count: 0 }),
      })
    }

    const cli = Cli.create('test')
    cli.command(createPrCommands())

    const { output } = await serve(cli, ['pr', 'list'])
    expect(output).toMatchInlineSnapshot(`"count: 0"`)
  })

  test('error in sub-command wraps in error envelope', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('fail', {
      run() {
        throw new Error('sub-boom')
      },
    })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'fail'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: sub-boom"
    `)
  })

  test('group error respects --format json', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('list', {
      run: () => ({}),
    })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'unknown', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('COMMAND_NOT_FOUND')
    expect(parsed.message).toContain('unknown')
  })
})

describe('cta', () => {
  test('string shorthand for cta commands', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      run({ ok }) {
        return ok({ items: [] }, { cta: { commands: ['get 1', 'get 2'] } })
      },
    })

    const { output } = await serve(cli, ['list', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toEqual({
      description: 'Suggested commands:',
      commands: [{ command: 'test get 1' }, { command: 'test get 2' }],
    })
  })

  test('tuple shorthand with description', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      run({ ok }) {
        return ok({ items: [] }, {
          cta: { commands: [{ command: 'get 1', description: 'View item 1' }] },
        })
      },
    })

    const { output } = await serve(cli, ['list', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.commands).toEqual([{ command: 'test get 1', description: 'View item 1' }])
  })

  test('tuple form with args/options', async () => {
    const cli = Cli.create('test')
    cli.command('create', {
      run({ ok }) {
        return ok({ id: 1 }, {
          cta: {
            commands: [{ command: 'get', args: { id: 1 }, options: { limit: 10 }, description: 'View the item' }],
          },
        })
      },
    })

    const { output } = await serve(cli, ['create', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.commands).toEqual([
      { command: 'test get 1 --limit 10', description: 'View the item' },
    ])
  })

  test('tuple form boolean args format as placeholders', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      run({ ok }) {
        return ok({ items: [] }, {
          cta: { commands: [{ command: 'get', args: { id: true }, options: { format: true } }] },
        })
      },
    })

    const { output } = await serve(cli, ['list', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.commands).toEqual([{ command: 'test get <id> --format <format>' }])
  })

  test('custom cta description', async () => {
    const cli = Cli.create('test')
    cli.command('create', {
      run({ ok }) {
        return ok({ id: 1 }, {
          cta: { description: 'View the created item:', commands: ['get 1'] },
        })
      },
    })

    const { output } = await serve(cli, ['create', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.description).toBe('View the created item:')
  })

  test('plain return omits meta.cta', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toBeUndefined()
  })

  test('empty commands array omits meta.cta', async () => {
    const cli = Cli.create('test')
    cli.command('noop', {
      run({ ok }) {
        return ok({ done: true }, { cta: { commands: [] } })
      },
    })

    const { output } = await serve(cli, ['noop', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toBeUndefined()
  })

  test('error() with cta', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run({ error }) {
        return error({
          code: 'NOT_AUTHENTICATED',
          message: 'Not logged in',
          cta: {
            description: 'Authenticate to continue:',
            commands: ['auth login'],
          },
        })
      },
    })

    const { output, exitCode } = await serve(cli, ['fail', '--verbose', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(false)
    expect(parsed.meta.cta).toEqual({
      description: 'Authenticate to continue:',
      commands: [{ command: 'test auth login' }],
    })
  })

  test('error() without cta omits meta.cta', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run({ error }) {
        return error({ code: 'FAILED', message: 'Something went wrong' })
      },
    })

    const { output, exitCode } = await serve(cli, ['fail', '--verbose', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toBeUndefined()
  })

  test('thrown error does not include cta', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })

    const { output } = await serve(cli, ['fail', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(false)
    expect(parsed.meta.cta).toBeUndefined()
  })

  test('ok() cta works with sub-commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('create', {
      args: z.object({ title: z.string() }),
      output: z.object({ id: z.number(), title: z.string() }),
      run({ args, ok }) {
        return ok({ id: 42, title: args.title }, {
          cta: { commands: [{ command: 'pr get 42', description: 'View the PR' }] },
        })
      },
    })
    cli.command(pr)

    const { output } = await serve(cli, ['pr', 'create', 'my-pr', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta).toEqual({
      description: 'Suggested commands:',
      commands: [{ command: 'test pr get 42', description: 'View the PR' }],
    })
  })
})

describe('leaf cli', () => {
  test('create with run returns a leaf cli (no command method)', () => {
    const cli = Cli.create('ping', { run: () => ({ pong: true }) })
    expect(cli.name).toBe('ping')
    expect('command' in cli).toBe(false)
  })

  test('serves without a command name in argv', async () => {
    const cli = Cli.create('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, [])
    expect(output).toMatchInlineSnapshot(`"pong: true"`)
  })

  test('parses args and options', async () => {
    const cli = Cli.create('greet', {
      args: z.object({ name: z.string() }),
      options: z.object({ loud: z.boolean().default(false) }),
      run({ args, options }) {
        return { message: options.loud ? `HELLO ${args.name}` : `hello ${args.name}` }
      },
    })
    const { output } = await serve(cli, ['world', '--loud'])
    expect(output).toMatchInlineSnapshot(`"message: HELLO world"`)
  })

  test('--verbose outputs full envelope', async () => {
    const cli = Cli.create('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        pong: true
      meta:
        command: ping
        duration: <stripped>"
    `)
  })

  test('--format json works', async () => {
    const cli = Cli.create('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['--format', 'json'])
    expect(JSON.parse(output)).toEqual({ pong: true })
  })

  test('errors wrap in error envelope', async () => {
    const cli = Cli.create('fail', {
      run() {
        throw new Error('boom')
      },
    })
    const { output, exitCode } = await serve(cli, [])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: UNKNOWN
      message: boom"
    `)
  })

  test('can be mounted on a parent as a single command', async () => {
    const ping = Cli.create('ping', {
      description: 'Health check',
      run: () => ({ pong: true }),
    })
    const cli = Cli.create('app')
    cli.command(ping)

    const { output } = await serve(cli, ['ping'])
    expect(output).toMatchInlineSnapshot(`"pong: true"`)
  })

  test('mounted leaf with args/options works', async () => {
    const greet = Cli.create('greet', {
      args: z.object({ name: z.string() }),
      options: z.object({ loud: z.boolean().default(false) }),
      run({ args, options }) {
        return { message: options.loud ? `HELLO ${args.name}` : `hello ${args.name}` }
      },
    })
    const cli = Cli.create('app')
    cli.command(greet)

    const { output } = await serve(cli, ['greet', 'world', '--loud'])
    expect(output).toMatchInlineSnapshot(`"message: HELLO world"`)
  })

  test('mounted leaf appears in --llms manifest', async () => {
    const ping = Cli.create('ping', {
      description: 'Health check',
      run: () => ({ pong: true }),
    })
    const cli = Cli.create('app')
    cli.command(ping)

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands).toHaveLength(1)
    expect(manifest.commands[0].name).toBe('ping')
    expect(manifest.commands[0].description).toBe('Health check')
  })
})

describe('help', () => {
  test('router with no subcommand shows help', async () => {
    const cli = Cli.create('tool')
    cli.command('ping', {
      description: 'Health check',
      run: () => ({ pong: true }),
    })

    const { output, exitCode } = await serve(cli, [])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "tool

      Usage: tool <command>

      Commands:
        ping  Health check"
    `)
  })

  test('--help on root shows help', async () => {
    const cli = Cli.create('tool')
    cli.command('ping', {
      description: 'Health check',
      run: () => ({ pong: true }),
    })

    const { output, exitCode } = await serve(cli, ['--help'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "tool

      Usage: tool <command>

      Commands:
        ping  Health check"
    `)
  })

  test('--help on leaf shows command help', async () => {
    const cli = Cli.create('tool')
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string().describe('Name') }),
      run: ({ args }) => ({ message: `hi ${args.name}` }),
    })

    const { output, exitCode } = await serve(cli, ['greet', '--help'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "tool greet — Greet someone

      Usage: tool greet <name>

      Arguments:
        name  Name"
    `)
  })

  test('group with no subcommand shows help', async () => {
    const pr = Cli.create('pr', { description: 'Pull request commands' })
    pr.command('list', {
      description: 'List PRs',
      run: () => ({}),
    })

    const cli = Cli.create('gh')
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "gh pr — Pull request commands

      Usage: gh pr <command>

      Commands:
        list  List PRs"
    `)
  })

  test('--version outputs version string', async () => {
    const cli = Cli.create('tool', { version: '1.2.3' })
    cli.command('ping', { run: () => ({}) })

    const { output, exitCode } = await serve(cli, ['--version'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`"1.2.3"`)
  })

  test('--help takes precedence over --version', async () => {
    const cli = Cli.create('tool', { version: '1.2.3' })
    cli.command('ping', { description: 'Ping', run: () => ({}) })

    const { output } = await serve(cli, ['--help', '--version'])
    expect(output).toMatchInlineSnapshot(`
      "tool

      Usage: tool <command>

      Commands:
        ping  Ping"
    `)
  })
})
