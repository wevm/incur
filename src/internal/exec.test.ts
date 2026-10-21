import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execFile } from './exec.js'

test('collects stdout and stderr', async () => {
  const { stdout, stderr } = await execFile(process.execPath, [
    '-e',
    'process.stdout.write("out"); process.stderr.write("err")',
  ])
  expect(stdout).toBe('out')
  expect(stderr).toBe('err')
})

test('rejects with stderr content when the command fails', async () => {
  await expect(
    execFile(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(1)']),
  ).rejects.toThrow('boom')
})

test('rejects with stdout content when stderr is empty', async () => {
  await expect(
    execFile(process.execPath, ['-e', 'process.stdout.write("only out"); process.exit(2)']),
  ).rejects.toThrow('only out')
})

test('rejects when the command does not exist', async () => {
  await expect(execFile('incur-command-that-does-not-exist', [])).rejects.toThrow(
    /incur-command-that-does-not-exist/,
  )
})

test('keeps a multibyte character intact when it spans two chunks', async () => {
  const { stdout } = await execFile(process.execPath, [
    '-e',
    'const b = Buffer.from("✓"); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)',
  ])
  expect(stdout).toBe('✓')
})

test('rejects when the command writes more than the output limit', async () => {
  await expect(
    execFile(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024 * 1024 + 1024))']),
  ).rejects.toThrow(/more than 1048576 bytes/)
})

test.skipIf(process.platform !== 'win32')(
  'runs a .cmd shim and keeps argument boundaries intact',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'incur-exec-'))
    try {
      writeFileSync(
        join(dir, 'echo.mjs'),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
        'utf8',
      )
      writeFileSync(join(dir, 'shim.cmd'), '@echo off\r\nnode "%~dp0echo.mjs" %*\r\n', 'utf8')

      const { stdout } = await execFile(join(dir, 'shim.cmd'), [
        'npx -y rea-agents@6.7.0 mcp',
        '--name',
        'x',
      ])

      expect(JSON.parse(stdout)).toEqual(['npx -y rea-agents@6.7.0 mcp', '--name', 'x'])
    } finally {
      rmSync(dir, { force: true, recursive: true })
    }
  },
)
