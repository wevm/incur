# clac — Implementation Plan

Phased TDD approach. Each phase is a vertical slice — one test → one implementation → repeat. Every phase produces a working (if minimal) system. No horizontal slicing (all tests first, then all code).

Reference: [tasks/prd.md](./prd.md)

---

## Phase 1: Tracer Bullet — Minimal CLI

**Goal:** Prove the full path works: `Cli.create()` → `.command()` → `.serve()` → parse argv → run handler → output YAML envelope on stdout.

**Setup:**
- [ ] Clean up scaffolded `Foo.ts` / `Foo.test.ts`
- [ ] Add `zod` dependency
- [ ] Add `@toon-format/toon` dependency (for TOON serialization)
- [ ] Add `yaml` dependency (for YAML format option)
- [ ] Set up `src/index.ts` with namespace re-exports

**TDD cycles (Cli.test.ts):**
1. `Cli.create('test')` returns a cli instance with name
2. `Cli.create('test', { version: '1.0.0', description: '...' })` accepts options as second arg
3. `cli.command('hello', { ... })` registers a command
4. `cli.serve(['hello'])` routes to the correct command handler
5. Handler receives parsed `args` and `options` from Zod schemas
6. Output is wrapped in `{ ok: true, data, meta }` envelope
7. Output is serialized as TOON to stdout (default format)
8. Non-zero exit + error envelope when command not found

**Behaviors to test through public interface:**
```ts
const cli = Cli.create('test', { version: '0.1.0', description: 'Test CLI' })
cli.command('greet', {
  args: z.object({ name: z.string() }),
  output: z.object({ message: z.string() }),
  run: ({ args }) => ({ message: `hello ${args.name}` }),
})
// assert stdout is YAML envelope with { ok: true, data: { message: 'hello world' } }
```

**Files created:** `Cli.ts`, `Cli.test.ts`, `index.ts`

---

## Phase 2: Parser — Full Argument Parsing

**Goal:** Robust argv parsing driven by Zod schemas. Pure module, no CLI coupling.

**TDD cycles (Parser.test.ts):**
1. Parses positional args in schema key order
2. Parses `--flag value` named options
3. Parses `--flag=value` syntax
4. Parses `-f value` short aliases (given alias map)
5. Parses boolean flags (`--verbose` → true, `--no-color` → false)
6. Parses array options (`--label bug --label feature`)
7. Coerces string → number for numeric Zod schemas
8. Coerces string → boolean for boolean Zod schemas
9. Applies Zod `.default()` values for missing options
10. Treats `.optional()` fields as not required
11. Throws `Clac.ParseError` on unknown flags
12. Throws `Clac.ValidationError` on missing required args
13. Throws `Clac.ValidationError` on Zod validation failure (enum mismatch, etc.)
14. Returns `{ args, options }` matching inferred Zod types

**Files created:** `Parser.ts`, `Parser.test.ts`

**Wire in:** Update `Cli.ts` to use `Parser.parse()` instead of inline parsing from Phase 1.

---

## Phase 3: Type Inference — Zod Schema Narrowing

**Goal:** Narrow all types wherever Zod schemas flow. `run({ args, options })` infers from `args`/`options` schemas. `Parser.parse()` return type narrows from input schemas. `alias` keys constrain to option schema keys.

**TDD cycles (Cli.test-d.ts — type tests):**
1. `args` in `run()` callback infers correct types from Zod `args` schema
2. `options` in `run()` callback infers correct types from Zod `options` schema
3. `run` return type is checked against `output` schema when provided
4. `alias` keys are constrained to keys of `options` schema
5. `next` callback receives correctly typed result (based on `output` or `run` return)
6. Without `args`/`options` schemas, `run` callback receives `{}`
7. Zod `.default()` and `.optional()` are reflected in inferred types

**TDD cycles (Parser.test-d.ts — type tests):**
8. `Parser.parse()` return type narrows `args` to `z.output<argsSchema>`
9. `Parser.parse()` return type narrows `options` to `z.output<optionsSchema>`
10. Without schemas, returns `{ args: {}; options: {} }`

