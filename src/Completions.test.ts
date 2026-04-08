import { execFile, spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cli, Completions, z } from 'incur'

const originalIsTTY = process.stdout.isTTY
const originalEnv = { ...process.env }
beforeAll(() => {
  ;(process.stdout as any).isTTY = false
})
afterAll(() => {
  ;(process.stdout as any).isTTY = originalIsTTY
  process.env = originalEnv
})

vi.mock('./SyncSkills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./SyncSkills.js')>()
  return { ...actual, readHash: () => undefined }
})

function hasShell(shell: string): boolean {
  return spawnSync(shell, ['-c', ':'], { stdio: 'ignore' }).status === 0
}

const bash = hasShell('bash')
const zsh = hasShell('zsh')
const fish = hasShell('fish')

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || stdout?.trim() || error.message))
      else resolve(stdout)
    })
  })
}

async function withFakeCli(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'incur-completions-'))
  const bin = join(dir, 'fake-cli')

  try {
    await writeFile(
      bin,
      `#!/bin/sh
if [ -n "$COMPLETE" ]; then
  printf '%s' "$COMPLETE:\${_COMPLETE_INDEX:-missing}"
else
  printf 'missing'
fi
`,
    )
    await chmod(bin, 0o755)
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function serve(
  cli: { serve: Cli.Cli['serve'] },
  argv: string[],
  env: Record<string, string | undefined> = {},
) {
  let output = ''
  const prevEnv = { ...process.env }
  Object.assign(process.env, env)
  await cli.serve(argv, {
    stdout(s) {
      output += s
    },
    exit() {},
  })
  process.env = prevEnv
  return output
}

function makeCli() {
  const cli = Cli.create('mycli', { version: '1.0.0', description: 'A test CLI' })

  cli.command('build', {
    description: 'Build the project',
    options: z.object({
      target: z.enum(['es2020', 'es2022', 'esnext']).default('esnext').describe('Build target'),
      watch: z.boolean().default(false).describe('Watch mode'),
      outDir: z.string().optional().describe('Output directory'),
    }),
    alias: { watch: 'w' },
    run(c) {
      return { target: c.options.target }
    },
  })

  cli.command('test', {
    description: 'Run tests',
    args: z.object({ pattern: z.string().optional() }),
    run(c) {
      return { pattern: c.args.pattern }
    },
  })

  const db = Cli.create('db', { description: 'Database commands' })
  db.command('migrate', {
    description: 'Run migrations',
    run() {
      return { ok: true }
    },
  })
  db.command('seed', {
    description: 'Seed database',
    run() {
      return { ok: true }
    },
  })
  cli.command(db)

  return cli
}

describe('complete', () => {
  test('suggests subcommands at root', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', ''], 1)
    const values = candidates.map((c) => c.value)
    expect(values).toContain('build')
    expect(values).toContain('test')
    expect(values).toContain('db')
  })

  test('filters subcommands by prefix', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', 'b'], 1)
    expect(candidates.map((c) => c.value)).toEqual(['build'])
  })

  test('suggests group subcommands', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', 'db', ''], 2)
    const values = candidates.map((c) => c.value)
    expect(values).toContain('migrate')
    expect(values).toContain('seed')
  })

  test('suggests options for leaf command', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', 'build', '--'], 2)
    const values = candidates.map((c) => c.value)
    expect(values).toContain('--target')
    expect(values).toContain('--watch')
    expect(values).toContain('--out-dir')
  })

  test('filters options by prefix', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', 'build', '--t'], 2)
    expect(candidates.map((c) => c.value)).toEqual(['--target'])
  })

  test('suggests short aliases', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', 'build', '-'], 2)
    const values = candidates.map((c) => c.value)
    expect(values).toContain('-w')
  })

  test('suggests enum values for options', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(
      commands,
      undefined,
      ['mycli', 'build', '--target', ''],
      3,
    )
    const values = candidates.map((c) => c.value)
    expect(values).toEqual(['es2020', 'es2022', 'esnext'])
  })

  test('filters enum values by prefix', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(
      commands,
      undefined,
      ['mycli', 'build', '--target', 'es202'],
      3,
    )
    expect(candidates.map((c) => c.value)).toEqual(['es2020', 'es2022'])
  })

  test('returns empty for non-enum option value', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(
      commands,
      undefined,
      ['mycli', 'build', '--out-dir', ''],
      3,
    )
    expect(candidates).toEqual([])
  })

  test('includes descriptions', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', ''], 1)
    const build = candidates.find((c) => c.value === 'build')
    expect(build?.description).toBe('Build the project')
  })

  test('marks groups with noSpace', () => {
    const cli = makeCli()
    const commands = Cli.toCommands.get(cli)!
    const candidates = Completions.complete(commands, undefined, ['mycli', ''], 1)
    const db = candidates.find((c) => c.value === 'db')
    expect(db?.noSpace).toBe(true)
    const build = candidates.find((c) => c.value === 'build')
    expect(build?.noSpace).toBeUndefined()
  })

  test('suggests subcommands for group with default', () => {
    const lint = Cli.create('lint', {
      description: 'Run linter',
      options: z.object({ fix: z.boolean().default(false).describe('Auto-fix') }),
      run: () => ({ linted: true }),
    })
    lint.command('rules', { description: 'List rules', run: () => ({}) })
    const cli = Cli.create('app', { description: 'App' }).command(lint)
    const commands = Cli.toCommands.get(cli)!

    const candidates = Completions.complete(commands, undefined, ['app', 'lint', ''], 2)
    expect(candidates.map((c) => c.value)).toContain('rules')
  })

  test('suggests options from group default command', () => {
    const lint = Cli.create('lint', {
      description: 'Run linter',
      options: z.object({ fix: z.boolean().default(false).describe('Auto-fix') }),
      run: () => ({ linted: true }),
    })
    lint.command('rules', { description: 'List rules', run: () => ({}) })
    const cli = Cli.create('app', { description: 'App' }).command(lint)
    const commands = Cli.toCommands.get(cli)!

    const candidates = Completions.complete(commands, undefined, ['app', 'lint', '--'], 2)
    expect(candidates.map((c) => c.value)).toContain('--fix')
  })
})

