/**
 * Reference CLIs for the differential suite. Every language port defines the same CLIs with the
 * same names, schemas, and handlers, and `cases.json` replays the same invocations against each.
 *
 * Schemas follow one canonical form so every port can describe them: `.optional()` or
 * `.default()` first, then `.describe()`, then `.meta()` with `count` before `deprecated`.
 *
 * Beyond the CLIs, ports mirror four pieces of fixture plumbing: `network` (every outgoing
 * `fetch`: `hosted.test` reaches `upstream`, `registry.test` is a fake npm registry, other hosts
 * fail with `fetch failed`), `upstream` (the HTTP API behind fetch-backed and OpenAPI commands),
 * `fakeMcp` (a streamable-HTTP MCP server with canned results), and the OpenAPI documents
 * `miniSpec` and `petSpec`. MCP sources whose `fetch` is another fixture's `cli.fetch` talk to
 * that fixture over in-process HTTP. Update callbacks report their context on stderr.
 */
import { Cli, Errors, Fetch, type Mcp, z } from '../../src/index.js'

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
      DEPLOY_RETRIES: z.int().optional().describe('Retries'),
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
      level: z.int().optional().describe('Level'),
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

/**
 * The fake network. Every outgoing `fetch` (hosted sources, OpenAPI URLs, the npm registry, MCP
 * URLs without a handler) lands here. `hosted.test` and `registry.test` answer; any other host
 * fails like an unreachable server.
 */
async function network(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const { host, pathname } = new URL(request.url)
  if (host === 'hosted.test') return upstream(request)
  if (host === 'registry.test') {
    const name = decodeURIComponent(pathname.slice(1))
    if (name === 'missing') return new Response('Not Found', { status: 404 })
    return Response.json({ name, 'dist-tags': { latest: name === 'stale' ? '0.1.0' : '2.0.0' } })
  }
  throw new TypeError('fetch failed')
}
globalThis.fetch = network as typeof fetch

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * The upstream API behind fetch-backed and OpenAPI commands. Routes on the last path segment, so
 * any prefix reaches the same behavior; unknown routes echo the request.
 */
async function upstream(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const route = url.pathname.split('/').pop()
  if (route === 'openapi.json') return json(miniSpec)
  if (route === 'users') return json({ users })
  if (route === 'text') return new Response('plain text body', { status: 200 })
  if (route === 'fail') return json({ error: { code: 'NOT_FOUND', message: 'No such thing' } }, 404)
  if (route === 'bad') return json({ message: 'Bad input', error: { code: 7 } }, 400)
  if (route === 'boom') return new Response('Internal failure', { status: 500 })
  if (route === 'down') return json({ status: 'down' }, 503)
  if (route === 'empty') return new Response(null, { status: 204 })
  if (route === 'stream')
    return new Response('{"n":1}\n\nnot json\n{"n":2}\n{"n":3}', {
      headers: { 'content-type': 'application/x-ndjson' },
    })
  if (route === 'sse')
    return new Response('data: {"n":1}\n\n', { headers: { 'content-type': 'text/event-stream' } })
  const text = await request.text()
  const body = (() => {
    // No body
    if (!text) return null
    // JSON body
    try {
      return JSON.parse(text)
    } catch {}
    // Any other body
    return text
  })()
  return json({
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(request.headers),
    body,
  })
}

/** A one-operation OpenAPI document served by the upstream API at any `openapi.json`. */
const miniSpec = {
  openapi: '3.1.0',
  info: { title: 'Mini', version: '1.0.0' },
  paths: {
    '/ping': { get: { operationId: 'ping', summary: 'Ping the API' } },
    '/ping/{id}': {
      post: {
        operationId: 'pingOne',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      },
    },
  },
}

const petId = {
  name: 'petId',
  in: 'path',
  required: true,
  description: 'Pet id',
  schema: { type: 'integer' },
}

