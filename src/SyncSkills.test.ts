import { Cli, SyncSkills } from 'incur'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let savedXdg: string | undefined

beforeEach(() => {
  savedXdg = process.env.XDG_DATA_HOME
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = savedXdg
})

test('generates skill files and installs to canonical location', async () => {
  const tmp = join(tmpdir(), `clac-sync-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test', { description: 'A test CLI' })
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })
  cli.command('greet', { description: 'Say hello', run: () => ({ hi: true }) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    description: 'A test CLI',
    // Use a fake home dir so we don't pollute the real one
    global: false,
    cwd: installDir,
  })

  expect(result.skills.length).toBeGreaterThan(0)
  expect(result.skills.map((s) => s.name)).toContain('test-greet')
  expect(result.skills.map((s) => s.name)).toContain('test-ping')

  // Verify skills were installed to canonical location
  for (const p of result.paths) {
    expect(existsSync(join(p, 'SKILL.md'))).toBe(true)
  }

  rmSync(tmp, { recursive: true, force: true })
})

test('uses custom depth', async () => {
  const tmp = join(tmpdir(), `clac-depth-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })
  cli.command('pong', { description: 'Pong', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    depth: 0,
    global: false,
    cwd: installDir,
  })

  // depth 0 = single skill
  expect(result.skills).toHaveLength(1)

  rmSync(tmp, { recursive: true, force: true })
})

test('writes hash after successful sync', async () => {
  const tmp = join(tmpdir(), `clac-hash-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('hash-test')
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  await SyncSkills.sync('hash-test', commands, {
    global: false,
    cwd: installDir,
  })

  const stored = SyncSkills.readHash('hash-test')
  expect(stored).toMatch(/^[0-9a-f]{16}$/)

  rmSync(tmp, { recursive: true, force: true })
})

test('readHash returns undefined when no hash exists', () => {
  const tmp = join(tmpdir(), `clac-hash-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  expect(SyncSkills.readHash('nonexistent')).toBeUndefined()

  rmSync(tmp, { recursive: true, force: true })
})

test('group with default command generates skills for both default and subcommands', async () => {
  const tmp = join(tmpdir(), `clac-default-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const lint = Cli.create('lint', { description: 'Run linter', run: () => ({}) })
  lint.command('fix', { description: 'Auto-fix', run: () => ({}) })
  const cli = Cli.create('test', { description: 'Test CLI' }).command(lint)

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('test', commands, {
    description: 'Test CLI',
    global: false,
    cwd: installDir,
  })

  const allContent = result.paths
    .map((p) => readFileSync(join(p, 'SKILL.md'), 'utf8'))
    .join('\n')
  expect(allContent).toContain('lint')
  expect(allContent).toContain('lint fix')

  rmSync(tmp, { recursive: true, force: true })
})

test('installed SKILL.md contains frontmatter', async () => {
  const tmp = join(tmpdir(), `clac-content-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('my-tool', { description: 'A useful tool' })
  cli.command('run', { description: 'Run something', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const result = await SyncSkills.sync('my-tool', commands, {
    global: false,
    cwd: installDir,
  })

  const skillPath = result.paths[0]!
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
  expect(content).toContain('name:')
  expect(content).toContain('description:')

  rmSync(tmp, { recursive: true, force: true })
})
