import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { check, checkFlag, install, isNewerVersion, refresh } from './update.js'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, '', '')
    },
  ),
  spawn: vi.fn(() => ({
    once: vi.fn(),
    unref: vi.fn(),
  })),
}))

let directory: string
let savedArgv: string | undefined
let savedCache: string | undefined
let savedCi: string | undefined
let savedNotifier: string | undefined
let savedRegistryNotifier: string | undefined
let savedUserAgent: string | undefined

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'incur-update-'))
  savedArgv = process.argv[1]
  savedCache = process.env.XDG_CACHE_HOME
  savedCi = process.env.CI
  savedNotifier = process.env.NO_UPDATE_NOTIFIER
  savedRegistryNotifier = process.env.npm_config_update_notifier
  savedUserAgent = process.env.npm_config_user_agent
  process.env.XDG_CACHE_HOME = path.join(directory, 'cache')
  delete process.env.CI
  delete process.env.NO_UPDATE_NOTIFIER
  delete process.env.npm_config_update_notifier
  process.env.npm_config_user_agent = 'npm/11.0.0 node/v22.0.0'
  vi.mocked(childProcess.execFile).mockClear()
  vi.mocked(childProcess.spawn).mockClear()

  return () => {
    process.argv[1] = savedArgv!
    restoreEnv('CI', savedCi)
    restoreEnv('NO_UPDATE_NOTIFIER', savedNotifier)
    restoreEnv('XDG_CACHE_HOME', savedCache)
    restoreEnv('npm_config_update_notifier', savedRegistryNotifier)
    restoreEnv('npm_config_user_agent', savedUserAgent)
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

test('returns a cached update for the executing package', () => {
  setupPackage({ name: 'frog', version: '1.0.0' })
  writeCache('frog', { checkedAt: Date.now(), latest: '1.1.0' })

  expect(check('frog')).toEqual({
    current: '1.0.0',
    latest: '1.1.0',
    name: 'frog',
  })
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

test('resolves a scoped package by its binary name', () => {
  setupPackage({
    bin: { frog: './dist/bin.js' },
    name: '@example/frog',
    version: '1.0.0',
  })
  writeCache('@example/frog', { checkedAt: Date.now(), latest: '2.0.0' })

  expect(check('frog')).toEqual({
    current: '1.0.0',
    latest: '2.0.0',
    name: '@example/frog',
  })
})

test('uses an explicitly configured registry package', () => {
  process.argv[1] = path.join(directory, 'missing.js')
  writeCache('@example/frog', { checkedAt: Date.now(), latest: '1.1.0' })

  expect(
    check('frog', {
      package: '@example/frog',
      version: '1.0.0',
    }),
  ).toEqual({
    current: '1.0.0',
    latest: '1.1.0',
    name: '@example/frog',
  })
})

test('does not assume a registry package from the CLI version', () => {
  process.argv[1] = path.join(directory, 'missing.js')
  writeCache('frog', { checkedAt: Date.now(), latest: '1.1.0' })

  expect(check('frog', { version: '1.0.0' })).toBeUndefined()
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

test('schedules stale checks by reinvoking the CLI', () => {
  setupPackage({ name: 'frog', version: '1.0.0' })

  expect(check('frog')).toBeUndefined()
  expect(childProcess.spawn).toHaveBeenCalledWith(
    process.execPath,
    expect.arrayContaining(['--incur-update-check']),
    {
      detached: true,
      stdio: 'ignore',
    },
  )
  expect(readCache('frog')).toMatchObject({ checkedAt: expect.any(Number) })
})

test('schedules custom checks for standalone binaries', () => {
  process.argv[1] = path.join(directory, 'standalone')

  expect(
    check('frog', {
      check: () => '2.0.0',
      version: '1.0.0',
    }),
  ).toBeUndefined()
  expect(childProcess.spawn).toHaveBeenCalledOnce()
})

test('reinvokes single-file executables directly', () => {
  process.argv[1] = process.execPath

  expect(
    check('frog', {
      check: () => '2.0.0',
      version: '1.0.0',
    }),
  ).toBeUndefined()
  expect(childProcess.spawn).toHaveBeenCalledWith(process.execPath, ['--incur-update-check'], {
    detached: true,
    stdio: 'ignore',
  })
})

test('reinvokes embedded binaries directly', () => {
  process.argv[1] = 'B:\\~BUN\\root\\entry.ts'

  expect(
    check('frog', {
      binary: true,
      check: () => '2.0.0',
      version: '1.0.0',
    }),
  ).toBeUndefined()
  expect(childProcess.spawn).toHaveBeenCalledWith(process.execPath, [checkFlag], {
    detached: true,
    stdio: 'ignore',
  })
})

test('refreshes a custom provider cache', async () => {
  process.argv[1] = path.join(directory, 'standalone')
  const checker = vi.fn(() => '2.0.0')

  await refresh('frog', { check: checker, version: '1.0.0' })

  expect(checker).toHaveBeenCalledWith({
    current: '1.0.0',
    name: 'frog',
  })
  expect(readCache('frog')).toEqual({
    checkedAt: expect.any(Number),
    latest: '2.0.0',
  })
})

test('installs through a custom standalone provider', async () => {
  process.argv[1] = path.join(directory, 'standalone')
  writeCache('frog', { checkedAt: Date.now(), latest: '2.0.0' })
  const installer = vi.fn()

  await expect(
    install('frog', {
      install: installer,
      version: '1.0.0',
    }),
  ).resolves.toEqual({ name: 'frog' })
  expect(installer).toHaveBeenCalledWith({
    current: '1.0.0',
    latest: '2.0.0',
    name: 'frog',
  })
})

test('reports deferred custom installations', async () => {
  process.argv[1] = path.join(directory, 'standalone')

  await expect(
    install('frog', {
      deferred: true,
      install: () => {},
      version: '1.0.0',
    }),
  ).resolves.toEqual({
    deferred: true,
    name: 'frog',
  })
})

test('installs executing packages through their package manager', async () => {
  setupPackage({ name: 'frog', version: '1.0.0' })

  await expect(install('frog')).resolves.toEqual({
    command: 'npm install --global frog@latest',
    name: 'frog',
  })
  expect(childProcess.execFile).toHaveBeenCalledWith(
    'npm',
    ['install', '--global', 'frog@latest'],
    expect.any(Function),
  )
})

test('reports unsupported standalone installation', async () => {
  process.argv[1] = path.join(directory, 'standalone')

  await expect(install('frog', { version: '1.0.0' })).rejects.toThrow(
    "No update installer is configured for 'frog'.",
  )
})

test('suppresses checks when update notifications are disabled', () => {
  setupPackage({ name: 'frog', version: '1.0.0' })
  process.env.NO_UPDATE_NOTIFIER = '1'

  expect(check('frog')).toBeUndefined()
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

test('rejects unsafe package names', () => {
  process.argv[1] = path.join(directory, 'missing.js')

  expect(check('frog', { package: 'frog; echo unsafe', version: '1.0.0' })).toBeUndefined()
  expect(childProcess.spawn).not.toHaveBeenCalled()
})

test.each([
  ['1.1.0', '1.0.0', true],
  ['2.0.0', '1.9.9', true],
  ['1.0.0', '1.0.0', false],
  ['1.0.0', '1.1.0', false],
  ['1.0.0', '1.0.0-rc.1', true],
  ['1.0.0-rc.2', '1.0.0-rc.1', true],
  ['1.0.0-rc.1', '1.0.0', false],
  ['invalid', '1.0.0', false],
])('compares %s against %s', (candidate, current, expected) => {
  expect(isNewerVersion(candidate, current)).toBe(expected)
})

function setupPackage(metadata: Record<string, unknown>) {
  const entry = path.join(directory, 'package', 'dist', 'bin.js')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '')
  fs.writeFileSync(path.join(directory, 'package', 'package.json'), JSON.stringify(metadata) + '\n')
  process.argv[1] = entry
}

function cacheFile(packageName: string): string {
  return path.join(
    process.env.XDG_CACHE_HOME!,
    'incur',
    'updates',
    `${encodeURIComponent(packageName)}.json`,
  )
}

function readCache(packageName: string) {
  return JSON.parse(fs.readFileSync(cacheFile(packageName), 'utf8'))
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function writeCache(packageName: string, value: Record<string, unknown>) {
  const file = cacheFile(packageName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value) + '\n')
}
