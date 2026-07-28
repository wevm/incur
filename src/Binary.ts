import * as childProcess from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as util from 'node:util'
import * as zlib from 'node:zlib'

import type * as Cli from './Cli.js'
import { isNewerVersion } from './internal/update.js'

declare const __INCUR_BINARY_NAME__: unknown
declare const __INCUR_BINARY_TARGET__: unknown
declare const __INCUR_BINARY_VERSION__: unknown

const githubApi = 'https://api.github.com'
const requestTimeout = 10_000
const downloadTimeout = 120_000
const handoffTimeout = 60_000
const gunzip = util.promisify(zlib.gunzip)

/** @internal Hidden flag used by a detached Windows update handoff. */
export const applyFlag = '--incur-binary-apply'

/** Name embedded by `incur build`, or `undefined` outside a compiled artifact. */
export const name =
  typeof __INCUR_BINARY_NAME__ === 'string' && __INCUR_BINARY_NAME__
    ? __INCUR_BINARY_NAME__
    : undefined

/** Target embedded by `incur build`, or `undefined` outside a compiled artifact. */
export const target =
  typeof __INCUR_BINARY_TARGET__ === 'string' && __INCUR_BINARY_TARGET__
    ? __INCUR_BINARY_TARGET__
    : undefined

/** Version embedded by `incur build`, or `undefined` outside a compiled artifact. */
export const version =
  typeof __INCUR_BINARY_VERSION__ === 'string' && __INCUR_BINARY_VERSION__
    ? __INCUR_BINARY_VERSION__
    : undefined

/**
 * Creates a GitHub Releases update provider for an Incur-built binary.
 *
 * Returns no overrides outside a compiled artifact, preserving package-manager updates.
 */
export function github(options: github.Options): Cli.create.UpdateOptions {
  if (!name || !target || !version) return {}
  if (!isRepository(options.repository))
    throw new Error(`Invalid GitHub repository '${options.repository}'. Expected 'owner/name'.`)

  const binaryName = name
  const binaryTarget = target
  const binaryVersion = version
  const assetName = releaseAssetName(binaryName, binaryTarget)

  return {
    async check(context) {
      const releases = await fetchReleases(options.repository)
      return selectRelease(releases, context.current, assetName)?.version
    },
    ...(process.platform === 'win32' ? { deferred: true } : undefined),
    async install(context) {
      const releases = await fetchReleases(options.repository)
      const release = selectRelease(releases, context.current ?? binaryVersion, assetName)
      if (!release)
        throw new Error(`No compatible update is available for ${binaryName} ${binaryTarget}.`)
      await installRelease(release)
    },
  }
}

export declare namespace github {
  /** Options for a GitHub Releases binary update provider. */
  type Options = {
    /** Public GitHub repository in `owner/name` form. */
    repository: string
  }
}

/**
 * @internal
 * Handles the internal Windows update handoff argument.
 *
 * Call this before normal CLI argument parsing and stop when it returns `true`.
 */
export async function handleArgv(argv: string[] = process.argv.slice(2)): Promise<boolean> {
  if (argv[0] !== applyFlag) {
    if (process.platform === 'win32' && name && target && version)
      await cleanupArtifacts(process.execPath)
    return false
  }
  if (process.platform !== 'win32') throw new Error(`${applyFlag} is only supported on Windows.`)
  if (argv.length !== 2 || !argv[1]) throw new Error(`Invalid ${applyFlag} arguments.`)

  const parent = Number(argv[1])
  if (!Number.isSafeInteger(parent) || parent <= 0)
    throw new Error(`Invalid ${applyFlag} arguments.`)
  await applyWindowsUpdate(parent)
  return true
}

type Asset = {
  browser_download_url: string
  digest?: string | null | undefined
  name: string
}

type Release = {
  assets: Asset[]
  draft: boolean
  prerelease: boolean
  published_at?: string | null | undefined
  tag_name: string
}

type SelectedRelease = {
  asset: Asset
  version: string
}

type WindowsState = {
  backup: string
  error: string
  helper: string
  parent: number
  staged: string
  target: string
}

/** Returns whether a GitHub repository identifier is safe to place in an API URL. */
function isRepository(repository: string): boolean {
  const [owner, name, extra] = repository.split('/')
  if (!owner || !name || extra) return false
  if (owner === '.' || owner === '..' || name === '.' || name === '..') return false
  return /^[A-Za-z0-9_.-]+$/.test(owner) && /^[A-Za-z0-9_.-]+$/.test(name)
}

/** Returns the canonical release asset name for an embedded target. */
function releaseAssetName(binaryName: string, binaryTarget: string): string {
  const extension = binaryTarget.startsWith('windows-') ? '.exe' : ''
  return `${binaryName}-${binaryTarget}${extension}.gz`
}

