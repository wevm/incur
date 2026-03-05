---
name: incur
description: incur is a TypeScript framework for building CLIs that work for both AI agents and humans. Use when creating new CLIs.
command: incur
---

# incur

TypeScript framework for building CLIs for agents and human consumption. Strictly typed schemas for arguments and options, structured output envelopes, auto-generated skill files, and agent discovery via Skills, MCP, and `--llms`.

## Install

```sh
npm i incur
```

```sh
pnpm i incur
```

```sh
bun i incur
```

## Quick Start

```ts
import { Cli, z } from 'incur'

const cli = Cli.create('greet', {
  description: 'A greeting CLI',
  args: z.object({
    name: z.string().describe('Name to greet'),
  }),
  run({ args }) {
    return { message: `hello ${args.name}` }
  },
})

cli.serve()
```

```sh
greet world
# → message: hello world
```

## Creating a CLI

`Cli.create()` is the entry point. It has two modes:

### Single-command CLI

Pass `run` to create a CLI with no subcommands:

```ts
const cli = Cli.create('tool', {
  description: 'Does one thing',
  args: z.object({ file: z.string() }),
  run({ args, options }) {
    return { processed: args.file }
  },
})
```

### Router CLI (subcommands)

Omit `run` to create a CLI that registers subcommands via `.command()`:

```ts
const cli = Cli.create('gh', {
  version: '1.0.0',
  description: 'GitHub CLI',
})

cli.command('status', {
  description: 'Show repo status',
  run() {
    return { clean: true }
  },
})

cli.serve()
```

## Commands

### Registering commands

```ts
cli.command('install', {
  description: 'Install a package',
  args: z.object({
    package: z.string().optional().describe('Package name'),
  }),
  options: z.object({
    saveDev: z.boolean().optional().describe('Save as dev dependency'),
    global: z.boolean().optional().describe('Install globally'),
  }),
  alias: { saveDev: 'D', global: 'g' },
  output: z.object({
    added: z.number(),
    packages: z.number(),
  }),
  examples: [
    { args: { package: 'express' }, description: 'Install a package' },
    {
      args: { package: 'vitest' },
      options: { saveDev: true },
      description: 'Install as dev dependency',
    },
  ],
  run({ args, options }) {
    return { added: 1, packages: 451 }
  },
})
```

`.command()` is chainable — it returns the CLI instance:

```ts
cli
  .command('ping', { run: () => ({ pong: true }) })
  .command('version', { run: () => ({ version: '1.0.0' }) })
```

### Subcommand groups

Create a sub-CLI and mount it as a command group:

```ts
const cli = Cli.create('gh', { description: 'GitHub CLI' })

const pr = Cli.create('pr', { description: 'Pull request commands' })

pr.command('list', {
  description: 'List pull requests',
  options: z.object({
    state: z.enum(['open', 'closed', 'all']).default('open'),
  }),
  run({ options }) {
    return { prs: [], state: options.state }
  },
})

pr.command('view', {
  description: 'View a pull request',
  args: z.object({ number: z.number() }),
  run({ args }) {
    return { number: args.number, title: 'Fix bug' }
  },
})

// Mount onto the parent CLI
cli.command(pr)

cli.serve()
```

```sh
gh pr list --state closed
gh pr view 42
```

Groups nest arbitrarily:

```ts
const cli = Cli.create('gh', { description: 'GitHub CLI' })
const pr = Cli.create('pr', { description: 'Pull requests' })
const review = Cli.create('review', { description: 'Review commands' })

review.command('approve', { run: () => ({ approved: true }) })
pr.command(review)
cli.command(pr)
// → gh pr review approve
```

### Fetch API

Mount an HTTP server as a command with `.command('name', { fetch })`. Argv is translated into HTTP requests using curl-style flags:

```ts
import { Cli } from 'incur'
import { Hono } from 'hono'

const app = new Hono()
app.get('/users', (c) => c.json({ users: [{ id: 1, name: 'Alice' }] }))
app.post('/users', async (c) => c.json({ created: true, ...(await c.req.json()) }, 201))

Cli.create('my-cli', { description: 'My CLI' })
  .command('api', { fetch: app.fetch })
  .serve()
```

```sh
my-cli api users                          # GET /users
my-cli api users -X POST -d '{"name":"Bob"}'  # POST /users
my-cli api users --limit 5                # GET /users?limit=5
```

### Fetch API + OpenAPI

