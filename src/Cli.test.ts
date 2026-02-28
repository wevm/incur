import { Cli, Errors, z } from 'incur'

const originalIsTTY = process.stdout.isTTY
beforeAll(() => {
  ;(process.stdout as any).isTTY = false
})
afterAll(() => {
  ;(process.stdout as any).isTTY = originalIsTTY
})

let __mockSkillsHash: string | undefined

vi.mock('./SyncSkills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SyncSkills.js')>()
  return { ...actual, readHash: () => __mockSkillsHash }
})

async function serve(
  cli: { serve: Cli.Cli['serve'] },
  argv: string[],
  options: Cli.serve.Options = {},
) {
  let output = ''
  let exitCode: number | undefined
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit(code) {
      exitCode = code
    },
    ...options,
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
      run(c) {
        return { message: `hello ${c.args.name}` }
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
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })

    const { output } = await serve(cli, ['greet', 'world'])
    expect(output).toMatchInlineSnapshot(`
      "message: hello world
      "
    `)
  })

  test('--verbose outputs full envelope', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })

    const { output } = await serve(cli, ['greet', 'world', '--verbose'])
    expect(output).toMatchInlineSnapshot(`
      "ok: true
      data:
        message: hello world
      meta:
        command: greet
        duration: <stripped>
      "
    `)
  })

  test('parses positional args by schema key order', async () => {
    const cli = Cli.create('test')
    let receivedArgs: any
    cli.command('add', {
      args: z.object({ a: z.string(), b: z.string() }),
      run(c) {
        receivedArgs = c.args
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
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
  })

  test('outputs error details for unknown command', async () => {
    const cli = Cli.create('test')

    const { output, exitCode } = await serve(cli, ['nonexistent'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: 'nonexistent' is not a command. See 'test --help' for a list of available commands.
      "
    `)
  })

  test('outputs human error for unknown command in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')

    const { output, exitCode } = await serve(cli, ['nonexistent'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: 'nonexistent' is not a command. See 'test --help' for a list of available commands.
      "
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
        message: 'nonexistent' is not a command. See 'test --help' for a list of available commands.
      meta:
        command: nonexistent
        duration: <stripped>
      "
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
      message: boom
      "
    `)
  })

  test('wraps handler errors in human format in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })

    const { output, exitCode } = await serve(cli, ['fail'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: boom
      "
    `)
  })

  test('IncurError in run() populates code/retryable', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Errors.IncurError({
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
      retryable: false
      "
    `)
  })

  test('IncurError shows human format in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Errors.IncurError({
          code: 'NOT_AUTHENTICATED',
          message: 'Token not found',
          retryable: false,
        })
      },
    })

    const { output, exitCode } = await serve(cli, ['fail'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error (NOT_AUTHENTICATED): Token not found
      "
    `)
  })

  test('ValidationError includes fieldErrors', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })

    const { output, exitCode } = await serve(cli, ['greet'])
    expect(exitCode).toBe(1)
    expect(output).toContain('VALIDATION_ERROR')
  })

  test('ValidationError shows human format in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })

    const { output, exitCode } = await serve(cli, ['greet'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toContain('Error: missing required argument <name>')
  })

  test('agent is true when not TTY', async () => {
    let agent: boolean | undefined
    const cli = Cli.create('test')
    cli.command('ping', {
      run(c) {
        agent = c.agent
        return {}
      },
    })

    await serve(cli, ['ping'])
    expect(agent).toBe(true)
  })

  test('agent is false when TTY', async () => {
    ;(process.stdout as any).isTTY = true
    let agent: boolean | undefined
    const cli = Cli.create('test')
    cli.command('ping', {
      run(c) {
        agent = c.agent
        return {}
      },
    })

    await serve(cli, ['ping'])
    ;(process.stdout as any).isTTY = false
    expect(agent).toBe(false)
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
    expect(output).toMatchInlineSnapshot(`
      "done: true
      "
    `)
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
    expect(manifest.version).toBe('incur.v1')
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
    expect(manifest.commands[0].schema.args).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    })
    expect(manifest.commands[0].schema.options).toEqual({
      type: 'object',
      properties: { loud: { type: 'boolean', default: false } },
      required: ['loud'],
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

  test('defaults to markdown format', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms'])
    expect(output).toContain('# test ping')
    expect(output).toContain('Health check')
  })

  test('respects --format yaml', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms', '--format', 'yaml'])
    expect(output).toContain('version: incur.v1')
    expect(output).toContain('name: ping')
  })

  test('full manifest snapshot', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string().describe('Name to greet') }),
      options: z.object({ loud: z.boolean().default(false).describe('Shout it') }),
      output: z.object({ message: z.string() }),
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    expect(JSON.parse(output)).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "description": "Greet someone",
            "name": "greet",
            "schema": {
              "args": {
                "additionalProperties": false,
                "properties": {
                  "name": {
                    "description": "Name to greet",
                    "type": "string",
                  },
                },
                "required": [
                  "name",
                ],
                "type": "object",
              },
              "options": {
                "additionalProperties": false,
                "properties": {
                  "loud": {
                    "default": false,
                    "description": "Shout it",
                    "type": "boolean",
                  },
                },
                "required": [
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
        "version": "incur.v1",
      }
    `)
  })

  test('--llms --format md outputs skill files', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string().describe('Name to greet') }),
      output: z.object({ message: z.string() }),
      run: ({ args }) => ({ message: `hello ${args.name}` }),
    })

    const { output } = await serve(cli, ['--llms', '--format', 'md'])
    expect(output).toContain('# test greet')
    expect(output).toContain('## Arguments')
    expect(output).toContain('## Output')
    expect(output).not.toMatch(/^---$/m)
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
    expect(output).toMatchInlineSnapshot(`
      "count: 0
      "
    `)
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
      draft: true
      "
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
        duration: <stripped>
      "
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
    expect(output).toMatchInlineSnapshot(`
      "approved: true
      "
    `)
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
        duration: <stripped>
      "
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
      message: 'unknown' is not a command. See 'test pr --help' for a list of available commands.
      "
    `)
  })

  test('unknown subcommand shows human error in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' })
      .command('list', { run: () => ({}) })
      .command('create', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'unknown'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: 'unknown' is not a command. See 'test pr --help' for a list of available commands.
      "
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
        list

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
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
    expect(output).toMatchInlineSnapshot(`
      "count: 0
      "
    `)
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
      message: sub-boom
      "
    `)
  })

  test('error in sub-command shows human format in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('fail', {
      run() {
        throw new Error('sub-boom')
      },
    })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'fail'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: sub-boom
      "
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
      run(c) {
        return c.ok({ items: [] }, { cta: { commands: ['get 1', 'get 2'] } })
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
      run(c) {
        return c.ok(
          { items: [] },
          {
            cta: { commands: [{ command: 'get 1', description: 'View item 1' }] },
          },
        )
      },
    })

    const { output } = await serve(cli, ['list', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.commands).toEqual([
      { command: 'test get 1', description: 'View item 1' },
    ])
  })

  test('tuple form with args/options', async () => {
    const cli = Cli.create('test')
    cli.command('create', {
      run(c) {
        return c.ok(
          { id: 1 },
          {
            cta: {
              commands: [
                {
                  command: 'get',
                  args: { id: 1 },
                  options: { limit: 10 },
                  description: 'View the item',
                },
              ],
            },
          },
        )
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
      run(c) {
        return c.ok(
          { items: [] },
          {
            cta: { commands: [{ command: 'get', args: { id: true }, options: { format: true } }] },
          },
        )
      },
    })

    const { output } = await serve(cli, ['list', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.commands).toEqual([{ command: 'test get <id> --format <format>' }])
  })

  test('custom cta description', async () => {
    const cli = Cli.create('test')
    cli.command('create', {
      run(c) {
        return c.ok(
          { id: 1 },
          {
            cta: { description: 'View the created item:', commands: ['get 1'] },
          },
        )
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
        return ok(
          { id: 42, title: args.title },
          {
            cta: { commands: [{ command: 'pr get 42', description: 'View the PR' }] },
          },
        )
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
  test('create with run returns a cli with command method', () => {
    const cli = Cli.create('ping', { run: () => ({ pong: true }) })
    expect(cli.name).toBe('ping')
    expect('command' in cli).toBe(true)
  })

  test('serves without a command name in argv', async () => {
    const cli = Cli.create('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, [])
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
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
    expect(output).toMatchInlineSnapshot(`
      "message: HELLO world
      "
    `)
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
        duration: <stripped>
      "
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
      message: boom
      "
    `)
  })

  test('errors show human format in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('fail', {
      run() {
        throw new Error('boom')
      },
    })
    const { output, exitCode } = await serve(cli, [])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: boom
      "
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
    expect(output).toMatchInlineSnapshot(`
      "pong: true
      "
    `)
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
    expect(output).toMatchInlineSnapshot(`
      "message: HELLO world
      "
    `)
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
        ping  Health check

      Built-in Commands:
        mcp add     Register as an MCP server
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --verbose                           Show full output envelope
        --version                           Show version
      "
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
        ping  Health check

      Built-in Commands:
        mcp add     Register as an MCP server
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --verbose                           Show full output envelope
        --version                           Show version
      "
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
        name  Name

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
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
        list  List PRs

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--version outputs version string', async () => {
    const cli = Cli.create('tool', { version: '1.2.3' })
    cli.command('ping', { run: () => ({}) })

    const { output, exitCode } = await serve(cli, ['--version'])
    expect(exitCode).toBeUndefined()
    expect(output).toMatchInlineSnapshot(`
      "1.2.3
      "
    `)
  })

  test('--help takes precedence over --version', async () => {
    const cli = Cli.create('tool', { version: '1.2.3' })
    cli.command('ping', { description: 'Ping', run: () => ({}) })

    const { output } = await serve(cli, ['--help', '--version'])
    expect(output).toMatchInlineSnapshot(`
      "tool
      v1.2.3

      Usage: tool <command>

      Commands:
        ping  Ping

      Built-in Commands:
        mcp add     Register as an MCP server
        skills add  Sync skill files to your agent

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --verbose                           Show full output envelope
        --version                           Show version
      "
    `)
  })

  test('--help shows hint after examples', async () => {
    const cli = Cli.create('tool')
    cli.command('deploy', {
      description: 'Deploy the app',
      hint: 'Run "tool status" to check deployment progress.',
      run: () => ({ ok: true }),
    })

    const { output } = await serve(cli, ['deploy', '--help'])
    expect(output).toMatchInlineSnapshot(`
      "tool deploy — Deploy the app

      Usage: tool deploy

      Run "tool status" to check deployment progress.

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--help omits hint when not set', async () => {
    const cli = Cli.create('tool')
    cli.command('ping', {
      description: 'Health check',
      run: () => ({ pong: true }),
    })

    const { output } = await serve(cli, ['ping', '--help'])
    expect(output).not.toContain('hint')
  })
})

describe('env', () => {
  test('parses env vars and passes to handler', async () => {
    const cli = Cli.create('test')
    let receivedEnv: any
    cli.command('deploy', {
      env: z.object({
        API_TOKEN: z.string().describe('Auth token'),
      }),
      run(c) {
        receivedEnv = c.env
        return { ok: true }
      },
    })

    await serve(cli, ['deploy'], { env: { API_TOKEN: 'secret-123' } })
    expect(receivedEnv).toEqual({ API_TOKEN: 'secret-123' })
  })

  test('env validation error for missing required var', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', {
      env: z.object({
        API_TOKEN: z.string().describe('Auth token'),
      }),
      run() {
        return {}
      },
    })

    const { output, exitCode } = await serve(cli, ['deploy'], { env: {} })
    expect(exitCode).toBe(1)
    expect(output).toContain('Error')
  })

  test('env with defaults works when var is unset', async () => {
    const cli = Cli.create('test')
    let receivedEnv: any
    cli.command('deploy', {
      env: z.object({
        API_URL: z.string().default('https://api.example.com').describe('API URL'),
      }),
      run(c) {
        receivedEnv = c.env
        return { ok: true }
      },
    })

    await serve(cli, ['deploy'], { env: {} })
    expect(receivedEnv).toEqual({ API_URL: 'https://api.example.com' })
  })

  test('--help shows environment variables section', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', {
      env: z.object({
        API_TOKEN: z.string().describe('Auth token'),
        API_URL: z.string().default('https://api.example.com').describe('API URL'),
      }),
      run() {
        return {}
      },
    })

    const { output } = await serve(cli, ['deploy', '--help'])
    expect(output).toMatchInlineSnapshot(`
      "test deploy

      Usage: test deploy

      Environment Variables:
        API_TOKEN  Auth token
        API_URL    API URL (default: https://api.example.com)

      Global Options:
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms                              Print LLM-readable manifest
        --verbose                           Show full output envelope
      "
    `)
  })

  test('--llms json includes schema.env', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', {
      env: z.object({
        API_TOKEN: z.string().describe('Auth token'),
      }),
      run() {
        return {}
      },
    })

    const { output } = await serve(cli, ['--llms', '--format', 'json'])
    const cmd = JSON.parse(output).commands.find((c: any) => c.name === 'deploy')
    expect(cmd.schema.env).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "API_TOKEN": {
            "description": "Auth token",
            "type": "string",
          },
        },
        "required": [
          "API_TOKEN",
        ],
        "type": "object",
      }
    `)
  })

  test('--llms markdown includes environment variables table', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', {
      env: z.object({
        API_TOKEN: z.string().describe('Auth token'),
      }),
      run() {
        return {}
      },
    })

    const { output } = await serve(cli, ['--llms'])
    expect(output).toContain('Environment Variables')
    expect(output).toContain('`API_TOKEN`')
  })

  test('env coerces boolean and number values', async () => {
    const cli = Cli.create('test')
    let receivedEnv: any
    cli.command('deploy', {
      env: z.object({
        DEBUG: z.boolean().default(false).describe('Debug mode'),
        PORT: z.number().default(3000).describe('Port'),
      }),
      run(c) {
        receivedEnv = c.env
        return { ok: true }
      },
    })

    await serve(cli, ['deploy'], { env: { DEBUG: 'true', PORT: '8080' } })
    expect(receivedEnv).toEqual({ DEBUG: true, PORT: 8080 })
  })
})

describe('skills staleness', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    __mockSkillsHash = undefined
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  test('warns on stderr when skills are stale', async () => {
    __mockSkillsHash = '0000000000000000'
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    await serve(cli, ['ping'])
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Skills are out of date. Run '"))
  })

  test('does not warn when hash matches', async () => {
    const { Skill } = await import('incur')
    __mockSkillsHash = Skill.hash([{ name: 'ping', description: 'Health check' }])
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    await serve(cli, ['ping'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  test('does not warn when no hash stored', async () => {
    __mockSkillsHash = undefined
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    await serve(cli, ['ping'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  test('does not warn for skills add', async () => {
    __mockSkillsHash = '0000000000000000'
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    await serve(cli, ['skills', 'add'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  test('does not warn for --help', async () => {
    __mockSkillsHash = '0000000000000000'
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    await serve(cli, ['--help'])
    expect(stderrSpy).not.toHaveBeenCalled()
  })
})

describe('outputPolicy', () => {
  beforeEach(() => {
    ;(process.stdout as any).isTTY = true
  })
  afterEach(() => {
    ;(process.stdout as any).isTTY = false
  })

  test('default (all): displays data in human mode', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).toContain('pong: true')
  })

  test('agent-only on command: suppresses data in human mode', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { outputPolicy: 'agent-only', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).toBe('')
  })

  test('agent-only on command: still outputs in agent mode (--json)', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { outputPolicy: 'agent-only', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping', '--json'])
    expect(output).toContain('"pong"')
  })

  test('agent-only on root CLI: inherited by commands', async () => {
    const cli = Cli.create('test', { outputPolicy: 'agent-only' })
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).toBe('')
  })

  test('agent-only on group: inherited by child commands', async () => {
    const cli = Cli.create('test')
    const sub = Cli.create('sub', { outputPolicy: 'agent-only' })
    sub.command('ping', { run: () => ({ pong: true }) })
    cli.command(sub)

    const { output } = await serve(cli, ['sub', 'ping'])
    expect(output).toBe('')
  })

  test('command overrides group outputPolicy', async () => {
    const cli = Cli.create('test')
    const sub = Cli.create('sub', { outputPolicy: 'agent-only' })
    sub.command('ping', { outputPolicy: 'all', run: () => ({ pong: true }) })
    cli.command(sub)

    const { output } = await serve(cli, ['sub', 'ping'])
    expect(output).toContain('pong: true')
  })

  test('agent-only suppresses streaming chunks in human mode', async () => {
    const cli = Cli.create('test')
    cli.command('stream', {
      outputPolicy: 'agent-only',
      async *run() {
        yield { step: 1 }
        yield { step: 2 }
      },
    })

    const { output } = await serve(cli, ['stream'])
    expect(output).toBe('')
  })

  test('agent-only still shows errors in human mode', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      outputPolicy: 'agent-only',
      run(c) {
        return c.error({ code: 'FAILED', message: 'something broke' })
      },
    })

    const { output } = await serve(cli, ['fail'])
    expect(output).toContain('Error (FAILED): something broke')
  })

  test('agent-only still shows CTAs in human mode', async () => {
    const cli = Cli.create('test')
    cli.command('ping', {
      outputPolicy: 'agent-only',
      run(c) {
        return c.ok({ pong: true }, { cta: { commands: ['ping'] } })
      },
    })

    const { output } = await serve(cli, ['ping'])
    expect(output).not.toContain('pong')
    expect(output).toContain('ping')
  })

  test('agent-only suppresses data when TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    cli.command('ping', { outputPolicy: 'agent-only', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).toBe('')
  })

  test('agent-only still displays data when not TTY (piped)', async () => {
    ;(process.stdout as any).isTTY = false
    const cli = Cli.create('test')
    cli.command('ping', { outputPolicy: 'agent-only', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).toContain('pong')
  })

  test('all displays data regardless of TTY', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { outputPolicy: 'all', run: () => ({ pong: true }) })

    ;(process.stdout as any).isTTY = true
    const tty = await serve(cli, ['ping'])
    expect(tty.output).toContain('pong: true')

    ;(process.stdout as any).isTTY = false
    const piped = await serve(cli, ['ping'])
    expect(piped.output).toContain('pong')
  })

  test('agent-only streaming suppresses when TTY, outputs when piped', async () => {
    const cli = Cli.create('test')
    cli.command('stream', {
      outputPolicy: 'agent-only',
      async *run() {
        yield { step: 1 }
      },
    })

    ;(process.stdout as any).isTTY = true
    const tty = await serve(cli, ['stream'])
    expect(tty.output).toBe('')

    ;(process.stdout as any).isTTY = false
    const piped = await serve(cli, ['stream'])
    expect(piped.output).toContain('step: 1')
  })

  test('e2e: realistic multi-level CLI with mixed policies', async () => {
    const cli = Cli.create('tool', { description: 'A deployment tool' })

    // Top-level command with agent-only
    cli.command('deploy', {
      outputPolicy: 'agent-only',
      args: z.object({ env: z.enum(['staging', 'production']) }),
      run(c) {
        return c.ok(
          { id: 'deploy-123', url: `https://${c.args.env}.example.com` },
          { cta: { commands: [{ command: 'status', description: 'Check status' }] } },
        )
      },
    })

    // Group with inherited agent-only
    const internal = Cli.create('internal', {
      description: 'Internal commands',
      outputPolicy: 'agent-only',
    })
    internal.command('sync', { run: () => ({ synced: 42, duration: '1.2s' }) })
    internal.command('healthcheck', {
      outputPolicy: 'all',
      run: () => ({ healthy: true }),
    })

    // Group without policy — children default to 'all'
    const db = Cli.create('db', { description: 'Database commands' })
    db.command('migrate', { run: () => ({ migrated: 3 }) })

    cli.command(internal)
    cli.command(db)

    // deploy: agent-only suppresses data, shows CTA
    const deploy = await serve(cli, ['deploy', 'staging'])
    expect(deploy.output).not.toContain('deploy-123')
    expect(deploy.output).toContain('Check status')

    // deploy --verbose: agent mode shows everything
    const deployVerbose = await serve(cli, ['deploy', 'staging', '--verbose'])
    expect(deployVerbose.output).toContain('deploy-123')
    expect(deployVerbose.output).toContain('staging.example.com')

    // deploy --json: agent mode shows data
    const deployJson = await serve(cli, ['deploy', 'staging', '--json'])
    expect(deployJson.output).toContain('deploy-123')

    // internal sync: inherits agent-only from group
    const sync = await serve(cli, ['internal', 'sync'])
    expect(sync.output).toBe('')

    // internal sync --json: agent mode works
    const syncJson = await serve(cli, ['internal', 'sync', '--json'])
    expect(syncJson.output).toContain('42')

    // internal healthcheck: overrides to 'all'
    const health = await serve(cli, ['internal', 'healthcheck'])
    expect(health.output).toContain('healthy: true')

    // db migrate: no policy, defaults to 'all'
    const migrate = await serve(cli, ['db', 'migrate'])
    expect(migrate.output).toContain('migrated: 3')
  })

  test('e2e: agent-only with streaming and error in nested group', async () => {
    const cli = Cli.create('tool')
    const ops = Cli.create('ops', {
      description: 'Operations',
      outputPolicy: 'agent-only',
    })

    ops.command('logs', {
      async *run() {
        yield { line: 'Starting...' }
        yield { line: 'Processing...' }
        yield { line: 'Done.' }
      },
    })

    ops.command('restart', {
      run(c) {
        return c.error({ code: 'PERMISSION_DENIED', message: 'Requires admin role' })
      },
    })

    cli.command(ops)

    // Streaming: agent-only suppresses chunks in human mode
    const logs = await serve(cli, ['ops', 'logs'])
    expect(logs.output).toBe('')

    // Streaming: --format jsonl still works
    const logsJsonl = await serve(cli, ['ops', 'logs', '--format', 'jsonl'])
    expect(logsJsonl.output).toContain('"type":"chunk"')
    expect(logsJsonl.output).toContain('Starting...')

    // Errors still display in human mode despite agent-only
    const restart = await serve(cli, ['ops', 'restart'])
    expect(restart.output).toContain('Error (PERMISSION_DENIED): Requires admin role')
    expect(restart.exitCode).toBe(1)
  })
})
