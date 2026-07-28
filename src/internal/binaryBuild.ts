import * as childProcess from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as path from 'node:path'
import * as stream from 'node:stream/promises'
import * as zlib from 'node:zlib'

/** Canonical standalone-binary targets supported by Incur. */
export const targets = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-glibc',
  'linux-x64-glibc-baseline',
  'linux-arm64-musl',
  'linux-x64-musl-baseline',
  'windows-arm64',
  'windows-x64-baseline',
] as const

/** A canonical standalone-binary target. */
export type Target = (typeof targets)[number]

const definitions: Record<Target, { bun: string; windows: boolean }> = {
  'darwin-arm64': { bun: 'bun-darwin-arm64', windows: false },
  'darwin-x64': { bun: 'bun-darwin-x64-baseline', windows: false },
  'linux-arm64-glibc': { bun: 'bun-linux-arm64', windows: false },
  'linux-arm64-musl': { bun: 'bun-linux-arm64-musl', windows: false },
  'linux-x64-glibc-baseline': { bun: 'bun-linux-x64-baseline', windows: false },
  'linux-x64-musl-baseline': { bun: 'bun-linux-x64-musl-baseline', windows: false },
  'windows-arm64': { bun: 'bun-windows-arm64', windows: true },
  'windows-x64-baseline': { bun: 'bun-windows-x64-baseline', windows: true },
}

/** Builds compressed standalone executables with embedded release metadata. */
export async function build(options: build.Options): Promise<build.Result> {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const resolved = await resolveEntry(options.entry, cwd, options.name)
  const metadata = await findPackage(path.dirname(resolved.entry))
  const name = normalizeName(options.name ?? resolveName(metadata?.value, resolved.binName))
  const version = normalizeVersion(options.version ?? metadata?.value.version)
  const output = options.output
    ? path.resolve(cwd, options.output)
    : path.join(metadata?.directory ?? path.dirname(resolved.entry), 'dist', 'binaries')
  const selected = normalizeTargets(options.targets)
  const execute = options.execute ?? executeCommand
  const bun = options.bun ?? 'bun'

  try {
    await execute(bun, ['--version'], { cwd })
  } catch (error) {
    throw new Error('Bun is required to build standalone binaries. Install Bun and try again.', {
      cause: error,
    })
  }

  await fsPromises.mkdir(path.dirname(output), { recursive: true })
  const staging = await fsPromises.mkdtemp(path.join(path.dirname(output), '.incur-build-'))

  try {
    // Prevent Bun from treating a CLI's default export as an auto-started server.
    const entry = path.join(staging, 'entry.ts')
    const source = resolved.entry.replaceAll(path.sep, '/')
    await fsPromises.writeFile(entry, `await import(${JSON.stringify(source)})\n`)
    const artifacts: build.Artifact[] = []
    for (const target of selected) {
      const definition = definitions[target]
      const executableName = `${name}-${target}${definition.windows ? '.exe' : ''}`
      const executable = path.join(staging, executableName)
      const asset = `${executable}.gz`
      const args = [
        'build',
        entry,
        '--compile',
        `--target=${definition.bun}`,
        `--outfile=${executable}`,
        '--define',
        `__INCUR_BINARY_NAME__=${JSON.stringify(name)}`,
        '--define',
        `__INCUR_BINARY_TARGET__=${JSON.stringify(target)}`,
        '--define',
        `__INCUR_BINARY_VERSION__=${JSON.stringify(version)}`,
      ]

      try {
        await execute(bun, args, { cwd, target })
      } catch (error) {
        throw new Error(`Failed to build target ${target}: ${errorMessage(error)}`, {
          cause: error,
        })
      }

      await assertFile(executable, target)
      if (!definition.windows) await fsPromises.chmod(executable, 0o755)
      await stream.pipeline(
        fs.createReadStream(executable),
        zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION }),
        fs.createWriteStream(asset),
      )

      artifacts.push({
        asset: path.join(output, path.basename(asset)),
        executable: path.join(output, executableName),
        sha256: await digest(asset),
        target,
      })
    }

    const checksums = path.join(output, 'SHA256SUMS')
    const checksumContents =
      artifacts
        .map((artifact) => `${artifact.sha256}  ${path.basename(artifact.asset)}`)
        .join('\n') + '\n'
    await fsPromises.writeFile(path.join(staging, 'SHA256SUMS'), checksumContents)
    await fsPromises.mkdir(output, { recursive: true })
    await cleanOutput(output, name)

    for (const artifact of artifacts) {
      await fsPromises.copyFile(
        path.join(staging, path.basename(artifact.executable)),
        artifact.executable,
      )
      await fsPromises.copyFile(path.join(staging, path.basename(artifact.asset)), artifact.asset)
      if (!definitions[artifact.target].windows) await fsPromises.chmod(artifact.executable, 0o755)
    }
    await fsPromises.copyFile(path.join(staging, 'SHA256SUMS'), checksums)

    return {
      artifacts,
      checksums,
      entry: resolved.entry,
      name,
      output,
      version,
    }
  } finally {
    await fsPromises.rm(staging, { force: true, recursive: true })
  }
}