describe('format', () => {
  const candidates: Completions.Candidate[] = [
    { value: '--target', description: 'Build target' },
    { value: '--watch', description: 'Watch mode' },
  ]

  test('bash: vertical tab separated values only', () => {
    expect(Completions.format('bash', candidates)).toBe('--target\v--watch')
  })

  test('zsh: value:description newline separated', () => {
    expect(Completions.format('zsh', candidates)).toBe('--target:Build target\n--watch:Watch mode')
  })

  test('fish: value\\tdescription newline separated', () => {
    expect(Completions.format('fish', candidates)).toBe(
      '--target\tBuild target\n--watch\tWatch mode',
    )
  })

  test('zsh: escapes colons in values', () => {
    const result = Completions.format('zsh', [{ value: 'foo:bar' }])
    expect(result).toBe('foo\\:bar')
  })

  test('nushell: outputs JSON array of records', () => {
    expect(Completions.format('nushell', candidates)).toBe(
      JSON.stringify([
        { value: '--target', description: 'Build target' },
        { value: '--watch', description: 'Watch mode' },
      ]),
    )
  })

  test('nushell: omits description when not present', () => {
    expect(Completions.format('nushell', [{ value: 'foo' }])).toBe('[{"value":"foo"}]')
  })

  test('bash: appends \\x01 sentinel for noSpace candidates', () => {
    const result = Completions.format('bash', [{ value: 'db', noSpace: true }, { value: 'build' }])
    expect(result).toBe('db\x01\vbuild')
  })
})

