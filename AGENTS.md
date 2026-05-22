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
- **Avoid global declaration merging in type tests** — module augmentation in `.test-d.ts` affects the full `tsc -b` project, so prefer explicit generics/local helper types unless the test is specifically about global registration behavior.
- **No `any` leakage** — Zod schemas may use `z.ZodObject<any>` as a generic bound, but inferred types flowing to user-facing callbacks must be narrowed via `z.output<typeof schema>`. The user should never see `any` in their IDE.
- **Type inference after every feature** — after implementing any feature, check if new types can be narrowed. If a new property, callback, or return type touches a Zod schema, add generics to flow the inferred type through. Add or update `.test-d.ts` type tests alongside.

## Documentation Conventions

- **JSDoc on all exports** — every exported function, type, and constant gets a JSDoc comment. Type properties get JSDoc too. Namespace types (e.g. `declare namespace create { type Options }`) get JSDoc too. Doc-driven development: write the JSDoc before or alongside the implementation, not after.
- **Parse structured frontmatter structurally** — when `SKILL.md` frontmatter is emitted as YAML, read it back with the YAML parser instead of regex-scraping individual fields.

## Testing Conventions

- **Snapshot tests for deterministic output** — prefer `toMatchInlineSnapshot()` for deterministic string outputs (TOON, JSON, etc.). If output is mostly deterministic with a few dynamic properties (e.g. `duration`), extract and assert those separately, then snapshot the rest.

## Git Conventions

- **Conventional commits** — use `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:` prefixes. Scope is optional (e.g. `feat(parser): add array coercion`).
