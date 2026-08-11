import { Cli, Mcp, z } from 'incur'
import { PassThrough } from 'node:stream'

function createTestCommands() {
  const commands = new Map<string, any>()

  commands.set('ping', {
    description: 'Health check',
    run() {
      return { pong: true }
    },
  })

  commands.set('echo', {
    description: 'Echo a message',
    args: z.object({
      message: z.string().describe('Message to echo'),
    }),
    options: z.object({
      upper: z.boolean().default(false).describe('Uppercase output'),
    }),
    run(c: any) {
      const msg = c.options.upper ? c.args.message.toUpperCase() : c.args.message
      return { result: msg }
    },
  })

  commands.set('greet', {
    _group: true,
    description: 'Greeting commands',
    commands: new Map([
      [
        'hello',
        {
          description: 'Say hello',
          args: z.object({ name: z.string().describe('Name to greet') }),
          run(c: any) {
            return { greeting: `hello ${c.args.name}` }
          },
        },
      ],
    ]),
  })

  commands.set('fail', {
    description: 'Always fails',
    run(c: any) {
      return c.error({ code: 'BOOM', message: 'it broke' })
    },
  })

  commands.set('stream', {
    description: 'Stream chunks',
    async *run() {
      yield { content: 'hello' }
      yield { content: 'world' }
    },
  })

  return commands
}

function createElicitationCommands() {
  const commands = new Map<string, any>()

  commands.set('ask-name', {
    description: 'Ask for a name',
    async run(c: any) {
      const result = await c.elicit.form({
        message: 'Please provide your profile.',
        schema: z.object({
          name: z.string().describe('Display name'),
          age: z.number().optional().describe('Age'),
        }),
      })
      if (result.action !== 'accept') return { action: result.action }
      return { action: result.action, name: result.content.name }
    },
  })

  commands.set('ask-keyed', {
    description: 'Ask with a stable key',
    async run(c: any) {
      const result = await c.elicit.form({
        key: 'profile',
        message: 'Please provide your profile.',
        schema: z.object({ name: z.string() }),
      })
      if (result.action !== 'accept') return { action: result.action }
      return { name: result.content.name }
    },
  })

  commands.set('open-url', {
    description: 'Open a URL',
    async run(c: any) {
      const result = await c.elicit.url({
        elicitationId: 'auth-1',
        message: 'Connect your account.',
        url: 'https://example.com/connect',
      })
      return { action: result.action }
    },
  })

  commands.set('require-url', {
    description: 'Require a URL',
    run(c: any) {
      c.elicit.requireUrl({
        elicitationId: 'auth-2',
        message: 'Connect your account.',
        url: 'https://example.com/connect',
      })
    },
  })

  commands.set('nested-form', {
    description: 'Ask for nested input',
    async run(c: any) {
      await c.elicit.form({
        message: 'Nested input.',
        schema: z.object({ profile: z.object({ name: z.string() }) }),
      })
      return {}
    },
  })

  commands.set('bad-url', {
    description: 'Ask for a bad URL',
    async run(c: any) {
      await c.elicit.url({ message: 'Bad URL.', url: 'not a url' })
      return {}
    },
  })

  return commands
}

function create2026Commands() {
  const commands = createTestCommands()
  commands.set('tasked', {
    description: 'Task backed command',
    mcpTool: { title: 'Tasked', task: { required: true, ttlMs: 300000, pollIntervalMs: 250 } },
    run() {
      return { done: true }
    },
  })
  commands.set('task-slow', {
    description: 'Slow task backed command',
    mcpTool: { title: 'Slow Task', task: { required: true, ttlMs: 300000 } },
    async run() {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return { done: true }
    },
  })
  commands.set('task-input', {
    description: 'Task with input',
    mcpTool: { title: 'Task Input', task: { required: true, ttlMs: 300000 } },
    async run(c: any) {
      const result = await c.elicit.form({
        key: 'profile',
        message: 'Need profile.',
        schema: z.object({ name: z.string() }),
      })
      if (result.action !== 'accept') return { action: result.action }
      return { name: result.content.name }
    },
  })
  commands.set('meta', {
    description: 'Metadata command',
    args: z.object({ token: z.string() }),
    output: z.object({ ok: z.boolean() }),
    mcpTool: {
      title: 'Metadata',
      icons: [{ src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml' }],
      annotations: { readOnlyHint: true },
      headers: { token: 'Authorization' },
    },
    run() {
      return { ok: true }
    },
  })
  return commands
}

/** Standard initialize params for MCP protocol. */
const initParams = {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '1.0.0' },
}

/** Sends JSON-RPC messages, ends the stream, waits for serve to finish, returns parsed responses. */
async function mcpSession(
  commands: Map<string, any>,
  messages: { method: string; params?: unknown; id?: number }[],
  options: Omit<Mcp.serve.Options, 'input' | 'output'> = {},
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk) => chunks.push(chunk.toString()))

  const { tools, ...rest } = options
  const done = Mcp.serve('test-cli', '1.0.0', commands, {
    input,
    output,
    ...rest,
    tools: { discovery: 'direct', ...tools },
  })

  for (const msg of messages) {
    const rpc = { jsonrpc: '2.0', ...msg }
    input.write(`${JSON.stringify(rpc)}\n`)
  }

  await waitForResponses(chunks, messages.filter((msg) => msg.id !== undefined).length)
  input.end()
  await done

  return chunks.map((c) => JSON.parse(c.trim()))
}

function mcpHarness(commands: Map<string, any>) {
  const input = new PassThrough()
  const output = new PassThrough()
  const messages: any[] = []
  const waiters: { predicate: (message: any) => boolean; resolve: (message: any) => void }[] = []
  let buffer = ''

  output.on('data', (chunk) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      messages.push(message)
      const i = waiters.findIndex((w) => w.predicate(message))
      if (i !== -1) waiters.splice(i, 1)[0]!.resolve(message)
    }
  })

  const done = Mcp.serve('test-cli', '1.0.0', commands, {
    input,
    output,
    tools: { discovery: 'direct' },
  })

  return {
    async close() {
      input.end()
      await done
    },
    next(predicate: (message: any) => boolean) {
      const found = messages.find(predicate)
      if (found) return Promise.resolve(found)
      return new Promise<any>((resolve) => waiters.push({ predicate, resolve }))
    },
    send(message: { method?: string; params?: unknown; id?: number | string; result?: unknown }) {
      input.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    },
  }
}