Pass an OpenAPI spec alongside `fetch` to generate typed subcommands with args, options, and descriptions from the spec:

```ts
Cli.create('my-cli', { description: 'My CLI' })
  .command('api', { fetch: app.fetch, openapi: spec })
  .serve()
```

```sh
my-cli api listUsers --limit 5     # GET /users?limit=5
my-cli api getUser 42              # GET /users/42
my-cli api createUser --name Bob   # POST /users with body
my-cli api --help                  # shows typed subcommands
```

Works with any `(Request) => Response` handler — Hono, Elysia, etc. Specs from `@hono/zod-openapi` are supported directly.

### Serve CLI as Fetch API

Expose your CLI as a standard Fetch API handler with `cli.fetch`. Works with Bun, Cloudflare Workers, Deno, Hono, and anything that accepts `(req: Request) => Response`.

```ts
import { Cli, z } from 'incur'

const cli = Cli.create('my-cli', { version: '1.0.0' })
  .command('users', {
    args: z.object({ id: z.coerce.number().optional() }),
    options: z.object({ limit: z.coerce.number().default(10) }),
    run(c) {
      if (c.args.id) return { id: c.args.id, name: 'Alice' }
      return { users: [{ id: 1, name: 'Alice' }], limit: c.options.limit }
    },
  })
```

```ts
Bun.serve(cli) // Bun
Deno.serve(cli.fetch) // Deno
export default cli // Cloudflare Workers
app.all('*', c => cli.fetch(c.request)) // Elysia
app.use(c => cli.fetch(c.req.raw)) // Hono
export const GET = cli.fetch // Next.js
export const POST = cli.fetch
```

Request mapping:

| HTTP | CLI equivalent |
|------|---------------|
| `GET /users?limit=5` | `my-cli users --limit 5` |
| `GET /users/42` | `my-cli users 42` (positional arg) |
| `POST /users` with JSON body | `my-cli users --name Bob` |
| `GET /` | root command (or 404) |

Responses are JSON envelopes: `{ "ok": true, "data": { ... }, "meta": { "command": "users", "duration": "3ms" } }`.

Error status codes: 400 for validation errors, 404 for unknown commands, 500 for thrown errors.

Async generator commands stream as NDJSON (`application/x-ndjson`). Middleware runs the same as `serve()`.

#### Fetch gateways

If a resolved command is a fetch gateway (`.command('api', { fetch })`), the request is forwarded to the nested handler.

#### MCP over HTTP

The fetch handler exposes an MCP endpoint at `/mcp`. Agents can discover and call commands as MCP tools over HTTP:

```
POST /mcp  { "jsonrpc": "2.0", "method": "initialize", ... }
POST /mcp  { "jsonrpc": "2.0", "method": "tools/list", ... }
POST /mcp  { "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "users", ... } }
```

The MCP server is initialized lazily on the first `/mcp` request. Non-`/mcp` paths route to the command API as usual.

## Arguments & Options

All schemas use Zod. Arguments are positional (assigned by schema key order). Options are named flags.

### Arguments

```ts
args: z.object({
  repo: z.string().describe('Repository in owner/repo format'),
  branch: z.string().optional().describe('Branch name'),
})
```

```sh
tool clone owner/repo main
#          ^^^^^^^^^^ ^^^^
#          repo       branch
```

### Options

```ts
options: z.object({
  state: z.enum(['open', 'closed']).default('open').describe('Filter by state'),
  limit: z.number().default(30).describe('Max results'),
  label: z.array(z.string()).optional().describe('Filter by labels'),
  verbose: z.boolean().optional().describe('Show details'),
})
```

Supported parsing:

- `--flag value` and `--flag=value`
- `-f value` short aliases (via `alias` property)
- `--verbose` boolean flags (`true`), `--no-verbose` (`false`)
- `--label bug --label feature` array options
- Automatic type coercion (string → number, string → boolean)
- Defaults from `.default()`, optionality from `.optional()`

### Aliases

```ts
alias: { state: 's', limit: 'l' }
```

```sh
tool list -s closed -l 10
```

### Deprecated options

Mark options as deprecated with `.meta({ deprecated: true })`. Shows `[deprecated]` in `--help`, `**Deprecated.**` in skill docs, `deprecated: true` in JSON Schema, and emits a stderr warning in TTY mode:

```ts
options: z.object({
  zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
  region: z.string().optional().describe('Target region'),
})
```

