/**
 * Reference CLIs for the differential suite. Every language port defines the same CLIs with the
 * same names, schemas, and handlers, and `cases.json` replays the same invocations against each.
 *
 * Schemas follow one canonical form so every port can describe them: `.optional()` or
 * `.default()` first, then `.describe()`, then `.meta()` with `count` before `deprecated`.
 */
import { Cli, Errors, z } from '../../src/index.js'

const users = [
  { name: 'Alice', email: 'alice@example.com', role: 'admin' },
  { name: 'Bob', email: 'bob@example.com', role: 'user' },
  { name: 'Carol', email: 'carol@example.com', role: 'user' },
]

const mixed = {
  context: { task: 'Our favorite hikes together', location: 'Boulder', season: 'spring_2025' },
  friends: ['ana', 'luis', 'sam'],
  hikes: [
    { id: 1, name: 'Blue Lake Trail', distanceKm: 7.5, wasSunny: true },
    { id: 2, name: 'Ridge Overlook', distanceKm: 9.2, wasSunny: false },
  ],
  matrix: [
    [1, 2],
    [3, 4],
  ],
  nested: [{ a: { b: 1 } }, 'x', [1, { y: 2 }]],
  empty: {},
  none: [],
  quoted: ['true', '42', '-dash', 'a:b', ' pad', '', 'comma,here', 'null', '05', '1e3'],
  text: 'line one\nline two',
  long: 'This is a fairly long sentence that should exceed the default YAML line width of eighty characters easily.',
  unicode: 'héllo wörld 日本語',
  special: { 'key with space': 1, '1abc': 2, 'dotted.key': 3, '': 4 },
  numbers: [0, -1, 1.5, 1e21, 0.000001, 123456789012],
  nil: null,
}

