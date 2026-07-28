import * as childProcess from 'node:child_process'
import * as crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    spawn: vi.fn(actual.spawn),
  }
})

const savedExecPath = process.execPath
const savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const directories: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  process.execPath = savedExecPath
  Object.defineProperty(process, 'platform', savedPlatform)
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => fs.promises.rm(directory, { force: true, recursive: true })),
  )
})

test('is inactive outside an Incur-built binary', async () => {
  const Binary = await load()

  expect({
    name: Binary.name,
    provider: Binary.github({ repository: 'wevm/frog' }),
    target: Binary.target,
    version: Binary.version,
  }).toEqual({
    name: undefined,
    provider: {},
    target: undefined,
    version: undefined,
  })
})

test('selects the highest stable release with an exact target asset', async () => {
  const Binary = await load(binary)
  const releases = [
    release('1.0.0'),
    release('v1.2.0'),
    release('1.3.0', { asset: 'frog-linux-x64-glibc-baseline.gz' }),
    release('2.0.0-beta.1'),
    release('8.0.0', { prerelease: true }),
    release('9.0.0', { draft: true }),
    release('1.4.0'),
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(releases)),
  )

  const provider = Binary.github({ repository: 'wevm/frog' })

  await expect(provider.check!({ current: '1.0.0', name: 'frog' })).resolves.toBe('1.4.0')
})

test('uses an explicit CLI version instead of embedded version metadata', async () => {
  const Binary = await load(binary)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response([release('1.4.0')])),
  )
  const provider = Binary.github({ repository: 'wevm/frog' })

  await expect(provider.check!({ current: '2.0.0', name: 'frog' })).resolves.toBeUndefined()
})

test('follows validated GitHub release pagination', async () => {
  const Binary = await load(binary)
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response([release('1.1.0')], {
        link: '<https://api.github.com/repos/wevm/frog/releases?page=2>; rel="next"',
      }),
    )
    .mockResolvedValueOnce(response([release('1.2.0')]))
  vi.stubGlobal('fetch', fetch)

  const provider = Binary.github({ repository: 'wevm/frog' })

  await expect(provider.check!({ current: '1.0.0', name: 'frog' })).resolves.toBe('1.2.0')
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('rejects unsafe repository identifiers in compiled binaries', async () => {
  const Binary = await load(binary)

  expect(() => Binary.github({ repository: '../private' })).toThrow(
    "Invalid GitHub repository '../private'. Expected 'owner/name'.",
  )
})

test('verifies, validates, and atomically replaces a Unix executable', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const executable = path.join(directory, 'frog')
  const old = script('1.0.0')
  const candidate = script('2.0.0')
  await fs.promises.writeFile(executable, old, { mode: 0o700 })
  process.execPath = executable
  mockReleaseDownload(candidate, '2.0.0')

  const provider = Binary.github({ repository: 'wevm/frog' })
  await provider.install!({
    current: '1.0.0',
    latest: '2.0.0',
    name: 'frog',
  })

  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe(candidate)
  expect((await fs.promises.stat(executable)).mode & 0o777).toBe(0o700)
  expect(await fs.promises.readdir(directory)).toEqual(['frog'])
})

test('installs the highest release when the cached notice is stale', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const executable = path.join(directory, 'frog')
  const candidate = script('3.0.0')
  const compressed = zlib.gzipSync(candidate)
  const digest = crypto.createHash('sha256').update(compressed).digest('hex')
  await fs.promises.writeFile(executable, script('2.0.0'), { mode: 0o755 })
  process.execPath = executable
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://api.github.com/'))
        return response([release('2.0.0'), release('3.0.0', { digest: `sha256:${digest}` })])
      return new Response(new Uint8Array(compressed))
    }),
  )

  const provider = Binary.github({ repository: 'wevm/frog' })
  await provider.install!({
    current: '2.0.0',
    latest: '2.0.0',
    name: 'frog',
  })

  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe(candidate)
})

test('preserves the executable when the digest does not match', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const executable = path.join(directory, 'frog')
  const old = script('1.0.0')
  await fs.promises.writeFile(executable, old, { mode: 0o755 })
  process.execPath = executable
  mockReleaseDownload(script('2.0.0'), '2.0.0', '0'.repeat(64))

  const provider = Binary.github({ repository: 'wevm/frog' })

  await expect(
    provider.install!({
      current: '1.0.0',
      latest: '2.0.0',
      name: 'frog',
    }),
  ).rejects.toThrow("SHA-256 digest mismatch for 'frog-darwin-arm64.gz'.")
  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe(old)
  expect(await fs.promises.readdir(directory)).toEqual(['frog'])
})

test('requires a GitHub SHA-256 digest before downloading', async () => {
  const Binary = await load(binary)
  const fetch = vi.fn(async () => response([release('2.0.0', { digest: null })]))
  vi.stubGlobal('fetch', fetch)
  const provider = Binary.github({ repository: 'wevm/frog' })

  await expect(
    provider.install!({
      current: '1.0.0',
      latest: '2.0.0',
      name: 'frog',
    }),
  ).rejects.toThrow("Release asset 'frog-darwin-arm64.gz' has no SHA-256 digest.")
  expect(fetch).toHaveBeenCalledOnce()
})

