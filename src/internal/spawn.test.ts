import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { resolveCommand } from './spawn.js'

let dir: string

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'incur spawn ')), 'bin dir')
  mkdirSync(dir, { recursive: true })
  return () => rmSync(dirname(dir), { recursive: true, force: true })
})

test('spawns the command unchanged off Windows', () => {
  expect(resolveCommand('npx', ['add-mcp', 'my-cli --mcp'], { platform: 'linux' })).toEqual({
    args: ['add-mcp', 'my-cli --mcp'],
    command: 'npx',
    windowsVerbatimArguments: false,
  })
})

test('runs Windows command scripts through cmd.exe with escaped arguments', () => {
  writeFileSync(join(dir, 'npx.cmd'), '')
  const env = { ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: dir, PATHEXT: '.EXE;.cmd' }
  const result = resolveCommand('npx', ['add-mcp', 'my-cli --mcp', '-a', 'a&b'], {
    env,
    platform: 'win32',
  })
  const file = join(dir, 'npx.cmd').replace(/ /g, '^ ')
  expect(result).toEqual({
    args: [
      '/d',
      '/s',
      '/c',
      `"${file} ^^^"add-mcp^^^" ^^^"my-cli^^^ --mcp^^^" ^^^"-a^^^" ^^^"a^^^&b^^^""`,
    ],
    command: 'C:\\Windows\\system32\\cmd.exe',
    windowsVerbatimArguments: true,
  })
})

test('spawns Windows executables directly', () => {
  writeFileSync(join(dir, 'bunx.exe'), '')
  const result = resolveCommand('bunx', ['add-mcp'], {
    env: { PATH: dir, PATHEXT: '.exe;.cmd' },
    platform: 'win32',
  })
  expect(result).toEqual({
    args: ['add-mcp'],
    command: join(dir, 'bunx.exe'),
    windowsVerbatimArguments: false,
  })
})

test('ignores extensionless files that cmd.exe cannot run', () => {
  writeFileSync(join(dir, 'npx'), '')
  writeFileSync(join(dir, 'npx.cmd'), '')
  const result = resolveCommand('npx', [], {
    env: { PATH: dir, PATHEXT: '.cmd' },
    platform: 'win32',
  })
  expect(result.args.at(-1)).toContain('npx.cmd')
})

test('leaves unresolved Windows commands for spawn to report', () => {
  expect(resolveCommand('missing', ['x'], { env: { PATH: dir }, platform: 'win32' })).toEqual({
    args: ['x'],
    command: 'missing',
    windowsVerbatimArguments: false,
  })
})

test.runIf(process.platform === 'win32')(
  'passes arguments through a real command script intact',
  async () => {
    writeFileSync(join(dir, 'echo-args.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    // Same shape as npm's `npx.cmd`: forwards `%*` to node.
    writeFileSync(
      join(dir, 'incur-echo.cmd'),
      `@ECHO off\r\n"${process.execPath}" "%~dp0\\echo-args.js" %*\r\n`,
    )
    const args = [
      'add-mcp',
      'my-cli --mcp',
      '"/path/to my/cli" --mcp',
      'a&b|c<d>e^f',
      '100%',
      '%PATH%',
      '!bang! (x) ;semi, comma',
      'trailing\\',
      'quote\\"inside',
      '',
    ]
    const env = { ...process.env, PATH: `${dir};${process.env.PATH}` }
    const {
      args: argv,
      command,
      windowsVerbatimArguments,
    } = resolveCommand('incur-echo', args, {
      env,
    })
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(command, argv, { env, windowsVerbatimArguments }, (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      ),
    )
    expect(JSON.parse(stdout)).toEqual(args)
  },
)
