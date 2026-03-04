import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importCli } from './utils.js'

let tmp: string

beforeEach(() => {
  tmp = join(tmpdir(), `incur-utils-test-${Date.now()}`)
  mkdirSync(tmp, { recursive: true })
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('throws when default export is not a Cli', async () => {
  const file = join(tmp, 'bad.ts')
  writeFileSync(file, 'export default 42')
  await expect(importCli(file)).rejects.toThrow('Expected default export to be a `Cli` instance')
})

test('resolves entry from package.json bin (.ts)', async () => {
  const entry = join(tmp, 'cli.ts')
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ bin: { 'my-cli': './cli.ts' } }))
  writeFileSync(entry, 'export default 42')
  // Should resolve the .ts bin entry from the directory
  await expect(importCli(tmp)).rejects.toThrow('Expected default export to be a `Cli` instance')
})

test('resolves entry from package.json main', async () => {
  const entry = join(tmp, 'main.ts')
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ main: './main.ts' }))
  writeFileSync(entry, 'export default 42')
  await expect(importCli(tmp)).rejects.toThrow('Expected default export to be a `Cli` instance')
})

test('falls back to cli.ts when no package.json', async () => {
  const entry = join(tmp, 'cli.ts')
  writeFileSync(entry, 'export default 42')
  await expect(importCli(tmp)).rejects.toThrow('Expected default export to be a `Cli` instance')
})

test('resolves entry from string bin', async () => {
  const entry = join(tmp, 'index.ts')
  writeFileSync(join(tmp, 'package.json'), JSON.stringify({ bin: './index.ts' }))
  writeFileSync(entry, 'export default 42')
  await expect(importCli(tmp)).rejects.toThrow('Expected default export to be a `Cli` instance')
})