const app = Cli.create('app', {
  description: 'A differential test CLI',
  version: '1.2.3',
  update: false,
  env: z.object({ APP_USER: z.string().optional().describe('Acting user') }),
  vars: z.object({ user: z.string().default('anonymous') }),
})
  .use((c, next) => {
    if (c.env.APP_USER) c.set('user', c.env.APP_USER)
    return next()
  })
  .command('status', {
    description: 'Show repo status',
    examples: [{ description: 'Show status' }],
    run: () => ({ clean: true, branch: 'main' }),
  })
  .command('install', {
    description: 'Install a package',
    args: z.object({ package: z.string().optional().describe('Package name') }),
    options: z.object({
      saveDev: z.boolean().optional().describe('Save as dev dependency'),
      registry: z.string().optional().describe('Registry URL'),
      retries: z.number().min(0).max(10).default(3).describe('Retry count'),
      tag: z.enum(['latest', 'next']).default('latest').describe('Dist tag'),
    }),
    alias: { saveDev: 'D', registry: 'r' },
    run: (c) => ({ added: 1, package: c.args.package ?? null, ...c.options }),
  })
  .command('greet', {
    description: 'Greet someone',
    args: z.object({ name: z.string().describe('Name to greet') }),
    options: z.object({
      loud: z.boolean().default(false).describe('Shout'),
      times: z.number().int().min(1).max(5).optional().describe('Repeat count'),
      suffix: z.string().min(1).max(3).optional().describe('Suffix'),
    }),
    output: z.object({ message: z.string().describe('The greeting') }),
    examples: [
      { args: { name: 'world' }, description: 'Greet the world' },
      { args: { name: 'bob' }, options: { loud: true } },
    ],
    hint: 'Names are case-sensitive.',
    run(c) {
      let message = `hello ${c.args.name}${c.options.suffix ?? ''}`
      if (c.options.loud) message = message.toUpperCase()
      return {
        message: Array(c.options.times ?? 1)
          .fill(message)
          .join(' '),
      }
    },
  })
  .command('users', {
    description: 'List users',
    output: z.object({
      users: z
        .array(
          z.object({
            name: z.string().describe('Name'),
            email: z.string().describe('Email'),
            role: z.string().describe('Role'),
          }),
        )
        .describe('Users'),
      page: z
        .object({ total: z.number().describe('Total') })
        .optional()
        .describe('Paging'),
    }),
    run: () => ({ users }),
  })
  .command('list', {
    description: 'List items',
    args: z.object({ state: z.enum(['open', 'closed']).default('open').describe('Item state') }),
    run(c) {
      return c.ok(
        { items: [{ id: 1, title: 'Fix bug' }], state: c.args.state },
        {
          cta: {
            description: 'Next steps:',
            commands: [
              { command: 'get 1', description: 'View item' },
              { command: 'list', args: { state: 'closed' }, description: 'View closed' },
              { command: 'search', options: { query: true } },
              'status',
              { command: 'app whoami', description: 'Who am I' },
              { command: 'tags', args: { target: true }, options: { tag: 'x' } },
            ],
          },
        },
      )
    },
  })
  .command('fail', {
    description: 'Fail with a code',
    run(c) {
      return c.error({
        code: 'NOT_AUTHENTICATED',
        message: 'GitHub token not found',
        hint: 'Tokens expire after 30 days.',
        retryable: true,
        exitCode: 3,
        cta: { commands: [{ command: 'auth login', description: 'Log in to GitHub' }, 'status'] },
      })
    },
  })
  .command('throw', {
    description: 'Throw an error',
    run() {
      throw new Error('boom')
    },
  })
  .command('throw-incur', {
    description: 'Throw an incur error',
    run() {
      throw new Errors.IncurError({ code: 'RATE_LIMITED', message: 'Slow down', retryable: true })
    },
  })
  .command('deploy', {
    description: 'Deploy the app',
    aliases: ['ship'],
    destructive: true,
    hint: 'Requires a deploy token.',
    env: z.object({
      DEPLOY_TOKEN: z.string().describe('Deploy token'),
      DEPLOY_REGION: z.string().default('us').describe('Region'),
      DEPLOY_RETRIES: z.number().optional().describe('Retries'),
      DEPLOY_DRY: z.boolean().optional().describe('Dry run'),
    }),
    options: z.object({
      zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
      region: z.string().optional().describe('Target region'),
      force: z.boolean().optional().describe('Force deploy'),
    }),
    alias: { zone: 'z', force: 'f' },
    run: (c) => ({
      deployed: true,
      region: c.options.region ?? c.env.DEPLOY_REGION,
      retries: c.env.DEPLOY_RETRIES ?? null,
      dry: c.env.DEPLOY_DRY ?? null,
    }),
  })
  .command('logs', {
    description: 'Tail logs',
    async *run(c) {
      yield 'connecting...'
      yield { progress: 50 }
      yield { progress: 100 }
      return c.ok(undefined, { cta: { commands: ['status'] } })
    },
  })
  .command('stream-fail', {
    description: 'Stream then fail',
    async *run(c) {
      yield { step: 1 }
      yield c.error({
        code: 'STREAM_BROKE',
        message: 'stream broke',
        cta: { commands: ['status'] },
      })
    },
  })
  .command('nuke', {
    description: 'Delete everything',
    destructive: true,
    hint: 'Confirm with the user before executing this destructive command.',
    run: () => ({ nuked: true }),
  })
  .command('scalar', {
    description: 'Return a string',
    output: z.string(),
    run: () => 'hello world',
  })
  .command('number', { description: 'Return a number', run: () => 42 })
  .command('nothing', {
    description: 'Return nothing',
    output: z.object({}),
    // The output schema documents an empty object; returning nothing is still allowed at runtime.
    run: () => undefined as never,
  })
  .command('json-string', { description: 'Return JSON text', run: () => '{"b":1,"a":[1,2]}' })
  .command('array', { description: 'Return an array', run: () => [1, 2, 3] })
  .command('objects', { description: 'Return objects', output: z.unknown(), run: () => users })
  .command('mixed', { description: 'Return mixed data', run: () => mixed })
  .command('data', {
    description: 'Return parsed JSON',
    args: z.object({ json: z.string().describe('JSON value') }),
    run: (c) => JSON.parse(c.args.json),
  })
  .command('secret', {
    description: 'Agent-only output',
    outputPolicy: 'agent-only',
    run: () => ({ token: 'abc' }),
  })
  .command('count', {
    description: 'Count flags',
    options: z.object({
      verbose: z.number().default(0).describe('Verbosity').meta({ count: true }),
      quiet: z.boolean().optional().describe('Quiet'),
      level: z.number().int().optional().describe('Level'),
    }),
    alias: { verbose: 'v', quiet: 'q' },
    run: (c) => ({
      verbose: c.options.verbose,
      quiet: c.options.quiet ?? false,
      level: c.options.level ?? null,
    }),
  })
  .command('tags', {
    description: 'Collect values',
    args: z.object({
      target: z.string().describe('Target'),
      files: z.array(z.string()).min(1).max(3).optional().describe('Files'),
    }),
    options: z.object({ tag: z.array(z.string()).default([]).describe('Tags') }),
    alias: { tag: 't' },
    run: (c) => ({ target: c.args.target, files: c.args.files ?? [], tag: c.options.tag }),
  })
  .command('variadic', {
    description: 'Variadic arg first',
    args: z.object({
      files: z.array(z.string()).describe('Files'),
      last: z.string().describe('Last'),
    }),
    run: () => ({ ok: true }),
  })
  .command('whoami', {
    description: 'Show the acting user',
    run: (c) => ({ user: c.var.user }),
  })
  .command('admin', {
    description: 'Admin only',
    destructive: true,
    middleware: [
      (c, next) => {
        if (c.var.user !== 'root') return c.error({ code: 'FORBIDDEN', message: 'admin only' })
        return next()
      },
    ],
    run: () => ({ admin: true }),
  })
  .command('fmt', {
    description: 'Defaults to JSON',
    format: 'json',
    run: () => ({ a: 1 }),
  })
  .command('usage', {
    description: 'Custom usage',
    args: z.object({ file: z.string().describe('File') }),
    options: z.object({ lines: z.number().optional().describe('Lines') }),
    usage: [
      { args: { file: true } },
      { prefix: 'cat x |', options: { lines: true }, suffix: '| head' },
    ],
    run: () => ({ ok: true }),
  })
  .command(
    Cli.create('pr', {
      description: 'Pull request commands',
      vars: z.object({ user: z.string().default('anonymous') }),
    })
      .use((c, next) => {
        c.set('user', `pr:${c.var.user}`)
        return next()
      })
      .command('list', {
        description: 'List pull requests',
        options: z.object({
          state: z.enum(['open', 'closed', 'all']).default('open').describe('State'),
        }),
        run: (c) => ({ prs: [], state: c.options.state, user: c.var.user }),
      })
      .command('view', {
        description: 'View a pull request',
        args: z.object({ number: z.number().describe('PR number') }),
        run: (c) => ({ number: c.args.number }),
      }),
  )
  .command(
    Cli.create('db', {
      description: 'Database commands',
      outputPolicy: 'agent-only',
      args: z.object({ table: z.string().optional().describe('Table') }),
      run: (c) => ({ tables: c.args.table ? [c.args.table] : ['users', 'posts'] }),
    }).command('migrate', { description: 'Run migrations', run: () => ({ migrated: true }) }),
  )
  .command(
    Cli.create('hi', { description: 'Leaf CLI', aliases: ['hey'], run: () => ({ hi: true }) }),
  )

