import fs from 'node:fs/promises'
import { Cli, SyncSkills } from 'clac'

let mockExecError: Error | null = null

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], cb: Function) => {
    if (mockExecError) cb(mockExecError, '', '')
    else cb(null, '', '')
  },
}))

beforeEach(() => {
  mockExecError = null
})

test('generates skill files to temp dir and calls runner', async () => {
  const cli = Cli.create('test', { description: 'A test CLI' })
  cli.command('ping', { description: 'Health check', run: () => ({ pong: true }) })
  cli.command('greet', { description: 'Say hello', run: () => ({ hi: true }) })

  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.sync('test', commands, {
    description: 'A test CLI',
    runner: 'npx',
  })

  expect(result.skills.length).toBeGreaterThan(0)
  expect(result.skills.map((s) => s.name)).toContain('greet')
  expect(result.skills.map((s) => s.name)).toContain('ping')
})

test('uses custom depth', async () => {
  const cli = Cli.create('test')
  cli.command('ping', { description: 'Ping', run: () => ({}) })
  cli.command('pong', { description: 'Pong', run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  const result = await SyncSkills.sync('test', commands, { depth: 0, runner: 'npx' })

  // depth 0 = single skill
  expect(result.skills).toHaveLength(1)
})

test('propagates runner errors', async () => {
  mockExecError = new Error('skills not found')

  const cli = Cli.create('test')
  cli.command('ping', { run: () => ({}) })

  const commands = Cli.toCommands.get(cli)!
  await expect(SyncSkills.sync('test', commands, { runner: 'npx' })).rejects.toThrow(
    'skills not found',
  )
})
