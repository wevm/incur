import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { detectPackageManager, detectRunner, exec, globalInstall } from './pm.js'

test('detects pnpm from user agent', () => {
  const saved = process.env.npm_config_user_agent
  process.env.npm_config_user_agent = 'pnpm/10.0.0 node/v22.0.0'
  expect(detectRunner()).toBe('pnpx')
  process.env.npm_config_user_agent = saved
})

test('detects bun from user agent', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedExec = process.env.npm_execpath
  process.env.npm_config_user_agent = 'bun/1.0.0'
  delete process.env.npm_execpath
  expect(detectRunner()).toBe('bunx')
  process.env.npm_config_user_agent = savedAgent
  process.env.npm_execpath = savedExec
})

test('detects pnpm from exec path', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  process.env.npm_execpath = '/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs'
  expect(detectRunner()).toBe('pnpx')
  process.env.npm_config_user_agent = savedAgent
  process.env.npm_execpath = savedExec
})

test('falls back to npx', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedArgv = process.argv[1]
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  delete process.env.npm_execpath
  process.argv[1] = '/usr/local/bin/my-cli'
  expect(detectRunner()).toBe('npx')
  process.env.npm_config_user_agent = savedAgent
  process.argv[1] = savedArgv!
  process.env.npm_execpath = savedExec
})

test('detects pnpm from the installed package path', () => {
  const savedAgent = process.env.npm_config_user_agent
  const savedArgv = process.argv[1]
  const savedExec = process.env.npm_execpath
  delete process.env.npm_config_user_agent
  delete process.env.npm_execpath
  process.argv[1] = '/Users/test/Library/pnpm/global/5/.pnpm/frog@1.0.0/node_modules/frog/bin.js'
  expect(detectPackageManager()).toBe('pnpm')
  process.env.npm_config_user_agent = savedAgent
  process.argv[1] = savedArgv!
  process.env.npm_execpath = savedExec
})

test('builds global install commands for the detected package manager', () => {
  const saved = process.env.npm_config_user_agent

  process.env.npm_config_user_agent = 'npm/11.0.0 node/v22.0.0'
  expect(globalInstall('frog')).toEqual({
    args: ['install', '--global', 'frog@latest'],
    command: 'npm',
  })

  process.env.npm_config_user_agent = 'pnpm/10.0.0 node/v22.0.0'
  expect(globalInstall('frog')).toEqual({
    args: ['add', '--global', 'frog@latest'],
    command: 'pnpm',
  })

  process.env.npm_config_user_agent = 'bun/1.0.0'
  expect(globalInstall('frog')).toEqual({
    args: ['add', '--global', 'frog@latest'],
    command: 'bun',
  })

  process.env.npm_config_user_agent = saved
})

describe('exec', () => {
  // The simulated cases stand POSIX scripts in for Windows programs.
  const posix = test.skipIf(process.platform === 'win32')
  let directory: string

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'incur pm ('))
    return () => {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
      fs.rmSync(directory, { force: true, recursive: true })
    }
  })

  /** Writes an executable that prints its arguments as JSON. */
  function echo(name: string) {
    const file = path.join(directory, name)
    fs.writeFileSync(
      file,
      `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)))\n`,
      { mode: 0o755 },
    )
    return file
  }

  /** Simulates Windows, with `directory` as the only `PATH` entry and `ComSpec` echoing its arguments. */
  function windows() {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('PATH', `"${directory}";`)
    vi.stubEnv('PATHEXT', '.exe;.cmd')
    vi.stubEnv('ComSpec', echo('cmd.js'))
  }

  posix('runs commands as is off Windows', async () => {
    echo('frogpm')
    vi.stubEnv('PATH', `${directory}${path.delimiter}${process.env.PATH}`)
    expect(JSON.parse(await exec('frogpm', ['a b', '%x%']))).toEqual(['a b', '%x%'])
  })

  posix('rejects with stderr, then stdout, then the spawn error', async () => {
    const file = path.join(directory, 'fail')
    fs.writeFileSync(file, '#!/bin/sh\necho "$1"\necho "$2" >&2\nexit 1\n', { mode: 0o755 })
    await expect(exec(file, ['out', 'err'])).rejects.toThrow(/^err$/)
    await expect(exec(file, ['out', ''])).rejects.toThrow(/^out$/)
    await expect(exec(file, ['', ''])).rejects.toThrow(`Command failed: ${file}  `)
    await expect(exec(path.join(directory, 'missing'), [])).rejects.toThrow('ENOENT')
  })

  posix('runs Windows command scripts through cmd.exe with quoted arguments', async () => {
    windows()
    fs.writeFileSync(path.join(directory, 'npx'), '')
    fs.writeFileSync(path.join(directory, 'npx.cmd'), '')
    const args = [
      'add-mcp',
      'npx my-cli --mcp',
      '--name',
      'C:\\safe\\path.js',
      'a&b|c<d>e^f',
      '100%',
      '%PATH%',
      'say "hi"',
      'a\\"b',
      'dir\\',
      '',
      'caf\u00e9',
      '\u0085',
    ]
    const quoted = [
      'add-mcp',
      '"npx my-cli --mcp"',
      '--name',
      'C:\\safe\\path.js',
      '"a&b|c<d>e^f"',
      '"100%%cd:~,%"',
      '"%%cd:~,%PATH%%cd:~,%"',
      '"say ""hi"""',
      '"a\\\\""b"',
      '"dir\\\\"',
      '""',
      'caf\u00e9',
      '"\u0085"',
    ]
    const line = `""${path.join(directory, 'npx.cmd')}" ${quoted.join(' ')}"`
    expect(JSON.parse(await exec('npx', args))).toEqual(['/e:ON', '/v:OFF', '/d', '/c', line])
  })

  posix('spawns Windows executables found on PATH directly', async () => {
    windows()
    echo('bun.exe')
    fs.writeFileSync(path.join(directory, 'bun.cmd'), '')
    expect(JSON.parse(await exec('bun', ['a b', '%x%']))).toEqual(['a b', '%x%'])
  })

  posix('rejects Windows command script arguments with line breaks', async () => {
    windows()
    fs.writeFileSync(path.join(directory, 'npm.cmd'), '')
    await expect(exec('npm', ['a\nb'])).rejects.toThrow('spawn npm EINVAL')
  })

  posix('leaves Windows commands missing from PATH to spawn', async () => {
    windows()
    await expect(exec('npm', [])).rejects.toThrow('spawn npm ENOENT')
  })

  test.runIf(process.platform === 'win32')(
    'passes arguments through a real npm-style command script intact',
    async () => {
      fs.writeFileSync(
        path.join(directory, 'echo.js'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
      )
      // Like npm's `npx.cmd`, forwards `%*`, which `cmd.exe` parses a second time.
      fs.writeFileSync(
        path.join(directory, 'incur-echo.cmd'),
        `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo.js" %*\r\n`,
      )
      vi.stubEnv('PATH', `${directory};${process.env.PATH}`)
      const args = [
        'npx my-cli --mcp',
        '"/path/to my/cli" --mcp',
        'a&b|c<d>e^f',
        '100%',
        '%PATH%',
        '!bang! (x) ;semi, comma',
        'trailing\\',
        'quote\\"inside',
        '',
      ]
      expect(JSON.parse(await exec('incur-echo', args))).toEqual(args)
    },
  )
})
