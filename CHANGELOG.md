# incur

## 0.11.0

### Minor Changes

- 4990409: **Breaking:** Unexpected positional arguments now fail with `Unexpected argument: <value>` before the command runs, instead of being silently dropped. This covers commands without `args`, callable group roots, and HTTP path segments past a command's args (which now respond with an `UNKNOWN` error). A final array argument still collects the remaining positionals.

  A `true` or `false` after a command's boolean flag (`--dry-run false`) is now the flag's value when no positional slot is left for it, instead of being ignored with the flag set to `true`. When the command still has a positional slot, the token fills it as before; `--flag=false` and `--no-flag` are unambiguous. Global boolean flags do not read a spaced value, so `--global-flag true` after a command now fails as an unexpected argument.

  Added `--` to end command option parsing: every following token is positional, even when it looks like a flag. Built-in flags such as `--json` are still read anywhere in argv.

- 9ef6992: Added MCP Apps: `cli.app()` serves an HTML view at a `ui://` URI, and a command's `mcp.app` links its tool to it so supporting hosts render its results there.
- 061606a: Added MCP 2026-07-28 support to `--mcp` and `/mcp`: `server/discover`, per-request `_meta` protocol versions, and the standard request headers, served next to the 2025 `initialize` handshake. Upgraded `@modelcontextprotocol/server` to 2.4.0.
- 86084eb: Added MCP elicitation: `c.elicit()` asks the MCP client's user for form input and `c.elicit.url()` sends them to a URL, through 2026-07-28 `input_required` results.

  Added an `io` option to `Schema.toJsonSchema()` that describes what a schema accepts instead of what parsing returns.

- 2ae2108: Added MCP resources, resource templates, prompts, and argument completion: `cli.resource()`, `cli.resourceTemplate()`, and `cli.prompt()`.
- 17d3afb: Added MCP tool metadata: command `mcp.title`, `mcp.icons`, and `mcp.headers` (`x-mcp-header` declarations that 2026-07-28 HTTP clients mirror into validated `Mcp-Param-*` headers), and server `mcp.cache` hints for `tools/list` and `server/discover`.
- 318ee0c: Fixed `--mcp` tool calls ignoring the global options passed to the server and the config file. Globals such as `my-cli --mcp --profile prod` and each command's config section (honoring `--config <path>` and `--no-config`) now apply to tool calls that do not pass their own values, and show as defaults in the tool input schemas. An invalid server global or config file stops the server at startup. Added the `defaults` option to `Mcp.serve`.
- 4cb6655: Added declarative CLIs with `parse()` to the Python and Zig ports, matching the Rust `Parser` derive: declare commands as types and groups as unions, then call `parse()` for the typed command or serve a handler for incur-formatted output, `--mcp`, and HTTP.
- a3613ef: `sync.command` now also applies to Markdown `--llms` and `--llms-full` output (title, command signatures, examples, and the footer) and to the skill files `cli.fetch` serves at `/.well-known/agent-skills/` and `/.well-known/skills/`.
- f82f39f: Added `sync.command`, which sets the command that generated `SKILL.md` files show in place of the CLI name, such as `bunx @scope/my-cli` (like `mcp.command` for `mcp add`). The command appears in headings, examples, the `command` frontmatter, and "Run `… --help`" descriptions. `requires_bin` becomes its first word, for example `bunx`. Skill names and install directories still derive from the CLI name.

### Patch Changes

