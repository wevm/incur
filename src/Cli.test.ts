import { Cli, Errors, z } from 'incur'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

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

function createConfigCli(flag?: string) {
  const project = Cli.create('project').command('list', {
    options: z.object({
      label: z.array(z.string()).default([]),
      limit: z.number().default(10),
    }),
    run(c) {
      return c.options
    },
  })

  const cli = Cli.create('test', {
    config: flag !== undefined ? { flag } : {},
    options: z.object({
      rootValue: z.string().default('root-default'),
    }),
    run(c) {
      return c.options
    },
  })

  cli.command('echo', {
    options: z.object({
      prefix: z.string().default(''),
      upper: z.boolean().default(false),
    }),
    run(c) {
      return c.options
    },
  })

  cli.command(project)

  return cli
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

describe('config defaults', () => {
  let cwd: string
  let dir: string

  beforeEach(async () => {
    cwd = process.cwd()
    dir = await mkdtemp(join(tmpdir(), 'incur-config-'))
    process.chdir(dir)
  })

  afterEach(async () => {
    process.chdir(cwd)
    await rm(dir, { force: true, recursive: true })
  })

  test('auto-loads <cli>.json for leaf commands', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        commands: {
          echo: {
            options: {
              prefix: 'cfg',
              upper: true,
            },
          },
        },
      }),
    )

    const { output } = await serve(createConfigCli(), ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'cfg', upper: true })
  })

  test('ignores a missing auto config file', async () => {
    const { output } = await serve(createConfigCli(), ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: '', upper: false })
  })

  test('root options coexist with subcommand keys', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        options: { rootValue: 'cfg-root' },
        commands: {
          echo: { options: { prefix: 'cfg' } },
        },
      }),
    )

    const rootResult = await serve(createConfigCli(), ['--json'])
    expect(JSON.parse(rootResult.output)).toEqual({ rootValue: 'cfg-root' })

    const echoResult = await serve(createConfigCli(), ['echo', '--json'])
    expect(JSON.parse(echoResult.output)).toEqual({ prefix: 'cfg', upper: false })
  })

  test('walks nested command sections in config tree', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        commands: {
          project: {
            commands: {
              list: {
                options: {
                  label: ['cfg'],
                  limit: 25,
                },
              },
            },
          },
        },
      }),
    )

    const { output } = await serve(createConfigCli(), ['project', 'list', '--json'])
    expect(JSON.parse(output)).toEqual({ label: ['cfg'], limit: 25 })
  })

  test('uses an explicit --config path instead of the auto file', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        commands: { echo: { options: { prefix: 'auto' } } },
      }),
    )
    await writeFile(
      join(dir, 'custom.json'),
      JSON.stringify({
        commands: { echo: { options: { prefix: 'custom', upper: true } } },
      }),
    )

    const { output } = await serve(createConfigCli('config'), [
      'echo',
      '--config',
      'custom.json',
      '--json',
    ])
    expect(JSON.parse(output)).toEqual({ prefix: 'custom', upper: true })
  })

  test('--no-config disables earlier config flags, and a later --config wins again', async () => {
    await writeFile(
      join(dir, 'one.json'),
      JSON.stringify({
        commands: { echo: { options: { prefix: 'one' } } },
      }),
    )
    await writeFile(
      join(dir, 'two.json'),
      JSON.stringify({
        commands: { echo: { options: { prefix: 'two' } } },
      }),
    )

    const first = await serve(createConfigCli('config'), [
      'echo',
      '--config',
      'one.json',
      '--no-config',
      '--json',
    ])
    expect(JSON.parse(first.output)).toEqual({ prefix: '', upper: false })

    const second = await serve(createConfigCli('config'), [
      'echo',
      '--config',
      'one.json',
      '--no-config',
      '--config=two.json',
      '--json',
    ])
    expect(JSON.parse(second.output)).toEqual({ prefix: 'two', upper: false })
  })

  test('fails when an explicit config file is missing', async () => {
    const { exitCode, output } = await serve(createConfigCli('config'), [
      'echo',
      '--config',
      'missing.json',
    ])
    expect(exitCode).toBe(1)
    expect(output).toContain('Config file not found')
  })

  test('fails on invalid JSON config files', async () => {
    await writeFile(join(dir, 'test.json'), '{ invalid')

    const { exitCode, output } = await serve(createConfigCli(), ['echo'])
    expect(exitCode).toBe(1)
    expect(output).toContain('Invalid JSON config file')
  })

  test('fails when the config file top level is not an object', async () => {
    await writeFile(join(dir, 'test.json'), JSON.stringify(['bad']))

    const { exitCode, output } = await serve(createConfigCli(), ['echo'])
    expect(exitCode).toBe(1)
    expect(output).toContain('expected a top-level object')
  })

  test('fails when the selected config section is not an object', async () => {
    await writeFile(join(dir, 'test.json'), JSON.stringify({ commands: { echo: true } }))

    const { exitCode, output } = await serve(createConfigCli(), ['echo'])
    expect(exitCode).toBe(1)
    expect(output).toContain("Invalid config section for 'echo'")
  })

  test('fails validation when config option values are invalid', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        commands: { echo: { options: { upper: 'nope' } } },
      }),
    )

    const { exitCode, output } = await serve(createConfigCli(), ['echo'])
    expect(exitCode).toBe(1)
    expect(output).toContain('VALIDATION_ERROR')
  })

  test('argv overrides invalid config values at the CLI layer', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        commands: { echo: { options: { prefix: 123 } } },
      }),
    )

    const { output } = await serve(createConfigCli(), ['echo', '--prefix', 'cli', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'cli', upper: false })
  })

  test('built-in commands ignore config loading', async () => {
    await writeFile(join(dir, 'test.json'), '{ invalid')

    const { output, exitCode } = await serve(createConfigCli(), ['--help'])
    expect(exitCode).toBeUndefined()
    expect(output).toContain('Global Options:')
  })

  test('config without flag does not reserve --config', async () => {
    const cli = Cli.create('test', { config: {} })
    cli.command('echo', {
      options: z.object({ config: z.string().default('') }),
      run(c) {
        return c.options
      },
    })

    const { output } = await serve(cli, ['echo', '--config', 'my-value', '--json'])
    expect(JSON.parse(output)).toEqual({ config: 'my-value' })
  })

  test('--help shows config flags only when flag name is set', async () => {
    const { output } = await serve(createConfigCli('config'), ['--help'])
    expect(output).toContain('--config <path>')
    expect(output).toContain('--no-config')

    const { output: noFlagOutput } = await serve(createConfigCli(), ['--help'])
    expect(noFlagOutput).not.toContain('--config')
  })

  test('custom flag name is used for config path override', async () => {
    await writeFile(
      join(dir, 'custom.json'),
      JSON.stringify({
        commands: { echo: { options: { prefix: 'custom' } } },
      }),
    )

    const { output } = await serve(createConfigCli('settings'), [
      'echo',
      '--settings',
      'custom.json',
      '--json',
    ])
    expect(JSON.parse(output)).toEqual({ prefix: 'custom', upper: false })
  })

  test('searches files list in order, first match wins', async () => {
    await writeFile(
      join(dir, '.testrc.json'),
      JSON.stringify({ commands: { echo: { options: { prefix: 'rc' } } } }),
    )

    const cli = Cli.create('test', {
      config: { files: ['test.json', '.testrc.json'] },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'rc' })
  })

  test('files: [] disables auto-discovery', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({ commands: { echo: { options: { prefix: 'should-not-load' } } } }),
    )

    const cli = Cli.create('test', {
      config: { files: [] },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: '' })
  })

  test('files supports ~ for home directory', async () => {
    const configDir = join(homedir(), '.config', 'test-incur-files-tilde')
    await mkdir(configDir, { recursive: true })
    try {
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({ commands: { echo: { options: { prefix: 'home' } } } }),
      )

      const cli = Cli.create('test', {
        config: { files: ['test.json', '~/.config/test-incur-files-tilde/config.json'] },
      })
      cli.command('echo', {
        options: z.object({ prefix: z.string().default('') }),
        run: (c) => c.options,
      })

      const { output } = await serve(cli, ['echo', '--json'])
      expect(JSON.parse(output)).toEqual({ prefix: 'home' })
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  })

  test('explicit --flag overrides files list', async () => {
    await writeFile(
      join(dir, '.testrc.json'),
      JSON.stringify({ commands: { echo: { options: { prefix: 'rc' } } } }),
    )
    await writeFile(
      join(dir, 'override.json'),
      JSON.stringify({ commands: { echo: { options: { prefix: 'override' } } } }),
    )

    const cli = Cli.create('test', {
      config: { flag: 'config', files: ['.testrc.json'] },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--config', 'override.json', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'override' })
  })

  test('custom loader replaces JSON parsing', async () => {
    await writeFile(join(dir, 'test.ini'), 'prefix=ini-value')

    const cli = Cli.create('test', {
      config: {
        files: ['test.ini'],
        async loader(path) {
          if (!path) return undefined
          const raw = await readFile(path, 'utf8')
          const obj: Record<string, unknown> = {}
          for (const line of raw.split('\n')) {
            const eq = line.indexOf('=')
            if (eq !== -1) obj[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
          }
          return { commands: { echo: { options: obj } } }
        },
      },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'ini-value' })
  })

  test('loader with files: [] receives undefined path', async () => {
    const cli = Cli.create('test', {
      config: {
        files: [],
        loader: async (path) => {
          expect(path).toBeUndefined()
          return { commands: { echo: { options: { prefix: 'from-loader' } } } }
        },
      },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'from-loader' })
  })

  test('loader returning undefined applies no defaults', async () => {
    const cli = Cli.create('test', {
      config: { files: [], loader: async () => undefined },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: '' })
  })

  test('--no-flag skips loader entirely', async () => {
    let loaderCalled = false
    const cli = Cli.create('test', {
      config: {
        flag: 'config',
        files: [],
        loader: async () => {
          loaderCalled = true
          return { commands: { echo: { options: { prefix: 'should-not-load' } } } }
        },
      },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--no-config', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: '' })
    expect(loaderCalled).toBe(false)
  })

  test('loader errors propagate', async () => {
    const cli = Cli.create('test', {
      config: {
        files: [],
        loader: async () => {
          throw new Error('Remote config server unreachable')
        },
      },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { exitCode, output } = await serve(cli, ['echo'])
    expect(exitCode).toBe(1)
    expect(output).toContain('Remote config server unreachable')
  })

  test('--no-flag disables auto-discovery without prior --flag', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({ commands: { echo: { options: { prefix: 'auto-loaded' } } } }),
    )

    const { output } = await serve(createConfigCli('config'), ['echo', '--no-config', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: '', upper: false })
  })

  test('--config without a value produces an error', async () => {
    const { exitCode, output } = await serve(createConfigCli('config'), ['echo', '--config'])
    expect(exitCode).toBe(1)
    expect(output).toContain('Missing value for flag')
  })

  test('--config= (empty value) produces an error', async () => {
    const { exitCode, output } = await serve(createConfigCli('config'), ['echo', '--config='])
    expect(exitCode).toBe(1)
    expect(output).toContain('Missing value for flag')
  })

  test('--no-settings works with custom flag name', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({ commands: { echo: { options: { prefix: 'auto' } } } }),
    )

    const { output } = await serve(createConfigCli('settings'), ['echo', '--no-settings', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: '', upper: false })
  })

  test('camelCase config keys are accepted at cli level', async () => {
    const cli = Cli.create('test', { config: {} })
    cli.command('echo', {
      options: z.object({ saveDev: z.boolean().default(false) }),
      run: (c) => c.options,
    })

    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({ commands: { echo: { options: { 'save-dev': true } } } }),
    )

    const { output } = await serve(cli, ['echo', '--json'])
    expect(JSON.parse(output)).toEqual({ saveDev: true })
  })

  test('config defaults with only subcommand namespaces yields no option defaults', async () => {
    await writeFile(
      join(dir, 'test.json'),
      JSON.stringify({
        commands: {
          echo: { options: { prefix: 'child' } },
          project: { commands: { list: { options: { limit: 50 } } } },
        },
      }),
    )

    const rootResult = await serve(createConfigCli(), ['--json'])
    expect(JSON.parse(rootResult.output)).toEqual({ rootValue: 'root-default' })
  })

  test('explicit --flag path is forwarded to custom loader', async () => {
    await writeFile(join(dir, 'custom.dat'), 'prefix=custom-loader')

    const cli = Cli.create('test', {
      config: {
        flag: 'config',
        async loader(path) {
          if (!path) return undefined
          const raw = await readFile(path, 'utf8')
          const [, value] = raw.split('=')
          return { commands: { echo: { options: { prefix: value!.trim() } } } }
        },
      },
    })
    cli.command('echo', {
      options: z.object({ prefix: z.string().default('') }),
      run: (c) => c.options,
    })

    const { output } = await serve(cli, ['echo', '--config', 'custom.dat', '--json'])
    expect(JSON.parse(output)).toEqual({ prefix: 'custom-loader' })
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
      message: 'nonexistent' is not a command for 'test'.
      cta:
        description: "Suggested command:"
        commands[1]{command,description}:
          test --help,see all available commands
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
      "Error: 'nonexistent' is not a command for 'test'.

      Suggested command:
        test --help  # see all available commands
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
        message: 'nonexistent' is not a command for 'test'.
      meta:
        command: nonexistent
        cta:
          description: "Suggested command:"
          commands[1]{command,description}:
            test --help,see all available commands
        duration: <stripped>
      "
    `)
  })

  test('suggests similar command for typos', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', { run: () => ({}) })
    cli.command('status', { run: () => ({}) })

    const { output, exitCode } = await serve(cli, ['deplyo'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: 'deplyo' is not a command for 'test'. Did you mean 'deploy'?
      cta:
        description: "Suggested commands:"
        commands[2]:
          - command: test deploy
          - command: test --help
            description: see all available commands
      "
    `)
  })

  test('suggests similar command for typos in TTY', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    cli.command('deploy', { run: () => ({}) })

    const { output, exitCode } = await serve(cli, ['deplyo'])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "Error: 'deplyo' is not a command for 'test'. Did you mean 'deploy'?

      Suggested commands:
        test deploy
        test --help  # see all available commands
      "
    `)
  })

  test('suggests builtin commands for typos', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({}) })

    const { output, exitCode } = await serve(cli, ['mpc'])
    expect(exitCode).toBe(1)
    expect(output).toContain("Did you mean 'mcp'?")
    expect(output).toContain('test mcp')
  })

  test('preserves flags in suggestion CTA', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', { run: () => ({}) })

    const { output } = await serve(cli, ['deplyo', '--verbose'])
    expect(output).toContain('test deploy --verbose')
  })

  test('no suggestion when input is too far from any command', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', { run: () => ({}) })

    const { output } = await serve(cli, ['xyz'])
    expect(output).not.toContain('Did you mean')
  })

  test('suggests similar subcommand for typos', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr')
      .command('list', { run: () => ({}) })
      .command('create', { run: () => ({}) })
    cli.command(pr)

    const { output, exitCode } = await serve(cli, ['pr', 'craete'])
    expect(exitCode).toBe(1)
    expect(output).toMatchInlineSnapshot(`
      "code: COMMAND_NOT_FOUND
      message: 'craete' is not a command for 'test pr'. Did you mean 'create'?
      cta:
        description: "Suggested commands:"
        commands[2]:
          - command: test pr create
          - command: test pr --help
            description: see all available commands
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

describe('--llms-full', () => {
  test('outputs manifest with version and commands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
    const manifest = JSON.parse(output)
    expect(manifest.commands[0].name).toBe('pr review approve')
    expect(manifest.commands[0].description).toBe('Approve a review')
  })

  test('defaults to markdown format', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms-full'])
    expect(output).toContain('# test ping')
    expect(output).toContain('Health check')
  })

  test('respects --format yaml', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['--llms-full', '--format', 'yaml'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'md'])
    expect(output).toContain('# test greet')
    expect(output).toContain('## Arguments')
    expect(output).toContain('## Output')
    expect(output).not.toMatch(/^---$/m)
  })
})