### Environment variables

```ts
env: z.object({
  NPM_TOKEN: z.string().optional().describe('Auth token'),
  NPM_REGISTRY: z.string().default('https://registry.npmjs.org').describe('Registry URL'),
})
```

Environment variables are parsed from `process.env` and validated against the Zod schema.

### Usage patterns

Define alternative usage patterns to show in `--help` instead of the auto-generated synopsis:

```ts
Cli.create('curl.md', {
  args: z.object({ url: z.string() }),
  options: z.object({ objective: z.string().optional() }),
  usage: [
    { args: { url: true } },
    { args: { url: true }, options: { objective: true } },
    { prefix: 'cat file.txt |', suffix: '| head' },
  ],
  run({ args }) {
    return { content: '...' }
  },
})
```

Renders in help as:

```
Usage: curl.md <url>
       curl.md <url> --objective <objective>
       cat file.txt | curl.md | head
```

Each usage entry supports:

| Property  | Type                         | Description                                      |
| --------- | ---------------------------- | ------------------------------------------------ |
| `args`    | `Partial<Record<key, true>>` | Argument keys to include as `<key>` placeholders |
| `options` | `Partial<Record<key, true>>` | Option keys to include as `--key <key>` flags    |
| `prefix`  | `string`                     | Text prepended before the command (e.g. piping)  |
| `suffix`  | `string`                     | Text appended after the command                  |

Both `args` and `options` are strictly typed from the Zod schemas — only valid keys are allowed.

Usage patterns also work on subcommands via `.command()`.

## Output

Every command returns data. incur wraps it in a structured envelope and serializes to the requested format.

### Output schema

Define `output` to declare the return shape:

```ts
cli.command('info', {
  output: z.object({
    name: z.string(),
    version: z.string(),
  }),
  run() {
    return { name: 'express', version: '4.21.2' }
  },
})
```

When `output` is provided, TypeScript enforces that `run()` returns the correct shape.

### Formats

Control with `--format <fmt>` or `--json`:

| Flag            | Format   | Description                                  |
| --------------- | -------- | -------------------------------------------- |
| _(default)_     | TOON     | Token-efficient, ~40% fewer tokens than JSON |
| `--format json` | JSON     | `JSON.parse()`-safe                          |
| `--format yaml` | YAML     | Human-readable                               |
| `--format md`   | Markdown | Tables for docs/issues                       |

### Envelope

With `--verbose`, the full envelope is emitted:

```sh
tool info express --verbose
```

```
ok: true
data:
  name: express
  version: 4.21.2
meta:
  command: info
  duration: 12ms
```

Without `--verbose`, only `data` is emitted. On errors, only the `error` block is emitted.

### Filtering output

Use `--filter-output` to prune command output to specific keys. Supports dot-notation for nested access, array slices with `[start,end]`, and comma-separated paths:

```ts
cli.command('users', {
  description: 'List users',
  run() {
    return {
      users: [
        { name: 'Alice', email: 'alice@example.com', role: 'admin' },
        { name: 'Bob', email: 'bob@example.com', role: 'user' },
        { name: 'Carol', email: 'carol@example.com', role: 'user' },
      ],
    }
  },
})
```

```sh
tool users --filter-output users.name
# → [3]: Alice,Bob,Carol

tool users --filter-output users[0,2].name
# → users[2]{name}:
# →   Alice
# →   Bob
```

### Token pagination

Use `--token-count`, `--token-limit`, and `--token-offset` to manage large outputs. Tokens are estimated using LLM tokenization rules (~96% accuracy).

```sh
# Check token count
tool users --token-count
# → 42

# Limit to first 20 tokens
tool users --token-limit 20

# Paginate with offset
tool users --token-offset 20 --token-limit 20
```

With `--verbose`, truncated output includes `meta.nextOffset` for programmatic pagination.

### Command schema

Use `--schema` to print the JSON Schema for a command's arguments, environment variables, options, and output:

```ts
cli.command('install', {
  description: 'Install a package',
  args: z.object({
    package: z.string().describe('Package name'),
  }),
  options: z.object({
    saveDev: z.boolean().optional().describe('Save as dev dependency'),
  }),
  run({ args }) {
    return { added: 1 }
  },
})
```

```sh
tool install --schema
# → args:
# →   type: object
# →   properties:
# →     package:
# →       type: string
# → options:
# →   type: object
# →   properties:
# →     saveDev:
# →       type: boolean
```

