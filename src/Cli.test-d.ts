import { Cli, z } from 'clac'
import { expectTypeOf, test } from 'vitest'

test('args in run() infers from args schema', () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    run({ args }) {
      expectTypeOf(args).toEqualTypeOf<{ name: string }>()
      return {}
    },
  })
})

test('options in run() infers from options schema', () => {
  const cli = Cli.create('test')
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
})

test('without schemas, run receives empty objects', () => {
  const cli = Cli.create('test')
  cli.command('ping', {
    run({ args, options }) {
      expectTypeOf(args).toEqualTypeOf<{}>()
      expectTypeOf(options).toEqualTypeOf<{}>()
      return { pong: true }
    },
  })
})

test('output constrains run return type', () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    output: z.object({ message: z.string() }),
    run() {
      return { message: 'hello' }
    },
  })

  cli.command('greet', {
    output: z.object({ message: z.string() }),
    // @ts-expect-error — return doesn't match output schema
    run() {
      return { wrong: 123 }
    },
  })
})

test('alias keys are constrained to option keys', () => {
  const cli = Cli.create('test')
  cli.command('list', {
    options: z.object({ state: z.string(), limit: z.number() }),
    alias: { state: 's', limit: 'l' },
    run: () => ({}),
  })

  cli.command('list', {
    options: z.object({ state: z.string() }),
    // @ts-expect-error — 'foo' is not an option key
    alias: { foo: 'f' },
    run: () => ({}),
  })
})

test('next callback receives typed result from output', () => {
  const cli = Cli.create('test')
  cli.command('list', {
    output: z.object({ items: z.array(z.string()) }),
    run: () => ({ items: ['a', 'b'] }),
    next(result) {
      expectTypeOf(result).toEqualTypeOf<{ items: string[] }>()
      return []
    },
  })
})