export declare namespace build {
  /** A built executable and its compressed release asset. */
  type Artifact = {
    /** Absolute path to the compressed release asset. */
    asset: string
    /** Absolute path to the runnable executable. */
    executable: string
    /** SHA-256 digest of the compressed release asset. */
    sha256: string
    /** Canonical target embedded in the executable. */
    target: Target
  }

  /** Command execution context. */
  type ExecuteContext = {
    /** Project working directory. */
    cwd: string
    /** Target being compiled, when applicable. */
    target?: Target | undefined
  }

  /** Command executor used for Bun discovery and compilation. */
  type Execute = (command: string, args: string[], context: ExecuteContext) => Promise<void>

  /** Standalone-binary build options. */
  type Options = {
    /** Bun executable name or path. */
    bun?: string | undefined
    /** Working directory used to resolve relative paths. */
    cwd?: string | undefined
    /** CLI entrypoint file or project directory. */
    entry: string
    /** Command executor override used by tests and build integrations. */
    execute?: Execute | undefined
    /** CLI name override. */
    name?: string | undefined
    /** Output directory, relative to `cwd` by default. */
    output?: string | undefined
    /** Canonical targets to build. Defaults to the full supported matrix. */
    targets?: string[] | undefined
    /** CLI version override. */
    version?: string | undefined
  }

  /** Standalone-binary build result. */
  type Result = {
    /** Built executables and release assets. */
    artifacts: Artifact[]
    /** Absolute path to `SHA256SUMS`. */
    checksums: string
    /** Absolute resolved entrypoint path. */
    entry: string
    /** Resolved CLI name. */
    name: string
    /** Absolute output directory. */
    output: string
    /** Resolved CLI version. */
    version: string
  }
}

type Package = {
  bin?: Record<string, string> | string | undefined
  name?: string | undefined
  version?: string | undefined
}

type ResolvedEntry = {
  binName?: string | undefined
  entry: string
}

async function resolveEntry(
  input: string,
  cwd: string,
  name: string | undefined,
): Promise<ResolvedEntry> {
  const resolved = path.resolve(cwd, input)
  const stat = await fsPromises.stat(resolved).catch(() => undefined)
  if (!stat) throw new Error(`Entrypoint does not exist: ${resolved}`)
  if (stat.isFile()) return { entry: resolved }
  if (!stat.isDirectory()) throw new Error(`Entrypoint is not a file or directory: ${resolved}`)

  const metadata = await readPackage(resolved)
  const bin = metadata?.bin
  if (typeof bin === 'string') return resolveFile(path.resolve(resolved, bin))
  if (bin && typeof bin === 'object') {
    const entries = Object.entries(bin)
    const selected = (() => {
      // An explicit matching name selects its package binary.
      if (name && bin[name]) return [name, bin[name]] as const
      // A single package binary is unambiguous.
      if (entries.length === 1) return entries[0]
      // Multiple package binaries require the caller to choose.
      return undefined
    })()
    if (!selected)
      throw new Error(
        `Project has multiple package binaries. Pass an entry file or select one with --name: ${resolved}`,
      )
    const result = await resolveFile(path.resolve(resolved, selected[1]))
    return { ...result, binName: selected[0] }
  }

  return resolveFile(path.join(resolved, 'cli.ts'))
}