**Implementation:**
- Add `const` generic parameters to `CommandDefinition`: `<const args, const options, const output>`
- Make `Cli.command()` generic, flowing schemas through to `run`, `next`, and `alias`
- Make `Parser.parse()` generic, returning narrowed `{ args: z.output<A>; options: z.output<O> }`
- Use `z.output<>` (not `z.infer<>`) for post-transform types

**Files created:** `Cli.test-d.ts`, `Parser.test-d.ts`
**Files modified:** `Cli.ts`, `Parser.ts`

---

## Phase 4: Errors — Structured Error Handling

**Goal:** Error classes + auto-wrapping of thrown errors into the error envelope.

**TDD cycles (Errors.test.ts):**
1. `BaseError` extends `Error`, sets `override name`
2. `ClacError` accepts `{ code, message, hint, retryable }`, sets `name = 'Clac.ClacError'`
3. `ValidationError` accepts `{ message, fieldErrors }`, sets `name = 'Clac.ValidationError'`
4. `ParseError` for arg parsing failures, sets `name = 'Clac.ParseError'`
5. `fieldErrors` has shape `Array<{ path, expected, received, message }>`

**TDD cycles (Cli.test.ts — error wrapping):**
6. `ClacError` thrown in `run()` → error envelope with code/hint/retryable on stdout
7. Plain `Error` thrown in `run()` → error envelope with code `'UNKNOWN'`
8. Zod validation failure during parsing → error envelope with `fieldErrors`
9. Exit code is 1 for errors

**Files created:** `Errors.ts`, `Errors.test.ts`

---

## Phase 5: Formatter — Output Formats

**Goal:** Support `--format toon|json|jsonl|yaml|md`, `--json` shorthand. stdout/stderr discipline.

**TDD cycles (Formatter.test.ts):**
1. `format(envelope, 'toon')` → valid TOON string with `ok`, `data`, `meta`
2. `format(envelope, 'json')` → valid JSON string, parseable via `JSON.parse()`
3. `format(envelope, 'yaml')` → valid YAML string
4. `format(envelope, 'md')` → Markdown with tables
5. `format(errorEnvelope, 'toon')` → error envelope with `ok: false`, `error` block
6. `format(errorEnvelope, 'json')` → JSON error envelope
7. `schemaVersion` is included in all formats
8. `meta.duration` is included (string, e.g. `'340ms'`)

**TDD cycles (Cli.test.ts — format flag):**
9. `cli.serve(['greet', 'world', '--format', 'json'])` → JSON on stdout
10. `cli.serve(['greet', 'world', '--json'])` → same as `--format json`
11. Default format is TOON (no flag needed)
12. Logs/warnings go to stderr, never stdout in any format

**Files created:** `Formatter.ts`, `Formatter.test.ts`

---

## Phase 6: Subcommands — Group Composition

**Goal:** `Cli.command('name')` without `run` acts as a group. Composable subcommand trees mounted via `cli.command(sub)`.

**TDD cycles (Cli.test.ts — subcommands):**
1. `Cli.command('pr', { description: '...' })` without `run` returns a command that accepts sub-commands
2. `pr.command('list', { ... })` registers a sub-command
3. `cli.command(pr)` mounts the sub-command tree — `cli.serve(['pr', 'list'])` routes correctly
4. Nested: command within command → `cli.serve(['pr', 'review', 'approve'])` works
5. Sub-commands defined in separate modules can be imported and mounted
6. Unknown subcommand → error envelope suggesting valid subcommands
7. Running `cli.serve(['pr'])` with no subcommand → help-like error listing available subcommands

---

## Phase 7: Schema — JSON Schema Generation

**Goal:** Convert Zod schemas to JSON Schema. Power the `--llms` manifest.

