# Phase 3: Type Inference — Zod Schema Narrowing

## Current State (every `any` / loose type)

| Location | Current Type | Should Be |
|---|---|---|
| `Cli.ts:26` — `run({ args, options })` | `{ args: any; options: any }` | `{ args: z.output<args>; options: z.output<options> }` |
| `Cli.ts:10` — `command()` | non-generic, accepts `CommandDefinition` | generic, infers from schemas |
| `Cli.ts:26` — `run()` return | `unknown` | `z.output<output>` when `output` provided, else `unknown` |
| `Parser.ts:111-116` — `parse.ReturnType` | `{ args: Record<string, unknown>; options: Record<string, unknown> }` | `{ args: z.output<A>; options: z.output<O> }` |
| `Parser.ts:102-109` — `parse.Options` | non-generic, schemas are `z.ZodObject<any>` | generic, flows to return type |
| Not yet defined — `alias` | `Record<string, string>` (Parser-level) | constrained to `keyof z.output<options>` at `Cli.command()` level |
| Not yet defined — `next` callback | doesn't exist | receives `z.output<output>` |

## Setup

- [ ] Verify `vitest typecheck` runs `.test-d.ts` files (may need `typecheck.enabled` in vitest config)

## TDD Cycles

### Cycle 1: `Parser.parse()` — narrows args

**Red** (`Parser.test-d.ts`):
```ts
const result = Parser.parse(['hello'], {
  args: z.object({ name: z.string() }),
})
expectTypeOf(result.args).toEqualTypeOf<{ name: string }>()
```

**Green** (`Parser.ts`):
- Add generic parameters to `parse()`: `<const args extends z.ZodObject<any>, const options extends z.ZodObject<any>>`
- Make `parse.Options` generic: `Options<args, options>`
- Make `parse.ReturnType` generic: `ReturnType<args, options>` using `z.output<args>`
- Cast the return: `return { args, options } as parse.ReturnType<args, options>` (runtime unchanged)

---

### Cycle 2: `Parser.parse()` — narrows options

**Red** (`Parser.test-d.ts`):
```ts
const result = Parser.parse(['--state', 'open'], {
  options: z.object({ state: z.string() }),
})
expectTypeOf(result.options).toEqualTypeOf<{ state: string }>()
```

**Green**: Already flows from Cycle 1.

---

### Cycle 3: `Parser.parse()` — defaults to empty

**Red** (`Parser.test-d.ts`):
```ts
const result = Parser.parse([])
expectTypeOf(result.args).toEqualTypeOf<{}>()
expectTypeOf(result.options).toEqualTypeOf<{}>()
```

**Green**: Set generic defaults so `z.output<default>` resolves to `{}`. Use `z.ZodObject<{}>` as default, or use conditional types with `undefined` default.

---

### Cycle 4: `Parser.parse()` — z.output reflects defaults/optionals

**Red** (`Parser.test-d.ts`):
```ts
// .default() makes the field non-optional in output
const r1 = Parser.parse([], {
  options: z.object({ limit: z.number().default(30) }),
})
expectTypeOf(r1.options).toEqualTypeOf<{ limit: number }>()

// .optional() makes the field optional in output
const r2 = Parser.parse([], {
  options: z.object({ verbose: z.boolean().optional() }),
})
expectTypeOf(r2.options).toEqualTypeOf<{ verbose?: boolean | undefined }>()
```

**Green**: Already works via `z.output<>` — defaults become non-optional, optionals stay optional. No code change.

---

### Cycle 5: `Cli.command()` — args inference in run

**Red** (`Cli.test-d.ts`):
```ts
const cli = Cli.create('test')
cli.command('greet', {
  args: z.object({ name: z.string() }),
  run({ args }) {
    expectTypeOf(args).toEqualTypeOf<{ name: string }>()
    return {}
  },
})
```

**Green** (`Cli.ts`):
- Make `CommandDefinition` generic: `<args, options, output>` each `extends z.ZodObject<any> | undefined = undefined`
- Use conditional type: `args extends z.ZodObject<any> ? z.output<args> : {}`
- Make `command()` method generic on `Cli` type

---

### Cycle 6: `Cli.command()` — options inference in run

**Red** (`Cli.test-d.ts`):
```ts
cli.command('list', {
  options: z.object({
    state: z.enum(['open', 'closed']).default('open'),
    limit: z.number().default(30),
  }),
  run({ options }) {
    expectTypeOf(options).toEqualTypeOf<{ state: 'open' | 'closed'; limit: number }>()
    return {}
  },
})
```