async function resolveFile(entry: string): Promise<ResolvedEntry> {
  const stat = await fsPromises.stat(entry).catch(() => undefined)
  if (!stat?.isFile()) throw new Error(`Entrypoint does not exist: ${entry}`)
  return { entry }
}

async function findPackage(
  directory: string,
): Promise<{ directory: string; value: Package } | undefined> {
  let current = directory
  while (true) {
    const value = await readPackage(current)
    if (value) return { directory: current, value }
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function readPackage(directory: string): Promise<Package | undefined> {
  const file = path.join(directory, 'package.json')
  const contents = await fsPromises.readFile(file, 'utf8').catch((error: unknown) => {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw new Error(`Could not read package metadata: ${file}`, { cause: error })
  })
  if (contents === undefined) return undefined
  try {
    return JSON.parse(contents)
  } catch (error) {
    throw new Error(`Invalid package metadata: ${file}`, { cause: error })
  }
}

function resolveName(
  metadata: Package | undefined,
  binName: string | undefined,
): string | undefined {
  if (binName) return binName
  if (!metadata?.name) return undefined
  return metadata.name.includes('/')
    ? metadata.name.slice(metadata.name.lastIndexOf('/') + 1)
    : metadata.name
}

function normalizeName(value: string | undefined): string {
  const name = value?.trim()
  if (!name)
    throw new Error('Could not resolve a CLI name. Add package.json `name` or pass --name.')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) throw new Error(`Invalid CLI name: ${name}`)
  return name
}

function normalizeVersion(value: string | undefined): string {
  const version = value?.trim()
  if (!version)
    throw new Error(
      'Could not resolve a CLI version. Add package.json `version` or pass --version.',
    )
  return version
}

function normalizeTargets(values: string[] | undefined): Target[] {
  if (!values?.length) return [...targets]
  const selected = [
    ...new Set(values.flatMap((value) => value.split(',').map((item) => item.trim()))),
  ]
  const invalid = selected.filter((target) => !targets.includes(target as Target))
  if (invalid.length > 0)
    throw new Error(
      `Unsupported target${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')}. Supported targets: ${targets.join(', ')}`,
    )
  return selected as Target[]
}

/** Removes managed artifacts without disturbing unrelated output files. */
async function cleanOutput(directory: string, name: string): Promise<void> {
  const files = new Set(['SHA256SUMS'])
  for (const target of targets) {
    const extension = definitions[target].windows ? '.exe' : ''
    const executable = `${name}-${target}${extension}`
    files.add(executable)
    files.add(`${executable}.gz`)
  }

  try {
    const checksums = await fsPromises.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')
    for (const line of checksums.split('\n')) {
      const asset = line.match(/^[0-9a-f]{64} {2}(.+)$/i)?.[1]
      if (!asset || path.basename(asset) !== asset || !isBinaryAsset(asset)) continue
      files.add(asset)
      files.add(asset.slice(0, -'.gz'.length))
    }
  } catch {}

  await Promise.all(
    [...files].map((file) => fsPromises.rm(path.join(directory, file), { force: true })),
  )
}

function isBinaryAsset(file: string): boolean {
  return targets.some((target) => {
    const extension = definitions[target].windows ? '.exe' : ''
    return file.endsWith(`-${target}${extension}.gz`)
  })
}

async function assertFile(file: string, target: Target): Promise<void> {
  const stat = await fsPromises.stat(file).catch(() => undefined)
  if (!stat?.isFile()) throw new Error(`Bun did not produce an executable for target ${target}.`)
}

async function digest(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function executeCommand(
  command: string,
  args: string[],
  context: build.ExecuteContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      command,
      args,
      { cwd: context.cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve()
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
      },
    )
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