**TDD cycles (Schema.test.ts):**
1. `z.string()` → `{ type: 'string' }`
2. `z.number()` → `{ type: 'number' }`
3. `z.boolean()` → `{ type: 'boolean' }`
4. `z.enum(['a', 'b'])` → `{ type: 'string', enum: ['a', 'b'] }`
5. `z.array(z.string())` → `{ type: 'array', items: { type: 'string' } }`
6. `z.object({ ... })` → `{ type: 'object', properties: { ... }, required: [...] }`
7. `.optional()` removes from `required`
8. `.default(val)` adds `default` to schema
9. `.describe('...')` adds `description` to schema

**TDD cycles (Cli.test.ts — --llms):**
10. `cli.serve(['--llms'])` → YAML manifest with all commands (default format)
11. Manifest includes `schema.input` and `schema.output` per command
12. Manifest includes `annotations` per command
13. Manifest includes `version: 'clac.v1'`
14. Nested group commands appear with full path (e.g. `pr list`)

**Files created:** `Schema.ts`, `Schema.test.ts`

**Note:** Consider using `zod-to-json-schema` if it covers our needs. Evaluate before writing from scratch.

---

## Phase 8: CTAs — Next Commands

**Goal:** `next` function on commands populates `meta.nextCommands` in output.

**TDD cycles (Cli.test.ts — next commands):**
1. Command with `next` function → output envelope includes `meta.nextCommands`
2. `next` receives the command's return value as argument
3. `nextCommands` entries have `{ command, description }` shape
4. `nextCommands` entries can optionally include `args`
5. Command without `next` → `meta.nextCommands` is empty array
6. `next` returning empty array → `meta.nextCommands` is empty array

---

## Phase 9: Skill Files — Markdown Generation

**Goal:** Auto-generate Markdown skill files with YAML frontmatter from command definitions.

**TDD cycles (Skill.test.ts):**
1. Generates valid Markdown with YAML frontmatter (`title`, `description`, `command`)
2. Frontmatter includes `annotations` when present
3. Includes `## Usage` section with synopsis
4. Includes `## Arguments` table (name, type, required, description)
5. Includes `## Options` table (flag, type, default, description)
6. Includes `## Output Schema` section
7. Includes `## Next Commands` section when `next` is defined
8. Omits sections when not applicable (no args → no Arguments section)

**TDD cycles (Cli.test.ts — --llms --format md):**
9. `cli.serve(['--llms', '--format', 'md'])` → concatenated Markdown of all commands

**Files created:** `Skill.ts`, `Skill.test.ts`

---

## Phase 10: Help, Version & Polish

**Goal:** Built-in `--help`, `--version`, implicit help for router CLIs with no subcommand, and root CLIs with no `run`.

### 10a: Default help for routers and root CLIs without `run`

When a router CLI is invoked with no subcommand, or a root CLI has no `run` handler, display usage/help instead of erroring.

**TDD cycles (Cli.test.ts — implicit help):**
1. `cli.serve([])` on a router CLI (no subcommand) → prints usage listing available commands, exits 0
2. `Cli.create('tool')` with no `run` and no subcommands → prints usage with name/description, exits 0
3. Usage output includes CLI name, description (when set), and list of commands with descriptions
4. Usage output includes listed args/options for leaf commands

### 10b: `--help` flag

Explicit `--help` flag at any level of the command tree.

**TDD cycles (Cli.test.ts — --help):**
5. `cli.serve(['--help'])` → prints usage for the root CLI, exits 0
6. `cli.serve(['pr', '--help'])` → prints usage for the `pr` group, listing its subcommands
7. `cli.serve(['pr', 'list', '--help'])` → prints usage for `pr list` with its args/options
8. `--help` is consumed before command resolution — no handler runs

### 10c: `--version` flag

**TDD cycles (Cli.test.ts — --version):**
9. `Cli.create('tool', { version: '1.0.0' })` + `cli.serve(['--version'])` → outputs `1.0.0`, exits 0
10. `--version` with no version set → error or no output

