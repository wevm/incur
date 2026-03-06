import { Cli, middleware, z } from 'incur'
import type { MiddlewareHandler } from 'incur'
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

  // @ts-expect-error — return doesn't match output schema
  cli.command('greet', {
    output: z.object({ message: z.string() }),
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

  // @ts-expect-error — 'foo' is not an option key
  cli.command('list', {
    options: z.object({ state: z.string() }),
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

test('vars are typed in run context', () => {
  Cli.create('test', {
    vars: z.object({ user: z.string(), count: z.number().default(0) }),
  }).command('check', {
    run(c) {
      expectTypeOf(c.var.user).toEqualTypeOf<string>()
      expectTypeOf(c.var.count).toEqualTypeOf<number>()
      return {}
    },
  })
})

test('vars are typed in middleware set()', () => {
  Cli.create('test', {
    vars: z.object({ user: z.string() }),
  }).use((c, _next) => {
    // valid key
    c.set('user', 'alice')
    // @ts-expect-error — 'unknown' is not a declared var key
    c.set('unknown', 'value')
  })
})

test('without vars, c.var is empty object', () => {
  Cli.create('test').command('ping', {
    run(c) {
      expectTypeOf(c.var).toEqualTypeOf<{}>()
      return {}
    },
  })
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

test('middleware<typeof cli.vars>() infers vars types', () => {
  const cli = Cli.create('test', {
    vars: z.object({ user: z.string(), count: z.number() }),
  })

  const mw = middleware<typeof cli.vars>((c, _next) => {
    expectTypeOf(c.var.user).toEqualTypeOf<string>()
    expectTypeOf(c.var.count).toEqualTypeOf<number>()
    c.set('user', 'alice')
    // @ts-expect-error — 'unknown' is not a declared var key
    c.set('unknown', 'value')
  })

  expectTypeOf(mw).toEqualTypeOf<MiddlewareHandler<typeof cli.vars>>()
})

test('middleware() without generic gives empty context', () => {
  middleware((c, _next) => {
    expectTypeOf(c.var).toEqualTypeOf<{}>()
    expectTypeOf(c.env).toEqualTypeOf<{}>()
    expectTypeOf(c.format).toEqualTypeOf<'toon' | 'json' | 'yaml' | 'md' | 'jsonl'>()
    expectTypeOf(c.formatExplicit).toEqualTypeOf<boolean>()
    expectTypeOf(c.human.enabled).toEqualTypeOf<boolean>()
    expectTypeOf(c.human.stream).toEqualTypeOf<NodeJS.WriteStream | undefined>()
    expectTypeOf(c.human.write).returns.toEqualTypeOf<void>()
    expectTypeOf(c.human.writeln).returns.toEqualTypeOf<void>()
  })
})

test('env is typed in middleware via .use()', () => {
  Cli.create('test', {
    env: z.object({
      API_TOKEN: z.string(),
      API_URL: z.string().default('https://api.example.com'),
    }),
  }).use((c, _next) => {
    expectTypeOf(c.env.API_TOKEN).toEqualTypeOf<string>()
    expectTypeOf(c.env.API_URL).toEqualTypeOf<string>()
  })
})

test('without env, c.env is empty object in middleware', () => {
  Cli.create('test').use((c, _next) => {
    expectTypeOf(c.env).toEqualTypeOf<{}>()
  })
})

test('middleware<vars, env>() infers both vars and env types', () => {
  const cli = Cli.create('test', {
    env: z.object({ API_TOKEN: z.string() }),
    vars: z.object({ user: z.string() }),
  })

  const mw = middleware<typeof cli.vars, typeof cli.env>((c, _next) => {
    expectTypeOf(c.env.API_TOKEN).toEqualTypeOf<string>()
    expectTypeOf(c.var.user).toEqualTypeOf<string>()
    c.set('user', 'alice')
  })

  expectTypeOf(mw).toEqualTypeOf<MiddlewareHandler<typeof cli.vars, typeof cli.env>>()
})

test('middleware context has error() for short-circuiting', () => {
  const vars = z.object({ session: z.custom<{ id: string } | null>() })

  const requireAuth = middleware<typeof vars>((c, next) => {
    if (!c.var.session)
      return c.error({
        code: 'NOT_AUTHENTICATED',
        message: 'You are not authenticated.',
        cta: {
          description: 'Log in:',
          commands: [{ command: 'auth login', description: 'Log in' }],
        },
      })
    return next()
  })

  Cli.create('test', { vars }).command('deploy', {
    middleware: [requireAuth],
    run: () => ({ deployed: true }),
  })
})

test('middleware error() returns never', () => {
  middleware((c, _next) => {
    expectTypeOf(c.error).returns.toEqualTypeOf<never>()
  })
})

test('c.error() accepts optional exitCode', () => {
  Cli.create('test').command('fail', {
    run(c) {
      // with exitCode
      c.error({ code: 'ERR', message: 'fail', exitCode: 10 })
      // without exitCode
      c.error({ code: 'ERR', message: 'fail' })
      return {}
    },
  })
})

test('env is typed in per-command middleware', () => {
  Cli.create('test', {
    env: z.object({ API_TOKEN: z.string() }),
  }).command('deploy', {
    middleware: [
      (c, next) => {
        expectTypeOf(c.env.API_TOKEN).toEqualTypeOf<string>()
        return next()
      },
    ],
    run: () => ({}),
  })
})

test('run() context exposes format metadata', () => {
  const cli = Cli.create('test')
  cli.command('ping', {
    run(c) {
      expectTypeOf(c.format).toEqualTypeOf<'toon' | 'json' | 'yaml' | 'md' | 'jsonl'>()
      expectTypeOf(c.formatExplicit).toEqualTypeOf<boolean>()
      expectTypeOf(c.human.enabled).toEqualTypeOf<boolean>()
      expectTypeOf(c.human.stream).toEqualTypeOf<NodeJS.WriteStream | undefined>()
      expectTypeOf(c.human.write).parameters.toEqualTypeOf<[text: string]>()
      expectTypeOf(c.human.write).returns.toEqualTypeOf<void>()
      expectTypeOf(c.human.writeln).parameters.toEqualTypeOf<[text: string]>()
      expectTypeOf(c.human.writeln).returns.toEqualTypeOf<void>()
      return { pong: true }
    },
  })
})
