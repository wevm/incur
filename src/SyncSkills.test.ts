import { Cli, SyncSkills } from 'incur'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('sync results are sorted alphabetically', async () => {
  const tmp = join(tmpdir(), `clac-sync-sort-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })

  const cli = Cli.create('test')
  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  mkdirSync(join(installDir, 'zeta'), { recursive: true })
  writeFileSync(
    join(installDir, 'zeta', 'SKILL.md'),
    ['---', 'name: zeta', 'description: Z skill.', '---', '', '# zeta'].join('\n'),
  )
  writeFileSync(
    join(installDir, 'SKILL.md'),
    ['---', 'name: test', 'description: Root skill.', '---', '', '# test'].join('\n'),
  )
  mkdirSync(join(installDir, 'alpha'), { recursive: true })
  writeFileSync(
    join(installDir, 'alpha', 'SKILL.md'),
    ['---', 'name: alpha', 'description: A skill.', '---', '', '# alpha'].join('\n'),
  )

  const result = await SyncSkills.sync('test', commands, {
    global: false,
    cwd: installDir,
    include: ['zeta', '_root', 'alpha'],
  })

  expect(result.skills.map((s) => s.name)).toEqual(['alpha', 'test', 'zeta'])

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

test('list returns skills from command map', async () => {
  const cli = Cli.create('test', { description: 'A test CLI' })
  cli.command('ping', { description: 'Health check', run: () => ({}) })
  cli.command('greet', { description: 'Say hello', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.list('test', commands)

  expect(result.length).toBeGreaterThan(0)
  const names = result.map((s) => s.name)
  expect(names).toContain('test-ping')
  expect(names).toContain('test-greet')
  for (const s of result) {
    expect(s.installed).toBe(false)
    expect(s.description).toBeDefined()
  }
})

test('list shows installed status after sync', async () => {
  const tmp = join(tmpdir(), `clac-list-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  // Sync first to install
  await SyncSkills.sync('test', commands, {
    global: false,
    cwd: installDir,
  })

  // Now list should show installed
  const result = await SyncSkills.list('test', commands)
  expect(result.length).toBeGreaterThan(0)
  for (const s of result) expect(s.installed).toBe(true)

  rmSync(tmp, { recursive: true, force: true })
})

test('list shows not installed when synced skills are removed', async () => {
  const tmp = join(tmpdir(), `clac-list-missing-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
  process.env.XDG_DATA_HOME = tmp

  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const installDir = join(tmp, 'install')
  mkdirSync(join(installDir, '.agents', 'skills'), { recursive: true })

  const sync = await SyncSkills.sync('test', commands, {
    global: false,
    cwd: installDir,
  })

  rmSync(sync.paths[0]!, { recursive: true, force: true })

  const result = await SyncSkills.list('test', commands)
  expect(result).toHaveLength(1)
  expect(result[0]!.installed).toBe(false)

  rmSync(tmp, { recursive: true, force: true })
})

test('list returns empty for CLI with no commands', async () => {
  const cli = Cli.create('empty')
  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.list('empty', commands)
  expect(result).toHaveLength(0)
})

test('list includes root command skill', async () => {
  const cli = Cli.create('test', {
    description: 'A test CLI',
    run: () => ({ ok: true }),
  })
  cli.command('ping', { description: 'Health check', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const rootCommand = Cli.toRootDefinition.get(cli as any)!
  const result = await SyncSkills.list('test', commands, {
    description: 'A test CLI',
    rootCommand,
  })

  const names = result.map((s) => s.name)
  expect(names).toContain('test')
  expect(names).toContain('test-ping')
})

test('list results are sorted alphabetically', async () => {
  const cli = Cli.create('test')
  cli.command('zebra', { description: 'Z command', run: () => ({}) })
  cli.command('alpha', { description: 'A command', run: () => ({}) })
  cli.command('middle', { description: 'M command', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.list('test', commands)
  const names = result.map((s) => s.name)
  expect(names).toEqual([...names].sort())
})
