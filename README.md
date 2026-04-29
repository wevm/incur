<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="incur" src=".github/logo-light.svg" width="100%" height="140px">
</picture>

<br/>

<p align="center">
  <a href="https://www.npmjs.com/package/incur">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/v/incur?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/v/incur?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="Version">
    </picture>
  </a>
  <a href="https://app.codecov.io/gh/wevm/incur">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/codecov/c/github/wevm/incur?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/codecov/c/github/wevm/incur?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="Code coverage">
    </picture>
  </a>
  <a href="https://github.com/wevm/incur/blob/main/LICENSE">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/l/incur?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/l/incur?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="MIT License">
    </picture>
  </a>
</p>

<p align="center">
  <a href="#features">Features</a> · <a href="#quickprompt">Quickprompt</a> · <a href="#install">Install</a> · <a href="#usage">Usage</a> · <a href="#walkthrough">Walkthrough</a> · <a href="#license">License</a>
</p>

## Features

- [**Agent discovery**](#agent-discovery): built-in Skills and MCP sync (`skills add`, `mcp add`) so agents find your CLI automatically
- [**Session savings**](#session-savings): up to **3× fewer tokens** per session vs. MCP or skill alternatives
- [**Call-to-actions**](#call-to-actions): suggest next commands to agents and humans after a run
- [**TOON output**](#toon-output): token-efficient default format that agents parse easily, with JSON, YAML, Markdown, and JSONL alternatives
- [**`--llms` flag**](#agent-discovery): token-efficient command manifest in Markdown or JSON schema
- [**Well-formed I/O**](#well-formed-io): Schemas schemas for arguments, options, environment variables, and output
- [**Inferred types**](#inferred-types): generic type flow from schemas to `run` callbacks with zero manual annotations
- [**Global options**](#global-options): `--format`, `--full-output`, `--help`, `--json`, `--version` on every CLI for free
- [**Light API surface**](#light-api-surface): `Cli.create()`, `.command()`, `.serve()` – that's it
- [**Middleware**](#middleware): composable before/after hooks with typed dependency injection via `cli.use()`

## Quickprompt

Prompt your agent:

**Skills (recommended – lighter on tokens)**

```txt
Run `npx incur skills add`, then show me how to build CLIs with incur.
```

**MCP**

```txt
Run `npx incur mcp add`, then show me how to build CLIs with incur.
```

## Install

```bash
npm i incur
```

```bash
pnpm i incur
```

```bash
bun i incur
```

## Usage

### Single-command CLI

Pass `run` directly to `Cli.create()` for CLIs that do one thing.

```ts
import { Cli, z } from 'incur'

Cli.create('greet', {
  description: 'A greeting CLI',
  args: z.object({
    name: z.string().describe('Name to greet'),
  }),
  run(c) {
    return { message: `hello ${c.args.name}` }
  },
}).serve()
```

```sh
$ greet world
# → message: hello world
```

```sh
$ greet --help
# greet – A greeting CLI
#
# Usage: greet <name>
#
# Arguments:
#   name  Name to greet
#
# Built-in Commands:
#   completions  Generate shell completion script
#   mcp add      Register as MCP server
#   skills add   Sync skill files to agents
#
# Global Options:
#   --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
#   --format <toon|json|yaml|md|jsonl>  Output format
#   --full-output                       Show full output envelope
#   --help                              Show help
#   --llms                              Print LLM-readable manifest
#   --mcp                               Start as MCP stdio server
#   --schema                            Show JSON Schema for command
#   --token-count                       Print token count of output instead of output
#   --token-limit <n>                   Limit output to n tokens
#   --token-offset <n>                  Skip first n tokens of output (for pagination)
#   --version                           Show version
```

### Multi-command CLI

Chain `.command()` calls to register subcommands.

```ts
import { Cli, z } from 'incur'

Cli.create('my-cli', {
  description: 'My CLI',
})
  .command('status', {
    description: 'Show repo status',
    run() {
      return { clean: true }
    },
  })
  .command('install', {
    description: 'Install a package',
    args: z.object({
      package: z.string().optional().describe('Package name'),
    }),
    options: z.object({
      saveDev: z.boolean().optional().describe('Save as dev dependency'),
    }),
    alias: { saveDev: 'D' },
    run(c) {
      return { added: 1, packages: 451 }
    },
  })
  .serve()
```

```sh
$ my-cli status
# → clean: true

$ my-cli install express -D
# → added: 1
# → packages: 451
```

```sh
$ my-cli --help
# my-cli – My CLI
#
# Usage: my-cli <command>
#
# Commands:
#   install  Install a package
#   status   Show repo status
#
# Built-in Commands:
#   completions  Generate shell completion script
#   mcp add      Register as MCP server
#   skills add   Sync skill files to agents
#
# Global Options:
#   --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
#   --format <toon|json|yaml|md|jsonl>  Output format
#   --full-output                       Show full output envelope
#   --help                              Show help
#   --llms                              Print LLM-readable manifest
#   --mcp                               Start as MCP stdio server
#   --schema                            Show JSON Schema for command
#   --token-count                       Print token count of output instead of output
#   --token-limit <n>                   Limit output to n tokens
#   --token-offset <n>                  Skip first n tokens of output (for pagination)
#   --version                           Show version
```

### Sub-command CLI

Create a separate `Cli` and mount it with `.command(cli)` to nest command groups.

```ts
const cli = Cli.create('my-cli', { description: 'My CLI' })

// Create a `pr` group.
const pr = Cli.create('pr', { description: 'Pull request commands' }).command('list', {
  description: 'List pull requests',
  options: z.object({
    state: z.enum(['open', 'closed', 'all']).default('open'),
  }),
  run(c) {
    return { prs: [], state: c.options.state }
  },
})

cli
  .command(pr) // Link the `pr` group.
  .serve()
```

```sh
$ my-cli pr list --state closed
# → prs: (empty)
# → state: closed
```

```sh
$ my-cli --help
# my-cli – My CLI
#
# Usage: my-cli <command>
#
# Commands:
#   pr  Pull request commands
#
# Built-in Commands:
#   completions  Generate shell completion script
#   mcp add      Register as MCP server
#   skills add   Sync skill files to agents
#
# Global Options:
#   --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])
#   --format <toon|json|yaml|md|jsonl>  Output format
#   --full-output                       Show full output envelope
#   --help                              Show help
#   --llms                              Print LLM-readable manifest
#   --mcp                               Start as MCP stdio server
#   --schema                            Show JSON Schema for command
#   --token-count                       Print token count of output instead of output
#   --token-limit <n>                   Limit output to n tokens
#   --token-offset <n>                  Skip first n tokens of output (for pagination)
#   --version                           Show version
```

### Mount APIs as CLIs

Mount any HTTP server as a command with the `fetch` property. Supports any API
framework that exposes a [Web Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) handler.

The CLI translates HTTP requests using curl-style flags.

```ts
import { Cli } from 'incur'
import { Hono } from 'hono'

const app = new Hono()
  .get('/users', (c) => c.json({ users: [{ id: 1, name: 'Alice' }] }))
  .post('/users', async (c) => c.json({ created: true, ...(await c.req.json()) }, 201))

Cli.create('my-cli', {
  description: 'My CLI',
  fetch: app.fetch,
  // OR
  // fetch: bunApp.fetch
  // fetch: denoApp.fetch
  // fetch: elysiaApp.fetch,
}).serve()
```

```sh
$ my-cli api users
# → users:
# →   - id: 1
# →     name: Alice

$ my-cli api users -X POST -d '{"name":"Bob"}'
# → created: true
# → name: Bob
```

#### As commands

You can also mount Hono apps onto commands:

```ts
import { Cli } from 'incur'
import { Hono } from 'hono'

const app = new Hono()
  .get('/users', (c) => c.json({ users: [{ id: 1, name: 'Alice' }] }))
  .post('/users', async (c) => c.json({ created: true, ...(await c.req.json()) }, 201))

Cli.create('my-cli', { description: 'My CLI' }).command('users', { fetch: app.fetch }).serve()
```

#### OpenAPI

Pass an OpenAPI spec alongside `fetch` to generate typed subcommands with args, options, and descriptions extracted from the spec:

```ts
import { Cli } from 'incur'
import { app, spec } from './my-hono-openapi-app.js'

Cli.create('my-cli', { description: 'My CLI' })
  .command('api', { fetch: app.fetch, openapi: spec })
  .serve()
```

```sh
$ my-cli api --help
# Commands:
#   listUsers    List users
#   createUser   Create a user
#   getUser      Get a user by ID

$ my-cli api listUsers --limit 5
# → users: ...

$ my-cli api getUser 42
# → id: 42
# → name: Alice

$ my-cli api createUser --name Bob
# → created: true
# → name: Bob
```

Incur can also generate an OpenAPI 3.2 document from your CLI:

```ts
import { Cli, Openapi, z } from 'incur'

const cli = Cli.create('my-cli', { description: 'My CLI' }).command('users list', {
  options: z.object({ limit: z.coerce.number().optional() }),
  run() {
    return { users: [] }
  },
})

const spec = Openapi.fromCli(cli)
```

When served with `cli.fetch`, the generated spec is available at `/openapi.json`, `/openapi.yml`, `/openapi.yaml`, and `/.well-known/openapi.json`. Methods are inferred from command names: read-like commands use `GET`, update-like commands use `PATCH`, delete-like commands use `DELETE`, and other commands use `POST`.

### Serve CLIs as APIs

The inverse of mounting — expose your CLI as a standard Fetch API handler with `cli.fetch`. Works with Bun, Cloudflare Workers, Deno, Hono, and anything that accepts `(req: Request) => Response`.

```ts
import { Cli, z } from 'incur'

const cli = Cli.create('my-cli', { version: '1.0.0' }).command('users', {
  args: z.object({ id: z.coerce.number().optional() }),
  options: z.object({ limit: z.coerce.number().default(10) }),
  run(c) {
    if (c.args.id) return { id: c.args.id, name: 'Alice' }
    return { users: [{ id: 1, name: 'Alice' }], limit: c.options.limit }
  },
})

Bun.serve(cli) // Bun
Deno.serve(cli.fetch) // Deno
export default cli // Cloudflare Workers
app.all('*', (c) => cli.fetch(c.request)) // Elysia
app.use((c) => cli.fetch(c.req.raw)) // Hono
export const GET = cli.fetch // Next.js
export const POST = cli.fetch // Next.js
```

Path segments map to commands and positional args, query params to options (GET), and JSON body to options (POST):

```
GET  /users?limit=5    → my-cli users --limit 5
GET  /users/42         → my-cli users 42
POST /users { "name": "Bob" }  → my-cli users --name Bob
```

Responses use the same JSON envelope as `--full-output --format json`:

```json
{ "ok": true, "data": { "users": [...] }, "meta": { "command": "users", "duration": "3ms" } }
```

Async generator commands stream as NDJSON (`application/x-ndjson`). Middleware runs the same as in `serve()`.

#### MCP over HTTP

The `fetch` handler automatically exposes an MCP endpoint at `/mcp`. Agents can discover and call your CLI's commands as MCP tools over HTTP — no stdio required:

```
POST /mcp  { "jsonrpc": "2.0", "method": "initialize", ... }
POST /mcp  { "jsonrpc": "2.0", "method": "tools/list", ... }
POST /mcp  { "jsonrpc": "2.0", "method": "tools/call", "params": { "name": "users", ... } }
```

Non-`/mcp` paths continue routing to the command API as usual.

## Walkthrough

### Agent discovery

Agents can only use your CLI if they know it exists. incur solves this with three built-in discovery mechanisms – no manual config, no copy-pasting tool definitions:

```sh
# Auto-generate and install agent skill files (recommended – lighter on tokens)
my-cli skills add

# Register as MCP server for your agents
my-cli mcp add

# Output machine-readable manifest
my-cli --llms
```

### Session savings

Most CLIs expose tools via MCP or a single monolithic skill file. incur combines on-demand skill loading with TOON output to cut token usage across the entire session – from discovery through invocation and response.

The table below models a session with a 20-command CLI producing full output envelopes.

- **Session start** – tokens consumed just by having the tool available. _MCP injects all tool schemas into every turn; skills only load frontmatter (name + description)._
- **Discovery** – tokens to learn what commands exist and how to call them. _MCP gets this at session start; skills load the full skill file on demand; incur splits by command group so only relevant commands are loaded._
- **Invocation (×5)** – tokens per tool call.
- **Response (×5)** – tokens in CLI output. _MCP and skills return JSON; incur defaults to TOON which strips braces, quotes, and keys._

```
┌─────────────────┬────────────┬──────────────────┬─────────┬───────────────┐
│                 │ MCP + JSON │ One Skill + JSON │   incur │ vs. incur     │
├─────────────────┼────────────┼──────────────────┼─────────┼───────────────┤
│ Session start   │      6,747 │              624 │     805 │         ↓8.4× │
│ Discovery       │          0 │           11,489 │     387 │        ↓29.7× │
│ Invocation (×5) │        110 │               65 │      65 │         ↓1.7× │
│ Response (×5)   │     10,940 │           10,800 │   5,790 │         ↓1.9× │
├─────────────────┼────────────┼──────────────────┼─────────┼───────────────┤
│ Cost            │    $0.0325 │          $0.0410 │ $0.0131 │         ↓3.1× │
└─────────────────┴────────────┴──────────────────┴─────────┴───────────────┘
```

### Call-to-actions

Without CTAs, agents have to guess what to do next or ask the user. With CTAs, your CLI tells the agent exactly which commands are relevant after each run, so it can chain operations without extra prompting.

Return CTAs from `ok()` or `error()` to suggest next steps. `cta` parameters are also fully type-inferred, so agents get valid command names, arguments, and options for free.

```ts
cli.command('list', {
  args: z.object({ state: z.enum(['open', 'closed']).default('open') }),
  run(c) {
    const items = [{ id: 1, title: 'Fix bug' }]
    return c.ok(
      { items },
      {
        cta: {
          commands: [
            { command: 'get 1', description: 'View item' },
            { command: 'list', args: { state: 'closed' }, description: 'View closed' },
          ],
        },
      },
    )
  },
})
```

```sh
$ my-cli list
# → items:
# →   - id: 1
# →     title: Fix bug
# Next:
#   my-cli get 1 – View item
#   my-cli list closed – View closed
```

### Light API surface

A small API means agents can build entire CLIs in a single pass without needing to learn framework abstractions. Three functions: `create`, `command`, `serve`, and everything else (parsing, help, validation, output formatting, agent discovery) is handled automatically:

```ts
import { Cli, z } from 'incur'

// Define sub-command groups
const db = Cli.create('db', { description: 'Database commands' }).command('migrate', {
  description: 'Run migrations',
  run: () => ({ migrated: true }),
})

// Create the root CLI
Cli.create('tool', { description: 'A tool' })
  // Register commands
  .command('run', { description: 'Run a task', run: () => ({ ok: true }) })
  // Mount sub-command groups
  .command(db)
  // Serve the CLI
  .serve()
```

```sh
$ tool --help
# Usage: tool <command>
#
# Commands:
#   run  Run a task
#   db   Database commands
```

### TOON output

Every token an agent spends reading CLI output is a token it can’t spend reasoning. incur defaults to [TOON](https://github.com/toon-format/toon) – a format that’s as readable as YAML but with no quoting, no braces, and no redundant syntax. Agents parse it easily and use up to **60% fewer tokens compared to JSON**.

```sh
$ my-cli hikes --location Boulder --season spring_2025
# → context:
# →   task: Our favorite hikes together
# →   location: Boulder
# →   season: spring_2025
# → friends[3]: ana,luis,sam
# → hikes[3]{id,name,distanceKm,elevationGain,companion,wasSunny}:
# →   1,Blue Lake Trail,7.5,320,ana,true
# →   2,Ridge Overlook,9.2,540,luis,false
# →   3,Wildflower Loop,5.1,180,sam,true
```

Switch formats with `--format` or `--json`:

```sh
$ my-cli status --format json
# → {
# →   "context": {
# →     "task": "Our favorite hikes together",
# →     "location": "Boulder",
# →     "season": "spring_2025"
# →   },
# →   "friends": ["ana", "luis", "sam"],
# →   "hikes": [
# →   ... + 1000 more tokens
# → ]
# → }
```

Supported formats: `toon`, `json`, `yaml`, `md`, `jsonl`.

### Well-formed I/O

Agents fail when they guess at argument formats or misinterpret output structure. incur eliminates this by declaring schemas for arguments, options, environment variables, and output – every input is validated before `run` executes, and every output has a known shape that agents can rely on without parsing heuristics:

```ts
cli.command('deploy', {
  args: z.object({ env: z.enum(['staging', 'production']) }),
  options: z.object({ force: z.boolean().optional() }),
  env: z.object({ DEPLOY_TOKEN: z.string() }),
  output: z.object({ url: z.string(), duration: z.number() }),
  run(c) {
    return { url: `https://${c.args.env}.example.com`, duration: 3.2 }
  },
})
```

### Streaming

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

```sh
$ my-cli logs
# → connecting...
# → streaming logs
# → done
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
async *run(c) {
  yield { step: 1 }
  yield { step: 2 }
  return c.ok(undefined, { cta: { commands: ['status'] } })
}
```

### Inferred types

Type safety isn’t just for humans – agents building CLIs with incur get immediate feedback when they pass the wrong argument type or return the wrong shape. Schemas flow through generics so `run` callbacks, `output`, and `cta` commands are all fully inferred with zero manual annotations:

```ts twoslash
cli.command('greet', {
  args: z.object({ name: z.string() }),
  options: z.object({ loud: z.boolean().default(false) }),
  output: z.object({ message: z.string() }),
  run(c) {
    c.args.name
    //     ^? (property) name: string
    c.options.loud
    //        ^? (property) loud: boolean
    return c.ok(
      { message: `hello ${c.args.name}` },
      //^? (property) message: string
      {
        cta: { commands: ['greet world'] },
        //     ^? 'greet' | 'other-cmd'
      },
    )
  },
})
```

### Output policy

Control whether output data is displayed to humans. By default, output goes to everyone (`'all'`). Set `outputPolicy: 'agent-only'` to suppress data in TTY mode while still returning it to agents via `--json`, `--format`, or `--full-output`.

```ts
cli.command('deploy', {
  outputPolicy: 'agent-only',
  run() {
    // Agents get the structured data; humans see nothing (or just CTAs/errors)
    return { id: 'deploy-123', url: 'https://staging.example.com' }
  },
})
```

Set it on a group or root CLI to inherit across all children:

```ts
const internal = Cli.create('internal', {
  description: 'Internal commands',
  outputPolicy: 'agent-only',
})
internal.command('sync', { run: () => ({ synced: true }) }) // inherits agent-only
internal.command('status', {
  outputPolicy: 'all', // overrides to show output
  run: () => ({ ok: true }),
})
```

### CLI name

The `run` context (and middleware context) includes `name` — the CLI name passed to `Cli.create()`. Useful for composing help text, error messages, and user-facing strings:

```ts
const cli = Cli.create('deploy-cli', { description: 'Deploy tools' })

cli.command('check', {
  output: z.string(),
  run(c) {
    if (!authenticated()) return `Not logged in. Run \`${c.name} auth login\` to log in.`
    return 'OK'
  },
})
```

### Deprecated options

Mark options as deprecated with `.meta({ deprecated: true })`. Deprecated flags show `[deprecated]` in `--help`, `**Deprecated.**` in skill docs, `deprecated: true` in JSON Schema (`--llms`), and emit a stderr warning when used in TTY mode:

```ts
cli.command('deploy', {
  options: z.object({
    zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
    region: z.string().optional().describe('Target region'),
  }),
  run(c) {
    return { region: c.options.region }
  },
})
```

```sh
$ my-cli deploy --zone us-east-1
# Warning: --zone is deprecated
```

### Agent detection

The `run` context includes an `agent` boolean — `true` when stdout is not a TTY (piped or consumed by an agent), `false` when running in a terminal. Use it to tailor behavior:

```ts
cli.command('deploy', {
  args: z.object({ env: z.enum(['staging', 'production']) }),
  run(c) {
    if (!c.agent) console.log(`Deploying to ${c.args.env}...`)
    return { url: `https://${c.args.env}.example.com` }
  },
})
```

### Middleware

Register composable before/after hooks with `cli.use()`. Middleware executes in registration order, onion-style – each calls `await next()` to proceed to the next middleware or the command handler.

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

Per-command middleware runs after root and group middleware, and only for that command:

```ts
import { Cli, middleware, z } from 'incur'

const cli = Cli.create('my-cli', {
  description: 'My CLI',
  vars: z.object({ user: z.custom<User>() }),
})

// structured error with code — shows up in the output envelope
const requireAuth = middleware<typeof cli.vars>((c, next) => {
  if (!c.var.user) return c.error({ code: 'AUTH', message: 'must be logged in' })
  return next()
})

// throwing also works — produces an UNKNOWN error code
const requireAdmin = middleware<typeof cli.vars>((c, next) => {
  if (!c.var.user?.admin) throw new Error('admin required')
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
# Error (AUTH): must be logged in

$ my-cli other-cmd
# per-command middleware does not run
```

### Variables

Declare a `vars` schema on `create()` to enable typed variables. Middleware sets them with `c.set()`, and both middleware and command handlers read them via `c.var`. Use `.default()` for vars that don't need middleware:

```ts
type User = { id: string; name: string }

const cli = Cli.create('my-cli', {
  description: 'My CLI',
  vars: z.object({
    user: z.custom<User>(),
    requestId: z.string(),
    debug: z.boolean().default(true),
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
# → debug: true
```

### Global options

Every incur CLI includes these flags automatically:

| Flag                     | Description                                            |
| ------------------------ | ------------------------------------------------------ |
| `--filter-output <keys>` | Filter output by key paths (e.g. `foo,bar.baz,a[0,3]`) |
| `--format <fmt>`         | Output format: `toon`, `json`, `yaml`, `md`            |
| `--full-output`          | Include full envelope (`ok`, `data`, `meta`)           |
| `--help`, `-h`           | Show help for the CLI or a specific command            |
| `--llms`                 | Output agent-readable command manifest                 |
| `--mcp`                  | Start as an MCP stdio server                           |
| `--json`                 | Shorthand for `--format json`                          |
| `--schema`               | Show JSON Schema for command's args, options, output   |
| `--token-count`          | Print token count of output instead of output          |
| `--token-limit <n>`      | Limit output to n tokens (for pagination)              |
| `--token-offset <n>`     | Skip first n tokens of output (for pagination)         |
| `--version`              | Print CLI version                                      |

### Config file

Load option defaults from a JSON config file. Opt in with `config` on `Cli.create()`:

```ts
const cli = Cli.create('my-cli', {
  config: {
    flag: 'config',
    files: ['my-cli.json', '~/.config/my-cli/config.json'],
  },
})
```

- `flag` — registers `--config <path>` and `--no-config` as global flags. The flag name is configurable (`{ flag: 'settings' }` → `--settings`/`--no-settings`). Omit to auto-load only.
- `files` — ordered search paths. First existing file wins. Supports resolving `~`. Defaults to `['<cli>.json']`.
- `loader` — custom loader function for non-JSON formats. Receives the resolved path (or `undefined`) and returns the config tree:

```ts
const cli = Cli.create('my-cli', {
  config: {
    files: ['my-cli.toml'],
    async loader(path) {
      if (!path) return undefined
      return TOML.parse(await readFile(path, 'utf8'))
    },
  },
})
```

Config files use a structured format with `options` and `commands` keys, mirroring the `Cli.create()` / `.command()` hierarchy:

```json
{
  "options": {
    "verbose": true
  },
  "commands": {
    "echo": {
      "options": {
        "upper": true,
        "prefix": "cfg"
      }
    },
    "project": {
      "commands": {
        "list": {
          "options": {
            "limit": 25,
            "save-dev": true
          }
        }
      }
    }
  }
}
```

Precedence is `argv > config > zod defaults`. Only command `options` are loaded — `args`, `env`, and built-in commands are unaffected.

Use `incur gen` to auto-generate a `config.schema.json` to distribute with your CLI for consumer autocomplete.

### Filtering output

Use `--filter-output` to prune command output to specific keys. Supports dot-notation for nested keys, array slices, and comma-separated paths:

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
$ my-cli users --filter-output users.name
# → [3]: Alice,Bob,Carol

$ my-cli users --filter-output users[0,2].name
# → users[2]{name}:
# →   Alice
# →   Bob
```

### Token pagination

Use `--token-count`, `--token-limit`, and `--token-offset` to manage large outputs. Tokens are estimated using LLM tokenization rules (~96% accuracy).

```sh
# Check how many tokens a command produces
$ my-cli users --token-count
# → 42

# Limit output to the first 20 tokens
$ my-cli users --token-limit 20
# → users[3]{name,email,role}:
# →   Alice,alice@example.
# → [truncated: showing tokens 0–20 of 42]

# Paginate: get the next page
$ my-cli users --token-offset 20 --token-limit 20
# → com,admin
# →   Bob,bob@example.com,
# → [truncated: showing tokens 20–40 of 42]
```

### Command schema

Use `--schema` to inspect the JSON Schema for a command's arguments, options, environment variables, and output — useful for code generation, validation, and tooling:

```sh
$ my-cli install --schema
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

Combine with `--format json` for machine-readable output:

```sh
$ my-cli install --schema --format json
```

### Shell completions

Every incur CLI has a built-in `completions` command that generates shell hook scripts for tab completion. The hook calls back into your binary at every tab press, so completions are always in sync with your commands.

```sh
# Generate and install completions
eval "$(my-cli completions bash)"    # add to ~/.bashrc
eval "$(my-cli completions zsh)"     # add to ~/.zshrc
my-cli completions fish | source     # add to ~/.config/fish/config.fish
```

Completions are dynamic — subcommands, `--options`, short aliases, and enum values are all suggested based on the current command context. Command groups suppress the trailing space so you can keep tabbing into subcommands.

Run `my-cli completions --help` for setup instructions.

## API Reference

> TODO

## License

MIT