describe('--llms', () => {
  test('outputs compact command index', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({}) })
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string() }),
      run: () => ({}),
    })

    const { output } = await serve(cli, ['--llms-full'])
    expect(output).toMatchInlineSnapshot(`
      "# test greet

      Greet someone

      ## Arguments

      | Name | Type | Required | Description |
      |------|------|----------|-------------|
      | \`name\` | \`string\` | yes |  |

      # test ping

      Health check
      "
    `)
  })

  test('--llms --json strips schemas', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      description: 'Greet someone',
      args: z.object({ name: z.string() }),
      output: z.object({ message: z.string() }),
      run: () => ({ message: 'hi' }),
    })

    const { output } = await serve(cli, ['--llms', '--json'])
    const manifest = JSON.parse(output)
    expect(manifest.version).toBe('incur.v1')
    expect(manifest.commands).toHaveLength(1)
    expect(manifest.commands[0].name).toBe('greet')
    expect(manifest.commands[0].description).toBe('Greet someone')
    expect(manifest.commands[0].schema).toBeUndefined()
    expect(manifest.commands[0].examples).toBeUndefined()
  })

  test('scopes to subtree', async () => {
    const cli = Cli.create('test')
    const group = Cli.create('auth', { description: 'Authentication' })
    group.command('login', { description: 'Log in', run: () => ({}) })
    group.command('logout', { description: 'Log out', run: () => ({}) })
    cli.command(group)
    cli.command('ping', { description: 'Health check', run: () => ({}) })

    const { output } = await serve(cli, ['auth', '--llms'])
    expect(output).toContain('test auth auth login')
    expect(output).toContain('test auth auth logout')
    expect(output).not.toContain('ping')
  })
})