**Green**: Flows from Cycle 5.

---

### Cycle 7: `Cli.command()` — no schemas → empty objects

**Red** (`Cli.test-d.ts`):
```ts
cli.command('ping', {
  run({ args, options }) {
    expectTypeOf(args).toEqualTypeOf<{}>()
    expectTypeOf(options).toEqualTypeOf<{}>()
    return { pong: true }
  },
})
```

**Green**: Generic defaults to `undefined`, conditional resolves to `{}`.

---

### Cycle 8: `Cli.command()` — output constrains run return

**Red** (`Cli.test-d.ts`):
```ts
cli.command('greet', {
  output: z.object({ message: z.string() }),
  run() {
    return { message: 'hello' } // ✓ matches output schema
  },
})

cli.command('greet', {
  output: z.object({ message: z.string() }),
  // @ts-expect-error — return doesn't match output schema
  run() {
    return { wrong: 123 }
  },
})
```

**Green**: When `output extends z.ZodObject<any>`, `run` return type is `z.output<output> | Promise<z.output<output>>`. When `output` is `undefined`, return type is `unknown`.

---

### Cycle 9: `alias` keys constrained to option keys

**Red** (`Cli.test-d.ts`):
```ts
cli.command('list', {
  options: z.object({ state: z.string(), limit: z.number() }),
  alias: { state: 's', limit: 'l' }, // ✓ both are option keys
  run: () => ({}),
})

cli.command('list', {
  options: z.object({ state: z.string() }),
  // @ts-expect-error — 'foo' is not an option key
  alias: { foo: 'f' },
  run: () => ({}),
})
```

**Green**: Type `alias` as `Partial<Record<keyof z.output<options>, string>>` (or equivalent using the schema shape keys).

Note: `Parser.parse` keeps `alias?: Record<string, string>` untyped — the constraint is only at the `Cli.command()` level.

---

### Cycle 10: `next` callback receives typed result

**Red** (`Cli.test-d.ts`):
```ts
cli.command('list', {
  output: z.object({ items: z.array(z.string()) }),
  run: () => ({ items: ['a', 'b'] }),
  next(result) {
    expectTypeOf(result).toEqualTypeOf<{ items: string[] }>()
    return []
  },
})
```

**Green**: Add `next?: ((result: ...) => NextCommand[]) | undefined` to `CommandDefinition`. When `output` is provided, `result` is `z.output<output>`. When not, `result` is `unknown`.

Note: Only the type signature is added here. Runtime handling of `next` comes in Phase 8 (CTAs).

---

### Cycle 11: Verify runtime tests pass

**Check**:
- `pnpm test` — all existing `Cli.test.ts` and `Parser.test.ts` tests still pass
- `pnpm check:types` — no type errors
- `pnpm check` — lint passes

No runtime behavior changes. All changes are type-level only (plus `as` casts on return values).

---

## Files Changed

| File | Change |
|---|---|
| `Parser.ts` | Add generics to `parse()`, `parse.Options`, `parse.ReturnType` |
| `Parser.test-d.ts` | **New** — type tests for `Parser.parse()` inference |
| `Cli.ts` | Make `CommandDefinition` generic, make `command()` generic, add `next` type |
| `Cli.test-d.ts` | **New** — type tests for `Cli.command()` inference |
| `vitest.config.ts` | Add `typecheck` config if needed |

## Key Design Decisions

1. **`z.output<>` not `z.infer<>`** — `z.output` gives post-transform types (after `.default()`, `.transform()`). This matches what `schema.parse()` returns at runtime.

2. **`undefined` default, not `z.ZodObject<{}>`** — generics default to `undefined` when the user doesn't provide a schema. Conditional types resolve `undefined` → `{}` for callback params, `undefined` → `unknown` for return types.

3. **`alias` constrained at `Cli.command()`, not `Parser.parse()`** — Parser is a low-level utility that takes `Record<string, string>`. The type constraint lives at the `Cli.command()` API boundary where users interact.

4. **`next` type-only in Phase 3** — the `next` property is added to `CommandDefinition` for type inference, but runtime execution (populating `meta.nextCommands`) happens in Phase 8.

5. **Runtime unchanged** — all changes are type-level. The `parse()` function body stays identical, just the return gets a type assertion. `command()` stores definitions as `CommandDefinition` (erased) in the Map.
