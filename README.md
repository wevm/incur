# clac

Simple CLI framework for agents and humans.

## Quickprompt

Prompt your agent:

```
Run `npx clac skills add`, then show me what I can do with clac.
```

## Install

```bash
npm i clac
```

```bash
pnpm i clac
```

```bash
bun i clac
```

## Usage

### Single-command CLI

```ts
import { Cli, z } from 'clac'

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
greet world
# → message: hello world
```

### Multi-command CLI

```ts
import { Cli, z } from 'clac'

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

### Sub-command CLI

```ts
const cli = Cli.create('my-cli', { description: 'My CLI' })

// Create a `pr` group.
const pr = Cli.create('pr', { description: 'Pull request commands' })
  .command('list', {
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
// → gh pr list --state closed
```

### Agent discovery

Every clac CLI gets a built-in `--llms` flag and `skills add` command:

```sh
# Output machine-readable manifest
my-cli --llms

# Auto-generate and install agent skill files
my-cli skills add
```

## API Reference

> TODO

## License

MIT
