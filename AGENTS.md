# incur — Agent Guidelines

> **Update after learnings or mistakes** — when a correction, new convention, or hard-won lesson emerges during development, append it to the relevant section of this file immediately. AGENTS.md is the source of truth for project conventions and should grow as the project does.

## TypeScript Conventions

- **Exact optional properties** — `exactOptionalPropertyTypes` is enabled in tsconfig. Optional properties must include `| undefined` in their type if they can be assigned `undefined` (e.g. `foo?: string | undefined`, not `foo?: string`).
- **No `readonly`** — skip `readonly` on type properties.
- **`type` over `interface`** — always use `type` for type definitions.
- **`.js` extensions** — all imports include `.js` for ESM compatibility.
- **Classes for errors only** — all other APIs use factory functions.
- **No enums** — use `as const` objects for fixed sets.
- **`const` generic modifier** — use to preserve literal types for full inference.
- **camelCase generics** — `<const args extends z.ZodObject<any>>` not `<T>`.
- **Options default `= {}`** — use `options: Options = {}` not `options?: Options`.
- **Minimal variable names** — prefer short, obvious names. Use `options` not `serveOptions`, `fn` not `callbackFunction`, etc. Context makes meaning clear.
- **No redundant type annotations** — if the return type of a function already covers it, don't annotate intermediate variables. Let the return type do the work (e.g. `const cli = { ... }` not `const cli: ReturnType = { ... }`).
- **Return directly** — don't declare a variable just to return it. Use `return { ... }` unless the variable is needed (e.g. self-reference for chaining).
- **Skip braces for single-statement blocks** — omit `{}` for single-statement `if`, `for`, etc.
- **Destructure when accessing multiple properties** — prefer `const { a, b } = options` over repeated `options.a`, `options.b`.
- **IIFE for multi-branch assignment** — use an IIFE instead of nested ternaries when assigning a value from multiple conditions. Add a comment to every branch explaining the case.

## Type Inference Conventions

- **`z.output<>` over `z.infer<>`** — use `z.output<schema>` for types after transforms/defaults are applied (what `schema.parse()` returns at runtime). Use `z.input<schema>` only when representing pre-validation types.
- **`const` generics on definitions** — any function that accepts Zod schemas and passes them to callbacks must use `const` generic parameters to preserve literal types (e.g. `<const args extends z.ZodObject<any>>`).
- **Flow schemas through generics** — when a factory function accepts Zod schemas, use generics to flow `z.output<>` through to callbacks (`run`, `next`), return types, and constraint types (`alias`). Never fall back to `any` in callback signatures.
- **Type tests in `.test-d.ts`** — use vitest's `expectTypeOf` in colocated `.test-d.ts` files to assert generic inference works. Type tests are first-class — write them alongside implementation, not as an afterthought.
- **No `any` leakage** — Zod schemas may use `z.ZodObject<any>` as a generic bound, but inferred types flowing to user-facing callbacks must be narrowed via `z.output<typeof schema>`. The user should never see `any` in their IDE.
- **Type inference after every feature** — after implementing any feature, check if new types can be narrowed. If a new property, callback, or return type touches a Zod schema, add generics to flow the inferred type through. Add or update `.test-d.ts` type tests alongside.

## Documentation Conventions

- **JSDoc on all exports** — every exported function, type, and constant gets a JSDoc comment. Type properties get JSDoc too. Namespace types (e.g. `declare namespace create { type Options }`) get JSDoc too. Doc-driven development: write the JSDoc before or alongside the implementation, not after.
- **Parse structured frontmatter structurally** — when `SKILL.md` frontmatter is emitted as YAML, read it back with the YAML parser instead of regex-scraping individual fields.

## Testing Conventions

- **Snapshot tests for deterministic output** — prefer `toMatchInlineSnapshot()` for deterministic string outputs (TOON, JSON, etc.). If output is mostly deterministic with a few dynamic properties (e.g. `duration`), extract and assert those separately, then snapshot the rest.