test('preserves the executable when the candidate reports another version', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const executable = path.join(directory, 'frog')
  const old = script('1.0.0')
  await fs.promises.writeFile(executable, old, { mode: 0o755 })
  process.execPath = executable
  mockReleaseDownload(script('3.0.0'), '2.0.0')

  const provider = Binary.github({ repository: 'wevm/frog' })

  await expect(
    provider.install!({
      current: '1.0.0',
      latest: '2.0.0',
      name: 'frog',
    }),
  ).rejects.toThrow("Downloaded binary reported version '3.0.0', expected '2.0.0'.")
  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe(old)
  expect(await fs.promises.readdir(directory)).toEqual(['frog'])
})

test('stages a Windows candidate and starts a distinct detached helper', async () => {
  const Binary = await load({ ...binary, target: 'windows-x64-baseline' })
  const directory = await temporaryDirectory()
  const executable = path.join(directory, 'frog.exe')
  await fs.promises.writeFile(executable, script('1.0.0'), { mode: 0o755 })
  process.execPath = executable
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  })
  mockReleaseDownload(script('2.0.0'), '2.0.0', undefined, {
    asset: 'frog-windows-x64-baseline.exe.gz',
  })
  const child = new EventEmitter() as ReturnType<typeof childProcess.spawn>
  child.unref = vi.fn()
  vi.mocked(childProcess.spawn).mockImplementationOnce(() => {
    queueMicrotask(() => child.emit('spawn'))
    return child
  })

  const provider = Binary.github({ repository: 'wevm/frog' })
  expect(provider.deferred).toBe(true)
  await provider.install!({
    current: '1.0.0',
    latest: '2.0.0',
    name: 'frog',
  })

  const [helper, args, options] = vi.mocked(childProcess.spawn).mock.calls[0]!
  expect(helper).toMatch(/frog\.exe\.incur-handoff-.+\.exe$/)
  expect(args).toEqual([Binary.applyFlag, String(process.pid)])
  expect(options).toEqual({
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  await expect(fs.promises.readFile(helper as string, 'utf8')).resolves.toBe(script('1.0.0'))
  const entries = await fs.promises.readdir(directory)
  expect(entries).toHaveLength(3)
  expect(entries).toContain('frog.exe')
  expect(entries.some((entry) => entry.includes('.incur-new-'))).toBe(true)
})

test('applies a detached Windows handoff from helper-derived paths', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const id = crypto.randomUUID()
  const executable = path.join(directory, 'frog.exe')
  const helper = `${executable}.incur-handoff-${id}.exe`
  const staged = `${executable}.incur-new-${id}.exe`
  await fs.promises.writeFile(executable, 'old')
  await fs.promises.writeFile(helper, 'helper')
  await fs.promises.writeFile(staged, 'new')
  process.execPath = helper
  setPlatform('win32')

  await expect(Binary.handleArgv([Binary.applyFlag, '99999999'])).resolves.toBe(true)

  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe('new')
  expect(await fs.promises.readdir(directory)).toEqual(['frog.exe'])
})

test('rolls back a failed Windows handoff and preserves failure evidence', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const id = crypto.randomUUID()
  const executable = path.join(directory, 'frog.exe')
  const helper = `${executable}.incur-handoff-${id}.exe`
  const error = `${executable}.incur-error-${id}.txt`
  await fs.promises.writeFile(executable, 'old')
  await fs.promises.writeFile(helper, 'helper')
  process.execPath = helper
  setPlatform('win32')

  await expect(Binary.handleArgv([Binary.applyFlag, '99999999'])).rejects.toThrow(/ENOENT/)

  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe('old')
  const evidence = await fs.promises.readFile(error, 'utf8')
  expect(evidence).toContain('Binary update failed:')
  expect(evidence).toContain('The previous executable was restored')
  expect(await fs.promises.readdir(directory)).toEqual(
    expect.arrayContaining([path.basename(error), 'frog.exe', path.basename(helper)]),
  )
})

test('preserves a candidate and error marker when the parent does not exit', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const id = crypto.randomUUID()
  const executable = path.join(directory, 'frog.exe')
  const helper = `${executable}.incur-handoff-${id}.exe`
  const staged = `${executable}.incur-new-${id}.exe`
  const error = `${executable}.incur-error-${id}.txt`
  await fs.promises.writeFile(executable, 'old')
  await fs.promises.writeFile(helper, 'helper')
  await fs.promises.writeFile(staged, 'new')
  process.execPath = helper
  setPlatform('win32')
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.useFakeTimers()

  const result = Binary.handleArgv([Binary.applyFlag, '12345'])
  await vi.advanceTimersByTimeAsync(60_000)

  await expect(result).rejects.toThrow('Timed out waiting for update process 12345 to exit.')
  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe('old')
  await expect(fs.promises.readFile(staged, 'utf8')).resolves.toBe('new')
  await expect(fs.promises.readFile(error, 'utf8')).resolves.toContain(
    `The installed executable remains at '${executable}'.`,
  )
})

