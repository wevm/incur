import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { detectPackageSpecifier, register } from './SyncMcp.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], cb: Function) => {
    cb(null, '│ ✓ Claude Code: ~/.claude.json │\n│ ✓ Cursor: ~/.cursor/mcp.json │\n', '')
  }),
}))

let fakeHome: string | undefined
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => fakeHome ?? actual.homedir(),
  }
})

let tmp: string

beforeEach(() => {
  const savedArgv1 = process.argv[1]
  tmp = join(tmpdir(), `clac-test-${Date.now()}`)
  mkdirSync(join(tmp, 'node_modules', '.bin'), { recursive: true })
  fakeHome = join(tmp, 'home')
  mkdirSync(fakeHome, { recursive: true })
  return () => {
    process.argv[1] = savedArgv1!
    fakeHome = undefined
    rmSync(tmp, { recursive: true, force: true })
  }
})

function setupPkg(deps: Record<string, string>) {
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ dependencies: deps }))
  process.argv[1] = join(tmp, 'node_modules', '.bin', 'my-cli')
}

// --- detectPackageSpecifier tests ---

test('returns bare name when argv[1] is undefined', () => {
  process.argv[1] = undefined as any
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

test('returns bare name when no node_modules in path', () => {
  process.argv[1] = '/usr/local/bin/my-cli'
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

test('returns bare name when package.json is missing', () => {
  process.argv[1] = join(tmp, 'node_modules', '.bin', 'my-cli')
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

test('returns bare name when dep is not found', () => {
  setupPkg({ other: '1.0.0' })
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

test('returns bare name when multiple deps exist', () => {
  setupPkg({ 'my-cli': '1.0.0', other: '2.0.0' })
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

test('returns URL specifier for https dep', () => {
  setupPkg({ 'my-cli': 'https://pkg.pr.new/my-cli@abc123' })
  expect(detectPackageSpecifier('my-cli')).toBe('https://pkg.pr.new/my-cli@abc123')
})

test('returns URL specifier for file: dep', () => {
  setupPkg({ 'my-cli': 'file:../local-cli' })
  expect(detectPackageSpecifier('my-cli')).toBe('file:../local-cli')
})

test('returns name@version for pinned version', () => {
  setupPkg({ 'my-cli': '1.2.3' })
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli@1.2.3')
})

test('returns bare name for range specifier', () => {
  setupPkg({ 'my-cli': '^1.0.0' })
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

test('returns bare name for tag specifier', () => {
  setupPkg({ 'my-cli': 'latest' })
  expect(detectPackageSpecifier('my-cli')).toBe('my-cli')
})

// --- register tests ---

test('register calls add-mcp and writes amp config', async () => {
  const result = await register('my-cli', { command: 'npx my-cli --mcp' })

  expect(result.command).toBe('npx my-cli --mcp')
  expect(result.agents).toContain('Claude Code')
  expect(result.agents).toContain('Cursor')
  expect(result.agents).toContain('Amp')

  const configPath = join(fakeHome!, '.config', 'amp', 'settings.json')
  expect(existsSync(configPath)).toBe(true)
  const config = JSON.parse(readFileSync(configPath, 'utf-8'))
  expect(config['amp.mcpServers']['my-cli']).toEqual({
    command: 'npx',
    args: ['my-cli', '--mcp'],
  })
})

test('register with agents: ["amp"] skips add-mcp', async () => {
  const { execFile } = await import('node:child_process')
  vi.mocked(execFile).mockClear()

  const result = await register('my-cli', {
    command: 'npx my-cli --mcp',
    agents: ['amp'],
  })

  expect(execFile).not.toHaveBeenCalled()
  expect(result.agents).toEqual(['Amp'])
})

test('register writes amp config to existing settings', async () => {
  const configDir = join(fakeHome!, '.config', 'amp')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ 'amp.theme': 'dark' }))

  await register('my-cli', { command: 'npx my-cli --mcp', agents: ['amp'] })

  const config = JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8'))
  expect(config['amp.theme']).toBe('dark')
  expect(config['amp.mcpServers']['my-cli']).toBeDefined()
})
