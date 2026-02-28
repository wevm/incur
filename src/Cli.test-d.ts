import { Cli, z } from 'incur'
import { expectTypeOf, test } from 'vitest'

test('args in run() infers from args schema', () => {
  const cli = Cli.create('test')
  cli.command('greet', {
    args: z.object({ name: z.string() }),
    run(c) {
      expectTypeOf(c.args).toEqualTypeOf<{ name: string }>()
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
    run(c) {
      expectTypeOf(c.options).toEqualTypeOf<{ state: 'open' | 'closed'; limit: number }>()
      return {}
    },
  })
})

test('without schemas, run receives empty objects', () => {
  const cli = Cli.create('test')
  cli.command('ping', {
    run(c) {
      expectTypeOf(c.args).toEqualTypeOf<{}>()
      expectTypeOf(c.options).toEqualTypeOf<{}>()
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

test('ok() data param is typed from output schema', () => {
  const cli = Cli.create('test')
  cli.command('list', {
    output: z.object({ items: z.array(z.string()) }),
    run(c) {
      return c.ok({ items: ['a', 'b'] })
    },
  })

  cli.command('list2', {
    output: z.object({ items: z.array(z.string()) }),
    run(c) {
      // @ts-expect-error — data doesn't match output schema
      return c.ok({ wrong: 123 })
    },
  })
})

test('Cta accepts string shorthand', () => {
  expectTypeOf<'auth login'>().toMatchTypeOf<Cli.Cta>()
})

test('Cta accepts object form', () => {
  expectTypeOf<{ command: 'auth login'; description: 'Log in' }>().toMatchTypeOf<Cli.Cta>()
})

test('Cta narrows strings and objects to registered commands', () => {
  type Commands = {
    get: { args: { id: number }; options: {} }
    list: { args: {}; options: { limit: number } }
  }
  type Cta = Cli.Cta<Commands>

  // string suggests registered command names but accepts any string
  expectTypeOf<'get'>().toMatchTypeOf<Cta>()
  expectTypeOf<'list'>().toMatchTypeOf<Cta>()
  expectTypeOf<'anything else'>().toMatchTypeOf<Cta>()

  // object form narrows args/options via discriminated union on command
  expectTypeOf<{ command: 'get'; args: { id: 42 } }>().toMatchTypeOf<Cta>()
  expectTypeOf<{ command: 'list'; options: { limit: 10 } }>().toMatchTypeOf<Cta>()
})

test('command() accumulates command types through chaining', () => {
  const cli = Cli.create('test')
    .command('get', {
      args: z.object({ id: z.number() }),
      options: z.object({ verbose: z.boolean().default(false) }),
      run: (c) => ({ id: c.args.id }),
    })
    .command('list', {
      options: z.object({ limit: z.number().default(30) }),
      run: () => ({ items: [] }),
    })

  type Commands = typeof cli extends Cli.Cli<infer C> ? C : never
  expectTypeOf<Commands['get']>().toEqualTypeOf<{
    args: { id: number }
    options: { verbose: boolean }
  }>()
  expectTypeOf<Commands['list']>().toEqualTypeOf<{ args: {}; options: { limit: number } }>()
})
