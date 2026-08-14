import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

import { build, type Target, targets } from './binaryBuild.js'
import { marker as installerMarker } from './binaryInstaller.js'

const decompress = promisify(gunzip)
const exec = promisify(execFile)

let directory: string
let entry: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'incur-binary-build-'))
  entry = join(directory, 'cli.ts')
  await writeFile(entry, 'console.log("fixture")\n')
})

afterEach(async () => {
  await rm(directory, { force: true, recursive: true })
})

describe('build', () => {
  test('builds the default target matrix with stable assets and embedded metadata', async () => {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@example/frog', version: '1.2.3' }),
    )
    const calls: { args: string[]; target?: Target | undefined }[] = []
    const execute: build.Execute = async (_command, args, context) => {
      calls.push({ args, target: context.target })
      if (args[0] === '--version') return
      const output = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(output, `${context.target}\n${args.join('\n')}\n`)
    }

    const result = await build({ entry, execute })

    expect(result).toMatchObject({
      entry,
      name: 'frog',
      output: join(directory, 'dist', 'binaries'),
      version: '1.2.3',
    })
    expect(result.artifacts.map((artifact) => basename(artifact.executable))).toEqual([
      'frog-darwin-arm64',
      'frog-darwin-x64',
      'frog-linux-arm64-glibc',
      'frog-linux-x64-glibc-baseline',
      'frog-linux-arm64-musl',
      'frog-linux-x64-musl-baseline',
      'frog-windows-arm64.exe',
      'frog-windows-x64-baseline.exe',
    ])
    expect(result.artifacts.map((artifact) => basename(artifact.asset))).toEqual([
      'frog-darwin-arm64.gz',
      'frog-darwin-x64.gz',
      'frog-linux-arm64-glibc.gz',
      'frog-linux-x64-glibc-baseline.gz',
      'frog-linux-arm64-musl.gz',
      'frog-linux-x64-musl-baseline.gz',
      'frog-windows-arm64.exe.gz',
      'frog-windows-x64-baseline.exe.gz',
    ])
    expect(calls.slice(1).map(({ args, target }) => ({ target, targetFlag: args[3] })))
      .toMatchInlineSnapshot(`
        [
          {
            "target": "darwin-arm64",
            "targetFlag": "--target=bun-darwin-arm64",
          },
          {
            "target": "darwin-x64",
            "targetFlag": "--target=bun-darwin-x64-baseline",
          },
          {
            "target": "linux-arm64-glibc",
            "targetFlag": "--target=bun-linux-arm64",
          },
          {
            "target": "linux-x64-glibc-baseline",
            "targetFlag": "--target=bun-linux-x64-baseline",
          },
          {
            "target": "linux-arm64-musl",
            "targetFlag": "--target=bun-linux-arm64-musl",
          },
          {
            "target": "linux-x64-musl-baseline",
            "targetFlag": "--target=bun-linux-x64-musl-baseline",
          },
          {
            "target": "windows-arm64",
            "targetFlag": "--target=bun-windows-arm64",
          },
          {
            "target": "windows-x64-baseline",
            "targetFlag": "--target=bun-windows-x64-baseline",
          },
        ]
      `)

    for (const artifact of result.artifacts) {
      const compressed = await readFile(artifact.asset)
      const contents = (await decompress(compressed)).toString()
      expect(contents).toContain(`__INCUR_BINARY_NAME__="frog"`)
      expect(contents).toContain(`__INCUR_BINARY_TARGET__="${artifact.target}"`)
      expect(contents).toContain('__INCUR_BINARY_VERSION__="1.2.3"')
      expect(artifact.sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
      if (!artifact.target.startsWith('windows-'))
        expect((await stat(artifact.executable)).mode & 0o111).not.toBe(0)
    }

    const checksums = await readFile(result.checksums, 'utf8')
    expect(checksums.split('\n').filter(Boolean)).toHaveLength(targets.length)
    for (const artifact of result.artifacts)
      expect(checksums).toContain(`${artifact.sha256}  ${basename(artifact.asset)}`)
  })

  test('supports entry, name, version, output, and target overrides', async () => {
    const output = join(directory, 'release')
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    const result = await build({
      entry: 'cli.ts',
      execute,
      name: 'toad',
      output: 'release',
      targets: ['darwin-arm64,windows-x64-baseline', 'darwin-arm64'],
      version: '4.5.6',
      cwd: directory,
    })

    expect(result).toMatchObject({
      entry,
      name: 'toad',
      output,
      version: '4.5.6',
    })
    expect(result.artifacts.map((artifact) => artifact.target)).toEqual([
      'darwin-arm64',
      'windows-x64-baseline',
    ])
  })

  test('embeds adjacent filesystem commands in the standalone entrypoint', async () => {
    await writeFile(entry, 'await cli.fs().serve()\n')
    await mkdir(join(directory, 'commands', 'project'), { recursive: true })
    await writeFile(join(directory, 'commands', 'status.ts'), 'export default {}\n')
    await writeFile(join(directory, 'commands', 'project', 'list.ts'), 'export default {}\n')
    let compiledEntry = ''
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      compiledEntry = await readFile(args[1]!, 'utf8')
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' })

    expect(compiledEntry).toContain('Symbol.for("incur.fs.manifests")')
    expect(compiledEntry).toContain('commands/status.ts')
    expect(compiledEntry).toContain('segments: ["project","list"]')
    expect(compiledEntry).toContain('load: () => import(')
    expect(compiledEntry).not.toContain('import __incurCommand')
  })

  test('embeds every filesystem command directory in source order', async () => {
    await writeFile(
      entry,
      "await cli.fs(new URL('./routes-a/', import.meta.url)).fs(new URL('./routes-b/', import.meta.url)).serve()\n",
    )
    await mkdir(join(directory, 'routes-a'))
    await mkdir(join(directory, 'routes-b'))
    await writeFile(join(directory, 'routes-a', 'alpha.ts'), 'export default {}\n')
    await writeFile(join(directory, 'routes-b', 'beta.ts'), 'export default {}\n')
    let compiledEntry = ''
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      compiledEntry = await readFile(args[1]!, 'utf8')
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' })

    expect(compiledEntry).toContain('routes-a/alpha.ts')
    expect(compiledEntry).toContain('routes-b/beta.ts')
    expect(compiledEntry.indexOf('routes-a/alpha.ts')).toBeLessThan(
      compiledEntry.indexOf('routes-b/beta.ts'),
    )
    expect(compiledEntry).toContain('segments: ["alpha"] }], [{ load: () => import(')
    expect(compiledEntry.match(/load: \(\) => import\(/g)).toHaveLength(2)
  })

  test('does not inspect adjacent commands unless the entrypoint enables filesystem routing', async () => {
    await mkdir(join(directory, 'commands'))
    await writeFile(join(directory, 'commands', 'badName.ts'), 'throw new Error()\n')
    let compiledEntry = ''
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      compiledEntry = await readFile(args[1]!, 'utf8')
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' })

    expect(compiledEntry).not.toContain('incur.fs.manifests')
  })

  test('ignores filesystem routing examples in comments and strings', async () => {
    await writeFile(
      entry,
      [
        '// cli.fs(routes)',
        '/* cli.fs() */',
        'const quoted = "cli.fs(routes)"',
        'const template = `cli.fs()`',
      ].join('\n'),
    )
    await mkdir(join(directory, 'commands'))
    await writeFile(join(directory, 'commands', 'badName.ts'), 'throw new Error()\n')
    let compiledEntry = ''
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      compiledEntry = await readFile(args[1]!, 'utf8')
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' })

    expect(compiledEntry).not.toContain('incur.fs.manifests')
  })

  test('embeds a static directory URL passed to filesystem routing', async () => {
    await writeFile(entry, "await cli.fs(new URL('./routes/', import.meta.url)).serve()\n")
    await mkdir(join(directory, 'routes'))
    await writeFile(join(directory, 'routes', 'status.ts'), 'export default {}\n')
    let compiledEntry = ''
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      compiledEntry = await readFile(args[1]!, 'utf8')
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' })

    expect(compiledEntry).toContain('routes/status.ts')
  })

  test('embeds an empty manifest for an empty filesystem command directory', async () => {
    await writeFile(entry, 'await cli.fs().serve()\n')
    await mkdir(join(directory, 'commands'))
    let compiledEntry = ''
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      compiledEntry = await readFile(args[1]!, 'utf8')
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' })

    expect(compiledEntry).toContain('Symbol.for("incur.fs.manifests")] = [[]]')
  })

  test('rejects filesystem directories that cannot be inferred for a standalone build', async () => {
    await writeFile(entry, 'await cli.fs(routes).serve()\n')
    const execute = vi.fn<build.Execute>().mockResolvedValue(undefined)

    await expect(
      build({ entry, execute, name: 'frog', targets: ['darwin-arm64'], version: '1.0.0' }),
    ).rejects.toThrow('Standalone builds require `fs()`')
  })

  test('generates release-pinned installers from package metadata', async () => {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'frog',
        repository: { type: 'git', url: 'git+https://github.com/wevm/frog.git' },
        version: '1.2.3',
      }),
    )
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    const result = await build({
      entry,
      execute,
      installer: true,
      tag: 'frog@1.2.3',
    })

    expect(result.installers).toEqual({
      powershell: join(directory, 'dist', 'binaries', 'install.ps1'),
      shell: join(directory, 'dist', 'binaries', 'install.sh'),
    })
    await expect(readFile(result.installers!.shell, 'utf8')).resolves.toContain(
      'base_url="https://github.com/$repository/releases/download/$tag"',
    )
    await expect(readFile(result.installers!.powershell, 'utf8')).resolves.toContain(
      '$baseUrl = "https://github.com/$repository/releases/download/$tag"',
    )
    await expect(readFile(result.installers!.shell, 'utf8')).resolves.toContain(
      "repository='wevm/frog'",
    )
    await expect(readFile(result.installers!.shell, 'utf8')).resolves.toContain("tag='frog@1.2.3'")
    expect((await stat(result.installers!.shell)).mode & 0o111).not.toBe(0)
  })

  test('removes stale managed artifacts and preserves unrelated output files', async () => {
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }
    const options = {
      cwd: directory,
      entry,
      execute,
      name: 'frog',
      output: 'release',
    }

    await build({
      ...options,
      targets: ['darwin-arm64', 'windows-arm64'],
      version: '1.0.0',
    })
    const output = join(directory, 'release')
    await writeFile(join(output, 'install.ps1'), `# ${installerMarker}\nstale`)
    await writeFile(join(output, 'install.sh'), `#!/bin/sh\n# ${installerMarker}\nstale`)
    await writeFile(join(output, 'notes.txt'), 'keep')

    await build({
      ...options,
      targets: ['windows-arm64'],
      version: '2.0.0',
    })

    expect((await readdir(output)).sort()).toEqual([
      'SHA256SUMS',
      'frog-windows-arm64.exe',
      'frog-windows-arm64.exe.gz',
      'notes.txt',
    ])
    await expect(readFile(join(output, 'notes.txt'), 'utf8')).resolves.toBe('keep')
    await expect(readFile(join(output, 'SHA256SUMS'), 'utf8')).resolves.not.toContain(
      'darwin-arm64',
    )
    await expect(readFile(join(output, 'install.sh'))).rejects.toThrow()
    await expect(readFile(join(output, 'install.ps1'))).rejects.toThrow()
  })

  test('preserves unmanaged installer files and refuses to overwrite them', async () => {
    const output = join(directory, 'release')
    await mkdir(output)
    await writeFile(join(output, 'install.ps1'), 'user PowerShell installer')
    await writeFile(join(output, 'install.sh'), 'user shell installer')
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    await build({
      entry,
      execute,
      name: 'frog',
      output,
      targets: ['darwin-arm64'],
      version: '1.0.0',
    })

    await expect(readFile(join(output, 'install.ps1'), 'utf8')).resolves.toBe(
      'user PowerShell installer',
    )
    await expect(readFile(join(output, 'install.sh'), 'utf8')).resolves.toBe('user shell installer')

    const compile = vi.fn<build.Execute>()
    await expect(
      build({
        entry,
        execute: compile,
        installer: true,
        name: 'frog',
        output,
        repository: 'wevm/frog',
        version: '1.0.0',
      }),
    ).rejects.toThrow('Refusing to replace unmanaged installer file')
    expect(compile).not.toHaveBeenCalled()
  })

  test('resolves a package binary from a project directory', async () => {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        bin: { frog: './src/frog.ts' },
        name: '@example/frog-package',
        version: '1.0.0',
      }),
    )
    const selected = join(directory, 'src', 'frog.ts')
    await mkdir(join(directory, 'src'))
    await writeFile(selected, 'console.log("frog")\n')
    const execute: build.Execute = async (_command, args) => {
      if (args[0] === '--version') return
      const file = args.find((arg) => arg.startsWith('--outfile='))!.slice('--outfile='.length)
      await writeFile(file, args.join('\n'))
    }

    const result = await build({
      entry: directory,
      execute,
      targets: ['darwin-arm64'],
    })

    expect(result.entry).toBe(selected)
    expect(result.name).toBe('frog')
  })

  test('reports input and target errors before compiling', async () => {
    const execute = vi.fn<build.Execute>()

    await expect(build({ entry: 'missing.ts', execute, cwd: directory })).rejects.toThrow(
      `Entrypoint does not exist: ${join(directory, 'missing.ts')}`,
    )
    await expect(build({ entry, execute })).rejects.toThrow(
      'Could not resolve a CLI name. Add package.json `name` or pass --name.',
    )
    await expect(build({ entry, execute, name: 'frog' })).rejects.toThrow(
      'Could not resolve a CLI version. Add package.json `version` or pass --version.',
    )
    await expect(
      build({
        entry,
        execute,
        targets: ['freebsd-x64'],
        name: 'frog',
        version: '1.0.0',
      }),
    ).rejects.toThrow('Unsupported target: freebsd-x64')
    await expect(
      build({
        entry,
        execute,
        installer: true,
        name: 'frog',
        repository: 'wevm/frog',
        targets: ['darwin-arm64'],
        version: '1.0.0',
      }),
    ).rejects.toThrow('Installers require the full target matrix')
    await expect(
      build({
        entry,
        execute,
        installer: true,
        name: 'frog',
        version: '1.0.0',
      }),
    ).rejects.toThrow('Could not resolve a public GitHub repository')
    await expect(
      build({
        entry,
        execute,
        installer: true,
        name: 'frog',
        repository: 'wevm/frog',
        version: '1.0.0-beta.1',
      }),
    ).rejects.toThrow('Invalid stable version')
    expect(execute).not.toHaveBeenCalled()
  })

  test('reports missing Bun and target-specific compilation failures', async () => {
    const missing = vi.fn<build.Execute>().mockRejectedValue(new Error('ENOENT'))
    await expect(
      build({ entry, execute: missing, name: 'frog', version: '1.0.0' }),
    ).rejects.toThrow('Bun is required to build standalone binaries')

    const failing: build.Execute = async (_command, args, context) => {
      if (args[0] === '--version') return
      throw new Error(`compiler failed for ${context.target}`)
    }
    await expect(
      build({
        entry,
        execute: failing,
        name: 'frog',
        targets: ['windows-arm64'],
        version: '1.0.0',
      }),
    ).rejects.toThrow('Failed to build target windows-arm64: compiler failed for windows-arm64')
  })

  const target = nativeTarget()
  test.runIf(target)(
    'creates and runs a real native Incur CLI',
    async () => {
      const source = `
import { Binary, Cli } from ${JSON.stringify(join(import.meta.dirname, '..', 'index.ts'))}

const cli = Cli.create('frog', { description: 'Compiled fixture.' })
cli.command('metadata', {
  description: 'Show embedded metadata.',
  run() {
    return {
      name: Binary.name,
      target: Binary.target,
      version: Binary.version,
    }
  },
})
cli.serve()
export default cli
`
      await writeFile(entry, source)

      const result = await build({
        entry,
        name: 'frog',
        targets: [target!],
        version: '1.2.3',
      })
      const executable = result.artifacts[0]!.executable
      const [{ stdout: help }, { stdout: metadata }, { stdout: version }] = await Promise.all([
        exec(executable, ['--help']),
        exec(executable, ['metadata', '--format', 'json']),
        exec(executable, ['--version']),
      ])

      expect(help).toContain('Usage: frog <command>')
      expect(JSON.parse(metadata)).toEqual({ name: 'frog', target, version: '1.2.3' })
      expect(version.trim()).toBe('1.2.3')
    },
    60_000,
  )

  test.runIf(target)(
    'runs embedded filesystem commands without a runtime commands directory',
    async () => {
      const incur = JSON.stringify(join(import.meta.dirname, '..', 'index.ts'))
      await mkdir(join(directory, 'commands'))
      await writeFile(
        join(directory, 'commands', 'status.ts'),
        `import { Cli } from ${incur}\nconst initialized = (globalThis as any)[Symbol.for('incur.test.initialized')]\nexport default Cli.command({ run: () => ({ initialized, status: 'ok' }) })\n`,
      )
      await writeFile(
        entry,
        `import { Cli } from ${incur}\n;(globalThis as any)[Symbol.for('incur.test.initialized')] = true\nconst cli = Cli.create('frog')\nawait cli.fs().serve()\nexport default cli\n`,
      )

      const result = await build({
        entry,
        name: 'frog',
        targets: [target!],
        version: '1.2.3',
      })
      const executable = result.artifacts[0]!.executable
      const { stdout } = await exec(executable, ['status', '--format', 'json'])

      expect(JSON.parse(stdout)).toEqual({ initialized: true, status: 'ok' })
    },
    60_000,
  )
})

function nativeTarget(): Target | undefined {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  if (process.platform === 'win32')
    return process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64-baseline'
  if (process.platform === 'linux') {
    type Report = { header?: { glibcVersionRuntime?: string | undefined } | undefined }
    const report = process.report?.getReport() as Report | undefined
    const musl = !report?.header?.glibcVersionRuntime
    if (process.arch === 'arm64') return musl ? 'linux-arm64-musl' : 'linux-arm64-glibc'
    if (process.arch === 'x64') return musl ? 'linux-x64-musl-baseline' : 'linux-x64-glibc-baseline'
  }
  return undefined
}