Use `--schema --format json` for machine-readable output. Not supported on fetch commands.

### TTY detection

incur adapts output based on whether stdout is a TTY:

| Scenario              | TTY (human)             | Non-TTY (agent/pipe) |
| --------------------- | ----------------------- | -------------------- |
| Command output        | Formatted data only     | TOON envelope        |
| Errors                | Human-readable message  | Error envelope       |
| `--help`              | Pretty help text        | Same                 |
| `--json` / `--format` | Overrides to structured | Same                 |

## Run Context

### `agent` boolean

The `run` context includes `agent` — `true` when stdout is not a TTY (piped or consumed by an agent), `false` when running in a terminal:

```ts
cli.command('deploy', {
  run(c) {
    if (!c.agent) console.log('Deploying...')
    return { status: 'ok' }
  },
})
```

### `ok()` and `error()` helpers

Use the context helpers for explicit result control:

```ts
run(c) {
  const item = await db.find(c.args.id)
  if (!item)
    return error({
      code: 'NOT_FOUND',
      message: `Item ${c.args.id} not found`,
      retryable: false,
    })
  return c.ok(item)
}
```

### CTAs (Call to Action)

Suggest next commands to guide agents on success:

```ts
run(c) {
  const result = { id: 42, name: c.args.name }
  return c.ok(result, {
    cta: {
      description: 'Suggested commands:',
      commands: [
        { command: 'get', args: { id: 42 }, description: 'View the item' },
        'list',
      ],
    },
  })
}
```

Or on errors, to help agents self-correct:

```ts
run(c) {
  const token = process.env.GH_TOKEN
  if (!token)
    return c.error({
      code: 'NOT_AUTHENTICATED',
      message: 'GitHub token not found',
      retryable: true,
      cta: {
        description: 'To authenticate:',
        commands: [
          { command: 'auth login', description: 'Log in to GitHub' },
          { command: 'config set', options: { token: true }, description: 'Set token manually' },
        ],
      },
    })
  // ...
}
```

## Agent Discovery

### MCP Server

Every incur CLI has built-in Model Context Protocol (MCP) support — exposing commands as MCP tools that agents can call directly.

#### `mcp add` built-in command

Register the CLI as an MCP server for your agents:

```sh
my-cli mcp add
```

This registers the CLI with your agent's MCP config. Works with Claude Code, Cursor, Amp, and others out of the box.

Options:

| Flag              | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `-c`, `--command` | Override the command agents will run to start the server |
| `--agent <agent>` | Target a specific agent (e.g. `claude-code`, `cursor`)   |
| `--no-global`     | Install to project instead of globally                   |

#### `--mcp` flag

Start the CLI as an MCP stdio server:

```sh
my-cli --mcp
```

This exposes all commands as MCP tools over stdin/stdout. Command groups are flattened with underscores (e.g. `pr_list`, `pr_view`). Arguments and options are merged into a single flat input schema.

### Skills

All incur-based CLIs can auto-generate and install agent skill files with `skills add`:

```sh
my-cli skills add
```

This generates Markdown skill files from your command definitions and installs them so agents discover your CLI automatically.

#### Configuration

It is also possible to configure `skills add`:

```ts
const cli = Cli.create('my-cli', {
  sync: {
    depth: 1,
    include: ['_root'],
    suggestions: ['install react as a dependency', 'check for outdated packages'],
  },
})
```

| Option        | Type       | Description                                                                                          |
| ------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `depth`       | `number`   | Grouping depth for skill files. `0` = single file, `1` = one per top-level command. Default: `1`     |
| `include`     | `string[]` | Glob patterns for additional SKILL.md files to include. Use `'_root'` for the project-level SKILL.md |
| `suggestions` | `string[]` | Example prompts shown after sync to help users get started                                           |

### `--llms` flag

Every incur CLI gets a built-in `--llms` flag that outputs a machine-readable manifest of all commands:

```sh
tool --llms
```

Outputs Markdown skill documentation by default.

```md
# tool install

Install a package

## Arguments

| Name      | Type     | Required | Description             |
| --------- | -------- | -------- | ----------------------- |
| `package` | `string` | no       | Package name to install |

## Options

| Flag        | Type      | Default | Description            |
| ----------- | --------- | ------- | ---------------------- |
| `--saveDev` | `boolean` |         | Save as dev dependency |
| `--global`  | `boolean` |         | Install globally       |
```