/** An OpenAPI document covering parameters, bodies, security, refs, and versions. */
const petSpec = {
  openapi: '3.1.0',
  info: { title: 'Pets', version: '1.0.0' },
  security: [{ apiKey: [] }],
  components: {
    securitySchemes: {
      apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key', description: 'API key' },
      bearer: { type: 'http', scheme: 'bearer' },
      basic: { type: 'http', scheme: 'Basic', description: 'Basic credentials' },
      query: { type: 'apiKey', in: 'query', name: 'key' },
      oauth: { type: 'oauth2' },
    },
    schemas: {
      Pet: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Pet name' },
          age: { type: 'integer', minimum: 0 },
          tags: { type: 'array', items: { type: 'string' } },
          owner: { type: 'object', properties: { id: { type: 'string' } } },
        },
        required: ['name'],
      },
    },
    parameters: {
      Limit: {
        name: 'limit',
        in: 'query',
        description: 'Max results',
        schema: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  paths: {
    '/': { get: { operationId: 'index', summary: 'API index' } },
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        description: 'Lists every pet in the store.',
        parameters: [
          { $ref: '#/components/parameters/Limit' },
          {
            name: 'status',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['available', 'sold'] },
          },
          { name: 'vaccinated', in: 'query', schema: { type: 'boolean' } },
          { name: 'X-Trace', in: 'header', description: 'Trace id', schema: { type: 'string' } },
        ],
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        security: [{ bearer: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
        },
      },
    },
    '/pets/{petId}': {
      get: { operationId: 'getPet', summary: 'Get a pet', parameters: [petId] },
      delete: { operationId: 'deletePet', parameters: [petId], security: [] },
      put: {
        summary: 'Replace a pet',
        parameters: [petId],
        security: [{ basic: [] }, { query: [] }, { oauth: [] }, { unknown: [] }],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
        },
      },
    },
    '/pets/{petId}/fail': { get: { operationId: 'failPet', parameters: [petId] } },
    '/store/text': { get: { operationId: 'storeText', description: 'Plain text' } },
    '/store/bad': {
      post: { operationId: 'storeBad', summary: 'Rejected', description: 'Rejected' },
    },
    '/store/boom': { post: { operationId: 'storeBoom' } },
    '/search': {
      get: {
        operationId: 'search',
        summary: 'Search',
        parameters: [
          {
            name: 'q',
            in: 'query',
            required: true,
            schema: { type: 'string', pattern: `^${'[a-z]'.repeat(40)}$`, example: 'abc' },
          },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'score', in: 'query', schema: { type: ['number', 'null'] } },
        ],
      },
    },
    '/v1/users': { get: { operationId: 'listUsersV1', summary: 'List users (v1)' } },
    '/v2/users': { get: { operationId: 'listUsersV2', summary: 'List users (v2)' } },
    '/v2/users/{id}': {
      patch: {
        operationId: 'updateUser',
        summary: 'Update a user',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'limit', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'Limit', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  'header-limit': { type: 'string' },
                  active: { type: 'boolean', description: 'Active flag' },
                },
                required: ['active'],
              },
            },
          },
        },
      },
    },
  },
} as const