const greet = Cli.create('greet', {
  description: 'A greeting CLI',
  update: false,
  banner: { render: () => 'Greet banner', mode: 'agent' },
  args: z.object({ name: z.string().describe('Name to greet') }),
  options: z.object({ loud: z.boolean().optional().describe('Shout') }),
  run: (c) => ({ message: c.options.loud ? `HELLO ${c.args.name}` : `hello ${c.args.name}` }),
})

const globals = Cli.create('glob', {
  description: 'Global options',
  update: false,
  globals: z.object({
    verbose: z.boolean().optional().describe('Verbose output'),
    profile: z.string().default('dev').describe('Profile name'),
    debug: z.number().default(0).describe('Debug level').meta({ count: true }),
  }),
  globalAlias: { verbose: 'V', profile: 'P', debug: 'D' },
  banner: { render: () => 'Glob banner', mode: 'human' },
  config: {
    flag: 'config',
    loader: (file) => {
      if (file?.endsWith('none.json')) return undefined
      if (file?.endsWith('array.json')) return [1] as never
      if (file?.endsWith('throw.json')) throw new Error('loader failed')
      return { commands: { show: { options: { name: 'loaded' } } } }
    },
  },
})
  .command('show', {
    description: 'Show globals',
    options: z.object({
      name: z.string().optional().describe('Name'),
      all: z.boolean().optional().describe('All'),
    }),
    alias: { name: 'n', all: 'a' },
    run: (c) => ({ globals: c.globals, name: c.options.name ?? null }),
  })
  .command('pick', {
    description: 'Pick a color',
    options: z.object({
      color: z.enum(['red', 'green']).optional().describe('Color'),
      mode: z.enum(['fast']).optional().describe('Mode'),
    }),
    run: (c) => ({ color: c.options.color ?? null }),
  })