Use `--llms --format json` for JSON schema manifest:

```json
{
  "version": "incur.v1",
  "commands": [
    {
      "name": "install",
      "description": "Install a package",
      "schema": {
        "args": { "type": "object", "properties": { "package": { "type": "string" } } },
        "options": { "type": "object", "properties": { "saveDev": { "type": "boolean" } } },
        "output": { "type": "object", "properties": { "added": { "type": "number" } } }
      }
    }
  ]
}
```

## Built-in Flags

| Flag             | Description                                  |
| ---------------- | -------------------------------------------- |
| `--help`, `-h`   | Show help for the CLI or a specific command  |
| `--version`      | Print CLI version                            |
| `--llms`         | Output agent-readable command manifest       |
| `--mcp`          | Start as an MCP stdio server                 |
| `--json`         | Shorthand for `--format json`                |
| `--format <fmt>` | Output format: `toon`, `json`, `yaml`, `md`  |
| `--verbose`      | Include full envelope (`ok`, `data`, `meta`) |

## Examples

### Typed examples on commands

```ts
cli.command('deploy', {
  args: z.object({ env: z.enum(['staging', 'production']) }),
  options: z.object({ force: z.boolean().optional() }),
  examples: [
    { args: { env: 'staging' }, description: 'Deploy to staging' },
    { args: { env: 'production' }, options: { force: true }, description: 'Force deploy to prod' },
  ],
  run({ args }) {
    return { deployed: args.env }
  },
})
```

Examples appear in `--help` output and generated skill files.

### Hints

```ts
cli.command('publish', {
  hint: 'Requires NPM_TOKEN to be set in your environment.',
  // ...
})
```

Hints are displayed after examples in help output and included in skill files.

### Output policy

Control whether output data is displayed to humans. `'all'` (default) shows output to everyone. `'agent-only'` suppresses data in human/TTY mode while still returning it via `--json`, `--format`, or `--verbose`.

```ts
cli.command('deploy', {
  outputPolicy: 'agent-only',
  run() {
    return { id: 'deploy-123', url: 'https://staging.example.com' }
  },
})
```

Set on a group or root CLI to inherit across children. Children can override:

```ts
const sub = Cli.create('internal', { outputPolicy: 'agent-only' })
sub.command('sync', { run: () => ({ synced: true }) }) // inherits agent-only
sub.command('status', { outputPolicy: 'all', run: () => ({}) }) // overrides
```

## Middleware

Register composable before/after hooks with `cli.use()`. Middleware executes in registration order, onion-style. Each calls `await next()` to proceed.

```ts
const cli = Cli.create('deploy-cli', { description: 'Deploy tools' })
  .use(async (c, next) => {
    const start = Date.now()
    await next()
    console.log(`took ${Date.now() - start}ms`)
  })
  .command('deploy', {
    run() {
      return { deployed: true }
    },
  })
```

```sh
$ deploy-cli deploy
# → deployed: true
# took 12ms
```

Middleware on a sub-CLI only applies to its commands:

```ts
const admin = Cli.create('admin', { description: 'Admin commands' })
  .use(async (c, next) => {
    if (!isAdmin()) throw new Error('forbidden')
    await next()
  })
  .command('reset', { run: () => ({ reset: true }) })

cli.command(admin) // middleware only runs for `my-cli admin reset`
```

```sh
$ my-cli admin reset
# → reset: true

$ my-cli other-cmd
# middleware does not run
```

Per-command middleware runs after root and group middleware, and only for that command:

```ts
import { Cli, middleware, z } from 'incur'

const cli = Cli.create('my-cli', {
  description: 'My CLI',
  vars: z.object({ user: z.custom<{ id: string }>() }),
})

const requireAuth = middleware<typeof cli.vars>((c, next) => {
  if (!c.var.user) throw new Error('must be logged in')
  return next()
})

cli.command('deploy', {
  middleware: [requireAuth],
  run() {
    return { deployed: true }
  },
})
```

```sh
$ my-cli deploy
# Error: must be logged in

$ my-cli other-cmd
# per-command middleware does not run
```

### Vars — typed dependency injection

Declare a `vars` schema on `create()` to inject typed variables. Middleware sets them with `c.set()`, handlers read them via `c.var`. Use `.default()` for vars that don't need middleware:

