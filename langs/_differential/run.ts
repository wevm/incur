/**
 * Runs every case in `cases.json` against the TypeScript reference CLIs and prints the results as
 * JSON: one `{ stdout, stderr, exit }` record per case, in case order, plus `files` for sandboxed
 * cases. Ports compare their own results with this output after normalizing durations.
 *
 * A case with `sandbox` runs isolated: fresh fixture CLIs, a reset sandbox directory as `HOME` and
 * working directory, a cleared environment, stub package-manager runners on `PATH`, `stdin` fed to
 * `--mcp`, and `requests` sent to `cli.fetch` instead of `serve`. See `langs/CONTRIBUTING.md`.
 *
 * Usage: `node --import tsx langs/_differential/run.ts [cases-file]` from any directory. The cases
 * file defaults to `cases.json` beside this script.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import * as url from 'node:url'

type Case = {
  argv: string[]
  bin?: string | undefined
  cli: keyof Clis
  env?: Record<string, string> | undefined
  /** HTTP requests sent in order to `cli.fetch` instead of serving `argv`. */
  requests?: HttpRequest[] | undefined
  /** Files seeded into the sandbox: path (`<project>` stands for the sandbox path hash) → contents, `null` for a directory, or a symlink. */
  sandbox?: Record<string, Entry> | undefined
  /** Lines written to stdin: strings verbatim, other values as JSON. */
  stdin?: unknown[] | undefined
  tty?: boolean | undefined
}

type Clis = typeof import('./fixtures.js').clis

type Entry = string | null | { symlink: string }

type HttpRequest = {
  body?: unknown
  headers?: Record<string, string> | undefined
  method?: string | undefined
  url: string
}

type Result = {
  exit: number
  files?: Record<string, Entry> | undefined
  stderr: string
  stdout: string
}

const dir = path.dirname(url.fileURLToPath(import.meta.url))
const file = path.resolve(process.argv[2] ?? path.join(dir, 'cases.json'))
process.chdir(dir)
const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as Case[]

const entry = process.argv[1]
const home = process.env.HOME
const original = { ...process.env }
const write = process.stdout.write.bind(process.stdout)
const writeErr = process.stderr.write.bind(process.stderr)
const results: Result[] = []
const stateful = new Set<string>(['remote', 'web'])

// Sandboxed cases share one root for the whole run: `home` is the sandbox (HOME and working
// directory), `bin` holds the stub runners on PATH, and `tmp` is TMPDIR.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'incur-differential-')))
const sandbox = path.join(root, 'home')
// Project skills metadata lives in a directory named after this hash of the sandbox path.
const project = createHash('sha256').update(sandbox).digest('hex').slice(0, 16)
const stubs = path.join(root, 'bin')
fs.mkdirSync(stubs)
fs.mkdirSync(path.join(root, 'tmp'))
// Each stub appends its name and arguments to `$HOME/stub.log`, then prints `STUB_STDERR` and
// `STUB_STDOUT` and exits with `STUB_EXIT` (default 0).
const stub = `#!/bin/sh
{ printf '%s' "\${0##*/}"; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> "$HOME/stub.log"
printf '%s' "$STUB_STDERR" >&2
printf '%s' "$STUB_STDOUT"
exit "\${STUB_EXIT:-0}"
`
for (const name of ['bun', 'bunx', 'npm', 'npx', 'pnpm', 'pnpx'])
  fs.writeFileSync(path.join(stubs, name), stub, { mode: 0o755 })

// Agent skill directories are read from HOME and XDG variables when the library is imported.
setEnv({})
const { clis } = await import('./fixtures.js')
setEnv(original)

for (const [index, c] of cases.entries())
  results.push(c.sandbox ? await runSandboxed(c, index) : await run(c, clis))

fs.rmSync(root, { recursive: true, force: true })
write(`${JSON.stringify(results)}\n`)

/** Serves a case in the current process environment. */
async function run(c: Case, clis: Clis): Promise<Result> {
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
  return { exit, stderr, stdout }
}

/** Serves a case, or sends its requests, in a fresh sandbox with fresh fixture CLIs. */
async function runSandboxed(c: Case, index: number): Promise<Result> {
  fs.rmSync(sandbox, { recursive: true, force: true })
  fs.mkdirSync(sandbox)
  for (const [name, value] of Object.entries(c.sandbox ?? {})) {
    const target = path.join(sandbox, name.replaceAll('<project>', project))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (value === null) fs.mkdirSync(target, { recursive: true })
    else if (typeof value === 'string') fs.writeFileSync(target, expand(value))
    else fs.symlinkSync(expand(value.symlink), target)
  }
  const env = Object.fromEntries(
    Object.entries(c.env ?? {}).map(([key, value]) => [key, expand(value)]),
  )
  setEnv(env)
  process.chdir(sandbox)
  process.argv[1] = path.join(sandbox, c.bin ?? 'cli')
  Object.defineProperty(process.stdout, 'isTTY', { value: c.tty ?? false, configurable: true })
  const input = new PassThrough()
  Object.defineProperty(process, 'stdin', { value: input, configurable: true })

  let stdout = ''
  let stderr = ''
  let exit = 0
  process.stdout.write = ((chunk: string) => {
    stdout += chunk
    return true
  }) as never
  process.stderr.write = ((chunk: string) => {
    stderr += chunk
    return true
  }) as never
  try {
    // CLIs that keep state between invocations (a stateful MCP session, resolved remote MCP
    // servers) come from a fresh module instance, as if each case ran in a new process.
    const cli = stateful.has(c.cli)
      ? ((await import(`./fixtures.js?case=${index}`)) as typeof import('./fixtures.js')).clis[
          c.cli
        ]
      : clis[c.cli]
    if (c.requests) stdout += await send(cli, c.requests)
    else {
      await cli.serve(c.argv, {
        env,
        exit: (code) => {
          exit = code
        },
        stdout: (s) => {
          stdout += s
        },
      })
      await feed(input, c.stdin ?? [], () => stdout)
    }
  } finally {
    process.stdout.write = write as never
    process.stderr.write = writeErr as never
    process.chdir(dir)
    setEnv(original)
  }
  return { exit, files: tree(), stderr: normalize(stderr), stdout: normalize(stdout) }
}

