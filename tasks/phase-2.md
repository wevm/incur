# Phase 2: Parser — Full Argument Parsing

**Goal:** Robust argv parsing driven by Zod schemas. Pure module, no CLI coupling. Replace the inline positional-only parsing in `Cli.ts`.

**Scope boundary:** Parser is a standalone pure function. It takes raw `string[]` argv + schema definitions, returns `{ args, options }`. No CLI wiring yet (that's the final step of this phase). No error classes — throw plain `Error` for now (Phase 3 adds structured errors).

---

## API Surface

```ts
/** Parses raw argv tokens against Zod schemas for args and options. */
export function parse(argv: string[], options: parse.Options = {}): parse.ReturnType

export declare namespace parse {
  /** Options for parsing. */
  type Options = {
    /** Zod schema for positional arguments. Keys define order. */
    args?: z.ZodObject<any> | undefined
    /** Zod schema for named options/flags. */
    options?: z.ZodObject<any> | undefined
    /** Map of option names to single-char aliases. */
    alias?: Record<string, string> | undefined
  }
  /** Parsed result with args and options. */
  type ReturnType = {
    /** Parsed positional arguments. */
    args: Record<string, unknown>
    /** Parsed named options. */
    options: Record<string, unknown>
  }
}
```

## Parsing rules

1. First pass: split argv into positional tokens and flag tokens
2. Anything starting with `--` or `-` (single char) is a flag; everything else is positional
3. Positional tokens are assigned to `args` schema keys in order
4. `--flag value` and `--flag=value` both work for named options
5. `-f value` works when `f` is in the alias map
6. `--verbose` (boolean schema) → `true`, `--no-verbose` → `false`
7. `--label x --label y` (array schema) collects into `['x', 'y']`
8. String → number coercion for `z.number()` schemas (before zod parse)
9. String → boolean coercion for `z.boolean()` schemas (`"true"` → `true`, `"false"` → `false`)
10. `z.default()` values applied by zod (parser just omits the key)
11. `z.optional()` fields are not required (parser just omits the key)
12. Unknown flags → throw error
13. Missing required positional args → throw error
14. Zod validation failure → throw error with details

## Type coercion strategy

Parser coerces before handing to zod. To determine the target type, unwrap through `ZodDefault` → `ZodOptional` → inner type, then check `constructor.name`:
- `ZodNumber` → `Number(value)`
- `ZodBoolean` → `value === 'true'` (flag-only boolean is just `true`)
- `ZodArray` → collect repeated flags into array
- `ZodEnum` → pass through as string (zod validates)

---

## TDD Cycles

### 1. Parses positional args in schema key order

```ts
test('parses positional args in schema key order', () => {
  const result = Parser.parse(['hello', 'world'], {
    args: z.object({ greeting: z.string(), name: z.string() }),
  })
  expect(result.args).toEqual({ greeting: 'hello', name: 'world' })
})
```

---

### 2. Parses `--flag value` named options

```ts
test('parses --flag value options', () => {
  const result = Parser.parse(['--state', 'open'], {
    options: z.object({ state: z.string() }),
  })
  expect(result.options).toEqual({ state: 'open' })
})
```

---

### 3. Parses `--flag=value` syntax

```ts
test('parses --flag=value syntax', () => {
  const result = Parser.parse(['--state=closed'], {
    options: z.object({ state: z.string() }),
  })
  expect(result.options).toEqual({ state: 'closed' })
})
```

---

### 4. Parses `-f value` short aliases

```ts
test('parses -f value short aliases', () => {
  const result = Parser.parse(['-s', 'open'], {
    options: z.object({ state: z.string() }),
    alias: { state: 's' },
  })
  expect(result.options).toEqual({ state: 'open' })
})
```

---

### 5. Parses boolean flags

```ts
test('parses --verbose as true', () => {
  const result = Parser.parse(['--verbose'], {
    options: z.object({ verbose: z.boolean() }),
  })
  expect(result.options).toEqual({ verbose: true })
})

test('parses --no-verbose as false', () => {
  const result = Parser.parse(['--no-verbose'], {
    options: z.object({ verbose: z.boolean() }),
  })
  expect(result.options).toEqual({ verbose: false })
})
```

---

### 6. Parses array options

```ts
test('parses repeated flags as array', () => {
  const result = Parser.parse(['--label', 'bug', '--label', 'feature'], {
    options: z.object({ label: z.array(z.string()) }),
  })
  expect(result.options).toEqual({ label: ['bug', 'feature'] })
})
```

---

### 7. Coerces string → number

```ts
test('coerces string to number', () => {
  const result = Parser.parse(['--limit', '10'], {
    options: z.object({ limit: z.number() }),
  })
  expect(result.options).toEqual({ limit: 10 })
})
```

---

### 8. Coerces string → boolean

```ts
test('coerces string to boolean', () => {
  const result = Parser.parse(['--dry', 'true'], {
    options: z.object({ dry: z.boolean() }),
  })
  expect(result.options).toEqual({ dry: true })
})
```

---

### 9. Applies Zod `.default()` values

```ts
test('applies default values for missing options', () => {
  const result = Parser.parse([], {
    options: z.object({ limit: z.number().default(30) }),
  })
  expect(result.options).toEqual({ limit: 30 })
})
```

---

### 10. Treats `.optional()` fields as not required

```ts
test('allows optional fields to be omitted', () => {
  const result = Parser.parse([], {
    options: z.object({ verbose: z.boolean().optional() }),
  })
  expect(result.options).toEqual({})
})
```

---

### 11. Throws on unknown flags

```ts
test('throws on unknown flags', () => {
  expect(() =>
    Parser.parse(['--unknown', 'val'], {
      options: z.object({ state: z.string() }),
    })
  ).toThrow(/unknown/i)
})
```

---

### 12. Throws on missing required positional args

```ts
test('throws on missing required positional args', () => {
  expect(() =>
    Parser.parse([], {
      args: z.object({ name: z.string() }),
    })
  ).toThrow(/name/i)
})
```

---

### 13. Throws on Zod validation failure

```ts
test('throws on enum mismatch', () => {
  expect(() =>
    Parser.parse(['--state', 'invalid'], {
      options: z.object({ state: z.enum(['open', 'closed']) }),
    })
  ).toThrow()
})
```

---

### 14. Returns `{ args, options }` with both empty schemas

```ts
test('returns empty args and options when no schemas', () => {
  const result = Parser.parse([])
  expect(result).toEqual({ args: {}, options: {} })
})
```

---

### 15. Positional args and options mixed

```ts
test('parses positional args and options together', () => {
  const result = Parser.parse(['myrepo', '--limit', '5'], {
    args: z.object({ repo: z.string() }),
    options: z.object({ limit: z.number() }),
  })
  expect(result.args).toEqual({ repo: 'myrepo' })
  expect(result.options).toEqual({ limit: 5 })
})
```

---

## Wire In

After all Parser tests pass, update `Cli.ts`:
- Replace the inline positional parsing (lines 70–78) with `Parser.parse(rest, { args: command.args, options: command.options })`
- Pass the parsed result to `command.run({ args, options })`
- Existing `Cli.test.ts` tests should still pass unchanged

## Files Modified

- `src/Parser.ts` — implement `parse()`
- `src/Parser.test.ts` — all tests above
- `src/Cli.ts` — replace inline parsing with `Parser.parse()`

## Done When

- All Parser tests pass
- All existing Cli tests still pass
- `pnpm check:types` clean
- `pnpm check` clean
