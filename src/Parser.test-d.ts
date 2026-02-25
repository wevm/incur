import { Parser, z } from 'clac'
import { expectTypeOf, test } from 'vitest'

test('narrows args from schema', () => {
  const result = Parser.parse(['hello'], {
    args: z.object({ name: z.string() }),
  })
  expectTypeOf(result.args).toEqualTypeOf<{ name: string }>()
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