describe('--schema', () => {
  test('returns command schema in toon format', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string().describe('Name to greet') }),
      options: z.object({ loud: z.boolean().default(false).describe('Shout') }),
      output: z.object({ message: z.string() }),
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })
    const { output } = await serve(cli, ['greet', '--schema'])
    expect(output).toContain('args')
    expect(output).toContain('options')
    expect(output).toContain('output')
  })

  test('returns command schema as JSON', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string().describe('Name to greet') }),
      options: z.object({ loud: z.boolean().default(false).describe('Shout') }),
      output: z.object({ message: z.string() }),
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })
    const { output } = await serve(cli, ['greet', '--schema', '--format', 'json'])
    expect(JSON.parse(output)).toMatchInlineSnapshot(`
      {
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
              "description": "Shout",
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
      }
    `)
  })

  test('on root command', async () => {
    const cli = Cli.create('test', {
      args: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      run(c) {
        return { greeting: `hi ${c.args.name}` }
      },
    })
    const { output } = await serve(cli, ['--schema', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.args).toBeDefined()
    expect(parsed.output).toBeDefined()
  })

  test('on unknown command shows error', async () => {
    const cli = Cli.create('test')
    cli.command('greet', { run: () => ({}) })
    const { output, exitCode } = await serve(cli, ['nope', '--schema'])
    expect(output).toContain("'nope' is not a command")
    expect(exitCode).toBe(1)
  })

  test('on unknown command suggests similar', async () => {
    const cli = Cli.create('test')
    cli.command('greet', { run: () => ({}) })
    const { output, exitCode } = await serve(cli, ['grete', '--schema'])
    expect(output).toContain("Did you mean 'greet'?")
    expect(exitCode).toBe(1)
  })

  test('on group shows available commands', async () => {
    const cli = Cli.create('test')
    const pr = Cli.create('pr', { description: 'PR management' }).command('list', {
      description: 'List PRs',
      run: () => ({ items: [] }),
    })
    cli.command(pr)
    const { output } = await serve(cli, ['pr', '--schema'])
    expect(output).toContain('pr')
    expect(output).toContain('list')
  })

  test('omits empty schema sections', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['ping', '--schema', '--format', 'json'])
    expect(JSON.parse(output)).toMatchInlineSnapshot('{}')
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
      message: 'unknown' is not a command for 'test pr'.
      cta:
        description: "Suggested command:"
        commands[1]{command,description}:
          test pr --help,see all available commands
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
      "Error: 'unknown' is not a command for 'test pr'.

      Suggested command:
        test pr --help  # see all available commands
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
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
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
      description: 'Suggested command:',
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

      Integrations:
        completions  Generate shell completion script
        mcp add      Register as MCP server
        skills add   Sync skill files to agents

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
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

      Integrations:
        completions  Generate shell completion script
        mcp add      Register as MCP server
        skills add   Sync skill files to agents

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
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
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
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
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope
      "
    `)
  })

  test('root command with required args shows help when no args provided (human)', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('fetch', {
      description: 'Fetch a URL',
      args: z.object({ url: z.string().describe('URL to fetch') }),
      run: ({ args }) => args.url,
    })
    const { output, exitCode } = await serve(cli, [])
    ;(process.stdout as any).isTTY = false
    expect(exitCode).toBeUndefined()
    expect(output).toContain('fetch — Fetch a URL')
    expect(output).toContain('Usage: fetch <url>')
  })

  test('root command with optional args runs command when no args provided (human)', async () => {
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('fetch', {
      description: 'Fetch a URL',
      args: z.object({ url: z.string().optional().describe('URL to fetch') }),
      run: ({ args }) => args.url ?? 'no url',
    })
    const { output } = await serve(cli, [])
    ;(process.stdout as any).isTTY = false
    expect(output).toContain('no url')
  })

  test('root command with optional args runs command when no args provided (agent)', async () => {
    const cli = Cli.create('fetch', {
      description: 'Fetch a URL',
      args: z.object({ url: z.string().optional().describe('URL to fetch') }),
      run: ({ args }) => args.url ?? 'no url',
    })
    const { output } = await serve(cli, [])
    expect(output).toContain('no url')
  })

  test('invalid subcommand in group returns COMMAND_NOT_FOUND instead of falling through to root', async () => {
    const cli = Cli.create('tool', {
      args: z.object({ url: z.string().describe('URL') }),
      run: ({ args }) => ({ url: args.url }),
    })
    const auth = Cli.create('auth').command('login', { run: () => ({ ok: true }) })
    cli.command(auth)

    const { output, exitCode } = await serve(cli, ['auth', 'badcmd', '--format', 'json'])
    expect(exitCode).toBe(1)
    const parsed = JSON.parse(output)
    expect(parsed.code).toBe('COMMAND_NOT_FOUND')
    expect(parsed.message).toContain('badcmd')
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
      "tool@1.2.3

      Usage: tool <command>

      Commands:
        ping  Ping

      Integrations:
        completions  Generate shell completion script
        mcp add      Register as MCP server
        skills add   Sync skill files to agents

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --mcp                               Start as MCP stdio server
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
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
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
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

      Global Options:
        --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
        --format <toon|json|yaml|md|jsonl>  Output format
        --help                              Show help
        --llms, --llms-full                 Print LLM-readable manifest
        --schema                            Show JSON Schema for command
        --token-count                       Print token count of output (instead of output)
        --token-limit <n>                   Limit output to n tokens
        --token-offset <n>                  Skip first n tokens of output
        --verbose                           Show full output envelope

      Environment Variables:
        API_TOKEN  Auth token
        API_URL    API URL (default: https://api.example.com)
      "
    `)
  })

  test('--help shows (set) for env vars present in process.env', async () => {
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

    process.env.API_TOKEN = 'secret'
    try {
      const { output } = await serve(cli, ['deploy', '--help'])
      expect(output).toMatchInlineSnapshot(`
        "test deploy

        Usage: test deploy

        Global Options:
          --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
          --format <toon|json|yaml|md|jsonl>  Output format
          --help                              Show help
          --llms, --llms-full                 Print LLM-readable manifest
          --schema                            Show JSON Schema for command
          --token-count                       Print token count of output (instead of output)
          --token-limit <n>                   Limit output to n tokens
          --token-offset <n>                  Skip first n tokens of output
          --verbose                           Show full output envelope

        Environment Variables:
          API_TOKEN  Auth token (set: ****cret)
          API_URL    API URL (default: https://api.example.com)
        "
      `)

      // Both set and default shown together
      process.env.API_URL = 'https://custom.example.com'
      const { output: output2 } = await serve(cli, ['deploy', '--help'])
      expect(output2).toContain(
        'API_URL    API URL (set: ****.com, default: https://api.example.com)',
      )
    } finally {
      delete process.env.API_TOKEN
      delete process.env.API_URL
    }
  })

  test('--help respects env source override for set display', async () => {
    const cli = Cli.create('test')
    cli.command('deploy', {
      env: z.object({
        API_TOKEN: z.string().describe('Auth token'),
      }),
      run() {
        return {}
      },
    })

    // When env source override does not include the var, "set:" should not appear
    const { output } = await serve(cli, ['deploy', '--help'], { env: {} })
    expect(output).toContain('API_TOKEN  Auth token')
    expect(output).not.toContain('set:')

    // When env source override includes the var, "set:" should appear
    const { output: output2 } = await serve(cli, ['deploy', '--help'], {
      env: { API_TOKEN: 'secret' },
    })
    expect(output2).toContain('set: ****cret')
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

    const { output } = await serve(cli, ['--llms-full', '--format', 'json'])
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

    const { output } = await serve(cli, ['--llms-full'])
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

describe('built-in commands', () => {
  test('bare completions shows help', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['completions'])
    expect(output).toContain('Generate shell completion script')
  })

  test('completions --help shows help', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['completions', '--help'])
    expect(output).toContain('test completions')
    expect(output).toContain('Generate shell completion script')
  })

  test('bare mcp shows help with subcommands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['mcp'])
    expect(output).toContain('test mcp')
    expect(output).toContain('Register as MCP server')
    expect(output).toContain('add')
  })

  test('mcp --help shows help with subcommands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['mcp', '--help'])
    expect(output).toContain('test mcp')
    expect(output).toContain('add')
  })

  test('mcp add --help shows options', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['mcp', 'add', '--help'])
    expect(output).toContain('test mcp add')
    expect(output).toContain('--command')
    expect(output).toContain('--no-global')
    expect(output).toContain('--agent')
  })

  test('bare skills shows help with subcommands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['skills'])
    expect(output).toContain('test skills')
    expect(output).toContain('Sync skill files to agents')
    expect(output).toContain('add')
  })

  test('skills --help shows help with subcommands', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['skills', '--help'])
    expect(output).toContain('test skills')
    expect(output).toContain('add')
  })

  test('skills typo suggests add', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({}) })
    const { output, exitCode } = await serve(cli, ['skills', 'addd'])
    expect(exitCode).toBe(1)
    expect(output).toContain("Did you mean 'add'?")
    expect(output).toContain('test skills add')
    expect(output).toContain('test skills --help')
  })

  test('mcp typo suggests add', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({}) })
    const { output, exitCode } = await serve(cli, ['mcp', 'addd'])
    expect(exitCode).toBe(1)
    expect(output).toContain("Did you mean 'add'?")
    expect(output).toContain('test mcp add')
  })

  test('skills add --help shows options', async () => {
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })
    const { output } = await serve(cli, ['skills', 'add', '--help'])
    expect(output).toContain('test skills add')
    expect(output).toContain('--depth')
    expect(output).toContain('--no-global')
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
    __mockSkillsHash = undefined
  })

  test('includes skills CTA when stale', async () => {
    __mockSkillsHash = '0000000000000000'
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).toContain('Skills are out of date:')
    expect(output).toContain('skills add')
  })

  test('merges skills CTA with command CTA', async () => {
    __mockSkillsHash = '0000000000000000'
    ;(process.stdout as any).isTTY = true
    const cli = Cli.create('test')
    cli.command('ping', {
      description: 'Health check',
      run: (c) => c.ok({ pong: true }, { cta: { commands: ['status'] } }),
    })

    const { output } = await serve(cli, ['ping'])
    ;(process.stdout as any).isTTY = false
    expect(output).toContain('status')
    expect(output).toContain('skills add')
  })

  test('does not warn when hash matches', async () => {
    const { Skill } = await import('incur')
    __mockSkillsHash = Skill.hash([{ name: 'ping', description: 'Health check' }])
    const cli = Cli.create('test')
    cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).not.toContain('Skills are out of date')
  })

  test('does not warn when no hash stored', async () => {
    __mockSkillsHash = undefined
    const cli = Cli.create('test')
    cli.command('ping', { run: () => ({ pong: true }) })

    const { output } = await serve(cli, ['ping'])
    expect(output).not.toContain('Skills are out of date')
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

    const { output } = await serve(cli, ['--help'])
    expect(output).not.toContain('Skills are out of date')
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

  test('streaming respects CLI-level default format json', async () => {
    const cli = Cli.create('test', { format: 'json' })
    cli.command('stream', {
      async *run() {
        yield { step: 1 }
        yield { step: 2 }
      },
    })

    const { output } = await serve(cli, ['stream'])
    expect(output).toContain('"step": 1')
    expect(output).toContain('"step": 2')
    expect(output).not.toContain('step: 1') // should not be toon format
  })

  test('streaming respects CLI-level default format jsonl', async () => {
    const cli = Cli.create('test', { format: 'jsonl' })
    cli.command('stream', {
      async *run() {
        yield { step: 1 }
        yield { step: 2 }
      },
    })

    const { output } = await serve(cli, ['stream'])
    expect(output).toContain('{"type":"chunk","data":{"step":1}}')
    expect(output).toContain('{"type":"chunk","data":{"step":2}}')
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

  test('e2e: middleware runs in order around handler', async () => {
    const order: string[] = []
    const cli = Cli.create('test')
      .use(async (_c, next) => {
        order.push('mw1:before')
        await next()
        order.push('mw1:after')
      })
      .use(async (_c, next) => {
        order.push('mw2:before')
        await next()
        order.push('mw2:after')
      })
      .command('ping', {
        run() {
          order.push('handler')
          return { pong: true }
        },
      })

    const { output } = await serve(cli, ['ping'])
    expect(output).toContain('pong: true')
    expect(order).toEqual(['mw1:before', 'mw2:before', 'handler', 'mw2:after', 'mw1:after'])
  })

  test('e2e: middleware can short-circuit by not calling next', async () => {
    const cli = Cli.create('test')
      .use(async (_c, _next) => {
        throw new Errors.IncurError({ code: 'FORBIDDEN', message: 'nope' })
      })
      .command('deploy', {
        run() {
          return { deployed: true }
        },
      })

    const { output, exitCode } = await serve(cli, ['deploy'])
    expect(output).toContain('FORBIDDEN')
    expect(output).toContain('nope')
    expect(exitCode).toBe(1)
  })

  test('e2e: group-scoped middleware only runs for group commands', async () => {
    const order: string[] = []
    const admin = Cli.create('admin', { description: 'Admin' })
      .use(async (_c, next) => {
        order.push('admin-mw')
        await next()
      })
      .command('reset', {
        run() {
          return { reset: true }
        },
      })

    const cli = Cli.create('test')
      .use(async (_c, next) => {
        order.push('root-mw')
        await next()
      })
      .command('ping', { run: () => ({ pong: true }) })
      .command(admin)

    // Group command: both root + admin middleware run
    order.length = 0
    await serve(cli, ['admin', 'reset'])
    expect(order).toEqual(['root-mw', 'admin-mw'])

    // Non-group command: only root middleware runs
    order.length = 0
    await serve(cli, ['ping'])
    expect(order).toEqual(['root-mw'])
  })

  test('e2e: vars with defaults and middleware set()', async () => {
    const cli = Cli.create('test', {
      vars: z.object({
        requestId: z.string().default('default-id'),
        user: z.string().default('anon'),
      }),
    })
      .use(async (c, next) => {
        c.set('user', 'alice')
        await next()
      })
      .command('whoami', {
        run(c) {
          return { user: c.var.user, requestId: c.var.requestId }
        },
      })

    const { output } = await serve(cli, ['whoami'])
    expect(output).toContain('user: alice')
    expect(output).toContain('requestId: default-id')
  })

  test('e2e: middleware does not run for --help', async () => {
    let middlewareRan = false
    const cli = Cli.create('test')
      .use(async (_c, next) => {
        middlewareRan = true
        await next()
      })
      .command('ping', { description: 'Ping', run: () => ({ pong: true }) })

    await serve(cli, ['--help'])
    expect(middlewareRan).toBe(false)

    await serve(cli, ['ping', '--help'])
    expect(middlewareRan).toBe(false)
  })

  test('e2e: middleware receives parsed CLI-level env', async () => {
    let capturedEnv: any
    const cli = Cli.create('test', {
      env: z.object({
        API_TOKEN: z.string(),
        API_URL: z.string().default('https://api.example.com'),
      }),
    })
      .use(async (c, next) => {
        capturedEnv = c.env
        await next()
      })
      .command('deploy', { run: () => ({ ok: true }) })

    await serve(cli, ['deploy'], { env: { API_TOKEN: 'secret-123' } })
    expect(capturedEnv).toEqual({ API_TOKEN: 'secret-123', API_URL: 'https://api.example.com' })
  })

  test('e2e: CLI-level env validation error before middleware runs', async () => {
    const cli = Cli.create('test', {
      env: z.object({ API_TOKEN: z.string() }),
    })
      .use(async (_c, next) => {
        await next()
      })
      .command('deploy', { run: () => ({ ok: true }) })

    const { output, exitCode } = await serve(cli, ['deploy'], { env: {} })
    expect(exitCode).toBe(1)
    expect(output).toContain('Error')
  })

  test('e2e: per-command middleware receives parsed CLI-level env', async () => {
    let capturedEnv: any
    const cli = Cli.create('test', {
      env: z.object({
        API_TOKEN: z.string(),
      }),
    }).command('deploy', {
      middleware: [
        async (c, next) => {
          capturedEnv = c.env
          await next()
        },
      ],
      run: () => ({ ok: true }),
    })

    await serve(cli, ['deploy'], { env: { API_TOKEN: 'from-cmd-mw' } })
    expect(capturedEnv).toEqual({ API_TOKEN: 'from-cmd-mw' })
  })

  test('e2e: CLI-level env available without middleware', async () => {
    const cli = Cli.create('test', {
      env: z.object({ API_TOKEN: z.string() }),
    }).command('deploy', { run: () => ({ ok: true }) })

    // Validation still runs even without middleware
    const { exitCode } = await serve(cli, ['deploy'], { env: {} })
    expect(exitCode).toBe(1)
  })

  test('e2e: middleware context has correct agent and command', async () => {
    let captured: { agent: boolean; command: string } | undefined
    const cli = Cli.create('test')
      .use(async (c, next) => {
        captured = { agent: c.agent, command: c.command }
        await next()
      })
      .command('deploy', { run: () => ({ ok: true }) })

    await serve(cli, ['deploy'])
    expect(captured).toEqual({ agent: false, command: 'deploy' })
  })

  test('e2e: middleware and run context expose format metadata', async () => {
    let mwCaptured:
      | {
          format: string
          formatExplicit: boolean
        }
      | undefined
    let runCaptured:
      | {
          format: string
          formatExplicit: boolean
        }
      | undefined

    const cli = Cli.create('test')
      .use(async (c, next) => {
        mwCaptured = {
          format: c.format,
          formatExplicit: c.formatExplicit,
        }
        await next()
      })
      .command('deploy', {
        run(c) {
          runCaptured = {
            format: c.format,
            formatExplicit: c.formatExplicit,
          }
          return { ok: true }
        },
      })

    await serve(cli, ['deploy', '--format', 'json'])
    expect(mwCaptured).toEqual({ format: 'json', formatExplicit: true })
    expect(runCaptured).toEqual({ format: 'json', formatExplicit: true })
  })

  test('e2e: middleware works with streaming handlers', async () => {
    const order: string[] = []
    const cli = Cli.create('test')
      .use(async (_c, next) => {
        order.push('before')
        await next()
        order.push('after')
      })
      .command('stream', {
        async *run() {
          order.push('chunk1')
          yield { n: 1 }
          order.push('chunk2')
          yield { n: 2 }
        },
      })

    const { output } = await serve(cli, ['stream'])
    expect(output).toContain('n: 1')
    expect(output).toContain('n: 2')
    expect(order).toEqual(['before', 'chunk1', 'chunk2', 'after'])
  })

  test('e2e: middleware errors propagate through catch', async () => {
    const cli = Cli.create('test')
      .use(async (_c, next) => {
        await next()
        throw new Error('after-error')
      })
      .command('ping', { run: () => ({ pong: true }) })

    const { output, exitCode } = await serve(cli, ['ping'])
    expect(output).toContain('after-error')
    expect(exitCode).toBe(1)
  })

  test('e2e: per-command middleware runs after root middleware', async () => {
    const order: string[] = []
    const cli = Cli.create('test')
      .use(async (_c, next) => {
        order.push('root')
        await next()
      })
      .command('ping', {
        middleware: [
          async (_c, next) => {
            order.push('cmd')
            await next()
          },
        ],
        run() {
          order.push('run')
          return { pong: true }
        },
      })
      .command('other', {
        run() {
          order.push('other-run')
          return { ok: true }
        },
      })

    await serve(cli, ['ping'])
    expect(order).toEqual(['root', 'cmd', 'run'])

    // per-command middleware does not run for other commands
    order.length = 0
    await serve(cli, ['other'])
    expect(order).toEqual(['root', 'other-run'])
  })

  test('e2e: per-command middleware composes with group middleware', async () => {
    const order: string[] = []
    const cli = Cli.create('test')
    const admin = Cli.create('admin', { description: 'Admin' })
      .use(async (_c, next) => {
        order.push('group')
        await next()
      })
      .command('reset', {
        middleware: [
          async (_c, next) => {
            order.push('cmd')
            await next()
          },
        ],
        run() {
          order.push('run')
          return { reset: true }
        },
      })

    cli.command(admin)
    await serve(cli, ['admin', 'reset'])
    expect(order).toEqual(['group', 'cmd', 'run'])
  })

  test('e2e: per-command middleware can short-circuit', async () => {
    const cli = Cli.create('test').command('guarded', {
      middleware: [
        async () => {
          throw new Error('blocked')
        },
      ],
      run: () => ({ ok: true }),
    })

    const { output, exitCode } = await serve(cli, ['guarded'])
    expect(output).toContain('blocked')
    expect(exitCode).toBe(1)
  })

  test('e2e: middleware error() short-circuits before run()', async () => {
    const vars = z.object({ authed: z.boolean().default(false) })
    const cli = Cli.create('test', { vars })
      .use((c, _next) => {
        if (!c.var.authed) return c.error({ code: 'DENIED', message: 'Not allowed' })
      })
      .command('secret', {
        output: z.string(),
        run: () => 'should not reach',
      })

    const { output, exitCode } = await serve(cli, ['secret'])
    expect(exitCode).toBe(1)
    expect(output).toContain('DENIED')
    expect(output).toContain('Not allowed')
    expect(output).not.toContain('should not reach')
  })

  test('e2e: middleware error() with CTA', async () => {
    const cli = Cli.create('test')
      .use((c, _next) => {
        return c.error({
          code: 'AUTH',
          message: 'Not authenticated',
          cta: {
            description: 'Log in:',
            commands: [{ command: 'auth login', description: 'Log in' }],
          },
        })
      })
      .command('deploy', { run: () => ({ ok: true }) })

    const { output, exitCode } = await serve(cli, ['deploy'])
    expect(exitCode).toBe(1)
    expect(output).toContain('AUTH')
    expect(output).toContain('Not authenticated')
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

test('--llms scoped to leaf command', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })
  cli.command('greet', { description: 'Greet someone', run: () => ({}) })

  const { output } = await serve(cli, ['--llms-full', '--format', 'json', 'ping'])
  const manifest = JSON.parse(output)
  expect(manifest.commands).toHaveLength(1)
  expect(manifest.commands[0].name).toBe('ping')
})

test('--llms scoped to group', async () => {
  const cli = Cli.create('test')
  const pr = Cli.create('pr', { description: 'PR management' })
    .command('list', { description: 'List PRs', run: () => ({}) })
    .command('create', { description: 'Create PR', run: () => ({}) })
  cli.command(pr)
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const { output } = await serve(cli, ['--llms-full', '--format', 'json', 'pr'])
  const manifest = JSON.parse(output)
  expect(manifest.commands).toHaveLength(2)
  expect(manifest.commands.every((c: any) => c.name.startsWith('pr '))).toBe(true)
})

test('--help on root with rootCommand shows command help with subcommands', async () => {
  const cli = Cli.create('tool', {
    description: 'A tool',
    args: z.object({ name: z.string().describe('Name') }),
    run: () => ({}),
  })
  cli.command('status', { description: 'Show status', run: () => ({}) })

  const { output } = await serve(cli, ['--help'])
  expect(output).toContain('tool — A tool')
  expect(output).toContain('name')
  expect(output).toContain('status')
})

test('streaming: generator yields error in incremental mode', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    async *run(c) {
      yield { step: 1 }
      yield c.error({ code: 'STREAM_ERR', message: 'mid-stream failure' })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail'])
  expect(exitCode).toBe(1)
  expect(output).toContain('STREAM_ERR')
  expect(output).toContain('mid-stream failure')
})

test('streaming: generator yields error in jsonl mode', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    async *run(c) {
      yield { step: 1 }
      yield c.error({ code: 'STREAM_ERR', message: 'mid-stream failure' })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail', '--format', 'jsonl'])
  expect(exitCode).toBe(1)
  expect(output).toContain('"type":"error"')
  expect(output).toContain('STREAM_ERR')
})

test('streaming: generator yields error in buffered mode', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    async *run(c) {
      yield { step: 1 }
      yield c.error({ code: 'BUF_ERR', message: 'buffered failure' })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail', '--format', 'json'])
  expect(exitCode).toBe(1)
  expect(output).toContain('BUF_ERR')
})

test('streaming: generator throws in buffered mode', async () => {
  const cli = Cli.create('test')
  cli.command('boom', {
    async *run() {
      yield { step: 1 }
      throw new Error('generator exploded')
    },
  })

  const { output, exitCode } = await serve(cli, ['boom', '--format', 'json'])
  expect(exitCode).toBe(1)
  expect(output).toContain('generator exploded')
})

test('streaming: generator returns error in buffered mode', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    async *run(c) {
      yield { step: 1 }
      return c.error({ code: 'RET_ERR', message: 'returned error' })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail', '--format', 'json'])
  expect(exitCode).toBe(1)
  expect(output).toContain('RET_ERR')
})

test('c.error({ exitCode }) uses custom exit code', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    run(c) {
      return c.error({ code: 'AUTH', message: 'not authed', exitCode: 10 })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail'])
  expect(exitCode).toBe(10)
  expect(output).toMatchInlineSnapshot(`
    "code: AUTH
    message: not authed
    "
  `)
})

test('c.error() without exitCode defaults to 1', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    run(c) {
      return c.error({ code: 'BAD', message: 'fail' })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail'])
  expect(exitCode).toBe(1)
  expect(output).toMatchInlineSnapshot(`
    "code: BAD
    message: fail
    "
  `)
})

test('middleware c.error({ exitCode }) uses custom exit code', async () => {
  const cli = Cli.create('test')
  cli.use((c) => {
    return c.error({ code: 'MW_ERR', message: 'blocked', exitCode: 42 })
  })
  cli.command('anything', { run: () => ({}) })

  const { output, exitCode } = await serve(cli, ['anything'])
  expect(exitCode).toBe(42)
  expect(output).toMatchInlineSnapshot(`
    "code: MW_ERR
    message: blocked
    "
  `)
})

test('thrown IncurError with exitCode uses custom exit code', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    run() {
      throw new Errors.IncurError({ code: 'RATE_LIMITED', message: 'too fast', exitCode: 99 })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail'])
  expect(exitCode).toBe(99)
  expect(output).toMatchInlineSnapshot(`
    "code: RATE_LIMITED
    message: too fast
    retryable: false
    "
  `)
})

test('streaming: c.error({ exitCode }) in yield uses custom exit code', async () => {
  const cli = Cli.create('test')
  cli.command('fail', {
    async *run(c) {
      yield { step: 1 }
      yield c.error({ code: 'STREAM_ERR', message: 'mid-stream', exitCode: 77 })
    },
  })

  const { output, exitCode } = await serve(cli, ['fail', '--format', 'jsonl'])
  expect(exitCode).toBe(77)
  expect(output).toContain('STREAM_ERR')
})

test('deprecated short flag emits warning', async () => {
  const cli = Cli.create('app').command('deploy', {
    options: z.object({
      zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
    }),
    alias: { zone: 'z' },
    run: ({ options }) => ({ zone: options.zone }),
  })

  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  ;(process.stdout as any).isTTY = true
  try {
    await serve(cli, ['deploy', '-z', 'us-east-1'])
    expect(spy).toHaveBeenCalledWith('Warning: --zone is deprecated\n')
  } finally {
    ;(process.stdout as any).isTTY = false
    spy.mockRestore()
  }
})

test('--llms includes hint in skill output', async () => {
  const cli = Cli.create('test')
  cli.command('deploy', {
    description: 'Deploy the app',
    hint: 'Always confirm before deploying to production',
    run: () => ({}),
  })

  const { output } = await serve(cli, ['--llms-full'])
  expect(output).toContain('Always confirm before deploying to production')
})

describe('fetch', async () => {
  const { app } = await import('../test/fixtures/hono-api.js')

  test('command with fetch: GET /users', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      description: 'Hono API',
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'users'])
    expect(output).toMatchInlineSnapshot(`
      "users[1]{id,name}:
        1,Alice
      limit: 10
      "
    `)
  })

  test('GET with query params', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'users', '--limit', '5'])
    expect(output).toMatchInlineSnapshot(`
      "users[1]{id,name}:
        1,Alice
      limit: 5
      "
    `)
  })

  test('GET /users/:id via path segments', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'users', '42'])
    expect(output).toMatchInlineSnapshot(`
      "id: 42
      name: Alice
      "
    `)
  })

  test('POST with -X and -d', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'users', '-X', 'POST', '-d', '{"name":"Bob"}'])
    expect(output).toMatchInlineSnapshot(`
      "created: true
      name: Bob
      "
    `)
  })

  test('implicit POST with --body', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'users', '--body', '{"name":"Eve"}'])
    expect(output).toMatchInlineSnapshot(`
      "created: true
      name: Eve
      "
    `)
  })

  test('DELETE with --method', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'users', '1', '--method', 'DELETE'])
    expect(output).toMatchInlineSnapshot(`
      "deleted: true
      id: 1
      "
    `)
  })

  test('error response → exit code 1', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { exitCode, output } = await serve(cli, ['api', 'error'])
    expect(exitCode).toBe(1)
    expect(output).toContain('HTTP_404')
  })

  test('--format json', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'health', '--format', 'json'])
    expect(JSON.parse(output)).toEqual({ ok: true })
  })

  test('--verbose includes request/response meta', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'health', '--verbose', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed.ok).toBe(true)
    expect(parsed.data).toEqual({ ok: true })
    expect(parsed.meta.command).toBe('api')
  })

  test('native + fetch commands coexist', async () => {
    const cli = Cli.create('test', { description: 'test' })
      .command('api', { fetch: app.fetch })
      .command('ping', { run: () => ({ pong: true }) })
    const { output: fetchOut } = await serve(cli, ['api', 'health'])
    expect(fetchOut).toContain('ok: true')
    const { output: nativeOut } = await serve(cli, ['ping'])
    expect(nativeOut).toContain('pong: true')
  })

  test('root-level fetch', async () => {
    const cli = Cli.create('api', { description: 'API', fetch: app.fetch })
    const { output } = await serve(cli, ['users'])
    expect(output).toMatchInlineSnapshot(`
      "users[1]{id,name}:
        1,Alice
      limit: 10
      "
    `)
  })

  test('root-level fetch with no args → root path', async () => {
    const cli = Cli.create('api', { description: 'API', fetch: app.fetch })
    // Hono returns 404 for / since we don't have a root route
    const { exitCode } = await serve(cli, [])
    expect(exitCode).toBe(1)
  })

  test('--help on fetch command', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      description: 'Proxy to Hono API',
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', '--help'])
    expect(output).toContain('Proxy to Hono API')
    expect(output).toContain('--method')
    expect(output).toContain('--header')
    expect(output).toContain('--body')
  })

  test('text response', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['api', 'text'])
    expect(output).toContain('hello world')
  })

  test('middleware runs before fetch handler', async () => {
    let middlewareRan = false
    const cli = Cli.create('test', { description: 'test' })
      .use(async (_c, next) => {
        middlewareRan = true
        await next()
      })
      .command('api', { fetch: app.fetch })
    await serve(cli, ['api', 'health'])
    expect(middlewareRan).toBe(true)
  })

  test('fetch command appears in --llms', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      description: 'Proxy to API',
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['--llms-full'])
    expect(output).toContain('api')
    expect(output).toContain('Proxy to API')
  })

  test('fetch command appears in --help root', async () => {
    const cli = Cli.create('test', { description: 'test' }).command('api', {
      description: 'Proxy to API',
      fetch: app.fetch,
    })
    const { output } = await serve(cli, ['--help'])
    expect(output).toContain('api')
    expect(output).toContain('Proxy to API')
  })
})

