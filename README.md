# incur

Simple CLI framework for agents and humans.

## Quickprompt

Prompt your agent:

```sh
# MCP (Recommended)
> "Run `npx incur mcp add`, then show me what I can do with incur."

# Skills 
> "Run `npx incur skills add`, then show me what I can do with incur."
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

```ts
import { Cli, z } from 'incur'

Cli.create('greet', {
  description: 'A greeting CLI',
  args: z.object({
    name: z.string().describe('Name to greet'),
  }),
  run({ args }) {
    return { message: `hello ${args.name}` }
  },
}).serve()
```

```sh
$ greet world
# → message: hello world
```

### Multi-command CLI

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
    run({ args }) {
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

### Sub-command CLI

```ts
const cli = Cli.create('my-cli', { description: 'My CLI' })

// Create a `pr` group.
const pr = Cli.create('pr', { description: 'Pull request commands' }).command('list', {
  description: 'List pull requests',
  options: z.object({
    state: z.enum(['open', 'closed', 'all']).default('open'),
  }),
  run({ options }) {
    return { prs: [], state: options.state }
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

### Agent discovery

Every incur CLI gets a built-in MCP support, `skills add` command and `--llms` flag:

```sh
# Register as an MCP server for your agents
my-cli mcp add

# Auto-generate and install agent skill files
my-cli skills add

# Output machine-readable manifest
my-cli --llms
```

## API Reference

> TODO

## License

MIT
