# Phase 10: Help, Version & Polish

## Design

Add built-in `--help`, `--version` flags, and implicit help display for router CLIs invoked with no subcommand or root CLIs created without `run`.

### Key behaviors

1. **Router with no subcommand** — `cli.serve([])` prints usage (commands list), exits 0. Currently errors with `COMMAND_NOT_FOUND`.
2. **Root CLI with no `run`** — `Cli.create('tool', { description: '...' })` without `run` or `.command()` calls — prints usage with name/description, exits 0.
3. **`--help` flag** — consumed before command resolution. Works at any level: root, group, or leaf.
4. **`--version` flag** — prints `version` string from `Cli.create()` options, exits 0.

### Help module

New `Help.ts` module handles formatting. Pure functions, no CLI coupling.

```ts
Help.formatRoot(name, description, commands)     // router or bare root
Help.formatCommand(name, description, args, options) // leaf command
```

Output is plain text (not TOON/JSON). Uses a Docker/Cargo-inspired layout:

- **Header**: `name — description` with em dash separator
- **Synopsis**: `Usage: tool <command>` or `Usage: tool greet <name> [title]`
- **Two-column layout**: dynamically aligned, left column for term, right for description
- **Defaults**: appended as `(default: X)` in dim position
- **Sections**: separated by blank lines, consistent 2-space indent for entries

For a router:

```
gh — GitHub CLI

Usage: gh <command>

Commands:
  pr list      List pull requests
  pr view      View a pull request
  issue list   List issues
```

For a leaf command:

```
gh pr list — List pull requests

Usage: gh pr list [repo]

Arguments:
  repo              Repository in owner/repo format

Options:
  --state <string>  Filter by state (default: open)
  --limit <number>  Max PRs to return (default: 30)
```

### Integration points in `Cli.ts`

- `extractBuiltinFlags` — extract `--help` and `--version` alongside existing `--verbose`, `--format`, `--llms`
- `serveImpl` — check `help`/`version` flags early, before command resolution
- `resolveCommand` — when resolution finds a group with no subcommand token, return a signal to show help instead of erroring

---

## TDD Cycles

### Cycle 1: Help.formatCommand — leaf command help text

**Red** (`Help.test.ts`):
```ts
test('formats leaf command with args and options', () => {
  const result = Help.formatCommand('gh pr list', {
    description: 'List pull requests',
    args: z.object({
      repo: z.string().optional().describe('Repository in owner/repo format'),
    }),
    options: z.object({
      state: z.string().default('open').describe('Filter by state'),
      limit: z.number().default(30).describe('Max PRs to return'),
    }),
  })
  expect(result).toMatchInlineSnapshot(`
    "gh pr list — List pull requests

    Usage: gh pr list [repo]

    Arguments:
      repo              Repository in owner/repo format

    Options:
      --state <string>  Filter by state (default: open)
      --limit <number>  Max PRs to return (default: 30)"
  `)
})
```

**Green**: Implement `Help.formatCommand()` — synopsis line, args table, options table.

---

### Cycle 2: Help.formatRoot — router help text

**Red**:
```ts
test('formats root with command list', () => {
  const result = Help.formatRoot('gh', {
    description: 'GitHub CLI',
    commands: [
      { name: 'pr list', description: 'List pull requests' },
      { name: 'pr view', description: 'View a pull request' },
      { name: 'issue list', description: 'List issues' },
    ],
  })
  expect(result).toMatchInlineSnapshot(`
    "gh — GitHub CLI

    Usage: gh <command>

    Commands:
      pr list      List pull requests
      pr view      View a pull request
      issue list   List issues"
  `)
})
```

**Green**: Implement `Help.formatRoot()` — name, description, commands list with aligned columns.

---

### Cycle 3: Omits empty sections

**Red**:
```ts
test('omits sections when no schemas', () => {
  const result = Help.formatCommand('tool ping', {
    description: 'Health check',
  })
  expect(result).toMatchInlineSnapshot(`
    "tool ping — Health check

    Usage: tool ping"
  `)
})
```

**Green**: Conditionally render sections — snapshot confirms no Arguments/Options sections.

---

### Cycle 4: Optional vs required args formatting

**Red**:
```ts
test('formats optional args in brackets, required in angle brackets', () => {
  const result = Help.formatCommand('tool greet', {
    args: z.object({
      name: z.string().describe('Name'),
      title: z.string().optional().describe('Title'),
    }),
  })
  expect(result).toMatchInlineSnapshot(`
    "tool greet

    Usage: tool greet <name> [title]

    Arguments:
      name   Name
      title  Title"
  `)
})
```

