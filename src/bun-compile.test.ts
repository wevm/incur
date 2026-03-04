import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || stdout?.trim() || error.message))
      else resolve({ stdout, stderr })
    })
  })
}

let dir: string
let bin: string

describe('bun build --compile', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'incur-bun-'))
    bin = join(dir, 'test-cli')
    const src = join(dir, 'cli.ts')

    await writeFile(
      src,
      `
import { Cli, z } from '${join(import.meta.dirname, 'index.ts')}'

const cli = Cli.create('test-cli', {
  version: '1.0.0',
  description: 'Bun compile test fixture.',
})

cli.command('ping', {
  description: 'Health check',
  run() {
    return { pong: true }
  },
})

cli.command('echo', {
  description: 'Echo a message',
  args: z.object({ message: z.string().describe('Message') }),
  options: z.object({ upper: z.boolean().default(false).describe('Uppercase') }),
  alias: { upper: 'u' },
  run(c) {
    const msg = c.options.upper ? c.args.message.toUpperCase() : c.args.message
    return { result: msg }
  },
})

cli.serve()
`,
    )

    await exec('bun', ['build', src, '--compile', '--outfile', bin])
  }, 60_000)

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('runs ping command', async () => {
    const { stdout } = await exec(bin, ['ping'])
    expect(stdout).toContain('pong: true')
  })

  test('runs command with args and options', async () => {
    const { stdout } = await exec(bin, ['echo', 'hello', '--upper'])
    expect(stdout).toContain('result: HELLO')
  })

  test('shows help', async () => {
    const { stdout } = await exec(bin, ['--help'])
    expect(stdout).toContain('test-cli')
    expect(stdout).toContain('ping')
    expect(stdout).toContain('echo')
  })

  test('shows version', async () => {
    const { stdout } = await exec(bin, ['--version'])
    expect(stdout.trim()).toBe('1.0.0')
  })
})