### 10d: Help formatting

**TDD cycles (Help.test.ts):**
11. Formats a command with args → `tool <name> <age>`-style synopsis
12. Formats a command with options → lists `--flag` with type and description
13. Formats a group → lists subcommands with descriptions in aligned columns
14. Formats optional args with `[brackets]`, required with `<brackets>`
15. Includes default values for options that have them

**Files created:** `Help.ts`, `Help.test.ts`
**Files modified:** `Cli.ts`

---

## Phase 11: Agent vs Human Output

**Goal:** Detect whether the caller is a human (TTY) or an agent/pipe (non-TTY) and adapt all output accordingly. Humans get pretty-printed results, agents get structured envelopes.

### Detection

- **Auto**: `process.stdout.isTTY` — `true` for humans in a terminal, `false` for pipes/programmatic callers
- **Override**: explicit `--format` or `--json` flag forces structured output regardless of TTY
- **Env**: `CI=true` or `TERM=dumb` treated as non-TTY

### Behavior matrix

| Scenario | TTY (human) | Non-TTY (agent) |
|---|---|---|
| **Command output** | Silent (handler logs what it wants) | TOON/JSON envelope `{ ok, data, meta }` |
| **Errors** | Human-readable message + hint | Error envelope `{ ok: false, error }` |
| **`--help`** | Pretty help text (Phase 10) | Structured command manifest (JSON) |
| **`--version`** | `1.2.3\n` | `{ version: "1.2.3" }` |
| **No subcommand** | Pretty help | Structured command list |
| **`--llms`** | Same as non-TTY (always structured) | Same |

### Human output formatting

When TTY and no explicit `--format`:
- Command return data is **not written to stdout** — the handler owns human-facing output via `console.log` or similar
- Errors show `Error: message` with optional hint, no envelope wrapper
- No `ok`/`meta` envelope — that's for agents only

### TDD cycles

**Cli.test.ts — TTY detection:**
1. Non-TTY (default in tests) → outputs TOON envelope as today
2. Simulated TTY → outputs human-friendly format (no envelope)
3. TTY + `--json` → outputs JSON envelope (override)
4. TTY + `--format toon` → outputs TOON envelope (override)
5. Non-TTY + `--help` → outputs structured command manifest (JSON)
6. TTY + `--help` → outputs pretty help text
7. Non-TTY error → error envelope
8. TTY error → human-readable error message

**Formatter.test.ts — human error mode:**
9. `formatError(error)` → `Error: message` with hint on next line
10. `formatError(error)` with field errors → lists fields below message

**Files modified:** `Cli.ts`, `Formatter.ts`

---

## Dependency Graph

```
Phase 1 (tracer bullet)
  ├── Phase 2 (parser) ──┐
  │                      ▼
  ├── Phase 3 (type inference) ──────────┐
  │                                      │
  ├── Phase 4 (errors) ─────────────────┤
  │                                      ▼
  ├── Phase 5 (formatter) ──── Phase 7 (schema)
  │                                      │
  ├── Phase 6 (subcommands)              ▼
  │                            Phase 9 (skills)
  ├── Phase 8 (CTAs)
  │
  ├── Phase 10 (help & version) ← all above
  │
  └── Phase 11 (agent vs human output) ← Phase 10
```

Phase 3 depends on Phase 2 (parser must exist to type it). Phases 4, 5, 6, 8 can be parallelized after Phase 3. Phase 7 depends on the formatter. Phase 9 depends on schema. Phase 10 is the help/version pass. Phase 11 builds on Phase 10 to adapt all output (help, errors, data) based on TTY detection.

---

## Per-Phase Checklist

Before marking a phase complete:

- [ ] All tests pass (`pnpm test`)
- [ ] Types check (`pnpm check:types`)
- [ ] Lint passes (`pnpm check`)
- [ ] Each test describes behavior, not implementation
- [ ] Each test uses the public interface only
- [ ] No speculative features added beyond the phase scope