**Green**: Check Zod schema for `.isOptional()` on each arg field. Snapshot confirms `<name> [title]` in synopsis.

---

### Cycle 5: Router CLI with no subcommand shows help

**Red** (`Cli.test.ts`):
```ts
test('router with no subcommand shows help', async () => {
  const cli = Cli.create('tool')
  cli.command('ping', {
    description: 'Health check',
    run: () => ({ pong: true }),
  })

  const { output, exitCode } = await serve(cli, [])
  expect(exitCode).toBe(0)
  expect(output).toMatchInlineSnapshot(`
    "tool

    Usage: tool <command>

    Commands:
      ping  Health check"
  `)
})
```

**Green**: In `serveImpl`, when `filtered` is empty (no tokens after builtin flags), print help and return instead of calling `resolveCommand`.

---

### Cycle 6: Group with no subcommand shows help

**Red**:
```ts
test('group with no subcommand shows help', async () => {
  const pr = Cli.create('pr', { description: 'Pull request commands' })
  pr.command('list', {
    description: 'List PRs',
    run: () => ({}),
  })

  const cli = Cli.create('gh')
  cli.command(pr)

  const { output, exitCode } = await serve(cli, ['pr'])
  expect(exitCode).toBe(0)
  expect(output).toMatchInlineSnapshot(`
    "gh pr — Pull request commands

    Usage: gh pr <command>

    Commands:
      list  List PRs"
  `)
})
```

**Green**: When `resolveCommand` hits a group with no remaining tokens, return a help signal. `serveImpl` handles it by printing group help.

---

### Cycle 7: `--help` on root

**Red**:
```ts
test('--help on root shows help', async () => {
  const cli = Cli.create('tool')
  cli.command('ping', {
    description: 'Health check',
    run: () => ({ pong: true }),
  })

  const { output, exitCode } = await serve(cli, ['--help'])
  expect(exitCode).toBe(0)
  expect(output).toMatchInlineSnapshot(`
    "tool

    Usage: tool <command>

    Commands:
      ping  Health check"
  `)
})
```

**Green**: Extract `--help` in `extractBuiltinFlags`, check early in `serveImpl`.

---

### Cycle 8: `--help` on leaf command

**Red**:
```ts
test('--help on leaf shows command help', async () => {
  const cli = Cli.create('tool')
  cli.command('greet', {
    description: 'Greet someone',
    args: z.object({ name: z.string().describe('Name') }),
    run: ({ args }) => ({ message: `hi ${args.name}` }),
  })

  const { output, exitCode } = await serve(cli, ['greet', '--help'])
  expect(exitCode).toBe(0)
  expect(output).toMatchInlineSnapshot(`
    "tool greet — Greet someone

    Usage: tool greet <name>

    Arguments:
      name  Name"
  `)
})
```

**Green**: When `--help` is in the rest tokens after command resolution, print command-level help instead of running the handler.

---

### Cycle 9: `--version`

**Red**:
```ts
test('--version outputs version string', async () => {
  const cli = Cli.create('tool', { version: '1.2.3' })
  cli.command('ping', { run: () => ({}) })

  const { output, exitCode } = await serve(cli, ['--version'])
  expect(exitCode).toBe(0)
  expect(output).toMatchInlineSnapshot(`"1.2.3"`)
})
```

**Green**: Extract `--version` in `extractBuiltinFlags`, print version and return early. Pass `version` to `serveImpl`.

---

### Cycle 10: `--help` takes precedence over `--version`

**Red**:
```ts
test('--help takes precedence over --version', async () => {
  const cli = Cli.create('tool', { version: '1.2.3' })
  cli.command('ping', { description: 'Ping', run: () => ({}) })

  const { output } = await serve(cli, ['--help', '--version'])
  expect(output).toMatchInlineSnapshot(`
    "tool

    Usage: tool <command>

    Commands:
      ping  Ping"
  `)
})
```

**Green**: Check `help` before `version` in `serveImpl`. Snapshot confirms usage text, no version string.

---

### Cycle 11: Verify all tests pass

- `pnpm test` — all pass
- `pnpm check:types` — no errors
- `pnpm check` — lint passes

---

## Files Changed

| File | Change |
|---|---|
| `Help.ts` | New — `formatRoot()`, `formatCommand()` |
| `Help.test.ts` | New — tests for help formatting |
| `Cli.ts` | Extract `--help`/`--version`, implicit help for router/group with no subcommand, wire Help module |
| `Cli.test.ts` | Tests for `--help`, `--version`, implicit help |
| `index.ts` | Export `Help` namespace |