- b31208a: Fixed the Bash completion hook on Bash 3.2 (macOS `/bin/bash`): it registers without `-o nosort` when Bash rejects that option, and no longer leaves a `\001` marker on group candidates.
- 33d311d: Fixed shell completion of options to include the built-in global flags that the command's help lists, such as `--format`, `--help`, and `--token-limit`.
- 133e889: Fixed shell completion inside a built-in group such as `mcp` or `skills`: it suggests only the group's subcommands, not root commands.
- 74340b4: Fixed registered commands and aliases named `completions`, `mcp`, `skills`, or `skill` being shadowed by the built-in of the same name: the registered command now runs. Root command positionals still yield to built-ins.
- 7b8564e: Fixed `Filter.parse` looping forever on an unclosed `[` (e.g. `--filter-output 'a['`). It now throws a `ParseError`, and `--filter-output` reports it before the command runs.
- 51e5996: Listed `--json` under Global Options in root and command help. Every command accepts it as a shorthand for `--format json`, but help did not mention it.
- 1f76305: Fixed root help listing a built-in under `Integrations:` when a registered command or alias of the same name shadows it, and dropped the section when every built-in is hidden. Added `hideBuiltins` to `Help.formatRoot` and `Help.formatCommand` options.
- 2356cb6: Fixed `mcp add` registering Amp: `--no-global` now writes `.amp/settings.json` in the working directory instead of the global settings, invalid Amp settings fail before any agent is configured instead of reporting success, an existing entry keeps its other fields such as `env` and `disabled`, and `--json` or `--format` prints only the result.
- 98cf9a6: Fixed `mcp add` so a missing, blank, or option-shaped value for `--agent`, `--command`, or `-c` fails with `Missing value for flag` instead of being ignored or swallowing the next flag. These options now also accept `--flag=value`.
- fa384d5: Matched the TypeScript reference in the Rust, Python, and Zig ports for OpenAPI and MCP-source options whose JSON Schema `type` lists several non-null types, such as `['string', 'array']`. Rust now validates the option as a union instead of reading it as its first non-null type, and coerces it to a number or boolean when any listed type is one. Python's help now shows `<value>` instead of `<union>`. Python and Zig now report a missing required option of this kind as an `invalid_union`, and Python reports the issues of the one listed type that failed only bounds or format checks, as Zod does.

  A type list with a `default`, such as `{ type: ['string', 'integer'], default: 'auto' }`, now stays uncoerced in Rust and Python, as `coerceIfNeeded` skips defaulted members. When an optional option of this kind is omitted, every port now applies its default.

- ae8da74: Rendered Markdown arrays that nest objects or arrays outside tables as compact JSON instead of `[object Object]`. Arrays of scalars still render comma-separated.
- da075aa: Rendered nested objects and arrays in Markdown table cells as compact JSON, with pipes escaped, instead of `[object Object]`.
- 925464d: Treated `T | null` union options, such as `z.fromJSONSchema` makes of OpenAPI 3.1 and MCP `type: ['array', 'null']`, as their inner type when parsing argv and environment variables and in help. Repeated flags of a nullable array option now collect into an array instead of failing validation.
- fd83167: Fixed two cases in OpenAPI-generated body options. A `true` alternative in `anyOf`/`oneOf` now leaves the other variants' fields optional, and a defaulted field that an `allOf` member refines keeps its default.
- 2937c32: Fixed OpenAPI-generated commands dropping request bodies composed with `anyOf`, `oneOf`, or `allOf`. Their object fields now become options. A field is required only when every union variant requires it, and a field whose schema differs between members accepts any value for the server to validate.
- 0a128c5: Fixed `skills add` with `--json` or `--format` printing progress and the human summary before the result. It now prints only the formatted result, as `mcp add` does.
- d03ee25: Fixed `sync.cwd` doing two jobs. It now only sets where `include` globs resolve, and `skills add` and `skills list` both default it to the CLI's package root. `skills add --no-global` always installs into the working directory, so `cwd: import.meta.dirname` no longer puts project skills inside the CLI's own package. `SyncSkills.sync()` and `SyncSkills.list()` take a new `root` option for the glob directory; their `cwd` option keeps working as before.
- 7daae4a: Fixed same-named CLIs in different projects overwriting each other's skills metadata, which caused false "Skills are out of date" notices. `skills add --no-global` now records its metadata per project, in `<XDG_DATA_HOME>/incur/projects/<hash of the project directory>/<name>.json`. Global installs keep using `<XDG_DATA_HOME>/incur/<name>.json`. The staleness check prefers skills installed in the current project and suggests `skills add --no-global` when those are out of date. `skills list` reports skills installed globally or in the project. `SyncSkills.readHash()` and `SyncSkills.hasInstalledSkills()` take `global: false` to read a project's metadata.
- 6958e59: Fixed `--token-limit` and `--token-offset` windows: negative values are now rejected with an error before the command runs, and an offset past the end of the output no longer prints a reversed range in the truncation footer (e.g. `showing tokens 100000–13 of 13` is now `13–13 of 13`).
- 0d3dc99: Fixed required `vars` throwing a `ZodError` before middleware could set them. Each run now starts with only the defaults of the `vars` schema, for commands and fetch gateways alike.
- 48f2c32: Fixed `mcp add` and `--update` failing on Windows with `spawn npx ENOENT` or `spawn npm ENOENT`. Package-manager commands installed as `.cmd` scripts (`npm`, `npx`, `pnpm`, `pnpx`) now run through `cmd.exe` with each argument quoted so it reaches the script intact.
- 4ce13db: Coerced option and environment variable strings to numbers for Zod number formats such as `z.int()`, `z.uint32()`, and `z.float64()`, as for `z.number()`.