describe('register', () => {
  test('bash: generates complete -F script with nospace support', () => {
    const script = Completions.register('bash', 'mycli')
    expect(script).toContain('_incur_complete_mycli()')
    expect(script).toContain('export COMPLETE="bash"')
    expect(script).toContain('complete -o default -o bashdefault -o nosort -F')
    expect(script).toContain('"mycli" -- "${COMP_WORDS[@]}"')
    expect(script).toContain('compopt -o nospace')
  })

  test.skipIf(!bash)('bash: exports completion env vars to the CLI subprocess', async () => {
    await withFakeCli(async (dir) => {
      const output = await exec(
        'bash',
        [
          '-lc',
          `${Completions.register('bash', 'fake-cli')}
COMP_WORDS=('fake-cli' 'build' '')
COMP_CWORD=2
_incur_complete_fake_cli
printf '%s' "\${COMPREPLY[*]}"`,
        ],
        { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      )

      expect(output).toBe('bash:2')
    })
  })

  test('zsh: generates compdef script', () => {
    const script = Completions.register('zsh', 'mycli')
    expect(script).toContain('#compdef mycli')
    expect(script).toContain('export COMPLETE="zsh"')
    expect(script).toContain('compdef _incur_complete_mycli mycli')
    expect(script).toContain('_describe')
  })

  test.skipIf(!zsh)('zsh: exports completion env vars to the CLI subprocess', async () => {
    await withFakeCli(async (dir) => {
      const output = await exec(
        'zsh',
        [
          '-lc',
          `compdef() { : }
_describe() { print -r -- "\${(j:|:)\${(@P)2}}" }
${Completions.register('zsh', 'fake-cli')}
words=('fake-cli' 'build' '')
CURRENT=3
_incur_complete_fake_cli`,
        ],
        { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      )

      expect(output.trim()).toBe('zsh:2')
    })
  })

  test('fish: generates complete command', () => {
    const script = Completions.register('fish', 'mycli')
    expect(script).toContain('complete --keep-order --exclusive --command mycli')
    expect(script).toContain('COMPLETE=fish')
    expect(script).toContain('commandline --current-token')
  })

  test.skipIf(!fish)('fish: passes completion env vars to the CLI subprocess', async () => {
    await withFakeCli(async (dir) => {
      const output = await exec(
        'fish',
        ['-c', `${Completions.register('fish', 'fake-cli')}
complete --do-complete 'fake-cli '`],
        { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
      )

      expect(output.trim()).toBe('fish:missing')
    })
  })

  test('nushell: generates external completer closure', () => {
    const script = Completions.register('nushell', 'mycli')
    expect(script).toContain('COMPLETE=nushell')
    expect(script).toContain('mycli -- ...$spans')
    expect(script).toContain('from json')
    expect(script).toContain('_incur_complete_mycli')
  })
})

describe('completions built-in command', () => {
  test('outputs bash hook script', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions', 'bash'])
    expect(output).toContain('_incur_complete_mycli()')
    expect(output).toContain('COMPLETE="bash"')
  })

  test('outputs zsh hook script', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions', 'zsh'])
    expect(output).toContain('#compdef mycli')
  })

  test('outputs fish hook script', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions', 'fish'])
    expect(output).toContain('complete --keep-order --exclusive --command mycli')
  })

  test('outputs nushell hook script', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions', 'nushell'])
    expect(output).toContain('COMPLETE=nushell')
    expect(output).toContain('from json')
  })

  test('shows help with --help', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions', '--help'])
    expect(output).toMatchInlineSnapshot(`
      "mycli completions — Generate shell completion script

      Usage: mycli completions <bash|fish|nushell|zsh>

      Arguments:
        shell  Shell to generate completions for

      Setup:
        bash     eval "$(mycli completions bash)"  # add to ~/.bashrc
        fish     mycli completions fish | source   # add to ~/.config/fish/config.fish
        nushell  see \`mycli completions nushell\`   # add to config.nu
        zsh      eval "$(mycli completions zsh)"   # add to ~/.zshrc
      "
    `)
  })

  test('shows help on missing shell argument', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions'])
    expect(output).toContain('Generate shell completion script')
  })

  test('errors on unknown shell', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['completions', 'powershell'])
    expect(output).toContain("Unknown shell 'powershell'")
  })
})