test('copies a Windows backup back when rollback rename fails', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const id = crypto.randomUUID()
  const executable = path.join(directory, 'frog.exe')
  const helper = `${executable}.incur-handoff-${id}.exe`
  const backup = `${executable}.incur-backup-${id}.exe`
  const error = `${executable}.incur-error-${id}.txt`
  await fs.promises.writeFile(executable, 'old')
  await fs.promises.writeFile(helper, 'helper')
  process.execPath = helper
  setPlatform('win32')
  const rename = fs.promises.rename.bind(fs.promises)
  let calls = 0
  vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
    calls++
    if (calls === 3) throw new Error('rollback rename failed')
    return rename(from, to)
  })

  await expect(Binary.handleArgv([Binary.applyFlag, '99999999'])).rejects.toThrow(/ENOENT/)

  await expect(fs.promises.readFile(executable, 'utf8')).resolves.toBe('old')
  await expect(fs.promises.readFile(backup, 'utf8')).resolves.toBe('old')
  await expect(fs.promises.readFile(error, 'utf8')).resolves.toContain(
    'The previous executable was copied back',
  )
})

test('rejects the internal apply flag outside Windows', async () => {
  const Binary = await load(binary)

  await expect(Binary.handleArgv([Binary.applyFlag, '99999999'])).rejects.toThrow(
    `${Binary.applyFlag} is only supported on Windows.`,
  )
})

test('rejects a handoff executable that cannot derive its target', async () => {
  const Binary = await load(binary)
  process.execPath = path.join(os.tmpdir(), 'frog-helper.exe')
  setPlatform('win32')

  await expect(Binary.handleArgv([Binary.applyFlag, '99999999'])).rejects.toThrow(
    'Invalid binary update handoff path.',
  )
})

test('normal compiled startup removes only unlocked helpers', async () => {
  const Binary = await load(binary)
  const directory = await temporaryDirectory()
  const executable = path.join(directory, 'frog.exe')
  const helper = `${executable}.incur-handoff-${crypto.randomUUID()}.exe`
  const error = `${executable}.incur-error-${crypto.randomUUID()}.txt`
  const lookalike = `${executable}.incur-handoff-not-managed.txt`
  await fs.promises.writeFile(executable, 'old')
  await fs.promises.writeFile(helper, 'helper')
  await fs.promises.writeFile(error, 'failure evidence')
  await fs.promises.writeFile(lookalike, 'unrelated')
  process.execPath = executable
  setPlatform('win32')

  await expect(Binary.handleArgv([])).resolves.toBe(false)

  await expect(fs.promises.stat(helper)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.promises.readFile(error, 'utf8')).resolves.toBe('failure evidence')
  await expect(fs.promises.readFile(lookalike, 'utf8')).resolves.toBe('unrelated')
})

type Metadata = {
  name: string
  target: string
  version: string
}

const binary: Metadata = {
  name: 'frog',
  target: 'darwin-arm64',
  version: '1.0.0',
}

async function load(metadata?: Metadata | undefined) {
  vi.resetModules()
  if (metadata) {
    vi.stubGlobal('__INCUR_BINARY_NAME__', metadata.name)
    vi.stubGlobal('__INCUR_BINARY_TARGET__', metadata.target)
    vi.stubGlobal('__INCUR_BINARY_VERSION__', metadata.version)
  }
  return import('./Binary.js')
}

function release(
  version: string,
  options: {
    asset?: string | undefined
    digest?: string | null | undefined
    draft?: boolean | undefined
    prerelease?: boolean | undefined
  } = {},
) {
  return {
    assets: [
      {
        browser_download_url: 'https://github.com/wevm/frog/releases/download/asset',
        digest: 'digest' in options ? options.digest : `sha256:${'1'.repeat(64)}`,
        name: options.asset ?? 'frog-darwin-arm64.gz',
      },
    ],
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: '2026-01-01T00:00:00Z',
    tag_name: version,
  }
}

function response(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function mockReleaseDownload(
  candidate: string,
  version: string,
  digest?: string | undefined,
  options: { asset?: string | undefined } = {},
) {
  const compressed = zlib.gzipSync(candidate)
  const expected = digest ?? crypto.createHash('sha256').update(compressed).digest('hex')
  const metadata = release(version, {
    asset: options.asset,
    digest: `sha256:${expected}`,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://api.github.com/')) return response([metadata])
      return new Response(new Uint8Array(compressed))
    }),
  )
}

function script(version: string): string {
  return `#!/bin/sh\nprintf '${version}\\n'\n`
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'incur-binary-'))
  directories.push(directory)
  return directory
}

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  })
}