/** Fetches all public releases exposed by the GitHub Releases API. */
async function fetchReleases(repository: string): Promise<Release[]> {
  const releases: Release[] = []
  let url: string | undefined = `${githubApi}/repos/${repository}/releases?per_page=100`

  while (url) {
    const response = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'incur',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(requestTimeout),
    })
    if (!response.ok)
      throw new Error(
        `GitHub release request failed with ${response.status} ${response.statusText}.`,
      )

    const value = await response.json()
    if (!Array.isArray(value)) throw new Error('GitHub returned invalid release metadata.')
    releases.push(...value.filter(isRelease))
    url = nextPage(response.headers.get('link'))
  }

  return releases
}

/** Returns whether unknown GitHub metadata contains the fields used by the provider. */
function isRelease(value: unknown): value is Release {
  if (!value || typeof value !== 'object') return false
  const release = value as Record<string, unknown>
  return (
    Array.isArray(release.assets) &&
    typeof release.draft === 'boolean' &&
    typeof release.prerelease === 'boolean' &&
    typeof release.tag_name === 'string'
  )
}

/** Extracts a validated next-page URL from a GitHub Link header. */
function nextPage(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const match = part.trim().match(/^<([^>]+)>;\s*rel="next"$/)
    if (!match?.[1]) continue
    const url = new URL(match[1])
    if (url.origin !== githubApi) throw new Error('GitHub returned an invalid pagination URL.')
    return url.href
  }
  return undefined
}

/** Selects the highest compatible stable release. */
function selectRelease(
  releases: Release[],
  current: string,
  assetName: string,
): SelectedRelease | undefined {
  let selected: SelectedRelease | undefined

  for (const release of releases) {
    if (release.draft || release.prerelease || typeof release.published_at !== 'string') continue
    const releaseVersion = stableVersion(release.tag_name)
    if (!releaseVersion || !isNewerVersion(releaseVersion, current)) continue
    const asset = release.assets.find(isAssetNamed(assetName))
    if (!asset) continue
    if (!selected || isNewerVersion(releaseVersion, selected.version))
      selected = { asset, version: releaseVersion }
  }

  return selected
}

/** Returns a stable semantic version from a release tag. */
function stableVersion(tag: string): string | undefined {
  const match = tag.match(/^[vV]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  if (!match) return undefined
  return `${match[1]}.${match[2]}.${match[3]}`
}

/** Returns an asset matcher that validates the fields used during installation. */
function isAssetNamed(assetName: string): (value: unknown) => value is Asset {
  return (value): value is Asset => {
    if (!value || typeof value !== 'object') return false
    const asset = value as Record<string, unknown>
    return (
      asset.name === assetName &&
      typeof asset.browser_download_url === 'string' &&
      (asset.digest === undefined || asset.digest === null || typeof asset.digest === 'string')
    )
  }
}

/** Downloads, verifies, validates, and installs one selected release. */
async function installRelease(release: SelectedRelease): Promise<void> {
  const digest = parseDigest(release.asset.digest)
  if (!digest) throw new Error(`Release asset '${release.asset.name}' has no SHA-256 digest.`)

  const response = await fetch(release.asset.browser_download_url, {
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'incur',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(downloadTimeout),
  })
  if (!response.ok)
    throw new Error(`Binary download failed with ${response.status} ${response.statusText}.`)

  const compressed = Buffer.from(await response.arrayBuffer())
  const actual = crypto.createHash('sha256').update(compressed).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(digest, 'hex')))
    throw new Error(`SHA-256 digest mismatch for '${release.asset.name}'.`)

  const candidate = await decompress(compressed, release.asset.name)
  const paths = updatePaths(process.execPath)
  try {
    const mode = await executableMode(process.execPath)
    await fs.promises.writeFile(paths.staged, candidate, {
      flag: 'wx',
      mode,
    })
    await validateCandidate(paths.staged, release.version)

    if (process.platform === 'win32') await startWindowsHandoff(paths)
    else await fs.promises.rename(paths.staged, process.execPath)
  } catch (error) {
    await remove(paths.staged)
    await remove(paths.helper)
    throw error
  }
}

/** Parses a GitHub Release asset digest. */
function parseDigest(digest: string | null | undefined): string | undefined {
  const match = digest?.match(/^sha256:([0-9a-f]{64})$/i)
  return match?.[1]?.toLowerCase()
}

/** Decompresses a gzip release asset with an actionable error. */
async function decompress(compressed: Buffer, assetName: string): Promise<Buffer> {
  try {
    return await gunzip(compressed)
  } catch {
    throw new Error(`Release asset '${assetName}' is not valid gzip data.`)
  }
}

/** Preserves existing executable bits, with a safe default for a new file. */
async function executableMode(file: string): Promise<number> {
  try {
    const stat = await fs.promises.stat(file)
    return stat.mode & 0o777
  } catch {
    return 0o755
  }
}

