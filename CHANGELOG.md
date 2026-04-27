# incur

## 0.4.5

### Patch Changes

- 85e98bc: Fixed `--json` to emit parsed JSON objects and arrays instead of double-encoding top-level JSON strings.
- 3124fe7: Clarified TTY validation output for missing options and environment variables.

## 0.4.4

### Patch Changes

- 9875d59: Fixed skill frontmatter generation and parsing so descriptions containing YAML-sensitive text like `key: value` were quoted and read correctly.

## 0.4.3

### Patch Changes

- 01c675f: Added `ls` alias for `skills list`.

## 0.4.2

### Patch Changes

- a6c584d: Fixed stale skills warnings to only appear when synced skill files were still installed on disk, and updated `skills list` to reflect actual install state instead of stale metadata.

## 0.4.1

### Minor Changes

- 1e58e47: **Breaking:** Renamed the global full-envelope flag from `--verbose` to `--full-output`, allowing `--verbose` to be used as a normal command option.

## 0.3.25

### Patch Changes

- abfa8c7: Fixed Root CLIs created with `Cli.create` and `aliases` not registering those aliases as command aliases when mounted via `cli.command()`.

## 0.3.24

### Patch Changes

- 250e65f: Added command-level `aliases` option for subcommands (e.g. `aliases: ['extensions', 'ext']` on an `extension` command).
- 26d7bf8: Fixed root fetch/command fallback bypassing "Did you mean?" suggestions when the input is a typo of a known command.

## 0.3.23

### Patch Changes

- 572c172: Replaced `@readme/openapi-parser` with a vendored `dereference` implementation, removing a heavy dependency tree.

## 0.3.22

### Patch Changes

- bfc3337: Replaced `@modelcontextprotocol/sdk` with `@modelcontextprotocol/server` (v2), reducing dependency count by 74 packages.

## 0.3.21

### Patch Changes

- d091bf7: Fixed stale `skills add` CTA commands to use the invoked CLI name when running installed binaries directly, instead of falling back to `npx`.

## 0.3.20

### Patch Changes

- ede37be: Fixed help output for boolean options so flags no longer showed `<boolean>` placeholders or redundant `(default: false)` text, including aliased flags.
- 96dfee4: Exported shell completion environment variables in bash and zsh hooks.

## 0.3.19

### Patch Changes

- 5c76b51: Fixed `skills add` to list synced skills in alphabetical order.

## 0.3.18

### Patch Changes

- a65c865: Used command description as fallback in skill frontmatter for root commands and single-command groups.

## 0.3.17

### Patch Changes

- dad62c9: Fixed `skills list` not including root command skill.

## 0.3.16

### Patch Changes

- de70444: Added `engines` field requiring Node.js >=22.
- 3462433: Fixed `z.bigint()`, `z.coerce.bigint()`, `z.date()`, and `z.coerce.date()` schemas failing during skill sync by representing them as `{ type: "string" }` in JSON Schema output.

## 0.3.15

### Patch Changes

- abd80e7: Fixed missing value errors for flags in `Fetch.parseArgv`, short secret leaking in `redact()`, silent `jsonl` fallthrough in `Formatter.format`, invalid `--format`/`--token-limit`/`--token-offset` values, lost descriptions when coercing OpenAPI param schemas, and hardcoded `process.env` in `Help.ts` for Deno compatibility.
- 7dd398b: Added `skills list` subcommand that shows all skills a CLI defines with install status.

## 0.3.14

### Patch Changes

- 71a787a: Fixed root commands defined on `Cli.create()` not being included in skill generation (`--llms`, `skills add`, `.well-known/skills/`).

## 0.3.13

### Patch Changes

- 0e0549f: Added `displayName` to the root `Cli.create(..., { run })` context type.

## 0.3.12

### Patch Changes

- b8370ac: Added `displayName` to the run and middleware context. Resolves the actual binary name from `process.argv[1]` so user-facing messages reflect the alias used to invoke the CLI.

## 0.3.11

### Patch Changes

- 7833e33: Updated command suggestion ranking to use tiered scoring (prefix → contains → fuzzy) so match type outranks raw edit distance.

## 0.3.10

### Patch Changes

- d1404b8: Fixed optional properties being typed as required in typegen output.

## 0.3.9

### Patch Changes

- 8ee1af4: Fixed skill display names to use canonical slug from SKILL.md frontmatter instead of reconstructing from CLI name and subcommand.

## 0.3.8

### Patch Changes

- 69a48ce: Tweaked "Did you mean" output.

## 0.3.7

### Patch Changes

- 2f8194b: Added "Did you mean?" suggestions for mistyped commands using Levenshtein distance. Includes builtin commands (`mcp`, `skills`, `completions`) in suggestion candidates. Suggestion CTA preserves original args/flags. Moved skills staleness warning from stderr into the CTA system.

## 0.3.6

### Patch Changes

- 9b2ab98: Updated help output

## 0.3.5

### Patch Changes

- 8952a65: Fixed built-in commands (`skills`, `mcp`) showing root command errors when invoked without subcommand. Bare `skills`/`mcp` and `--help` now show their own help with available subcommands. Added built-in commands to shell completions. Fixed skill name sanitization for CLI names containing dots.
- 05d89f3: Fixed `resolvePackageRoot` failing with `ENOENT` when running from a Bun compiled binary.
- 64295d2: Added unified command execution across CLI, HTTP, and MCP transports.

## 0.3.4

### Patch Changes

- 83aa331: Tweaked help and CTA outputs.

## 0.3.3

### Patch Changes

- 8adbfbc: Tweaked help output

## 0.3.2

### Patch Changes

- d2ef65b: Added enum and union-of-literal values in help text instead of generic `<value>` placeholder.

## 0.3.1

### Patch Changes

- 1f5a2df: Added support for count options via `.meta({ count: true })` on `z.number().default(0)` schemas. Count flags behave like booleans (no value consumed), but increment on each occurrence, supporting both repeated flags (`--verbose --verbose`) and stacked aliases (`-vvv`).

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
