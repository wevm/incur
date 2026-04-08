import { Cli, z } from 'incur'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generate } from './Skillgen.js'

vi.mock('./internal/utils.js', () => ({
  importCli: vi.fn(),
}))
import { importCli } from './internal/utils.js'

let tmp: string
beforeEach(() => {
  tmp = join(tmpdir(), `skillgen-${Date.now()}`)
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

test('generates skill file for single-command cli', async () => {
  const cli = Cli.create('greet', {
    description: 'A greeting CLI',
    args: z.object({ name: z.string().describe('Name') }),
    run: () => ({ message: 'hi' }),
  })
  vi.mocked(importCli).mockResolvedValue(cli)

  const files = await generate('fake-input', tmp, 0)
  expect(files).toHaveLength(1)
  expect(readFileSync(files[0]!, 'utf-8')).toContain('name: greet')
})

test('generates split files for multi-command cli', async () => {
  const cli = Cli.create('app', { description: 'My app' })
    .command('deploy', { description: 'Deploy', run: () => ({}) })
    .command('status', { description: 'Status', run: () => ({}) })
  vi.mocked(importCli).mockResolvedValue(cli)

  const files = await generate('fake-input', tmp, 1)
  expect(files.length).toBeGreaterThanOrEqual(1)
  const content = files.map((f) => readFileSync(f, 'utf-8')).join('\n')
  expect(content).toContain('deploy')
  expect(content).toContain('status')
})

test('collects group descriptions', async () => {
  const group = Cli.create('admin', { description: 'Admin tools' }).command('reset', {
    description: 'Reset',
    run: () => ({}),
  })
  const cli = Cli.create('app', { description: 'My app' }).command(group)
  vi.mocked(importCli).mockResolvedValue(cli)

  const files = await generate('fake-input', tmp, 1)
  const content = files.map((f) => readFileSync(f, 'utf-8')).join('\n')
  expect(content).toContain('admin reset')
})

test('group with default command includes both default and subcommands', async () => {
  const lint = Cli.create('lint', {
    description: 'Run linter',
    run: () => ({ linted: true }),
  })
  lint.command('fix', { description: 'Auto-fix', run: () => ({}) })
  const cli = Cli.create('app', { description: 'My app' }).command(lint)
  vi.mocked(importCli).mockResolvedValue(cli)

  const files = await generate('fake-input', tmp, 1)
  const content = files.map((f) => readFileSync(f, 'utf-8')).join('\n')
  expect(content).toContain('lint')
  expect(content).toContain('Run linter')
  expect(content).toContain('lint fix')
  expect(content).toContain('Auto-fix')
})

test('includes args, options, and examples in output', async () => {
  const cli = Cli.create('tool', {
    description: 'A tool',
  }).command('greet', {
    description: 'Greet someone',
    args: z.object({ name: z.string().describe('Name to greet') }),
    options: z.object({ loud: z.boolean().default(false).describe('Shout') }),
    examples: [{ args: { name: 'world' }, description: 'Greet the world' }],
    run: () => ({}),
  })
  vi.mocked(importCli).mockResolvedValue(cli)

  const files = await generate('fake-input', tmp, 0)
  const content = readFileSync(files[0]!, 'utf-8')
  expect(content).toContain('Name to greet')
  expect(content).toContain('Shout')
  expect(content).toContain('Greet the world')
})