/** Writes stdin lines one at a time, waiting for each request's response, then closes stdin. */
async function feed(input: PassThrough, lines: unknown[], output: () => string) {
  for (const line of lines) {
    const text = typeof line === 'string' ? line : JSON.stringify(line)
    const start = output().length
    input.write(`${text}\n`)
    const id = requestId(text)
    if (id === undefined) await sleep(20)
    else {
      const deadline = Date.now() + 5_000
      while (!responded(output().slice(start), id) && Date.now() < deadline) await sleep(1)
    }
  }
  input.end()
  await sleep(20)
}

/** Returns the id of a JSON-RPC request line, or `undefined` for anything else. */
function requestId(text: string): unknown {
  try {
    const message = JSON.parse(text)
    if (message && typeof message === 'object' && 'method' in message && 'id' in message)
      return message.id
  } catch {}
  return undefined
}

/** Returns whether `output` holds a JSON-RPC response with `id`. */
function responded(output: string, id: unknown) {
  return output.split('\n').some((line) => {
    try {
      const message = JSON.parse(line)
      return message.id === id && ('result' in message || 'error' in message)
    } catch {
      return false
    }
  })
}

/**
 * Sends requests in order and renders each response as `HTTP <status>`, its headers sorted by
 * name, a blank line, and the body followed by a newline. A request header value `<session>` is
 * replaced with the last `mcp-session-id` response header, which renders as `<session>`.
 */
async function send(cli: Clis[keyof Clis], requests: HttpRequest[]) {
  let session: string | undefined
  let out = ''
  for (const r of requests) {
    const headers = Object.fromEntries(
      Object.entries(r.headers ?? {}).map(([key, value]) => [
        key,
        value === '<session>' ? (session ?? '') : value,
      ]),
    )
    const body =
      r.body === undefined
        ? undefined
        : typeof r.body === 'string'
          ? r.body
          : JSON.stringify(r.body)
    const response = await cli.fetch(
      new Request(new URL(r.url, 'http://localhost'), {
        method: r.method ?? 'GET',
        headers,
        ...(body === undefined ? undefined : { body }),
      }),
    )
    session = response.headers.get('mcp-session-id') ?? session
    out += `HTTP ${response.status}\n`
    for (const [key, value] of response.headers)
      out += `${key}: ${key === 'mcp-session-id' ? '<session>' : value}\n`
    out += `\n${await response.text()}\n`
  }
  return out
}

/** Replaces the process environment with the sandbox base environment plus `env`. */
function setEnv(env: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  const base =
    env === original ? {} : { HOME: sandbox, PATH: stubs, TMPDIR: path.join(root, 'tmp') }
  for (const [key, value] of Object.entries({ ...base, ...env }))
    if (value !== undefined) process.env[key] = value
}

/**
 * Lists every entry under the sandbox, sorted by path, with normalized file contents. The sandbox
 * path hash in entry paths becomes `<project>`.
 */
function tree() {
  const entries: [string, Entry][] = []
  const visit = (relative: string) => {
    for (const name of fs.readdirSync(path.join(sandbox, relative))) {
      const child = relative ? `${relative}/${name}` : name
      const key = child.replaceAll(project, '<project>')
      const stat = fs.lstatSync(path.join(sandbox, child))
      if (stat.isSymbolicLink())
        entries.push([key, { symlink: normalize(fs.readlinkSync(path.join(sandbox, child))) }])
      else if (stat.isDirectory()) {
        entries.push([key, null])
        visit(child)
      } else
        entries.push([key, metadata(normalize(fs.readFileSync(path.join(sandbox, child), 'utf8')))])
    }
  }
  visit('')
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Sorts the `skills` and `paths` arrays of a skills metadata file (a JSON object with a string
 * `hash` and a `skills` array), which follow directory listing order, and rewrites it as compact
 * JSON with a trailing newline. Other contents are returned unchanged.
 */
function metadata(text: string) {
  try {
    const value = JSON.parse(text)
    if (typeof value?.hash !== 'string' || !Array.isArray(value.skills)) return text
    value.skills.sort()
    if (Array.isArray(value.paths)) value.paths.sort()
    return `${JSON.stringify(value)}\n`
  } catch {
    return text
  }
}

/** Replaces `<sandbox>` and `<root>` placeholders with their real paths. */
function expand(text: string) {
  return text.replaceAll('<sandbox>', sandbox).replaceAll('<root>', root)
}

/** Replaces real sandbox paths and timestamps with placeholders. */
function normalize(text: string) {
  return text
    .replaceAll(sandbox, '<sandbox>')
    .replaceAll(root, '<root>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>')
    .replace(/"checkedAt":\d+/g, '"checkedAt":0')
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