## Binary Build Conventions

- **Compile through a wrapper** — Bun treats a CLI default export with `fetch` as a server, so standalone builds import the entry through a side-effect-only wrapper.
- **Keep release sets coherent** — remove stale managed artifacts before publishing a completed build while preserving unrelated output files.
- **Mark generated installers** — replace or clean `install.sh` and `install.ps1` only when their Incur marker is present; reject collisions with unmanaged files.
- **Pin generated installers** — a mutable latest-release URL may select an installer, but the generated script must download binary assets from its embedded exact release tag.
- **Release from one Linux action** — run `release@v1` as a step on `ubuntu-latest` with `contents: write`; it cross-compiles unsigned assets for every target.
- **Infer release action inputs** — default to `./src/bin.ts`, derive the CLI name and stable version, and treat `entry`, `name`, and `release_tag` as overrides.
- **Append to existing releases** — default to the latest published release, require its tag to match the package version, and never create or modify releases or tags.
- **Trust action release inputs** — install, build, and upload share one job's write permission; `persist-credentials: false` does not create a permission boundary.
- **Limit smoke tests to the runner** — test only matching-architecture Linux glibc and musl assets; native macOS and Windows tests and signing stay out of scope.
- **Install musl runtime libraries** — Bun musl executables require `libstdc++` and `libgcc`; install both before Alpine smoke tests.
- **Test spaced version overrides** — command-local `--version <value>` must not be consumed as the root boolean `--version` flag.

## Language Port Conventions

- **TypeScript is the reference** — ports in `langs/<language>` match its stdout, stderr, and exit codes byte for byte. Fix a port, never the expectation.
- **Shared differential suite** — `langs/_differential` holds the reference CLIs (`fixtures.ts`), the cases (`cases.json`, one per line), and config fixtures. Every port mirrors the fixtures and runs every case. A TypeScript behavior change adds cases there.
- **Cover through cases** — reach port code through new fixture behavior and cases before anything else. Port-only APIs (trait impls, typed failures, unsupported built-ins) get public-API integration tests; unreachable code is restructured away, not excluded.
- **Mirror JavaScript semantics** — numbers are doubles, `slice` and element reads follow ECMAScript, and dependency output (zod, yaml, toon, tokenx) is ported from the pinned version, key order included.
- **Rust gate** — `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` (also with `--features incur/client` and `--no-default-features`, alone and combined), `cargo test --workspace --no-default-features`, and `cargo llvm-cov --workspace --fail-uncovered-lines 0` in `langs/rust`.
- **Python gate** — `uv run ruff check`, `uv run ruff format --check`, `uv run pyright` (strict), and `uv run coverage erase && uv run coverage run -m pytest && uv run coverage report` (100% branch coverage; erase first, since stale `.coverage.*` files from subprocess runs otherwise merge in) in `langs/python`.
- **Zig gate** — `zig fmt --check .`, `zig build test`, and `zig build coverage` (kcov, 100% of `src/` lines) in `langs/zig`, on Zig 0.17.1. No `test` blocks in `src/`; README programs run in `zig build test`, as child processes that coverage traces under kcov.
- **Package READMEs mirror the root** — each port's README is a concise version of the root README (header, Features, Install, Usage, Walkthrough, License) with tested examples; development commands live in `langs/README.md`.
- **No unpaired surrogates in cases** — JavaScript strings can hold them; Rust, Python, and Zig strings cannot, so the suite never compares them.
- **Node-independent expectations** — a case must not depend on the Node version's wording, such as `fs` error messages; test those per port instead.

## Git Conventions

- **Conventional commits** — use `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` prefixes. Scope is optional (e.g. `feat(parser): add array coercion`).
- **Changesets for package changes** — user-facing fixes and features require a `.changeset/*.md` entry in the same PR. Use `patch` for fixes, `minor` for additive features, and `major` for breaking changes. Skip only for tests, docs, or internal-only changes that do not affect the published package.