describe('--filter-output', () => {
  test('selects specific keys', async () => {
    const cli = Cli.create('test')
    cli.command('user', {
      run() {
        return { name: 'alice', age: 30, email: 'alice@example.com' }
      },
    })
    const { output } = await serve(cli, ['user', '--filter-output', 'name,age'])
    expect(output).toMatchInlineSnapshot(`
      "name: alice
      age: 30
      "
    `)
  })

  test('returns scalar for single key', async () => {
    const cli = Cli.create('test')
    cli.command('greet', {
      args: z.object({ name: z.string() }),
      run(c) {
        return { message: `hello ${c.args.name}` }
      },
    })
    const { output } = await serve(cli, ['greet', 'world', '--filter-output', 'message'])
    expect(output).toMatchInlineSnapshot(`
      "hello world
      "
    `)
  })

  test('dot notation filters nested keys', async () => {
    const cli = Cli.create('test')
    cli.command('profile', {
      run() {
        return { user: { name: 'alice', email: 'a@b.com' }, status: 'active' }
      },
    })
    const { output } = await serve(cli, ['profile', '--filter-output', 'user.name'])
    expect(output).toMatchInlineSnapshot(`
      "user:
        name: alice
      "
    `)
  })

  test('array slice', async () => {
    const cli = Cli.create('test')
    cli.command('list', {
      run() {
        return { items: [1, 2, 3, 4, 5] }
      },
    })
    const { output } = await serve(cli, ['list', '--filter-output', 'items[0,3]'])
    expect(output).toMatchInlineSnapshot(`
      "items[3]: 1,2,3
      "
    `)
  })

  test('works with --format json', async () => {
    const cli = Cli.create('test')
    cli.command('user', {
      run() {
        return { name: 'alice', age: 30, email: 'alice@example.com' }
      },
    })
    const { output } = await serve(cli, ['user', '--filter-output', 'name,age', '--format', 'json'])
    const parsed = JSON.parse(output)
    expect(parsed).toEqual({ name: 'alice', age: 30 })
  })
})

