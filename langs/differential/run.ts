/**
 * Runs every case in `cases.json` against the TypeScript reference CLIs and prints the results as
 * JSON: one `{ stdout, stderr, exit }` record per case, in case order. Ports compare their own
 * results with this output after normalizing durations.
 *
 * Usage: `node --import tsx langs/differential/run.ts` from any directory.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as url from 'node:url'

import { clis } from './fixtures.js'

type Case = {
  argv: string[]
  bin?: string | undefined
  cli: keyof typeof clis
  env?: Record<string, string> | undefined
  tty?: boolean | undefined
}

const dir = path.dirname(url.fileURLToPath(import.meta.url))
process.chdir(dir)
const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8')) as Case[]

const entry = process.argv[1]
const home = process.env.HOME
const write = process.stdout.write.bind(process.stdout)
const writeErr = process.stderr.write.bind(process.stderr)
const results: { exit: number; stderr: string; stdout: string }[] = []

for (const c of cases) {
  let stdout = ''
  let stderr = ''
  let exit = 0
  const env = c.env ?? {}
  // Completions read COMPLETE and _COMPLETE_INDEX, and `~` paths read HOME, from the process
  // environment.
  for (const key of ['COMPLETE', '_COMPLETE_INDEX', 'HOME'] as const) {
    const value = env[key] ?? (key === 'HOME' ? home : undefined)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // The display name comes from the basename of `process.argv[1]`.
  process.argv[1] = c.bin ?? entry ?? ''
  Object.defineProperty(process.stdout, 'isTTY', { value: c.tty ?? false, configurable: true })
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as never
  try {
    await clis[c.cli].serve(c.argv, {
      env,
      exit: (code) => {
        exit = code
      },
      stdout: (s) => {
        stdout += s
      },
    })
  } finally {
    process.stderr.write = writeErr as never
  }
  results.push({ exit, stderr, stdout })
}

write(`${JSON.stringify(results)}\n`)