describe('aliases', () => {
  function makeAliasedCli() {
    const cli = Cli.create('my-tool', {
      version: '1.0.0',
      description: 'A test CLI',
      aliases: ['mt', 'myt'],
    })
    cli.command('fetch', {
      description: 'Fetch a URL',
      run() {
        return { ok: true }
      },
    })
    return cli
  }

  test('completions fish outputs registration for all names', async () => {
    const cli = makeAliasedCli()
    const output = await serve(cli, ['completions', 'fish'])
    expect(output).toContain('--command my-tool')
    expect(output).toContain('--command mt')
    expect(output).toContain('--command myt')
  })

  test('completions bash outputs registration for all names', async () => {
    const cli = makeAliasedCli()
    const output = await serve(cli, ['completions', 'bash'])
    expect(output).toContain('_incur_complete_my_tool()')
    expect(output).toContain('_incur_complete_mt()')
    expect(output).toContain('_incur_complete_myt()')
  })

  test('completions zsh outputs registration for all names', async () => {
    const cli = makeAliasedCli()
    const output = await serve(cli, ['completions', 'zsh'])
    expect(output).toContain('#compdef my-tool')
    expect(output).toContain('compdef _incur_complete_mt mt')
    expect(output).toContain('compdef _incur_complete_myt myt')
  })

  test('COMPLETE env var registers all names', async () => {
    const cli = makeAliasedCli()
    const output = await serve(cli, [], { COMPLETE: 'fish' })
    expect(output).toContain('--command my-tool')
    expect(output).toContain('--command mt')
    expect(output).toContain('--command myt')
  })
})

describe('serve integration', () => {
  test('COMPLETE=bash with no words outputs registration script', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['--', ''], { COMPLETE: 'bash' })
    expect(output).toBeTruthy()
  })

  test('COMPLETE=bash with words outputs candidates', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['--', 'mycli', ''], {
      COMPLETE: 'bash',
      _COMPLETE_INDEX: '1',
    })
    expect(output).toContain('build')
    expect(output).toContain('test')
    expect(output).toContain('db')
  })

  test('COMPLETE=bash includes built-in commands at root', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['--', 'mycli', ''], {
      COMPLETE: 'bash',
      _COMPLETE_INDEX: '1',
    })
    expect(output).toContain('completions')
    expect(output).toContain('mcp')
    expect(output).toContain('skills')
  })

  test('COMPLETE=bash suggests add for skills subcommand', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['--', 'mycli', 'skills', ''], {
      COMPLETE: 'bash',
      _COMPLETE_INDEX: '2',
    })
    expect(output).toContain('add')
  })

  test('COMPLETE=bash suggests add for mcp subcommand', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['--', 'mycli', 'mcp', ''], {
      COMPLETE: 'bash',
      _COMPLETE_INDEX: '2',
    })
    expect(output).toContain('add')
  })

  test('COMPLETE=zsh with words outputs candidates in zsh format', async () => {
    const cli = makeCli()
    await serve(cli, ['--', 'mycli', '--'], {
      COMPLETE: 'zsh',
      _COMPLETE_INDEX: '1',
    })
    const output2 = await serve(cli, ['--', 'mycli', 'build', '--'], {
      COMPLETE: 'zsh',
      _COMPLETE_INDEX: '2',
    })
    expect(output2).toContain('--target')
    expect(output2).toContain('Build target')
  })

  test('COMPLETE=fish with words outputs tab-separated candidates', async () => {
    const cli = makeCli()
    const output = await serve(cli, ['--', 'mycli', 'build', '--'], {
      COMPLETE: 'fish',
      _COMPLETE_INDEX: '2',
    })
    expect(output).toContain('--target\tBuild target')
    expect(output).toContain('--watch\tWatch mode')
  })
})