/** Builds a CLI that exercises MCP tool behaviors. `tools` and `catalog` differ only in `mcp`. */
function toolCli(
  name: string,
  mcp: { instructions?: string; title?: string; tools: Mcp.ToolFilter },
) {
  return Cli.create(name, {
    description: 'MCP tool behaviors',
    version: '2.0.0',
    update: false,
    sync: false,
    mcp,
    env: z.object({ TOOLS_REGION: z.string().default('eu').describe('Region') }),
    globals: z.object({
      profile: z.string().default('dev').describe('Profile'),
      verbose: z.boolean().optional().describe('Verbose output'),
    }),
    vars: z.object({ trace: z.string().default('none') }),
  })
    .use(async (c, next) => {
      c.set('trace', `root:${c.command}:${c.env.TOOLS_REGION}`)
      await next()
    })
    .command('echo', {
      description: 'Echo text back',
      aliases: ['say'],
      args: z.object({ text: z.string().describe('Text to echo') }),
      options: z.object({
        upper: z.boolean().default(false).describe('Uppercase'),
        times: z.number().int().min(1).max(3).default(1).describe('Repeat count'),
      }),
      output: z.object({ text: z.string().describe('Echoed text') }),
      mcp: {
        annotations: {
          title: 'Echo',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      run(c) {
        const text = c.options.upper ? c.args.text.toUpperCase() : c.args.text
        return { text: Array(c.options.times).fill(text).join(' ') }
      },
    })
    .command('context', {
      description: 'Show globals, env, and vars',
      options: z.object({ label: z.string().optional().describe('Label') }),
      env: z.object({ TOOLS_TOKEN: z.string().optional().describe('Token') }),
      run: (c) => ({
        agent: c.agent,
        format: c.format,
        globals: c.globals,
        label: c.options.label ?? null,
        token: c.env.TOOLS_TOKEN ?? null,
        trace: c.var.trace,
      }),
    })
    .command('named', {
      description: 'Positional named like a global',
      args: z.object({ profile: z.string().describe('Profile argument') }),
      run: (c) => ({ arg: c.args.profile, global: c.globals.profile }),
    })
    .command('deploy', {
      description: 'Deploy with a required token',
      destructive: true,
      env: z.object({ TOOLS_TOKEN: z.string().describe('Token') }),
      run: (c) => ({ deployed: c.env.TOOLS_TOKEN }),
    })
    .command('fail', {
      description: 'Fail with details',
      run: (c) =>
        c.error({
          code: 'QUOTA',
          message: 'Quota exceeded',
          hint: 'Wait a minute.',
          retryable: true,
          exitCode: 4,
          cta: {
            commands: [
              { command: 'echo', args: { text: 'retry' }, description: 'Try again' },
              { command: 'context', options: { label: true } },
            ],
          },
        }),
    })
    .command('plain-fail', {
      description: 'Fail without details',
      run: (c) => c.error({ code: 'NOPE', message: 'nope' }),
    })
    .command('throws', {
      description: 'Throw an error',
      run() {
        throw new Error('kaput')
      },
    })
    .command('suggest', {
      description: 'Return data with suggestions',
      run: (c) =>
        c.ok(
          { done: true },
          { cta: { description: 'Then:', commands: ['echo next', 'tools fail'] } },
        ),
    })
    .command('stream', {
      description: 'Stream chunks',
      async *run(c) {
        yield { n: 1 }
        yield 'two'
        return c.ok(undefined, { cta: { commands: ['echo done'] } })
      },
    })
    .command('stream-plain', {
      description: 'Stream without suggestions',
      async *run() {
        yield { n: 1 }
      },
    })
    .command('stream-fail', {
      description: 'Stream then fail',
      async *run(c) {
        yield { n: 1 }
        yield c.error({ code: 'BROKEN', message: 'stream broke', cta: { commands: ['stream'] } })
      },
    })
    .command('stream-throw', {
      description: 'Stream then throw',
      async *run() {
        yield { n: 1 }
        throw new Error('stream threw')
      },
    })
    .command('stream-return-error', {
      description: 'Stream then return an error',
      async *run(c) {
        yield { n: 1 }
        return c.error({ code: 'LATE', message: 'failed at the end' })
      },
    })
    .command('scalar', { description: 'Return a string', output: z.string(), run: () => 'plain' })
    .command('nothing', { description: 'Return nothing', run: () => undefined })
    .command('hidden', {
      description: 'Hidden from MCP',
      mcp: false,
      run: () => ({ hidden: true }),
    })
    .command('renamed', {
      description: 'Renamed for MCP',
      mcp: { name: 'custom_tool', description: 'A custom tool', instructions: 'Call sparingly.' },
      run: () => ({ renamed: true }),
    })
    .command('guarded', {
      description: 'Requires --verbose',
      middleware: [
        (c, next) => {
          if (!c.globals.verbose) return c.error({ code: 'NEEDS_VERBOSE', message: 'pass verbose' })
          return next()
        },
      ],
      run: (c) => ({ trace: c.var.trace }),
    })
    .command(
      Cli.create('ops', {
        description: 'Operations',
        vars: z.object({ trace: z.string().default('none') }),
        args: z.object({ target: z.string().optional().describe('Target') }),
        run: (c) => ({ ops: c.args.target ?? 'all' }),
      })
        .use(async (c, next) => {
          c.set('trace', `${c.var.trace}>ops`)
          await next()
        })
        .command('list', {
          description: 'List operations',
          options: z.object({ limit: z.number().default(2).describe('Limit') }),
          run: (c) => ({ limit: c.options.limit, trace: c.var.trace }),
        }),
    )
    .command(
      Cli.create('private', { description: 'Hidden group', mcp: false }).command('peek', {
        description: 'Peek',
        run: () => ({ peek: true }),
      }),
    )
}

const tools = toolCli('tools', {
  instructions: 'Use echo for testing.',
  title: 'Tool Box',
  tools: { discovery: 'direct' },
})

const catalog = toolCli('catalog', {
  tools: {
    include: ['echo', 'ops*', 'stream*', 'fail', 'context', 'named', 'deploy'],
    exclude: ['stream-throw'],
  },
})

const bare = Cli.create('bare', { update: false, sync: false })

const dupe = Cli.create('dupe', { description: 'Duplicate tool names', update: false, sync: false })
  .command('a_b', { description: 'Underscored', run: () => 1 })
  .command(Cli.create('a', { description: 'Group' }).command('b', { run: () => 2 }))

const web = Cli.create('web', {
  description: 'HTTP serving',
  version: '3.0.0',
  update: false,
  sync: false,
  mcp: { stateless: false },
  globals: z.object({ region: z.string().default('us').describe('Region') }),
  args: z.object({ name: z.string().optional().describe('Name') }),
  run: (c) => ({ root: true, name: c.args.name ?? null, region: c.globals.region }),
})
  .command('items', {
    description: 'List items',
    args: z.object({ id: z.number().optional().describe('Item id') }),
    options: z.object({
      limit: z.number().default(10).describe('Limit'),
      tags: z.array(z.string()).optional().describe('Tags'),
      verbose: z.boolean().optional().describe('Verbose'),
    }),
    run: (c) => ({ id: c.args.id ?? null, ...c.options, region: c.globals.region }),
  })
  .command('create', {
    description: 'Create an item',
    options: z.object({
      title: z.string().min(1).describe('Title'),
      draft: z.boolean().default(false).describe('Draft'),
    }),
    output: z.object({ title: z.string(), draft: z.boolean() }),
    run: (c) => c.options,
  })
  .command('request', {
    description: 'Inspect the HTTP request',
    run: (c) => ({
      agent: c.request?.headers.get('x-agent') ?? null,
      method: c.request?.method ?? null,
      url: c.request?.url ?? null,
    }),
  })
  .command('stream', {
    description: 'Stream chunks',
    async *run(c) {
      yield { n: 1 }
      yield { n: 2 }
      return c.ok(undefined, { cta: { commands: ['items'] } })
    },
  })
  .command('stream-plain', {
    description: 'Stream without suggestions',
    async *run() {
      yield 'only'
    },
  })
  .command('stream-fail', {
    description: 'Stream then fail',
    async *run(c) {
      yield { n: 1 }
      yield c.error({ code: 'BROKEN', message: 'stream broke', cta: { commands: ['stream'] } })
      yield { n: 2 }
    },
  })
  .command('stream-throw', {
    description: 'Stream then throw',
    async *run() {
      yield { n: 1 }
      throw new Error('stream threw')
    },
  })
  .command('stream-return-error', {
    description: 'Stream then return an error',
    async *run(c) {
      yield { n: 1 }
      return c.error({ code: 'LATE', message: 'failed at the end' })
    },
  })
  .command('fail', {
    description: 'Fail with suggestions',
    run: (c) =>
      c.error({ code: 'NOPE', message: 'nope', retryable: false, cta: { commands: ['items'] } }),
  })
  .command('throws', {
    description: 'Throw an error',
    run() {
      throw new Error('kaput')
    },
  })
  .command(
    Cli.create('admin', { description: 'Admin commands' })
      .use((c, next) => {
        if ((c.globals as { region?: string }).region !== 'eu')
          return c.error({ code: 'REGION', message: 'eu only' })
        return next()
      })
      .command('stats', { description: 'Show stats', run: () => ({ users: 3 }) }),
  )

const gateway = Cli.create('gateway', {
  description: 'Fetch gateways',
  update: false,
  sync: false,
  env: z.object({ GATEWAY_MODE: z.string().optional().describe('Mode') }),
})
  .use(async (c, next) => {
    if (c.env.GATEWAY_MODE === 'deny')
      return c.error({ code: 'DENIED', message: 'gateway denied', cta: { commands: ['status'] } })
    if (c.env.GATEWAY_MODE === 'throw') throw new Error('middleware threw')
    await next()
  })
  .command('api', { description: 'Upstream API', fetch: upstream })
  .command('v1', { fetch: upstream, basePath: '/v1' })
  .command('hosted', {
    description: 'Hosted API',
    fetch: Fetch.fromRequest('http://hosted.test/base/', {
      headers: { authorization: 'Bearer hosted', 'x-default': 'yes' },
    }),
  })
  .command('offline', {
    description: 'Unreachable API',
    fetch: Fetch.fromRequest('http://offline.test'),
  })
  .command('secret', { description: 'Agent-only API', fetch: upstream, outputPolicy: 'agent-only' })
  .command('status', { description: 'Local command', run: () => ({ ok: true }) })
  .command(
    Cli.create('nested', { description: 'Nested gateways' }).command('api', {
      description: 'Nested API',
      fetch: upstream,
    }),
  )

const proxy = Cli.create('proxy', {
  description: 'Root fetch with commands',
  update: false,
  sync: false,
  fetch: upstream,
}).command('local', { description: 'Local command', run: () => ({ local: true }) })

const raw = Cli.create('raw', {
  description: 'Root fetch only',
  update: false,
  sync: false,
  fetch: upstream,
})

const oa = Cli.create('oa', {
  description: 'OpenAPI commands',
  update: false,
  sync: false,
})
  .command('ops', { description: 'Operation mode', fetch: upstream, openapi: petSpec })
  .command('ns', {
    description: 'Namespace mode',
    fetch: upstream,
    basePath: '/base',
    openapi: petSpec,
    openapiConfig: {
      mode: 'namespace',
      groups: {
        pets: 'Pet operations',
        'v2 users': 'Users (v2)',
        missing: 'Ignored',
        'pets petId get': 'Leaf',
      },
      forwardHeaders: ['x-forward', 'x-api-key'],
    },
  })
  .command('latest', {
    description: 'Latest versions only',
    fetch: upstream,
    openapi: petSpec,
    openapiConfig: {
      mode: 'namespace',
      versions: 'latest',
      security: false,
      include: ({ method, path }) => method !== 'delete' && !path.startsWith('/store'),
    },
  })
  .command('compact', {
    description: 'Compact schemas',
    fetch: upstream,
    openapi: petSpec,
    openapiConfig: { compact: true, include: ({ path }) => path === '/search' },
    mcp: false,
  })
  .command('url', {
    description: 'Spec from a URL',
    fetch: upstream,
    openapi: 'http://hosted.test/openapi.json',
  })
  .command('rel', {
    description: 'Spec relative to a hosted source',
    fetch: Fetch.fromRequest('http://hosted.test/svc'),
    openapi: 'openapi.json',
    outputPolicy: 'agent-only',
  })

const oaroot = Cli.create('oaroot', {
  description: 'Root OpenAPI commands',
  version: '0.1.0',
  update: false,
  sync: false,
  fetch: upstream,
  openapi: miniSpec,
  openapiConfig: { mode: 'namespace' },
})

/** A fake streamable-HTTP MCP server with canned tool results. */
async function fakeMcp(request: Request): Promise<Response> {
  const message = (await request.json()) as {
    id?: string
    method: string
    params?: { name?: string; arguments?: Record<string, unknown> }
  }
  const reply = (result: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
      headers: { 'content-type': 'application/json', ...headers },
    })
  const text = (...items: string[]) =>
    reply({ content: items.map((t) => ({ type: 'text', text: t })) })
  if (message.method === 'initialize')
    return reply(
      {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      },
      { 'mcp-session-id': 'fake-session' },
    )
  if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
  if (message.method === 'tools/list')
    return reply({
      tools: [
        {
          name: 'structured',
          description: 'Structured result',
          inputSchema: {
            type: 'object',
            properties: {
              count: { type: 'integer', description: 'Count' },
              label: { type: 'string' },
              on: { type: 'boolean' },
              ratio: { type: ['number', 'null'] },
            },
            required: ['count'],
          },
          outputSchema: { type: 'object', properties: { total: { type: 'number' } } },
          annotations: { readOnlyHint: true },
        },
        { name: 'headers', description: 'Echo MCP headers' },
        { name: 'texts', description: 'Two text items', outputSchema: { type: 'string' } },
        { name: 'words', description: 'Non-JSON text' },
        { name: 'none', description: 'No content' },
        { name: 'tool-error', description: 'Tool error result' },
        { name: 'silent-error', description: 'Tool error without text' },
        { name: 'rpc-error', description: 'JSON-RPC error' },
        { name: 'http-error', description: 'HTTP error' },
        { name: 'sse', description: 'SSE response' },
        { name: 'sse-other', description: 'SSE without a matching message' },
        { name: 'empty-body', description: 'Empty response body' },
      ],
    })
  const args = message.params?.arguments ?? {}
  switch (message.params?.name) {
    case 'structured':
      return reply({
        content: [{ type: 'text', text: 'ignored' }],
        structuredContent: { total: Number(args.count) * 2, args },
      })
    case 'headers':
      return text(
        JSON.stringify({
          session: request.headers.get('mcp-session-id'),
          version: request.headers.get('mcp-protocol-version'),
          custom: request.headers.get('x-custom'),
          accept: request.headers.get('accept'),
        }),
      )
    case 'texts':
      return text('first', 'second')
    case 'words':
      return text('just words')
    case 'none':
      return reply({})
    case 'tool-error':
      return reply({ content: [{ type: 'text', text: 'remote failed' }], isError: true })
    case 'silent-error':
      return reply({ content: [{ type: 'image', data: '' }], isError: true })
    case 'rpc-error':
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32000, message: 'rpc failed' },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    case 'http-error':
      return new Response('unavailable', { status: 503 })
    case 'sse':
      return new Response(
        `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"via":"sse"}' }] } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      )
    case 'sse-other':
      return new Response('data: {"jsonrpc":"2.0","id":"other","result":{}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      })
    default:
      return new Response('', { headers: { 'content-type': 'application/json' } })
  }
}

const remote = Cli.create('remote', {
  description: 'Remote MCP servers',
  update: false,
  sync: false,
})
  .command('direct', {
    description: 'Direct discovery',
    mcp: { url: 'http://tools.test/mcp', fetch: (request) => tools.fetch(request) },
  })
  .command('catalog', {
    description: 'Progressive discovery',
    mcp: { url: 'http://catalog.test/mcp', fetch: (request) => catalog.fetch(request) },
  })
  .command('paged', {
    description: 'Progressive discovery across pages',
    mcp: { url: 'http://app.test/mcp', fetch: (request) => app.fetch(request) },
  })
  .command('session', {
    description: 'Stateful server',
    mcp: { url: 'http://web.test/mcp', fetch: (request) => web.fetch(request) },
  })
  .command('fake', {
    description: 'Canned server',
    outputPolicy: 'agent-only',
    mcp: { url: 'http://fake.test/mcp', fetch: fakeMcp, headers: { 'x-custom': 'yes' } },
  })
  .command('local', { description: 'Local command', run: () => ({ local: true }) })

/** Builds a CLI that syncs skills and registers MCP servers. */
function kitCli(
  name: string,
  options: {
    mcp?: { agents?: string[]; command?: string; name?: string }
    package?: string
    version?: string
  } = {},
) {
  return Cli.create(name, {
    description: 'Skill and MCP sync',
    version: options.version ?? '1.4.0',
    update: false,
    ...(options.package === undefined ? undefined : { package: options.package }),
    ...(options.mcp === undefined ? undefined : { mcp: options.mcp }),
    sync: {
      include: ['skills/*', '_root'],
      body: 'Run `kit auth login` to finish setup.',
      suggestions: ['Show my status', 'Deploy the app'],
    },
  })
    .command('status', {
      description: 'Show status',
      examples: [{ description: 'Show status' }],
      run: () => ({ ok: true }),
    })
    .command('deploy', {
      description: 'Deploy the app',
      destructive: true,
      args: z.object({ env: z.enum(['staging', 'prod']).describe('Target environment') }),
      run: (c) => ({ deployed: c.args.env }),
    })
    .command(
      Cli.create('auth', { description: 'Authentication' })
        .command('login', { description: 'Log in', run: () => ({ ok: true }) })
        .command('logout', {
          description: 'Log out',
          hint: 'Clears tokens.',
          run: () => ({ ok: true }),
        }),
    )
}

const kit = kitCli('kit')
const kitpkg = kitCli('kitpkg', {
  package: '@acme/kit',
  mcp: { name: 'acme', agents: ['amp'] },
})
const kitcmd = kitCli('kitcmd', {
  mcp: { agents: ['cursor', 'amp'], command: 'kit serve --stdio' },
})
const kitbad = kitCli('kitbad', { package: 'Bad Name', version: '1' })
const kitver = kitCli('kitver', { package: 'kitver', version: 'latest' })
const spaced = kitCli('kit tool')

const upd = Cli.create('upd', {
  description: 'Custom updates',
  version: '1.0.0',
  update: {
    check: (c) => {
      process.stderr.write(`check ${JSON.stringify(c)}\n`)
      return c.current === '1.0.0' ? '1.2.0' : undefined
    },
    install: (c) => {
      process.stderr.write(`install ${JSON.stringify(c)}\n`)
    },
  },
}).command('status', { description: 'Show status', run: () => ({ ok: true }) })

const updbeta = Cli.create('updbeta', {
  description: 'Prerelease updates',
  version: '1.0.0-beta.2',
  sync: false,
  update: {
    check: () => 'not-a-version',
    deferred: true,
    install: () => {
      throw new Error('installer failed')
    },
  },
}).command('status', { description: 'Show status', run: () => ({ ok: true }) })

const updcheck = Cli.create('updcheck', {
  version: '1.0.0',
  sync: false,
  update: {
    check: () => {
      throw new Error('check failed')
    },
    deferred: true,
    install: () => {},
  },
}).command('status', { run: () => ({ ok: true }) })

const updnone = Cli.create('updnone', {
  version: '1.0.0',
  sync: false,
  update: { check: () => '9.0.0' },
}).command('status', { run: () => ({ ok: true }) })

const updpkg = Cli.create('updpkg', { description: 'Package updates', sync: false }).command(
  'status',
  {
    run: () => ({ ok: true }),
  },
)

const updbad = Cli.create('updbad', { sync: false, update: { package: 'Bad Name!' } }).command(
  'status',
  {
    run: () => ({ ok: true }),
  },
)

export const clis = {
  app,
  bare,
  catalog,
  cfg,
  dupe,
  gateway,
  globals,
  greet,
  kit,
  kitbad,
  kitcmd,
  kitpkg,
  kitver,
  oa,
  oaroot,
  plain,
  proxy,
  raw,
  remote,
  rooted,
  spaced,
  tools,
  upd,
  updbad,
  updbeta,
  updcheck,
  updnone,
  updpkg,
  web,
} as const
