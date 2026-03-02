# incur

## 0.1.12

### Patch Changes

- a61c474: Added help output in human mode for root command with args when no args provided

## 0.1.11

### Patch Changes

- 77f5c98: Added deprecated option support via Zod's `.meta({ deprecated: true })`. Deprecated flags show `[deprecated]` in help output, `**Deprecated.**` in skill docs, `deprecated: true` in JSON Schema, and emit stderr warnings in TTY mode.

## 0.1.10

### Patch Changes

- e7564a0: Added `c.error()` to middleware context for structured error short-circuiting. Middleware can now return `c.error({ code, message })` instead of throwing, producing a proper error envelope with optional CTAs.

## 0.1.9

### Patch Changes

- 1a671e9: Added `name` to run and middleware context (`c.name`) — returns the CLI name passed to `Cli.create()`.

## 0.1.8

### Patch Changes

- eec5906: Added `c.env` to middleware context. CLI-level `env` schema defined on `Cli.create()` is now parsed before middleware runs and available as typed `c.env` in both `.use()` and per-command `middleware: [...]` handlers. This enables initializing shared dependencies (API clients, auth tokens) in middleware using validated environment variables instead of reading `process.env` directly.

## 0.1.7

### Patch Changes

- 2c60110: - Added middleware support via `cli.use()`.
  - Added typed dependency injection via `vars`: declare a Zod schema on `create()` (and optionally set defaults), set values with `c.set()` in middleware, read them via `c.var` in handlers.
- ba07f0b: Added per-command middleware via `middleware` property on command definitions. Added `middleware()` helper for creating strictly typed middleware handlers with `middleware<typeof cli.vars>(...)`. Added `cli.vars` property to expose the vars schema for use with `typeof`.

## 0.1.6

### Patch Changes

- 6642c48: Added `agent` boolean to the `run` context. `true` when stdout is not a TTY (piped/agent consumer), `false` when running in a terminal. Use it to tailor command behavior for agents vs humans.
- 6642c48: Added `outputPolicy` option to commands, groups, and root CLIs. Set `outputPolicy: 'agent-only'` to suppress data output in human/TTY mode while still returning structured data to agents. Defaults to `'all'`. Inherited from parent groups — children can override.

## 0.1.5

### Patch Changes

- b334523: Added automatic cleanup of stale skills when commands are removed or depth changes.
  Fixed broken symlinks not being removed on Node v24.

## 0.1.4

### Patch Changes

- 9bb41e3: Fixed `--depth=N` equals syntax not being parsed in `skills add`.
  Fixed `depth=0` producing a root SKILL.md without a subdirectory wrapper.

## 0.1.3

### Patch Changes

- 0e42bc0: Added native skill installation.

## 0.1.2

### Patch Changes

- dfd804c: Added ability for a root command to have both a `run` handler and subcommands. Subcommands take precedence — unmatched tokens fall back to the root handler. `--help` shows both root command usage and the subcommand list.

## 0.1.1

### Patch Changes

- 370d039: Fixed commands returning `undefined` being serialized as the literal string `"undefined"` in output. Void commands now produce no output in human and machine modes. MCP tool calls with undefined results now return valid JSON (`null`) instead of broken output.

## 0.1.0

### Minor Changes

- 09e4d76: Initial release.

## 0.0.2

### Patch Changes

- 9c7f8aa: Updated SKILL.md
- 3d38f2d: Added usage info at end of description frontmatter in skills.

## 0.0.1

### Patch Changes

- 1318c14: Initial release
