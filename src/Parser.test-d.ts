import { Parser, z } from 'incur'
import { expectTypeOf, test } from 'vitest'

test('narrows args from schema', () => {
  const result = Parser.parse(['hello'], {
    args: z.object({ name: z.string() }),
  })
  expectTypeOf(result.args).toEqualTypeOf<{ name: string }>()
})

test('variadic array arg infers as array', () => {
  const result = Parser.parse(['a.ts', 'b.ts'], {
    args: z.object({ paths: z.array(z.string()) }),
  })
  expectTypeOf(result.args).toEqualTypeOf<{ paths: string[] }>()
})

test('scalar and variadic args infer together', () => {
  const result = Parser.parse(['dest', 'a.ts'], {
    args: z.object({ target: z.string(), paths: z.array(z.string()).default([]) }),
  })
  expectTypeOf(result.args).toEqualTypeOf<{ target: string; paths: string[] }>()
})

test('narrows options from schema', () => {
  const result = Parser.parse(['--state', 'open'], {
    options: z.object({ state: z.string() }),
  })
  expectTypeOf(result.options).toEqualTypeOf<{ state: string }>()
})

test('defaults to empty objects when no schemas', () => {
  const result = Parser.parse([])
  expectTypeOf(result.args).toEqualTypeOf<{}>()
  expectTypeOf(result.options).toEqualTypeOf<{}>()
})

test('z.output reflects .default() as non-optional', () => {
  const result = Parser.parse([], {
    options: z.object({ limit: z.number().default(30) }),
  })
  expectTypeOf(result.options).toEqualTypeOf<{ limit: number }>()
})

test('z.output reflects .optional() as optional', () => {
  const result = Parser.parse([], {
    options: z.object({ verbose: z.boolean().optional() }),
  })
  expectTypeOf(result.options).toEqualTypeOf<{ verbose?: boolean | undefined }>()
})

test('narrows both args and options together', () => {
  const result = Parser.parse(['myrepo', '--limit', '5'], {
    args: z.object({ repo: z.string() }),
    options: z.object({ limit: z.number() }),
  })
  expectTypeOf(result.args).toEqualTypeOf<{ repo: string }>()
  expectTypeOf(result.options).toEqualTypeOf<{ limit: number }>()
})

test('defaults are typed from z.input of the options schema', () => {
  const result = Parser.parse([], {
    defaults: { limit: '5' },
    options: z.object({ limit: z.coerce.number().default(30) }),
  })
  expectTypeOf(result.options).toEqualTypeOf<{ limit: number }>()
})

test('defaults do not leak any', () => {
  type Options = z.ZodObject<{
    limit: z.ZodDefault<z.ZodNumber>
    saveDev: z.ZodOptional<z.ZodBoolean>
  }>

  expectTypeOf<Parser.parse.Options<undefined, Options>>().toEqualTypeOf<{
    args?: undefined
    alias?: Record<string, string> | undefined
    defaults?: Partial<z.input<Options>> | undefined
    options?: Options
  }>()
})
