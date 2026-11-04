import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { exec } from './update.js'

let directory: string
let savedArgs: string | undefined
let savedPath: string | undefined

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'incur-exec-'))
  savedArgs = process.env.INCUR_TEST_ARGS
  savedPath = process.env.PATH
  process.env.INCUR_TEST_ARGS = path.join(directory, 'args.txt')
  process.env.PATH = `${directory}${path.delimiter}${savedPath}`

  return () => {
    process.env.PATH = savedPath
    if (savedArgs === undefined) delete process.env.INCUR_TEST_ARGS
    else process.env.INCUR_TEST_ARGS = savedArgs
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

/**
 * Installs a package manager that, like npm and pnpm on Windows, is a script shim and not an executable.
 * Like theirs, the Windows shim finds its own files through `%~dp0`, which cmd.exe resolves to the
 * working directory when the command name is quoted.
 */
function setupPackageManager(name: string, exitCode: number) {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(directory, `${name}.marker`), '')
    fs.writeFileSync(
      path.join(directory, `${name}.cmd`),
      `@echo off\r\nif not exist "%~dp0${name}.marker" exit /b 3\r\necho %* > "%INCUR_TEST_ARGS%"\r\necho shim says no 1>&2\r\nexit /b ${exitCode}\r\n`,
    )
  } else
    fs.writeFileSync(
      path.join(directory, name),
      `#!/bin/sh\necho "$@" > "$INCUR_TEST_ARGS"\necho "shim says no" >&2\nexit ${exitCode}\n`,
      { mode: 0o755 },
    )
}

function recordedArgs() {
  return fs.readFileSync(path.join(directory, 'args.txt'), 'utf8').replaceAll('"', '').trim()
}

test('runs a package manager that is a script shim', async () => {
  setupPackageManager('frogpm', 0)

  await expect(exec('frogpm', ['install', '--global', 'frog@latest'])).resolves.toBeUndefined()
  expect(recordedArgs()).toBe('install --global frog@latest')
})

test('rejects with the error output of a failing package manager', async () => {
  setupPackageManager('frogpm', 1)

  await expect(exec('frogpm', ['install', '--global', 'frog@latest'])).rejects.toThrow(
    'shim says no',
  )
})