async function mcp2026(
  body: Record<string, unknown>,
  options: Mcp.handle2026Http.Options = {},
  headers: Record<string, string> = {},
) {
  const req = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': Mcp.draftProtocolVersion,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  })
  const res = await Mcp.handle2026Http(req, 'test-cli', '1.0.0', create2026Commands(), options)
  const text = await res.text()
  return { res, body: text ? JSON.parse(text) : undefined }
}

async function waitForResponses(chunks: string[], expected: number) {
  const started = Date.now()
  while (chunks.length < expected) {
    if (Date.now() - started > 1_000) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('Mcp', () => {
  test('initialize responds with server info', async () => {
    const [res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
    ])
    expect(res.id).toBe(1)
    expect(res.result.protocolVersion).toBe('2024-11-05')
    expect(res.result.serverInfo).toEqual({ name: 'test-cli', version: '1.0.0' })
    expect(res.result.capabilities.tools).toBeDefined()
  })

  test('initialize includes the server title', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', createTestCommands(), {
      input,
      output,
      title: 'Test MCP',
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const [res] = chunks.map((chunk) => JSON.parse(chunk.trim()))
    expect(res.result.serverInfo).toEqual({
      name: 'test-cli',
      title: 'Test MCP',
      version: '1.0.0',
    })
  })

  test('initialize with 2025-03-26 protocol version', async () => {
    const [res] = await mcpSession(createTestCommands(), [
      {
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      },
    ])
    expect(res.result.serverInfo).toEqual({ name: 'test-cli', version: '1.0.0' })
    expect(res.result.capabilities.tools).toBeDefined()
  })

  test('tools/list returns all leaf commands as tools', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    const names = res.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['echo', 'fail', 'greet_hello', 'ping', 'stream'])

    const echoTool = res.result.tools.find((t: any) => t.name === 'echo')
    expect(echoTool.description).toBe('Echo a message')
    expect(echoTool.inputSchema.properties.message).toBeDefined()
    expect(echoTool.inputSchema.properties.upper).toBeDefined()
    expect(echoTool.inputSchema.required).toContain('message')
  })

  test('tools/list defaults to progressive discovery', async () => {
    const [, res] = await mcpSession(
      createTestCommands(),
      [
        { id: 1, method: 'initialize', params: initParams },
        { id: 2, method: 'tools/list', params: {} },
      ],
      { tools: { discovery: undefined } },
    )

    expect(res.result.tools.map((tool: any) => tool.name)).toEqual([
      'search_tools',
      'get_tool_details',
      'call_read_tool',
      'call_write_tool',
    ])
    expect(res.result.tools.some((tool: any) => tool.name === 'echo')).toBe(false)
  })

  test('progressive discovery searches, inspects, and gates execution', async () => {
    const commands = new Map<string, any>([
      [
        'read-user',
        {
          description: 'Read a user profile',
          args: z.object({ id: z.string() }),
          mcp: { annotations: { readOnlyHint: true } },
          run: (c: any) => ({ id: c.args.id }),
        },
      ],
      [
        'delete-user',
        {
          description: 'Delete a user profile',
          args: z.object({ id: z.string() }),
          mcp: { annotations: { destructiveHint: true, readOnlyHint: false } },
          run: (c: any) => ({ deleted: c.args.id }),
        },
      ],
    ])
    const responses = await mcpSession(
      commands,
      [
        { id: 1, method: 'initialize', params: initParams },
        {
          id: 2,
          method: 'tools/call',
          params: { name: 'search_tools', arguments: { query: 'user', limit: 1 } },
        },
        {
          id: 3,
          method: 'tools/call',
          params: { name: 'get_tool_details', arguments: { name: 'read-user' } },
        },
        {
          id: 4,
          method: 'tools/call',
          params: {
            name: 'call_read_tool',
            arguments: { name: 'read-user', arguments: { id: '1' } },
          },
        },
        {
          id: 5,
          method: 'tools/call',
          params: {
            name: 'call_read_tool',
            arguments: { name: 'delete-user', arguments: { id: '1' } },
          },
        },
        {
          id: 6,
          method: 'tools/call',
          params: {
            name: 'call_write_tool',
            arguments: { name: 'delete-user', arguments: { id: '1' } },
          },
        },
        {
          id: 7,
          method: 'tools/call',
          params: {
            name: 'call_write_tool',
            arguments: { name: 'read-user', arguments: { id: '1' } },
          },
        },
      ],
      { tools: { discovery: 'progressive' } },
    )

    const byId = new Map(responses.map((response) => [response.id, response]))
    const search = JSON.parse(byId.get(2).result.content[0].text)
    expect(search.tools).toHaveLength(1)
    expect(search.tools[0]).toMatchObject({ name: 'delete-user' })
    expect(search.tools[0]).not.toHaveProperty('inputSchema')

    const details = JSON.parse(byId.get(3).result.content[0].text)
    expect(details.name).toBe('read-user')
    expect(details.inputSchema.properties.id).toBeDefined()
    expect(JSON.parse(byId.get(4).result.content[0].text)).toEqual({ id: '1' })
    expect(byId.get(5).result).toMatchObject({ isError: true })
    expect(JSON.parse(byId.get(5).result.content[0].text)).toEqual({
      error: 'Tool is not read-only: delete-user',
    })
    expect(JSON.parse(byId.get(6).result.content[0].text)).toEqual({ deleted: '1' })
    expect(byId.get(7).result).toMatchObject({ isError: true })
    expect(JSON.parse(byId.get(7).result.content[0].text)).toEqual({
      error: 'Tool is read-only: read-user',
    })
  })

  test('progressive discovery applies tool filters before search', async () => {
    const [, res] = await mcpSession(
      new Map<string, any>([
        ['docs-list', { description: 'List docs', run: () => null }],
        ['secret-list', { description: 'List secrets', run: () => null }],
      ]),
      [
        { id: 1, method: 'initialize', params: initParams },
        {
          id: 2,
          method: 'tools/call',
          params: { name: 'search_tools', arguments: { query: 'list' } },
        },
      ],
      { tools: { discovery: 'progressive', exclude: ['secret-*'] } },
    )

    expect(JSON.parse(res.result.content[0].text).tools.map((tool: any) => tool.name)).toEqual([
      'docs-list',
    ])
  })

  test('collectTools hides commands and groups with mcp false', () => {
    const commands = createTestCommands()
    commands.set('secret', { mcp: false, run: () => ({ ok: true }) })
    commands.set('hidden', {
      _group: true,
      mcp: false,
      commands: new Map([['inside', { run: () => ({ ok: true }) }]]),
    })

    expect(Mcp.collectTools(commands, []).map((tool) => tool.name)).toMatchInlineSnapshot(`
      [
        "echo",
        "fail",
        "greet_hello",
        "ping",
        "stream",
      ]
    `)
  })

  test('collectTools filters tools by include and exclude patterns', () => {
    const commands = new Map<string, any>([
      ['docs_list', { run: () => null }],
      ['docs_secret', { run: () => null }],
      ['users_list', { run: () => null }],
    ])

    expect(
      Mcp.collectTools(commands, [], [], { include: ['docs_*'], exclude: ['*_secret'] }).map(
        (tool) => tool.name,
      ),
    ).toMatchInlineSnapshot(`
      [
        "docs_list",
      ]
    `)
  })

  test('stdio serve filters tools/list by configured patterns', async () => {
    const commands = new Map<string, any>([
      ['docs_list', { run: () => null }],
      ['secret_list', { run: () => null }],
    ])
    const [, res] = await mcpSession(
      commands,
      [
        { id: 1, method: 'initialize', params: initParams },
        { id: 2, method: 'tools/list', params: {} },
      ],
      { tools: { exclude: ['secret_*'] } },
    )

    expect(res.result.tools.map((tool: any) => tool.name)).toMatchInlineSnapshot(`
      [
        "docs_list",
      ]
    `)
  })

  test('tools/list uses command MCP name and description overrides', async () => {
    const commands = new Map<string, any>()
    commands.set('whoami', {
      description: 'Show wallet identity',
      mcp: {
        name: 'get_balance',
        description: 'Get wallet balance',
      },
      run() {
        return { balance: '1.00' }
      },
    })

    const [, listRes] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    const names = listRes.result.tools.map((tool: any) => tool.name)
    expect(names).toEqual(['get_balance'])
    expect(listRes.result.tools[0].description).toBe('Get wallet balance')

    const [, callRes] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'get_balance', arguments: {} } },
    ])
    expect(callRes.result.content).toEqual([{ type: 'text', text: '{"balance":"1.00"}' }])
  })

  test('collectTools rejects duplicate MCP tool names', () => {
    const commands = new Map<string, any>()
    commands.set('whoami', {
      mcp: { name: 'get_balance' },
      run() {
        return { balance: '1.00' }
      },
    })
    commands.set('balance', {
      mcp: { name: 'get_balance' },
      run() {
        return { balance: '1.00' }
      },
    })

    expect(() => Mcp.collectTools(commands, [])).toThrowError(
      'Duplicate MCP tool name: get_balance',
    )
  })

  test('notifications are ignored (no response)', async () => {
    const responses = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { method: 'notifications/initialized' },
      { id: 2, method: 'ping' },
    ])
    expect(responses).toHaveLength(2)
    expect(responses[0].id).toBe(1)
    expect(responses[1].id).toBe(2)
  })

  test('tools/call executes simple command', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"pong":true}' }])
  })

  test('tools/call with args and options', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hello', upper: true } },
      },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"result":"HELLO"}' }])
  })

  test('tools/list and tools/call handle variadic array args', async () => {
    const commands = new Map<string, any>()
    commands.set('lint', {
      description: 'Lint files',
      args: z.object({ paths: z.array(z.string()).describe('Files to lint') }),
      run: (c: any) => ({ count: c.args.paths.length }),
    })

    const [, listRes, callRes] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
      {
        id: 3,
        method: 'tools/call',
        params: { name: 'lint', arguments: { paths: ['a.ts', 'b.ts'] } },
      },
    ])

    expect(listRes.result.tools[0].inputSchema.properties.paths).toMatchObject({ type: 'array' })
    expect(callRes.result.content).toEqual([{ type: 'text', text: '{"count":2}' }])
  })

  test('tools/call validation error includes fieldErrors', async () => {
    const tool = Mcp.collectTools(createTestCommands(), []).find((tool) => tool.name === 'echo')!
    const result = await Mcp.callTool(tool, { message: 123 })
    expect(result.isError).toBe(true)
    const [content] = result.content
    expect(content).toBeDefined()
    expect(JSON.parse(content!.text)).toMatchObject({
      code: 'VALIDATION_ERROR',
      fieldErrors: [{ code: 'invalid_type', missing: false, path: 'message' }],
    })
  })

  test('tools/call with nested group command', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'greet_hello', arguments: { name: 'world' } },
      },
    ])
    expect(res.result.content).toEqual([{ type: 'text', text: '{"greeting":"hello world"}' }])
  })

  test('tools/call serializes bigint values as strings', async () => {
    const commands = new Map<string, any>()
    commands.set('whois', {
      description: 'Return ENS data',
      output: z.object({ expiry: z.bigint() }),
      run() {
        return { expiry: 2461152330n }
      },
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'whois', arguments: {} } },
    ])
    expect(res.result.isError).toBeUndefined()
    expect(res.result.content).toEqual([{ type: 'text', text: '{"expiry":"2461152330"}' }])
    expect(res.result.structuredContent).toEqual({ expiry: '2461152330' })
  })

  test('tools/list tolerates non-object output schemas', async () => {
    const commands = new Map<string, any>()
    commands.set('list', {
      description: 'List records',
      output: z.array(z.object({ id: z.string() })),
      run() {
        return [{ id: 'foo' }]
      },
    })
    commands.set('count', {
      description: 'Count records',
      output: z.number(),
      run() {
        return 1
      },
    })
    commands.set('show', {
      description: 'Show record',
      output: z.object({ id: z.string() }),
      run() {
        return { id: 'foo' }
      },
    })

    const tools = Mcp.collectTools(commands, [])
    expect(tools.find((tool) => tool.name === 'list')?.outputSchema).toBeUndefined()
    expect(tools.find((tool) => tool.name === 'count')?.outputSchema).toBeUndefined()
    expect(tools.find((tool) => tool.name === 'show')?.outputSchema?.type).toBe('object')

    const [, listRes] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    expect(listRes.error).toBeUndefined()
    expect(listRes.result.tools.map((tool: any) => tool.name).sort()).toEqual([
      'count',
      'list',
      'show',
    ])

    const [, callRes] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'list', arguments: {} } },
    ])
    expect(callRes.result.content).toEqual([{ type: 'text', text: '[{"id":"foo"}]' }])
    expect(callRes.result.structuredContent).toBeUndefined()
  })

  test('tools/call appends cta suggestions to result text', async () => {
    const commands = new Map<string, any>()
    commands.set('show', {
      description: 'Show a record',
      output: z.object({ id: z.string() }),
      run(c: any) {
        return c.ok(
          { id: 'foo' },
          {
            cta: {
              description: 'Next:',
              commands: [{ command: 'list', description: 'List all' }],
            },
          },
        )
      },
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'show', arguments: {} } },
    ])

    expect(res.result.content[0].text).toMatchInlineSnapshot(`
      "{"id":"foo"}

      Next:
        test-cli list - List all"
    `)
    expect(res.result.structuredContent).toEqual({ id: 'foo' })
    expect(res.result._meta?.cta).toEqual({
      description: 'Next:',
      commands: [{ command: 'test-cli list', description: 'List all' }],
    })
  })

  test('tools/call appends cta suggestions to error text', async () => {
    const commands = new Map<string, any>()
    commands.set('deploy', {
      description: 'Deploy a thing',
      run(c: any) {
        return c.error({
          code: 'NOT_AUTHENTICATED',
          message: 'not signed in',
          cta: {
            description: 'Next:',
            commands: [{ command: 'login', description: 'Sign in' }],
          },
        })
      },
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'deploy', arguments: {} } },
    ])

    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatchInlineSnapshot(`
      "not signed in

      Next:
        test-cli login - Sign in"
    `)
    expect(res.result._meta?.cta).toEqual({
      description: 'Next:',
      commands: [{ command: 'test-cli login', description: 'Sign in' }],
    })
  })

  test('callTool serializes bigint values as strings', async () => {
    const result = await Mcp.callTool(
      {
        name: 'whois',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: {
          type: 'object',
          properties: { expiry: { type: 'string' } },
          required: ['expiry'],
        },
        command: {
          run() {
            return { expiry: 2461152330n }
          },
        },
      },
      {},
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: '{"expiry":"2461152330"}' }])
    expect(result.structuredContent).toEqual({ expiry: '2461152330' })
  })

  test('callTool serializes streamed bigint chunks as strings', async () => {
    const notifications: any[] = []
    const result = await Mcp.callTool(
      {
        name: 'whois',
        inputSchema: { type: 'object', properties: {} },
        command: {
          async *run() {
            yield { expiry: 2461152330n }
          },
        },
      },
      {},
      {
        extra: { mcpReq: { _meta: { progressToken: 'tok-1' } } },
        sendNotification: async (notification) => {
          notifications.push(notification)
        },
      },
    )

    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: '[{"expiry":"2461152330"}]' }])
    expect(notifications[0].params.message).toBe('{"expiry":"2461152330"}')
  })

  test('tools/call unknown tool returns error', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ])
    // SDK returns a JSON-RPC error for unknown tools
    const hasError = res.error?.message?.includes('nope') || res.result?.isError
    expect(hasError).toBeTruthy()
  })

  test('tools/call with sentinel error result', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'fail', arguments: {} } },
    ])
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toBe('it broke')
  })

  test('unknown method returns JSON-RPC error', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'bogus/method', params: {} },
    ])
    // SDK returns either a JSON-RPC error or ignores unknown methods
    expect(res.error ?? res.result).toBeDefined()
  })

  test('ping returns empty object', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'ping' },
    ])
    expect(res.result).toEqual({})
  })

  test('options get defaults applied', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'echo', arguments: { message: 'hi' } } },
    ])
    // upper defaults to false, so message stays lowercase
    expect(res.result.content).toEqual([{ type: 'text', text: '{"result":"hi"}' }])
  })

  test('streaming command buffers chunks into array', async () => {
    const [, res] = await mcpSession(createTestCommands(), [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'stream', arguments: {} } },
    ])
    expect(res.result.content).toEqual([
      { type: 'text', text: '[{"content":"hello"},{"content":"world"}]' },
    ])
  })

  test('middleware runs for tool calls', async () => {
    const commands = new Map<string, any>()
    commands.set('secret', {
      description: 'Protected command',
      run: () => ({ secret: 'data' }),
    })
    const middlewares = [
      async (_c: any, next: () => Promise<void>) => {
        _c.set('ran', true)
        await next()
      },
    ]
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', commands, {
      input,
      output,
      middlewares,
      tools: { discovery: 'direct' },
      vars: z.object({ ran: z.boolean().default(false) }),
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 10))
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'secret', arguments: {} } })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const responses = chunks.map((c) => JSON.parse(c.trim()))
    const callRes = responses.find((r: any) => r.id === 2)
    expect(callRes.result.content).toEqual([{ type: 'text', text: '{"secret":"data"}' }])
  })

  test('middleware error blocks tool call', async () => {
    const commands = new Map<string, any>()
    commands.set('secret', {
      description: 'Protected',
      run: () => ({ secret: true }),
    })
    const middlewares = [
      (c: any) => {
        c.error({ code: 'FORBIDDEN', message: 'not allowed' })
      },
    ]
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', commands, {
      input,
      output,
      middlewares,
      tools: { discovery: 'direct' },
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 10))
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'secret', arguments: {} } })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const responses = chunks.map((c) => JSON.parse(c.trim()))
    const callRes = responses.find((r: any) => r.id === 2)
    expect(callRes.result.isError).toBe(true)
    expect(callRes.result.content[0].text).toBe('not allowed')
  })

  test('group middleware runs for nested tool calls', async () => {
    const commands = new Map<string, any>()
    const groupMiddleware = async (c: any, next: () => Promise<void>) => {
      c.set('group', 'admin')
      await next()
    }
    commands.set('admin', {
      _group: true,
      description: 'Admin commands',
      middlewares: [groupMiddleware],
      commands: new Map([
        [
          'status',
          {
            description: 'Admin status',
            run: (c: any) => ({ group: c.var.group }),
          },
        ],
      ]),
    })

    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', commands, {
      input,
      output,
      tools: { discovery: 'direct' },
      vars: z.object({ group: z.string().default('none') }),
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 10))
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'admin_status', arguments: {} } })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const responses = chunks.map((c) => JSON.parse(c.trim()))
    const callRes = responses.find((r: any) => r.id === 2)
    expect(callRes.result.content).toEqual([{ type: 'text', text: '{"group":"admin"}' }])
  })

  test('env schema is parsed for tool calls', async () => {
    const commands = new Map<string, any>()
    commands.set('check-env', {
      description: 'Check env',
      env: z.object({ MY_VAR: z.string().default('default-val') }),
      run: (c: any) => ({ val: c.env.MY_VAR }),
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'check-env', arguments: {} } },
    ])
    const data = JSON.parse(res.result.content[0].text)
    expect(data.val).toBe('default-val')
  })

  test('streaming command sends progress notifications', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: any[] = []
    output.on('data', (chunk) => chunks.push(JSON.parse(chunk.toString().trim())))

    const done = Mcp.serve('test-cli', '1.0.0', createTestCommands(), {
      input,
      output,
      tools: { discovery: 'direct' },
    })

    // Initialize
    input.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 10))

    // Call streaming tool with progressToken
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'stream', arguments: {}, _meta: { progressToken: 'tok-1' } },
      }) + '\n',
    )
    await new Promise((r) => setTimeout(r, 50))
    input.end()
    await done

    // Filter for progress notifications
    const progress = chunks.filter((c) => c.method === 'notifications/progress')
    expect(progress).toHaveLength(2)
    expect(progress[0].params.message).toBe('{"content":"hello"}')
    expect(progress[1].params.message).toBe('{"content":"world"}')
    expect(progress[0].params.progress).toBe(1)
    expect(progress[1].params.progress).toBe(2)
  })

  test('tools/call can request form elicitation', async () => {
    const session = mcpHarness(createElicitationCommands())
    session.send({
      id: 1,
      method: 'initialize',
      params: {
        ...initParams,
        capabilities: { elicitation: { form: {} } },
      },
    })
    await session.next((m) => m.id === 1)

    session.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'ask-name', arguments: {} },
    })
    const request = await session.next((m) => m.method === 'elicitation/create')
    expect(request.params).toMatchObject({
      mode: 'form',
      message: 'Please provide your profile.',
      requestedSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      },
    })

    session.send({
      id: request.id,
      result: { action: 'accept', content: { name: 'octocat', age: 30 } },
    })
    const response = await session.next((m) => m.id === 2)
    expect(JSON.parse(response.result.content[0].text)).toEqual({
      action: 'accept',
      name: 'octocat',
    })
    await session.close()
  })

  test('empty elicitation capability supports form mode', async () => {
    const session = mcpHarness(createElicitationCommands())
    session.send({
      id: 1,
      method: 'initialize',
      params: {
        ...initParams,
        capabilities: { elicitation: {} },
      },
    })
    await session.next((m) => m.id === 1)

    session.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'ask-name', arguments: {} },
    })
    const request = await session.next((m) => m.method === 'elicitation/create')
    session.send({ id: request.id, result: { action: 'decline' } })
    const response = await session.next((m) => m.id === 2)
    expect(JSON.parse(response.result.content[0].text)).toEqual({ action: 'decline' })
    await session.close()
  })

  test('tools/call can request URL elicitation', async () => {
    const session = mcpHarness(createElicitationCommands())
    session.send({
      id: 1,
      method: 'initialize',
      params: {
        ...initParams,
        capabilities: { elicitation: { url: {} } },
      },
    })
    await session.next((m) => m.id === 1)

    session.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'open-url', arguments: {} },
    })
    const request = await session.next((m) => m.method === 'elicitation/create')
    expect(request.params).toMatchObject({
      mode: 'url',
      elicitationId: 'auth-1',
      message: 'Connect your account.',
      url: 'https://example.com/connect',
    })

    session.send({ id: request.id, result: { action: 'accept' } })
    const response = await session.next((m) => m.id === 2)
    expect(JSON.parse(response.result.content[0].text)).toEqual({ action: 'accept' })
    await session.close()
  })

  test('unsupported URL elicitation returns a tool error', async () => {
    const [, response] = await mcpSession(createElicitationCommands(), [
      {
        id: 1,
        method: 'initialize',
        params: {
          ...initParams,
          capabilities: { elicitation: { form: {} } },
        },
      },
      { id: 2, method: 'tools/call', params: { name: 'open-url', arguments: {} } },
    ])
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('url elicitation')
  })

  test('requireUrl returns URL elicitation required JSON-RPC error', async () => {
    const session = mcpHarness(createElicitationCommands())
    session.send({
      id: 1,
      method: 'initialize',
      params: {
        ...initParams,
        capabilities: { elicitation: { url: {} } },
      },
    })
    await session.next((m) => m.id === 1)

    session.send({
      id: 2,
      method: 'tools/call',
      params: { name: 'require-url', arguments: {} },
    })
    const response = await session.next((m) => m.id === 2)
    expect(response.error.code).toBe(-32042)
    expect(response.error.data.elicitations).toEqual([
      {
        mode: 'url',
        elicitationId: 'auth-2',
        message: 'Connect your account.',
        url: 'https://example.com/connect',
      },
    ])
    await session.close()
  })

  test('invalid form elicitation schema returns a tool error', async () => {
    const [, response] = await mcpSession(createElicitationCommands(), [
      {
        id: 1,
        method: 'initialize',
        params: {
          ...initParams,
          capabilities: { elicitation: { form: {} } },
        },
      },
      { id: 2, method: 'tools/call', params: { name: 'nested-form', arguments: {} } },
    ])
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('must not be nested')
  })

  test('invalid URL elicitation input returns a tool error', async () => {
    const [, response] = await mcpSession(createElicitationCommands(), [
      {
        id: 1,
        method: 'initialize',
        params: {
          ...initParams,
          capabilities: { elicitation: { url: {} } },
        },
      },
      { id: 2, method: 'tools/call', params: { name: 'bad-url', arguments: {} } },
    ])
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('URL elicitation requires a valid URL.')
  })

  test('2026 server/discover advertises stateless capabilities', async () => {
    const { body } = await mcp2026({ id: 1, method: 'server/discover' })
    expect(body.result.resultType).toBe('complete')
    expect(body.result.supportedVersions).toContain(Mcp.draftProtocolVersion)
    expect(body.result.serverInfo).toEqual({ name: 'test-cli', version: '1.0.0' })
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.capabilities.extensions[Mcp.tasksExtensionId]).toEqual({})
  })

  test('2026 rejects unsupported protocol versions', async () => {
    const { res, body } = await mcp2026(
      { id: 1, method: 'tools/list', params: {} },
      {},
      { 'MCP-Protocol-Version': '1999-01-01' },
    )
    expect(res.status).toBe(400)
    expect(body.error.code).toBe(-32001)
    expect(body.error.data.supportedVersions).toContain(Mcp.draftProtocolVersion)
  })

  test('2026 notifications do not return errors', async () => {
    const notification = await mcp2026({ method: 'bogus/method', params: {} })
    expect(notification.res.status).toBe(202)
    expect(notification.body).toBeUndefined()
  })

  test('2026 validates method and name routing headers', async () => {
    const wrongMethod = await mcp2026(
      { id: 1, method: 'tools/list', params: {} },
      {},
      { 'Mcp-Method': 'tools/call' },
    )
    expect(wrongMethod.body.error.code).toBe(-32600)
    expect(wrongMethod.body.error.message).toContain('Mcp-Method')

    const wrongTool = await mcp2026(
      {
        id: 2,
        method: 'tools/call',
        params: { name: 'echo', arguments: { message: 'hi' } },
      },
      {},
      { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'ping' },
    )
    expect(wrongTool.body.error.code).toBe(-32600)
    expect(wrongTool.body.error.message).toContain('Mcp-Name')
  })

  test('stdio routes 2026 server/discover through the stateless dispatcher', async () => {
    const [res] = await mcpSession(create2026Commands(), [
      { id: 1, method: 'server/discover', params: {} },
    ])
    expect(res.result.resultType).toBe('complete')
    expect(res.result.supportedVersions).toContain(Mcp.draftProtocolVersion)
  })

  test('2026 tools/list includes metadata, headers, output schemas, and cache hints', async () => {
    const { body } = await mcp2026(
      {
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/protocolVersion': Mcp.draftProtocolVersion },
        },
      },
      { cache: { ttlMs: 1000, cacheScope: 'private' } },
    )
    const tool = body.result.tools.find((t: any) => t.name === 'meta')
    expect(body.result.resultType).toBe('complete')
    expect(body.result.ttlMs).toBe(1000)
    expect(tool.title).toBe('Metadata')
    expect(tool.icons[0].src).toBe('https://example.com/icon.svg')
    expect(tool.annotations.readOnlyHint).toBe(true)
    expect(tool.inputSchema.properties.token['x-mcp-header']).toBe('Authorization')
    expect(tool.outputSchema.properties.ok).toBeDefined()
  })

  test('2026 tools/call executes without initialize', async () => {
    const { body } = await mcp2026(
      {
        id: 1,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: 'hi', upper: true },
          _meta: { 'io.modelcontextprotocol/protocolVersion': Mcp.draftProtocolVersion },
        },
      },
      {},
      { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' },
    )
    expect(body.result.resultType).toBe('complete')
    expect(JSON.parse(body.result.content[0].text)).toEqual({ result: 'HI' })
  })

  test('2026 tools/call uses MRTR elicitation input requests and responses', async () => {
    const req = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': Mcp.draftProtocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ask-name', arguments: {} },
      }),
    })
    const first = await Mcp.handle2026Http(req, 'test-cli', '1.0.0', createElicitationCommands())
    const firstBody = (await first.json()) as any
    expect(firstBody.result.resultType).toBe('input_required')
    expect(firstBody.result.inputRequests.input_1.params.mode).toBe('form')

    const retry = new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': Mcp.draftProtocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'ask-name',
          arguments: {},
          inputResponses: { input_1: { action: 'accept', content: { name: 'octocat', age: 30 } } },
          requestState: firstBody.result.requestState,
        },
      }),
    })
    const second = await Mcp.handle2026Http(retry, 'test-cli', '1.0.0', createElicitationCommands())
    const secondBody = (await second.json()) as any
    expect(secondBody.result.resultType).toBe('complete')
    expect(JSON.parse(secondBody.result.content[0].text)).toEqual({
      action: 'accept',
      name: 'octocat',
    })
  })

  test('2026 MRTR elicitation supports stable keys', async () => {
    const first = await Mcp.handle2026Http(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': Mcp.draftProtocolVersion,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ask-keyed', arguments: {} },
        }),
      }),
      'test-cli',
      '1.0.0',
      createElicitationCommands(),
    )
    const firstBody = (await first.json()) as any
    expect(firstBody.result.inputRequests.profile.params.mode).toBe('form')

    const second = await Mcp.handle2026Http(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': Mcp.draftProtocolVersion,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'ask-keyed',
            arguments: {},
            inputResponses: { profile: { action: 'accept', content: { name: 'octocat' } } },
          },
        }),
      }),
      'test-cli',
      '1.0.0',
      createElicitationCommands(),
    )
    const secondBody = (await second.json()) as any
    expect(JSON.parse(secondBody.result.content[0].text)).toEqual({ name: 'octocat' })
  })

  test('2026 resources, prompts, apps, and completion are exposed through Cli.fetch', async () => {
    const cli = Cli.create('tool')
      .resource('config', {
        uri: 'file:///config.json',
        title: 'Config',
        read: () => ({
          uri: 'file:///config.json',
          mimeType: 'application/json',
          text: '{"ok":true}',
        }),
      })
      .resourceTemplate('user', {
        uriTemplate: 'file:///users/{id}.json',
        complete: { id: (value) => ['one', 'two'].filter((id) => id.startsWith(value)) },
      })
      .prompt('review', {
        args: z.object({ language: z.string().describe('Language') }),
        complete: {
          language: (value) => ['typescript', 'rust'].filter((lang) => lang.startsWith(value)),
        },
        get: (args) => [{ role: 'user', content: Mcp.text(`Review ${args.language}`) }],
      })
      .app('panel', { resourceUri: 'ui://panel', html: '<main>panel</main>' })

    async function request(method: string, params: Record<string, unknown> = {}) {
      const res = await cli.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'MCP-Protocol-Version': Mcp.draftProtocolVersion,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        }),
      )
      return (await res.json()) as any
    }

    expect(
      (await request('resources/list')).result.resources.map((r: any) => r.uri).sort(),
    ).toEqual(['file:///config.json', 'ui://panel'])
    expect(
      (await request('resources/templates/list')).result.resourceTemplates[0].uriTemplate,
    ).toBe('file:///users/{id}.json')
    const panel = (await request('resources/read', { uri: 'ui://panel' })).result.contents[0]
    expect(panel.text).toContain('panel')
    expect(panel.mimeType).toBe(Mcp.appResourceMimeType)
    const missing = await request('resources/read', { uri: 'file:///missing.json' })
    expect(missing.error.code).toBe(-32602)
    expect(missing.error.data.uri).toBe('file:///missing.json')
    expect((await request('prompts/list')).result.prompts[0].name).toBe('review')
    expect(
      (await request('prompts/get', { name: 'review', arguments: { language: 'typescript' } }))
        .result.messages[0].content.text,
    ).toBe('Review typescript')
    expect(
      (
        await request('completion/complete', {
          ref: { type: 'ref/prompt', name: 'review' },
          argument: { name: 'language', value: 't' },
        })
      ).result.completion.values,
    ).toEqual(['typescript'])
    expect(
      (
        await request('completion/complete', {
          ref: { type: 'ref/resource', uri: 'file:///users/{id}.json' },
          argument: { name: 'id', value: 'o' },
        })
      ).result.completion.values,
    ).toEqual(['one'])
    expect((await request('prompts/get', { name: 'review', arguments: {} })).error.code).toBe(
      -32602,
    )

    const discover = await request('server/discover')
    expect(discover.result.capabilities.extensions[Mcp.appsExtensionId].mimeTypes).toEqual([
      Mcp.appResourceMimeType,
    ])
    expect(discover.result.capabilities.extensions[Mcp.appsExtensionAlias].mimeTypes).toEqual([
      Mcp.appResourceMimeType,
    ])
  })

  test('2026 task-backed tools can be polled and cancelled', async () => {
    const created = await mcp2026({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'tasked',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [Mcp.tasksExtensionId]: {} },
          },
        },
      },
    })
    expect(created.body.result.resultType).toBe('task')
    const taskId = created.body.result.taskId
    expect(taskId).toEqual(expect.any(String))
    expect(created.body.result.ttlMs).toBe(300000)
    expect(created.body.result.pollIntervalMs).toBe(250)

    await new Promise((resolve) => setTimeout(resolve, 10))
    const polled = await mcp2026({ id: 2, method: 'tasks/get', params: { taskId } })
    expect(polled.body.result.status).toBe('completed')
    expect(JSON.parse(polled.body.result.result.content[0].text)).toEqual({ done: true })

    const cancelled = await mcp2026({ id: 3, method: 'tasks/cancel', params: { taskId } })
    expect(cancelled.body.result).toEqual({ resultType: 'complete' })
    const afterCancel = await mcp2026({ id: 4, method: 'tasks/get', params: { taskId } })
    expect(afterCancel.body.result.status).toBe('cancelled')
  })

  test('2026 task cancellation remains final after command completion', async () => {
    const created = await mcp2026({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'task-slow',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [Mcp.tasksExtensionId]: {} },
          },
        },
      },
    })
    const taskId = created.body.result.taskId

    await mcp2026({ id: 2, method: 'tasks/cancel', params: { taskId } })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const polled = await mcp2026({ id: 3, method: 'tasks/get', params: { taskId } })
    expect(polled.body.result.status).toBe('cancelled')
    expect(polled.body.result.result).toBeUndefined()
  })

  test('2026 task methods validate Mcp-Name against taskId', async () => {
    const created = await mcp2026({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'tasked',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [Mcp.tasksExtensionId]: {} },
          },
        },
      },
    })
    const wrongName = await mcp2026(
      { id: 2, method: 'tasks/get', params: { taskId: created.body.result.taskId } },
      {},
      { 'Mcp-Method': 'tasks/get', 'Mcp-Name': 'not-the-task' },
    )
    expect(wrongName.body.error.code).toBe(-32600)
    expect(wrongName.body.error.message).toContain('taskId')
  })

  test('2026 task tools require client task extension support', async () => {
    const created = await mcp2026({
      id: 1,
      method: 'tools/call',
      params: { name: 'tasked', arguments: {} },
    })
    expect(created.body.error.code).toBe(-32003)
    expect(created.body.error.data.requiredCapabilities.extensions[Mcp.tasksExtensionId]).toEqual(
      {},
    )
  })

  test('2026 task tools can enter input_required and resume through tasks/update', async () => {
    const created = await mcp2026({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'task-input',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [Mcp.tasksExtensionId]: {} },
          },
        },
      },
    })
    const taskId = created.body.result.taskId

    await new Promise((resolve) => setTimeout(resolve, 10))
    const waiting = await mcp2026({ id: 2, method: 'tasks/get', params: { taskId } })
    expect(waiting.body.result.status).toBe('input_required')
    expect(waiting.body.result.inputRequests.profile.params.mode).toBe('form')

    const updated = await mcp2026({
      id: 3,
      method: 'tasks/update',
      params: {
        taskId,
        inputResponses: { profile: { action: 'accept', content: { name: 'octocat' } } },
      },
    })
    expect(updated.body.result).toEqual({ resultType: 'complete' })

    await new Promise((resolve) => setTimeout(resolve, 10))
    const completed = await mcp2026({ id: 4, method: 'tasks/get', params: { taskId } })
    expect(completed.body.result.status).toBe('completed')
    expect(JSON.parse(completed.body.result.result.content[0].text)).toEqual({ name: 'octocat' })
  })

  test('2026 task cancellation clears pending input requests', async () => {
    const created = await mcp2026({
      id: 1,
      method: 'tools/call',
      params: {
        name: 'task-input',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/clientCapabilities': {
            extensions: { [Mcp.tasksExtensionId]: {} },
          },
        },
      },
    })
    const taskId = created.body.result.taskId

    await new Promise((resolve) => setTimeout(resolve, 10))
    await mcp2026({ id: 2, method: 'tasks/cancel', params: { taskId } })
    const cancelled = await mcp2026({ id: 3, method: 'tasks/get', params: { taskId } })
    expect(cancelled.body.result.status).toBe('cancelled')
    expect(cancelled.body.result.inputRequests).toBeUndefined()

    await mcp2026({
      id: 4,
      method: 'tasks/update',
      params: {
        taskId,
        inputResponses: { profile: { action: 'accept', content: { name: 'octocat' } } },
      },
    })
    const afterUpdate = await mcp2026({ id: 5, method: 'tasks/get', params: { taskId } })
    expect(afterUpdate.body.result.status).toBe('cancelled')
    expect(afterUpdate.body.result.result).toBeUndefined()
  })

  test('2026 authorization extensions advertise and enforce an authorization hook', async () => {
    const cli = Cli.create('secure', {
      mcpServer: {
        authorization: {
          oauthClientCredentials: { scopes: ['read:tools'] },
          enterpriseManagedAuthorization: true,
          authorize: ({ bearerToken }) => bearerToken === 'good',
        },
      },
    }).command('ping', { run: () => ({ pong: true }) })

    async function request(token?: string) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': Mcp.draftProtocolVersion,
      }
      if (token) headers.Authorization = `Bearer ${token}`
      const res = await cli.fetch(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          }),
        }),
      )
      return (await res.json()) as any
    }

    const denied = await request('bad')
    expect(denied.error.code).toBe(-32004)
    expect(denied.error.data.extensions[Mcp.oauthClientCredentialsExtensionId]).toEqual({
      scopes: ['read:tools'],
    })

    const allowed = await request('good')
    expect(allowed.result.tools[0].name).toBe('ping')

    const discover = await cli.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'server/discover' }),
      }),
    )
    const discoverBody = (await discover.json()) as any
    expect(
      discoverBody.result.capabilities.extensions[Mcp.oauthClientCredentialsExtensionId],
    ).toEqual({ scopes: ['read:tools'] })
    expect(
      discoverBody.result.capabilities.extensions[Mcp.enterpriseManagedAuthorizationExtensionId],
    ).toEqual({})
  })

  test('serve options.instructions appears in initialize response', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk) => chunks.push(chunk.toString()))

    const done = Mcp.serve('test-cli', '1.0.0', createTestCommands(), {
      input,
      output,
      instructions: 'Use this CLI to run test commands.',
    })

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: initParams })}\n`,
    )
    await new Promise((r) => setTimeout(r, 20))
    input.end()
    await done

    const [res] = chunks.map((c) => JSON.parse(c.trim()))
    expect(res.result.instructions).toBe('Use this CLI to run test commands.')
  })

  test('command mcp.annotations appear in tools/list', async () => {
    const commands = new Map<string, any>()
    commands.set('read-data', {
      description: 'Read some data',
      mcp: { annotations: { readOnlyHint: true, idempotentHint: true } },
      run: () => ({ data: 42 }),
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    const tool = res.result.tools.find((t: any) => t.name === 'read-data')
    expect(tool.annotations).toEqual({ readOnlyHint: true, idempotentHint: true })
  })

  test('command mcp.instructions appear in tools/list as _meta.instructions', async () => {
    const commands = new Map<string, any>()
    commands.set('guided', {
      description: 'A guided command',
      mcp: { instructions: 'Pass a valid JSON payload.' },
      run: () => ({ ok: true }),
    })

    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/list', params: {} },
    ])
    const tool = res.result.tools.find((t: any) => t.name === 'guided')
    expect(tool._meta?.instructions).toBe('Pass a valid JSON payload.')
  })

  test('collectTools extracts annotations and instructions from entry.mcp', () => {
    const commands = new Map<string, any>()
    commands.set('destroy', {
      description: 'Destructive op',
      mcp: {
        annotations: { destructiveHint: true, openWorldHint: false },
        instructions: 'Only call this in dry-run mode.',
      },
      run: () => null,
    })

    const tools = Mcp.collectTools(commands, [])
    expect(tools).toHaveLength(1)
    expect(tools[0]?.annotations).toEqual({ destructiveHint: true, openWorldHint: false })
    expect(tools[0]?.instructions).toBe('Only call this in dry-run mode.')
  })

  test('collectTools omits annotations/instructions when not set', () => {
    const commands = new Map<string, any>()
    commands.set('plain', { description: 'No mcp opts', run: () => null })

    const tools = Mcp.collectTools(commands, [])
    expect(tools[0]?.annotations).toBeUndefined()
    expect(tools[0]?.instructions).toBeUndefined()
  })
})