```ts
const cli = Cli.create('my-cli', {
  description: 'My CLI',
  vars: z.object({
    user: z.custom<{ id: string; name: string }>(),
    requestId: z.string(),
    debug: z.boolean().default(false),
  }),
})

cli.use(async (c, next) => {
  c.set('user', await authenticate())
  c.set('requestId', crypto.randomUUID())
  await next()
})

cli.command('whoami', {
  run(c) {
    return { user: c.var.user, requestId: c.var.requestId, debug: c.var.debug }
  },
})
```

```sh
$ my-cli whoami
# → user:
# →   id: u_123
# →   name: Alice
# → requestId: 550e8400-e29b-41d4-a716-446655440000
# → debug: false
```

Middleware does **not** run for built-in commands (`--help`, `--llms`, `--mcp`, `mcp add`, `skills add`).

## Serving

Call `.serve()` to parse `process.argv` and run:

```ts
cli.serve()
```

For testing, pass custom argv and DI overrides:

```ts
let output = ''
await cli.serve(['install', 'express', '--json'], {
  stdout(s) {
    output += s
  },
  exit() {},
})
```

### `serve()` options

| Option   | Type                                  | Description                    |
| -------- | ------------------------------------- | ------------------------------ |
| `stdout` | `(s: string) => void`                 | Override stdout writer         |
| `exit`   | `(code: number) => void`              | Override exit handler          |
| `env`    | `Record<string, string \| undefined>` | Override environment variables |

### `cli.fetch(req: Request): Promise<Response>`

Expose the CLI as a Fetch API handler. See [Serve CLI as Fetch API](#serve-cli-as-fetch-api) for full details.

```ts
Bun.serve(cli)
```

## Streaming

Use `async *run` to stream chunks incrementally. Yield objects for structured data or plain strings for text:

```ts
cli.command('logs', {
  description: 'Tail logs',
  async *run() {
    yield 'connecting...'
    yield 'streaming logs'
    yield 'done'
  },
})
```

Each yielded value is written as a line in human/TOON mode. With `--format jsonl`, each chunk becomes `{"type":"chunk","data":"..."}`. You can also yield objects:

```ts
async *run() {
  yield { progress: 50 }
  yield { progress: 100 }
}
```

Use `ok()` or `error()` as the return value to attach CTAs or signal failure:

```ts
async *run({ ok }) {
  yield { step: 1 }
  yield { step: 2 }
  return ok(undefined, { cta: { commands: ['status'] } })
}
```

## Type Generation

Generate type definitions for your CLI's command map to get typed CTAs:

```sh
incur gen
```

This creates a `incur.generated.ts` file that registers your commands on the `Cli.Commands` type, enabling autocomplete on CTA command names, args, and options.

## Full Example

```ts
import { Cli, z } from 'incur'

const cli = Cli.create('npm', {
  version: '10.9.2',
  description: 'The package manager for JavaScript.',
  sync: {
    suggestions: ['install react as a dependency', 'check for outdated packages'],
  },
})

cli.command('install', {
  description: 'Install a package',
  args: z.object({
    package: z.string().optional().describe('Package name to install'),
  }),
  options: z.object({
    saveDev: z.boolean().optional().describe('Save as dev dependency'),
    global: z.boolean().optional().describe('Install globally'),
  }),
  alias: { saveDev: 'D', global: 'g' },
  output: z.object({
    added: z.number().describe('Number of packages added'),
    packages: z.number().describe('Total packages'),
  }),
  examples: [
    { args: { package: 'express' }, description: 'Install a package' },
    {
      args: { package: 'vitest' },
      options: { saveDev: true },
      description: 'Install as dev dependency',
    },
  ],
  run({ args }) {
    if (!args.package) return { added: 120, packages: 450 }
    return { added: 1, packages: 451 }
  },
})

cli.command('outdated', {
  description: 'Check for outdated packages',
  options: z.object({
    global: z.boolean().describe('Check global packages'),
  }),
  alias: { global: 'g' },
  output: z.object({
    packages: z.array(
      z.object({
        name: z.string(),
        current: z.string(),
        wanted: z.string(),
        latest: z.string(),
      }),
    ),
  }),
  run() {
    return {
      packages: [{ name: 'express', current: '4.18.0', wanted: '4.21.2', latest: '4.21.2' }],
    }
  },
})

cli.serve()

export default cli
```

> Always `export default cli` so that `incur gen` can import it and generate types.