const cfg = Cli.create('cfg', {
  description: 'Config defaults',
  update: false,
  config: { flag: 'config', files: ['config/cfg.json'] },
  env: z.object({ CFG_LIMIT: z.number().optional().describe('Limit') }),
  globals: z.object({ trace: z.boolean().optional().describe('Trace') }),
})
  .command('echo', {
    description: 'Echo text',
    args: z.object({ text: z.string().describe('Text') }),
    options: z.object({
      upper: z.boolean().optional().describe('Uppercase'),
      prefix: z.string().default('>').describe('Prefix'),
      tags: z.array(z.string()).optional().describe('Tags'),
      meta: z
        .object({ a: z.string().describe('A') })
        .optional()
        .describe('Meta'),
      extra: z.unknown().optional().describe('Extra'),
    }),
    run: (c) => ({
      out: `${c.options.prefix} ${c.options.upper ? c.args.text.toUpperCase() : c.args.text}`,
    }),
  })
  .command('ping', { description: 'Ping', run: () => 'pong' })
  .command(
    Cli.create('project', { description: 'Projects' }).command('list', {
      description: 'List projects',
      options: z.object({ limit: z.number().default(10).describe('Limit') }),
      run: (c) => ({ limit: c.options.limit }),
    }),
  )

const plain = Cli.create('plain', {
  description: 'No skills, JSON by default',
  update: false,
  sync: false,
  format: 'json',
  aliases: ['pl', 'plain-cli'],
  config: {},
  banner: () => 'Welcome to plain',
})
  .command('hello', { description: 'Say hello', run: () => ({ hello: 'world' }) })
  .command('ping', { run: () => 'pong' })
  .command('Hello', { description: 'Say hello loudly', run: () => ({ hello: 'WORLD' }) })
  .command('v2', { description: 'Version two', run: () => ({ v: 2 }) })
  .command('ピン', { description: 'Katakana ping', run: () => 'ポン' })

const rooted = Cli.create('rooted', {
  description: 'Root with subcommands',
  update: false,
  config: { files: ['config/cfg.json'] },
  args: z.object({ query: z.string().optional().describe('Query') }),
  run: (c) => ({ query: c.args.query ?? null }),
})
  .command('sub', { description: 'A subcommand', run: () => ({ sub: true }) })
  .command(
    Cli.create('nest', { description: 'Nested commands' }).command('leaf', {
      description: 'A nested leaf',
      run: () => ({ leaf: true }),
    }),
  )

export const clis = { app, cfg, globals, greet, plain, rooted } as const
