# incur

## 0.3.0

### Minor Changes

- 9add1a0: **Breaking:** Renamed `--llms` to `--llms-full`. Added a new `--llms` flag that outputs a compact command index (table of command signatures + descriptions) instead of the full manifest. This reduced token usage by ~95% for agents that already know the CLI and just need a quick reminder of available commands.

### Patch Changes

- a2610bc: Added `requires_bin` and fallback descriptions to generated skill frontmatter.
- dd7a1af: Fixed `--no-global` resolving `cwd` to the CLI's installation directory instead of `process.cwd()`.

## 0.2.2

### Patch Changes

- 9454412: Added `--token-count`, `--token-limit`, and `--token-offset` global options for token-aware output pagination. Uses LLM tokenization estimation (~96% accuracy via `tokenx`). In `--verbose` mode, truncated output includes `meta.nextOffset` for programmatic pagination.

## 0.2.1

### Patch Changes

- 6ab9a33: Added `--filter-output` global option to filter output by key paths with support for dot notation and array slicing.
- 2dc1b00: Added `--schema` global option to every command that returns its JSON Schema (args, env, options, output).
- c60e6b8: Exposed `format` and `formatExplicit` on run and middleware context.
- 0e52ec0: Added `cli.fetch` to expose CLI as a standard Fetch API handler
- f5b0133: Added optional exitCode to c.error() and IncurError, allowing CLI authors to control the process exit code. Defaults to 1 when omitted (backward compatible).

## 0.2.0

### Minor Changes

- 00b0b2d: Added Fetch API integration — mount any HTTP server as a CLI command.

  - **Fetch gateway**: `.command('api', { fetch: app.fetch })` translates argv into HTTP requests using curl-style flags (`-X`, `-d`, `-H`, `--key value` query params)
  - **Streaming**: NDJSON responses (`application/x-ndjson`) are streamed incrementally
  - **OpenAPI support**: `.command('api', { fetch, openapi: spec })` generates typed subcommands with args, options, and descriptions from an OpenAPI 3.x spec
  - Works with any framework exposing a Web Fetch API handler (Hono, Elysia, etc.)

## 0.1.17

### Patch Changes

- b73feaf: Added `aliases` option to `Cli.create` for registering alternative binary names. Shell completions and help output include all aliases.

## 0.1.16

### Patch Changes

- e3aa038: Added dynamic shell completions for bash, zsh, fish, and nushell. CLIs get a built-in `completions <shell>` command that outputs a hook script. The hook calls back into the binary at every tab press, so completions stay in sync with commands automatically. Supports subcommands, `--options`, short aliases, enum values, and space suppression for command groups.
- 06580f0: Added short-alias stacking (e.g. `-abc` parsed as `-a -b -c`). The last flag in a stack can consume a value; all preceding flags must be boolean.

## 0.1.15

### Patch Changes

- 5122c9b: Fixed help formatter using `process.env` instead of env source override for "set:" display

## 0.1.14

### Patch Changes

- 3f7ca73: Added leading `#` to CTA command descriptions for easier copy-paste.
- 3f7ca73: Moved environment variables section to bottom of help output.
- 3f7ca73: Fixed invalid subcommand in a group falling through to root handler instead of returning `COMMAND_NOT_FOUND`. Added CTA with copyable help command to `COMMAND_NOT_FOUND` errors.
- 50282a8: Added redacted current value indicator for environment variables in help output.
- 79fbabd: Fixed streaming handler ignoring CLI-level and command-level default `format`. Previously, `handleStreaming` used only `formatExplicit` to decide between incremental and buffered mode, causing CLI defaults like `{ format: 'json' }` to be ignored in favor of hardcoded `'toon'`.

## 0.1.13

### Patch Changes

- aa32795: Added `version` to the command run context (`c.version`).

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