/** Runs the staged candidate and requires the expected version output. */
async function validateCandidate(file: string, expected: string): Promise<void> {
  const output = await execFile(file, ['--version'])
  if (output.trim() !== expected)
    throw new Error(
      `Downloaded binary reported version '${output.trim() || 'unknown'}', expected '${expected}'.`,
    )
}

/** Runs an executable and captures stdout while preserving useful failure output. */
function execFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      { encoding: 'utf8', timeout: requestTimeout },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout)
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
      },
    )
  })
}

/** Creates collision-resistant paths beside an installed executable. */
function updatePaths(executable: string): WindowsState {
  const id = crypto.randomUUID()
  const extension = executable.toLowerCase().endsWith('.exe') ? '.exe' : ''
  return {
    backup: `${executable}.incur-backup-${id}${extension}`,
    error: `${executable}.incur-error-${id}.txt`,
    helper: `${executable}.incur-handoff-${id}.exe`,
    parent: process.pid,
    staged: `${executable}.incur-new-${id}${extension}`,
    target: executable,
  }
}

/** Copies a handoff executable and starts it detached. */
async function startWindowsHandoff(state: WindowsState): Promise<void> {
  await fs.promises.copyFile(state.target, state.helper, fs.constants.COPYFILE_EXCL)

  await new Promise<void>((resolve, reject) => {
    const child = childProcess.spawn(state.helper, [applyFlag, String(state.parent)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Applies a validated Windows handoff and rolls back a failed replacement. */
async function applyWindowsUpdate(parent: number): Promise<void> {
  const state = pathsFromHelper(process.execPath, parent)

  let backedUp = false
  try {
    await waitForExit(parent)
    await fs.promises.rename(state.target, state.backup)
    backedUp = true
    await fs.promises.rename(state.staged, state.target)
  } catch (error) {
    let failure = error
    let recovery = `The installed executable remains at '${state.target}'.`
    if (backedUp) {
      try {
        await fs.promises.rename(state.backup, state.target)
        backedUp = false
        recovery = `The previous executable was restored to '${state.target}'.`
      } catch (rollback) {
        try {
          await fs.promises.copyFile(state.backup, state.target, fs.constants.COPYFILE_EXCL)
          recovery = `The previous executable was copied back to '${state.target}', and its backup remains at '${state.backup}'.`
        } catch (recovery) {
          failure = new Error(
            `Binary update failed and '${state.target}' could not be restored. The previous executable remains at '${state.backup}': ${message(recovery)}`,
            { cause: rollback },
          )
        }
      }
    }
    await writeError(state, failure, recovery)
    throw failure
  }

  await remove(state.backup)
  await remove(state.error)
  await remove(state.staged)
  await remove(state.helper)
}

/** Derives every replacement path from the running handoff executable. */
function pathsFromHelper(helper: string, parent: number): WindowsState {
  const absolute = path.resolve(helper)
  const match = absolute.match(
    /^(.*)\.incur-handoff-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.exe$/i,
  )
  if (!match?.[1] || !match[2]) throw new Error('Invalid binary update handoff path.')
  const target = match[1]
  const extension = target.toLowerCase().endsWith('.exe') ? '.exe' : ''
  return {
    backup: `${target}.incur-backup-${match[2]}${extension}`,
    error: `${target}.incur-error-${match[2]}.txt`,
    helper: absolute,
    parent,
    staged: `${target}.incur-new-${match[2]}${extension}`,
    target,
  }
}

/** Waits for the parent updater process to release the installed executable. */
async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + handoffTimeout
  while (isRunning(pid)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for update process ${pid} to exit.`)
    await delay(100)
  }
}

/** Returns whether a process still exists without sending it a signal. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Resolves after a short handoff polling interval. */
function delay(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration))
}

/** Removes unlocked handoff copies on the next normal compiled-binary startup. */
async function cleanupArtifacts(executable: string): Promise<void> {
  const directory = path.dirname(executable)
  const prefix = `${path.basename(executable)}.incur-handoff-`
  try {
    const entries = await fs.promises.readdir(directory)
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.startsWith(prefix) &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.exe$/i.test(
              entry.slice(prefix.length),
            ),
        )
        .map((entry) => remove(path.join(directory, entry))),
    )
  } catch {}
}

/** Preserves an actionable detached-handoff failure beside the executable. */
async function writeError(state: WindowsState, error: unknown, recovery: string): Promise<void> {
  const body = [
    `Binary update failed: ${message(error)}`,
    `Recovery: ${recovery}`,
    `Downloaded candidate: ${state.staged}`,
    `Previous executable backup: ${state.backup}`,
  ].join('\n')
  try {
    await fs.promises.writeFile(state.error, `${body}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
  } catch {}
}

/** Removes one update artifact when it still exists. */
async function remove(file: string): Promise<void> {
  try {
    await fs.promises.unlink(file)
  } catch {}
}

/** Returns a useful error message for a failed rollback. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