## 0.10.0

### Minor Changes

- 3612441: Added `#[derive(Parser)]` to the Rust port: declare a CLI as a struct or an enum of commands and groups, then call `MyCli::parse()` for the typed command or `MyCli::serve(handler)` for incur-formatted output, `--mcp`, and HTTP. Rust handlers now return any `Serialize` value, `incur::Result<T>` aliases results, and `tokio` became a default feature with a std-only executor when disabled. A Rust handler returning `Result<T, E>` where `E` is itself `Serialize` now needs `Result<T, incur::Error>`.

## 0.9.0

### Minor Changes

- d8e9f88: Updated `cli.fetch` to serve the [Agent Skills discovery](https://github.com/cloudflare/agent-skills-discovery-rfc) v0.2.0 index at `/.well-known/agent-skills/index.json`, listing each skill's `SKILL.md` URL and `sha256:` digest, with skills at `/.well-known/agent-skills/{name}/SKILL.md`. The v0.1.0 index at `/.well-known/skills/index.json` stays for older clients. Added `Skill.discovery({ origin, skills })`, which builds the same index with WebCrypto so other servers, including Cloudflare Workers, can publish it.

## 0.8.0

### Minor Changes

- 737644e: Added `globals` support to MCP tools and the generated OpenAPI document. Global options are now merged into every MCP tool's input schema (stdio `--mcp` and HTTP `/mcp`) and into each OpenAPI operation's query parameters or request body. MCP tool calls split them back out, apply the globals schema's defaults and validation once, and pass them to commands and middleware as `globals`. `Mcp.serve` accepts a `globals` schema for CLIs that serve their command map directly, and types `c.globals` in its middlewares from it. A global wins over a command option of the same name, as on the CLI.
- ebe96c7: Added `openapiConfig.versions`. Set it to `'latest'` to generate each path-versioned operation (`/v1/users`, `/v2/users`) from its highest version and name namespace commands without the version segment.
- 67a09c6: Added `cta` to `IncurError` and `hint` to `c.error()`. A thrown `IncurError` now renders exactly like a returned `c.error()` with the same fields, in every output format, streaming, `cli.fetch`, and MCP, instead of dropping its `cta` and `hint`. A `hint` appears as `error.hint` in structured output (and in the generated OpenAPI error schema) and as a `Hint:` line after the message in human and MCP text. Streaming commands also render the `cta` of a yielded or returned `c.error()`.

  ```ts
  throw new Errors.IncurError({
    code: "NOT_AUTHENTICATED",
    message: "GitHub token not found",
    hint: "Tokens expire after 30 days.",
    cta: { commands: ["auth login"] },
  });
  ```

  Added `_meta.error` to MCP tool error results, carrying the error's `code`, `retryable`, and `exitCode` so clients can branch on them without parsing the text.

  Fixed MCP tool calls of streaming commands reporting a yielded or returned `c.error()` as a successful chunk array. They now return a tool error, and the `cta` of a returned `c.ok()` is appended like it is for non-streaming commands.

### Patch Changes

- be33f71: Fixed agent output for commands that return an array (or other non-plain object) alongside a CTA, including framework notices such as the stale skills CTA. The data is now wrapped as `{ data, cta }`, matching scalar outputs, instead of being spread into index keys (`{ "0": ..., "1": ..., cta }`). Plain object outputs are unchanged.
- 2b99cdc: Fixed shell completions reading the values of global and built-in flags as command words. `cli --network testnet com<TAB>` now completes `completions`, `cli --network testnet skills <TAB>` suggests the `skills` subcommands, and `cli --format json <TAB>` includes the built-in commands. A partial value at the cursor (e.g. `cli --format j<TAB>`) no longer writes an error into the completion output.
- e0c4a1a: Fixed CTA prefixing for multi-word CLI names (e.g. `Cli.create('tempo request')`): CTA commands that start with the program name (e.g. `tempo wallet login`) are now kept as full command lines instead of being rendered as `tempo request tempo wallet login`. String CTAs now follow the same rule as object CTAs, so a string CTA that already starts with the CLI name is no longer prefixed twice.
- f9cf9c6: Fixed global options being read out of command option values. Globals are now parsed with the resolved command's option arity, so in `cli send -d --network=testnet` the token `--network=testnet` is the value of `-d` instead of setting the global `--network`. Stacked short flags can mix global and command aliases (e.g. `-sn testnet`). Global option errors are now reported like command option errors: an invalid value reports `VALIDATION_ERROR` with `fieldErrors` instead of `UNKNOWN`, and errors respect `--format`/`--json`.
- 8ec8334: Fixed command groups created with `Cli.create()` not being able to opt out of MCP. `Cli.create(name, { mcp: false })` now hides the mounted group's root command and all of its subcommands, including nested groups, from MCP tools, matching per-command `mcp: false`. The commands remain available through the CLI and HTTP routes.
- d441840: Changed remote MCP command groups to connect on first use, so invocations that never reach the group skip the MCP handshake.
- d441840: Changed OpenAPI-generated commands to build their Zod schemas on first read, and removed the document clone before dereferencing.
- 4932611: Fixed the default `mcp add` command for CLI names that are not npm package names (e.g. `Cli.create('tempo wallet')`). The registered command no longer runs the name as a package (e.g. `npx tempo wallet --mcp`), and runs the installed binary (`tempo wallet --mcp`) unless `package` is set.
- 702b2f5: Fixed MCP servers (`--mcp` and `/mcp`) for CLIs that expose no tools, such as a CLI with only a root command: the `tools` capability is now always advertised and `tools/list` returns an empty list instead of a `-32601` (method not found) error that was written before the `initialize` response.
- ebe96c7: Fixed fetch gateway paths starting with `/`. A root fetch gateway no longer rejects `/v1/orgs` as a typo of an `orgs` command, and a leading `/` no longer turns the path into a protocol-relative URL.
- cce80f5: Fixed the stale-skills CTA for CLI names that are not npm package names (e.g. `Cli.create('tempo wallet')`). Under a package manager, the CTA no longer suggests running the name as a package (e.g. `pnpx tempo wallet skills add`), and suggests the installed binary (`tempo wallet skills add`) unless `package` is set.
- 7e6b917: Fixed TOON, YAML, and Markdown output diverging from JSON output. Command data is now normalized the same way as JSON before rendering, so `undefined` object values are omitted instead of rendered as `null` (or `undefined` in Markdown), BigInt values are rendered as strings instead of numbers, and `Date` values are rendered as ISO strings.
- fd03ea8: Fixed `update: false` to also disable the built-in `--update` flag. Root help no longer lists `--update`, and `--update` is parsed like any other flag: it is rejected as unknown unless a command option or global option named `update` is declared.
- 991579d: Allowed custom global options named `verbose`, which was still reserved after the built-in `--verbose` flag was renamed to `--full-output`. A global named `fullOutput` now throws at `Cli.create()` time instead, since `--full-output` is consumed by the built-in flag.

## 0.7.1

### Patch Changes

- 0bc1fe7: Fixed `--mcp` in bundled and compiled CLIs (e.g. `bun build --compile`, esbuild) by loading `@modelcontextprotocol/server/stdio` through a literal dynamic import that bundlers can include.

## 0.7.0

### Minor Changes

- a806d03: Added `openapiConfig.include` to generate commands for only the operations it matches, and `openapiConfig.groups` to describe generated command groups.

  ```ts
  Cli.create("my-cli").command("api", {
    fetch: app.fetch,
    openapi: spec,
    openapiConfig: {
      groups: { users: "Manage users" },
      include: (o) => o.path.startsWith("/users"),
      mode: "namespace",
    },
  });
  ```

## 0.6.1

### Patch Changes

- e95e4eb: Surfaced `error.code` and `error.message` from nested `{ error: { code, message } }` response bodies in OpenAPI-generated commands and the fetch gateway, instead of falling back to `HTTP <status>`.
- f617e17: Require a patched TOON version to prevent prototype pollution when decoding untrusted input.

## 0.6.0

### Minor Changes

- dcfec03: Added support for disabling generated skills, including their commands, help, completions, and stale-skill notices, with `sync: false`.

### Patch Changes

- afbb49a: Generate MCP and stale-skill commands from an explicit trusted package. Never reuse dependency specifiers from the invoking project's manifest.

## 0.5.1

### Patch Changes

- 00767da: Changed zero-argument `cli.fs()` to infer commands from sibling files and folders beside the entrypoint.

  ```ts
  import { Cli } from "incur";

  await Cli.create("my-cli").fs().serve();
  ```

## 0.5.0

### Minor Changes

- f28d63f: Added filesystem command routing through `Cli.command()` and `cli.fs()`.

  ```ts
  await Cli.create("my-cli").fs().serve();
  ```

  [Read more](https://github.com/wevm/incur#file-based-commands).

## 0.4.26

### Patch Changes

- 0b4df91: Added GitHub action tag.

## 0.4.25

### Patch Changes

- 8e9dd67: Appended standalone binary assets to the latest matching GitHub release, including Changesets workspace releases.

## 0.4.24

### Patch Changes

- 6ff275f: Published completed standalone binary releases by default and added a `publish` input for draft-first workflows.

## 0.4.23

### Patch Changes

- 32c2fdf: Fixed Alpine smoke tests for Bun musl binaries.

## 0.4.22

### Patch Changes

- 5b5103d: Made the binary release action create missing drafts and upload to existing published releases.

## 0.4.21

### Patch Changes

- 452578e: Added cross-platform binary distribution, and update notices

  ```ts
  import { Binary, Cli } from "incur";

  const cli = Cli.create("my-cli", {
    update: Binary.github({ repository: "example/my-cli" }),
  });
  ```

- 630815a: Added `sync.body`, printed verbatim after the synced skills, for setup `skills add` cannot perform itself.

  ```ts
  const cli = Cli.create("my-cli", {
    sync: {
      body: "Authorize the app at https://github.com/apps/my-cli/installations/new",
    },
  });
  ```

## 0.4.20

### Patch Changes

- dfb9498: Fixed `skills add` deleting the skill it had just installed, and replacing it with a self-referential symlink, when an agent's skills directory is a symlink to the canonical one.

## 0.4.19

### Patch Changes

- 6c6bc6c: Added configurable MCP server names and titles.

  ```ts
  Cli.create("tapimo", { mcp: { name: "tempo", title: "Tempo MCP" } });
  ```

## 0.4.18

### Patch Changes

- 1cc5c95: Prevented completed MCP JSON responses from retaining transport stream state.
- 9f11871: Isolated stateless MCP requests, preventing cross-client response collisions and retained aborted requests.

## 0.4.17

### Patch Changes

- 5b9647a: Delivered CTA suggestions in MCP tool result and error text, keeping `_meta.cta` for structured consumers.
- eacc238: Added variadic positional arguments: a final `z.array(...)` args key collects all remaining positionals.

  ```ts
  Cli.create("my-cli").command("lint", {
    args: z.object({ paths: z.array(z.string()).describe("Files to lint") }),
    run: (c) => ({ count: c.args.paths.length }),
  });
  ```

## 0.4.16

### Patch Changes

- 8da2cfc: Fixed parsed global options missing from command handler contexts.

## 0.4.15

### Patch Changes

- e6f51cd: Changed MCP servers to expose progressive tool discovery by default.

## 0.4.14

### Patch Changes

- 539d0ac: Added `compact` and `security` OpenAPI config options for trimming generated command schemas and skipping credential option injection.
- 4c0fc4b: Included OpenAPI operation descriptions in MCP tool descriptions by concatenating summary and description; CLI help keeps the short summary.

## 0.4.13

### Patch Changes

- 20a6f42: Added MCP tool filtering via `mcp: false` on commands and root-level `mcp.tools` include/exclude patterns.
- 3fecb7c: Added remote MCP servers as command sources via `cli.command(name, { mcp })`.
- 11b7406: Added `context.request` for HTTP and MCP invocations and `openapiConfig.forwardHeaders` for propagating caller headers to upstream APIs.

## 0.4.12

### Patch Changes

- c37c5f7: Respect explicit output formats when stdout is a TTY so `--format` and `--json` output remains machine-readable.

## 0.4.11

### Patch Changes

- 4de8518: Fixed `--mcp` stdio transport loading against `@modelcontextprotocol/server` prereleases that export it from `./stdio`.

## 0.4.10

### Patch Changes

- a94480c: Added `mcp doctor` command that smoke-tests MCP initialization and tool listing without calling tools.
- f069769: Added MCP tool name and description metadata overrides for commands, including duplicate exposed-name validation.
- 309d566: Added support for non-object MCP output schemas by omitting them from tool registration while preserving JSON text output.

## 0.4.9

### Patch Changes

- 0720a24: Added custom global options support via `globals` and `globalAlias` on `Cli.create()`.
- 7e94269: Added destructive command hints to generated skill files.
- a14e41d: Fixed BigInt serialization across JSON, JSONL, MCP, and fetch output paths.
- cb05897: Fixed MCP registration command detection for global, local, and source-launched CLIs.
- 15c9068: Defaulted MCP-over-HTTP to stateless transport behavior and returned `405` for unsupported stateless methods.
- 1c52be9: Lazy-loaded YAML and MCP SDK imports outside plain command runs.
- dc0faff: Added typed MCP command metadata for `instructions` and `annotations`.
- 1cbe459: Fixed HTTP and MCP command input validation to return standard validation field errors for object-shaped inputs.
- 43c1551: Added `banner` option to `Cli.create` for displaying custom content above root help output with sync/async functions, error swallowing, and `mode` targeting.
- a0f469f: Fixed streaming command terminal records so HTTP NDJSON responses preserved returned `c.ok()` CTA metadata, represented returned or yielded `c.error()` values as terminal errors, included terminal duration metadata, unwound generators on response cancellation, and preserved `IncurError.retryable` metadata in streaming machine-format errors.
- 9a43129: Surfaced `c.ok(..., { cta })` metadata on MCP tool responses under `_meta.cta`.
- a0f469f: Fixed generated and synced skills to use the same command projection as CLI skill output, avoided duplicate skills for command aliases, preserved output schemas and examples consistently, and included the fetch gateway skill hint for fetch-based commands.
- bffbdf4: Typed the root command `hint` option on `Cli.create`.

## 0.4.8

### Patch Changes

- 935e6f7: Generated OpenAPI commands accepted header parameters and header security schemes as CLI options.

## 0.4.7

### Patch Changes

- 01b5c91: Added `openapiConfig.mode` for choosing operation id or namespace command generation.
- bfc05ac: Added hosted OpenAPI command generation from `Fetch.fromRequest` sources.

## 0.4.6

### Patch Changes

- ed18ddc: Added support for automatic OpenAPI v3.2.0 schema generation

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
