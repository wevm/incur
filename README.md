<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="incur" src=".github/logo-light.svg" width="100%" height="140px">
</picture>

<br/>

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
- [**Global options**](#global-options): `--format`, `--json`, `--verbose`, `--help`, `--version` on every CLI for free
- [**Light API surface**](#light-api-surface): `Cli.create()`, `.command()`, `.serve()` – that's it

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
#   mcp add     Register as an MCP server
#   skills add  Sync skill files to your agent
#
# Global Options:
#   --format <toon|json|yaml|md|jsonl>  Output format
#   --help                              Show help
#   --llms                              Print LLM-readable manifest
#   --mcp                               Start as MCP stdio server
#   --verbose                           Show full output envelope
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
#   mcp add     Register as an MCP server
#   skills add  Sync skill files to your agent
#
# Global Options:
#   --format <toon|json|yaml|md|jsonl>  Output format
#   --help                              Show help
#   --llms                              Print LLM-readable manifest
#   --mcp                               Start as MCP stdio server
#   --verbose                           Show full output envelope
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
#   mcp add     Register as an MCP server
#   skills add  Sync skill files to your agent
#
# Global Options:
#   --format <toon|json|yaml|md|jsonl>  Output format
#   --help                              Show help
#   --llms                              Print LLM-readable manifest
#   --mcp                               Start as MCP stdio server
#   --verbose                           Show full output envelope
#   --version                           Show version
```

## Walkthrough

### Agent discovery

Agents can only use your CLI if they know it exists. incur solves this with three built-in discovery mechanisms – no manual config, no copy-pasting tool definitions:

```sh
# Auto-generate and install agent skill files (recommended – lighter on tokens)
my-cli skills add

# Register as an MCP server for your agents
my-cli mcp add

# Output machine-readable manifest
my-cli --llms
```

### Session savings

Most CLIs expose tools via MCP or a single monolithic skill file. incur combines on-demand skill loading with TOON output to cut token usage across the entire session – from discovery through invocation and response.

The table below models a session with a 20-command CLI producing verbose output.

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
      {
        //            ^? (property) message: string
        cta: { commands: ['greet world'] },
        //                   ^? 'greet' | 'other-cmd'
      },
    )
  },
})
```

### Output policy

Control whether output data is displayed to humans. By default, output goes to everyone (`'all'`). Set `outputPolicy: 'agent-only'` to suppress data in TTY mode while still returning it to agents via `--json`, `--format`, or `--verbose`.

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

### Global options

Every incur CLI includes these flags automatically:

| Flag             | Description                                  |
| ---------------- | -------------------------------------------- |
| `--help`, `-h`   | Show help for the CLI or a specific command  |
| `--version`      | Print CLI version                            |
| `--llms`         | Output agent-readable command manifest       |
| `--mcp`          | Start as an MCP stdio server                 |
| `--json`         | Shorthand for `--format json`                |
| `--format <fmt>` | Output format: `toon`, `json`, `yaml`, `md`  |
| `--verbose`      | Include full envelope (`ok`, `data`, `meta`) |

## API Reference

> TODO

## License

MIT
