import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Cli from '../Cli.js'
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

test('provides the entrypoint used by default filesystem command discovery', async () => {
  const entry = join(tmp, 'cli.ts')
  const commands = join(tmp, 'commands')
  const incur = JSON.stringify(join(import.meta.dirname, '..', 'index.ts'))
  mkdirSync(commands)
  writeFileSync(
    join(commands, 'status.ts'),
    `import { Cli } from ${incur}\nexport default Cli.command({ run: () => ({ status: 'ok' }) })\n`,
  )
  writeFileSync(
    entry,
    `import { Cli } from ${incur}\nconst cli = Cli.create('test').fs()\nexport default cli\n`,
  )

  const cli = await importCli(entry)
  expect([...Cli.toCommands.get(cli)!.keys()]).toEqual(['status'])
})