async function fetchJson(cli: Cli.Cli<any, any, any>, req: Request) {
  const res = await cli.fetch(req)
  const body = await res.json()
  body.meta.duration = '<stripped>'
  return { status: res.status, body }
}

describe('fetch', () => {
  test('GET /health → 200', async () => {
    const cli = Cli.create('test')
    cli.command('health', { run: () => ({ ok: true }) })
    expect(await fetchJson(cli, new Request('http://localhost/health'))).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "ok": true,
          },
          "meta": {
            "command": "health",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('GET /unknown → 404', async () => {
    const cli = Cli.create('test')
    cli.command('health', { run: () => ({}) })
    expect(await fetchJson(cli, new Request('http://localhost/unknown'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "COMMAND_NOT_FOUND",
            "message": "'unknown' is not a command for 'test'.",
          },
          "meta": {
            "command": "unknown",
            "duration": "<stripped>",
          },
          "ok": false,
        },
        "status": 404,
      }
    `)
  })

  test('GET /helath → 404 with suggestion', async () => {
    const cli = Cli.create('test')
    cli.command('health', { run: () => ({}) })
    const res = await fetchJson(cli, new Request('http://localhost/helath'))
    expect(res.status).toBe(404)
    expect(res.body.error.message).toContain("Did you mean 'health'?")
  })

  test('GET / with root command → 200', async () => {
    const cli = Cli.create('test', { run: () => ({ root: true }) })
    expect(await fetchJson(cli, new Request('http://localhost/'))).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "root": true,
          },
          "meta": {
            "command": "test",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('GET / without root command → 404', async () => {
    const cli = Cli.create('test')
    cli.command('health', { run: () => ({}) })
    expect(await fetchJson(cli, new Request('http://localhost/'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "COMMAND_NOT_FOUND",
            "message": "No root command defined.",
          },
          "meta": {
            "command": "/",
            "duration": "<stripped>",
          },
          "ok": false,
        },
        "status": 404,
      }
    `)
  })

  test('GET search params → options', async () => {
    const cli = Cli.create('test')
    cli.command('users', {
      options: z.object({ limit: z.coerce.number().default(10) }),
      run: (c) => ({ limit: c.options.limit }),
    })
    expect(await fetchJson(cli, new Request('http://localhost/users?limit=5')))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "limit": 5,
          },
          "meta": {
            "command": "users",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('POST body → options', async () => {
    const cli = Cli.create('test')
    cli.command('users', {
      options: z.object({ name: z.string() }),
      run: (c) => ({ created: true, name: c.options.name }),
    })
    const req = new Request('http://localhost/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bob' }),
    })
    expect(await fetchJson(cli, req)).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "created": true,
            "name": "Bob",
          },
          "meta": {
            "command": "users",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('trailing path segments → positional args', async () => {
    const cli = Cli.create('test')
    cli.command('users', {
      args: z.object({ id: z.coerce.number() }),
      run: (c) => ({ id: c.args.id }),
    })
    expect(await fetchJson(cli, new Request('http://localhost/users/42'))).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "id": 42,
          },
          "meta": {
            "command": "users",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('nested command resolution', async () => {
    const sub = Cli.create('users')
    sub.command('list', { run: () => ({ users: [] }) })
    const cli = Cli.create('test')
    cli.command(sub)
    expect(await fetchJson(cli, new Request('http://localhost/users/list'))).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "users": [],
          },
          "meta": {
            "command": "users list",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('validation error → 400', async () => {
    const cli = Cli.create('test')
    cli.command('users', {
      args: z.object({ id: z.coerce.number() }),
      run: (c) => ({ id: c.args.id }),
    })
    const { status, body } = await fetchJson(cli, new Request('http://localhost/users'))
    expect(status).toBe(400)
    expect(body.ok).toBe(false)
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  test('thrown error → 500', async () => {
    const cli = Cli.create('test')
    cli.command('fail', {
      run() {
        throw new Error('boom')
      },
    })
    expect(await fetchJson(cli, new Request('http://localhost/fail'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "UNKNOWN",
            "message": "boom",
          },
          "meta": {
            "command": "fail",
            "duration": "<stripped>",
          },
          "ok": false,
        },
        "status": 500,
      }
    `)
  })

  test('async generator → NDJSON streaming response', async () => {
    const cli = Cli.create('test')
    cli.command('stream', {
      async *run() {
        yield { progress: 1 }
        yield { progress: 2 }
        return { done: true }
      },
    })
    const res = await cli.fetch(new Request('http://localhost/stream'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-ndjson')
    const text = await res.text()
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(lines).toMatchInlineSnapshot(`
      [
        {
          "data": {
            "progress": 1,
          },
          "type": "chunk",
        },
        {
          "data": {
            "progress": 2,
          },
          "type": "chunk",
        },
        {
          "meta": {
            "command": "stream",
          },
          "ok": true,
          "type": "done",
        },
      ]
    `)
  })

  test('middleware sets var → command sees it', async () => {
    const cli = Cli.create('test', {
      vars: z.object({ user: z.string().default('anonymous') }),
    })
    cli.use(async (c, next) => {
      c.set('user', 'alice')
      await next()
    })
    cli.command('whoami', {
      run: (c) => ({ user: c.var.user }),
    })
    expect(await fetchJson(cli, new Request('http://localhost/whoami'))).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "user": "alice",
          },
          "meta": {
            "command": "whoami",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('middleware error → error response', async () => {
    const cli = Cli.create('test')
    cli.use((c) => {
      c.error({ code: 'UNAUTHORIZED', message: 'not allowed' })
    })
    cli.command('secret', { run: () => ({ secret: true }) })
    expect(await fetchJson(cli, new Request('http://localhost/secret'))).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "UNAUTHORIZED",
            "message": "not allowed",
          },
          "meta": {
            "command": "secret",
            "duration": "<stripped>",
          },
          "ok": false,
        },
        "status": 500,
      }
    `)
  })

  test('fetch gateway → forwards request', async () => {
    const handler = (req: Request) => {
      const url = new URL(req.url)
      return new Response(JSON.stringify({ path: url.pathname }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    const cli = Cli.create('test')
    cli.command('api', { fetch: handler })
    const res = await cli.fetch(new Request('http://localhost/api/users/list'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchInlineSnapshot(`
      {
        "path": "/api/users/list",
      }
    `)
  })

  test('group middleware runs for nested commands', async () => {
    const sub = Cli.create('admin', {
      vars: z.object({ role: z.string().default('none') }),
    })
    sub.use(async (c, next) => {
      c.set('role', 'admin')
      await next()
    })
    sub.command('status', {
      run: (c) => ({ role: c.var.role }),
    })
    const cli = Cli.create('test', {
      vars: z.object({ role: z.string().default('none') }),
    })
    cli.command(sub)
    expect(await fetchJson(cli, new Request('http://localhost/admin/status')))
      .toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "role": "admin",
          },
          "meta": {
            "command": "admin status",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('cli-level env schema is parsed', async () => {
    const cli = Cli.create('test', {
      env: z.object({ APP_TOKEN: z.string().default('fallback') }),
    })
    cli.use(async (c, next) => {
      // env should be parsed from envSchema
      ;(globalThis as any).__testEnv = c.env
      await next()
    })
    cli.command('check', { run: () => ({ ok: true }) })
    await cli.fetch(new Request('http://localhost/check'))
    expect((globalThis as any).__testEnv).toEqual({ APP_TOKEN: 'fallback' })
    delete (globalThis as any).__testEnv
  })

  test('retryable error is propagated', async () => {
    const cli = Cli.create('test')
    cli.command('rate-limit', {
      run: (c) => c.error({ code: 'RATE_LIMITED', message: 'slow down', retryable: true }),
    })
    const { body } = await fetchJson(cli, new Request('http://localhost/rate-limit'))
    expect(body.ok).toBe(false)
    expect(body.error.retryable).toBe(true)
  })

  test('cta block is propagated', async () => {
    const cli = Cli.create('test')
    cli.command('done', {
      run: (c) =>
        c.ok({ id: 1 }, { cta: { commands: ['list'], description: 'Suggested commands:' } }),
    })
    const { body } = await fetchJson(cli, new Request('http://localhost/done'))
    expect(body.ok).toBe(true)
    expect(body.meta.cta).toMatchInlineSnapshot(`
      {
        "commands": [
          {
            "command": "test list",
          },
        ],
        "description": "Suggested commands:",
      }
    `)
  })

  describe('mcp over http', () => {
    function mcpCli() {
      const cli = Cli.create('test', { version: '1.0.0' })
      cli.command('greet', {
        description: 'Greet someone',
        args: z.object({ name: z.string() }),
        run: (c) => ({ message: `hello ${c.args.name}` }),
      })
      cli.command('ping', {
        description: 'Ping',
        run: () => ({ pong: true }),
      })
      return cli
    }

    async function mcpRequest(cli: Cli.Cli<any, any, any>, body: unknown, sessionId?: string) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      if (sessionId) headers['mcp-session-id'] = sessionId
      return cli.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      )
    }

    async function initSession(cli: Cli.Cli<any, any, any>) {
      const res = await mcpRequest(cli, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      })
      const sessionId = res.headers.get('mcp-session-id')
      const body = await res.json()
      // Send initialized notification
      await mcpRequest(cli, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId!)
      return { sessionId: sessionId!, body }
    }

    test('POST /mcp with initialize → valid MCP response', async () => {
      const cli = mcpCli()
      const res = await mcpRequest(cli, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect({
        serverInfo: body.result.serverInfo,
        hasTools: 'tools' in (body.result.capabilities ?? {}),
      }).toMatchInlineSnapshot(`
        {
          "hasTools": true,
          "serverInfo": {
            "name": "test",
            "version": "1.0.0",
          },
        }
      `)
    })

    test('POST /mcp with tools/list → returns registered tools', async () => {
      const cli = mcpCli()
      const { sessionId } = await initSession(cli)
      const res = await mcpRequest(
        cli,
        { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
        sessionId,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      const tools = body.result.tools.map((t: any) => ({
        name: t.name,
        description: t.description,
        hasInputSchema: Object.keys(t.inputSchema?.properties ?? {}).length > 0,
      }))
      expect(tools).toMatchInlineSnapshot(`
        [
          {
            "description": "Greet someone",
            "hasInputSchema": true,
            "name": "greet",
          },
          {
            "description": "Ping",
            "hasInputSchema": false,
            "name": "ping",
          },
        ]
      `)
    })

    test('POST /mcp with tools/call → executes command', async () => {
      const cli = mcpCli()
      const { sessionId } = await initSession(cli)
      const res = await mcpRequest(
        cli,
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'greet', arguments: { name: 'world' } },
        },
        sessionId,
      )
      expect(res.status).toBe(200)
      const body = await res.json()
      expect({
        isError: body.result.isError,
        content: JSON.parse(body.result.content[0].text),
      }).toMatchInlineSnapshot(`
        {
          "content": {
            "message": "hello world",
          },
          "isError": undefined,
        }
      `)
    })

    test('non-/mcp paths still route to command API', async () => {
      const cli = mcpCli()
      const { body } = await fetchJson(cli, new Request('http://localhost/ping'))
      expect(body.data).toMatchInlineSnapshot(`
        {
          "pong": true,
        }
      `)
    })
  })
})

describe('displayName', () => {
  let savedArgv1: string | undefined
  beforeEach(() => {
    savedArgv1 = process.argv[1]
  })
  afterEach(() => {
    process.argv[1] = savedArgv1!
  })

  test('defaults to name when argv[1] is not an alias', async () => {
    process.argv[1] = '/usr/local/bin/my-cli'
    const cli = Cli.create({
      name: 'my-cli',
      aliases: ['mc'],
    }).command('ping', {
      run: (c) => c.ok({ displayName: c.displayName }),
    })
    const { output } = await serve(cli, ['ping', '--json'])
    expect(JSON.parse(output).displayName).toBe('my-cli')
  })

  test('resolves alias from argv[1]', async () => {
    process.argv[1] = '/usr/local/bin/mc'
    const cli = Cli.create({
      name: 'my-cli',
      aliases: ['mc'],
    }).command('ping', {
      run: (c) => c.ok({ displayName: c.displayName }),
    })
    const { output } = await serve(cli, ['ping', '--json'])
    expect(JSON.parse(output).displayName).toBe('mc')
  })

  test('falls back to name when argv[1] is undefined', async () => {
    process.argv[1] = undefined as any
    const cli = Cli.create({
      name: 'my-cli',
      aliases: ['mc'],
    }).command('ping', {
      run: (c) => c.ok({ displayName: c.displayName }),
    })
    const { output } = await serve(cli, ['ping', '--json'])
    expect(JSON.parse(output).displayName).toBe('my-cli')
  })

  test('available in middleware context', async () => {
    process.argv[1] = '/usr/local/bin/mc'
    let middlewareDisplayName: string | undefined
    const cli = Cli.create({
      name: 'my-cli',
      aliases: ['mc'],
    })
      .use((c, next) => {
        middlewareDisplayName = c.displayName
        return next()
      })
      .command('ping', {
        run: (c) => c.ok({ ok: true }),
      })
    await serve(cli, ['ping', '--json'])
    expect(middlewareDisplayName).toBe('mc')
  })

  test('cta commands use displayName', async () => {
    process.argv[1] = '/usr/local/bin/mc'
    const cli = Cli.create({
      name: 'my-cli',
      aliases: ['mc'],
    }).command('ping', {
      run: (c) =>
        c.ok(
          { ok: true },
          { cta: { commands: ['login'] } },
        ),
    })
    const { output } = await serve(cli, ['ping', '--json', '--verbose'])
    const parsed = JSON.parse(output)
    expect(parsed.meta.cta.commands[0].command).toBe('mc login')
  })
})
