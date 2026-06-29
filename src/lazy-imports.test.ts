import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: join(import.meta.dirname, '..'), timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || stdout?.trim() || error.message))
        else resolve({ stdout, stderr })
      },
    )
  })
}

let dir: string
let src: string

describe('lazy imports', () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'incur-lazy-'))
    src = join(dir, 'cli.mts')

    // Records every module loaded during a CLI run, then prints the heavy ones.
    await writeFile(
      src,
      `
import { registerHooks } from 'node:module'

const loaded: string[] = []
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context)
    loaded.push(result.url)
    return result
  },
})

const { Cli, z } = await import('${join(import.meta.dirname, 'index.ts')}')

const cli = Cli.create('lazy-cli', { version: '1.0.0' })

cli.command('ping', {
  description: 'Health check',
  options: z.object({ upper: z.boolean().default(false) }),
  run() {
    return { pong: true }
  },
})

await cli.serve(process.argv.slice(2))

const heavy = loaded.filter(
  (url) => url.includes('@modelcontextprotocol') || url.includes('node_modules/yaml'),
)
console.log(JSON.stringify({ heavy }))
`,
    )
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function parseHeavy(stdout: string): string[] {
    const line = stdout.trim().split('\n').at(-1)!
    return (JSON.parse(line) as { heavy: string[] }).heavy
  }

  test('plain command run does not load yaml or the MCP SDK', async () => {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', src, 'ping'])
    expect(stdout).toContain('pong: true')
    expect(parseHeavy(stdout)).toEqual([])
  })

  test('--format yaml loads yaml on demand, but not the MCP SDK', async () => {
    const { stdout } = await exec(process.execPath, [
      '--import',
      'tsx',
      src,
      'ping',
      '--format',
      'yaml',
    ])
    expect(stdout).toContain('pong: true')
    const heavy = parseHeavy(stdout)
    expect(heavy.some((url) => url.includes('node_modules/yaml'))).toBe(true)
    expect(heavy.some((url) => url.includes('@modelcontextprotocol'))).toBe(false)
  })
})
