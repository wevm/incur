import { Errors, Mcp, z } from 'incur'
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
  options: Omit<Mcp.serve.Options<z.ZodObject<any> | undefined>, 'input' | 'output'> = {},
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

  test.each(['direct', 'progressive'] as const)(
    'tools/list returns no tools after initialize when none are exposed (%s)',
    async (discovery) => {
      const commands = new Map<string, any>([['hidden', { mcp: false, run: () => null }]])
      const responses = await mcpSession(
        commands,
        [
          { id: 1, method: 'initialize', params: initParams },
          { id: 2, method: 'tools/list', params: {} },
        ],
        { tools: { discovery } },
      )

      expect(responses.map((res) => res.id)).toEqual([1, 2])
      expect(responses[0].result.capabilities.tools).toEqual({ listChanged: true })
      expect(responses[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } })
    },
  )

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

  test('collectTools includes callable groups and their child commands', () => {
    const commands = new Map<string, any>([
      [
        'project',
        {
          _group: true,
          root: { description: 'Show project', run: () => null },
          commands: new Map([['list', { description: 'List projects', run: () => null }]]),
        },
      ],
    ])

    expect(Mcp.collectTools(commands, []).map((tool) => tool.name)).toEqual([
      'project',
      'project_list',
    ])
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

  test('tools/call thrown IncurError keeps cta and hint like error()', async () => {
    const options = {
      code: 'NOT_AUTHENTICATED',
      cta: { description: 'Next:', commands: [{ command: 'login', description: 'Sign in' }] },
      exitCode: 4,
      hint: 'Sign in, then retry.',
      message: 'not signed in',
      retryable: true,
    }
    const commands = new Map<string, any>()
    commands.set('returned', { run: (c: any) => c.error(options) })
    commands.set('thrown', {
      run() {
        throw new Errors.IncurError(options)
      },
    })

    const responses = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'returned', arguments: {} } },
      { id: 3, method: 'tools/call', params: { name: 'thrown', arguments: {} } },
    ])
    const returned = responses.find((r) => r.id === 2).result
    const thrown = responses.find((r) => r.id === 3).result

    expect(thrown).toEqual(returned)
    expect(thrown).toMatchInlineSnapshot(`
      {
        "_meta": {
          "cta": {
            "commands": [
              {
                "command": "test-cli login",
                "description": "Sign in",
              },
            ],
            "description": "Next:",
          },
          "error": {
            "code": "NOT_AUTHENTICATED",
            "exitCode": 4,
            "retryable": true,
          },
        },
        "content": [
          {
            "text": "not signed in
      Hint: Sign in, then retry.

      Next:
        test-cli login - Sign in",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `)
  })

  test.each([
    {
      name: 'error()',
      run: (c: any) => c.error({ code: 'BOOM', message: 'it broke', retryable: true, exitCode: 3 }),
      text: 'it broke',
      error: { code: 'BOOM', exitCode: 3, retryable: true },
    },
    {
      name: 'error() without retryable or exitCode',
      run: (c: any) => c.error({ code: 'BOOM', message: 'it broke' }),
      text: 'it broke',
      error: { code: 'BOOM' },
    },
    {
      name: 'thrown IncurError',
      run() {
        throw new Errors.IncurError({ code: 'LIMITED', message: 'too fast', exitCode: 75 })
      },
      text: 'too fast',
      error: { code: 'LIMITED', exitCode: 75, retryable: false },
    },
    {
      name: 'thrown IncurError mid-stream',
      async *run() {
        yield { step: 1 }
        throw new Errors.IncurError({ code: 'LIMITED', message: 'too fast', retryable: true })
      },
      text: 'too fast',
      error: { code: 'LIMITED', retryable: true },
    },
    {
      name: 'thrown Error',
      run() {
        throw new Error('kaboom')
      },
      text: 'kaboom',
      error: { code: 'UNKNOWN' },
    },
  ])('tools/call $name carries code, retryable, and exitCode in _meta', async (c) => {
    const commands = new Map<string, any>([['fail', { run: c.run }]])
    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'fail', arguments: {} } },
    ])
    expect(res.result).toEqual({
      content: [{ type: 'text', text: c.text }],
      _meta: { error: c.error },
      isError: true,
    })
  })

  test.each([
    {
      name: 'yielded error()',
      async *run(c: any) {
        yield { step: 1 }
        yield c.error({ code: 'STREAM_ERR', message: 'mid-stream', exitCode: 3 })
        yield { step: 2 }
      },
      result: {
        content: [{ type: 'text', text: 'mid-stream' }],
        _meta: { error: { code: 'STREAM_ERR', exitCode: 3 } },
        isError: true,
      },
    },
    {
      name: 'returned error()',
      async *run(c: any) {
        yield { step: 1 }
        return c.error({
          code: 'RET_ERR',
          message: 'returned',
          retryable: true,
          cta: { commands: ['retry'] },
        })
      },
      result: {
        content: [{ type: 'text', text: 'returned\n\nSuggested command:\n  test-cli retry' }],
        _meta: {
          cta: { description: 'Suggested command:', commands: [{ command: 'test-cli retry' }] },
          error: { code: 'RET_ERR', retryable: true },
        },
        isError: true,
      },
    },
    {
      name: 'returned ok() with cta',
      async *run(c: any) {
        yield { step: 1 }
        return c.ok(undefined, { cta: { commands: ['status'] } })
      },
      result: {
        content: [{ type: 'text', text: '[{"step":1}]\n\nSuggested command:\n  test-cli status' }],
        _meta: {
          cta: { description: 'Suggested command:', commands: [{ command: 'test-cli status' }] },
        },
      },
    },
    {
      name: 'returned plain value',
      async *run() {
        yield { step: 1 }
        return { ignored: true }
      },
      result: { content: [{ type: 'text', text: '[{"step":1}]' }] },
    },
  ])('tools/call streaming $name', async (c) => {
    const commands = new Map<string, any>([['stream', { run: c.run }]])
    const [, res] = await mcpSession(commands, [
      { id: 1, method: 'initialize', params: initParams },
      { id: 2, method: 'tools/call', params: { name: 'stream', arguments: {} } },
    ])
    expect(res.result).toEqual(c.result)
  })

  test('callTool closes a generator that yields error()', async () => {
    let closed = false
    const commands = new Map<string, any>()
    commands.set('stream', {
      async *run(c: any) {
        try {
          yield c.error({ code: 'STOP', message: 'stopped' })
          yield { unreachable: true }
        } finally {
          closed = true
        }
      },
    })
    const [tool] = Mcp.collectTools(commands, [])
    const result = await Mcp.callTool(tool!, {})
    expect(result.isError).toBe(true)
    expect(closed).toBe(true)
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

describe('globals', () => {
  type Discovery = 'direct' | 'progressive'
  type SessionOptions = Omit<Mcp.serve.Options<z.ZodObject<any> | undefined>, 'input' | 'output'>

  const globals = z.object({
    network: z.enum(['mainnet', 'testnet']).default('mainnet').describe('Network to use'),
  })

  const middlewares = [
    async (c: any, next: () => Promise<void>) => {
      c.set('network', c.globals.network)
      await next()
    },
  ]

  const vars = z.object({ network: z.string().optional() })

  function deployCommands(
    options: z.ZodObject<any> = z.object({ force: z.boolean().default(false) }),
  ) {
    return new Map<string, any>([
      [
        'deploy',
        {
          description: 'Deploy the app',
          options,
          run: (c: any) => ({ globals: c.globals, middleware: c.var.network, options: c.options }),
        },
      ],
    ])
  }

  /** Lists the `deploy` tool's input schema the way the discovery mode exposes it. */
  async function deploySchema(discovery: Discovery, options: SessionOptions = {}) {
    const request =
      discovery === 'direct'
        ? { id: 2, method: 'tools/list', params: {} }
        : {
            id: 2,
            method: 'tools/call',
            params: { name: 'get_tool_details', arguments: { name: 'deploy' } },
          }
    const [, res] = await mcpSession(
      deployCommands(),
      [{ id: 1, method: 'initialize', params: initParams }, request],
      { globals, ...options, tools: { discovery } },
    )
    if (discovery === 'direct') return res.result.tools[0].inputSchema
    return JSON.parse(res.result.content[0].text).inputSchema
  }

  /** Calls the `deploy` tool the way the discovery mode exposes it. */
  async function callDeploy(
    discovery: Discovery,
    args: Record<string, unknown>,
    {
      commands = deployCommands(),
      ...options
    }: SessionOptions & { commands?: Map<string, any> | undefined } = {},
  ) {
    const params =
      discovery === 'direct'
        ? { name: 'deploy', arguments: args }
        : { name: 'call_write_tool', arguments: { name: 'deploy', arguments: args } }
    const [, res] = await mcpSession(
      commands,
      [
        { id: 1, method: 'initialize', params: initParams },
        { id: 2, method: 'tools/call', params },
      ],
      { globals, middlewares, vars, ...options, tools: { discovery } },
    )
    return res.result
  }

  describe.each(['direct', 'progressive'] as const)('%s discovery', (discovery) => {
    test.each([
      {
        name: 'include globals',
        options: {},
        expected: {
          force: { type: 'boolean' },
          network: { description: 'Network to use', enum: ['mainnet', 'testnet'] },
        },
      },
      {
        name: 'are unchanged without globals',
        options: { globals: undefined },
        expected: { force: { type: 'boolean' } },
      },
    ])('tool input schemas $name', async ({ options, expected }) => {
      const schema = await deploySchema(discovery, options)
      expect(Object.keys(schema.properties)).toEqual(Object.keys(expected))
      expect(schema.properties).toMatchObject(expected)
    })

    test.each([
      {
        name: 'passes globals to run and middleware',
        args: { force: true, network: 'testnet' },
        options: {},
        expected: {
          globals: { network: 'testnet' },
          middleware: 'testnet',
          options: { force: true },
        },
      },
      {
        name: 'applies global defaults when omitted',
        args: {},
        options: {},
        expected: {
          globals: { network: 'mainnet' },
          middleware: 'mainnet',
          options: { force: false },
        },
      },
      {
        name: 'prefers a global over a command option of the same name',
        args: { network: 'testnet' },
        options: { commands: deployCommands(z.object({ network: z.string().default('option') })) },
        expected: {
          globals: { network: 'testnet' },
          middleware: 'testnet',
          options: { network: 'option' },
        },
      },
      {
        name: 'passes a value shared by a positional and a global to both',
        args: { network: 'testnet' },
        options: {
          commands: new Map<string, any>([
            [
              'deploy',
              {
                args: z.object({ network: z.string() }),
                run: (c: any) => ({ args: c.args, globals: c.globals }),
              },
            ],
          ]),
        },
        expected: { args: { network: 'testnet' }, globals: { network: 'testnet' } },
      },
      {
        name: 'leaves calls unchanged without globals',
        args: { force: true, network: 'testnet' },
        options: { globals: undefined },
        expected: { globals: {}, options: { force: true } },
      },
    ])('tools/call $name', async ({ args, options, expected }) => {
      const result = await callDeploy(discovery, args, options)
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(result.content[0].text)).toEqual(expected)
    })

    test('tools/call parses transforming globals once', async () => {
      const toUrl = vi.fn((value: string) => new URL(value))
      const result = await callDeploy(
        discovery,
        { rpcUrl: 'https://example.com' },
        {
          commands: new Map<string, any>([
            ['deploy', { run: (c: any) => ({ href: c.globals.rpcUrl.href, url: c.var.url }) }],
          ]),
          globals: z.object({ rpcUrl: z.string().transform(toUrl) }),
          middlewares: [
            async (c: any, next: () => Promise<void>) => {
              c.set('url', c.globals.rpcUrl instanceof URL)
              await next()
            },
          ],
          vars: z.object({ url: z.boolean().default(false) }),
        },
      )
      expect(result.isError).toBeUndefined()
      expect(JSON.parse(result.content[0].text)).toEqual({
        href: 'https://example.com/',
        url: true,
      })
      expect(toUrl).toHaveBeenCalledOnce()
    })
  })

  test.each([
    { discovery: 'direct' as const, text: /^Input validation error: .* network: Invalid option/ },
    { discovery: 'progressive' as const, text: /^\{"code":"VALIDATION_ERROR",.*"path":"network"/ },
  ])('$discovery tools/call rejects invalid global values', async ({ discovery, text }) => {
    const result = await callDeploy(discovery, { network: 'devnet' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(text)
  })

  test('callTool validates globals before middleware runs', async () => {
    const middleware = vi.fn(async (_c: any, next: () => Promise<void>) => next())
    const [tool] = Mcp.collectTools(deployCommands(), [])
    const options = { globals, middlewares: [middleware] }
    const result = await Mcp.callTool(tool!, { network: 'devnet' }, options)
    expect(middleware).not.toHaveBeenCalled()
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      code: 'VALIDATION_ERROR',
      fieldErrors: [{ code: 'invalid_value', missing: false, path: 'network' }],
    })
  })
})

describe('defaults', () => {
  function commands(options: z.ZodObject<any>) {
    return new Map<string, any>([
      [
        'audio',
        {
          _group: true,
          commands: new Map<string, any>([
            [
              'record',
              {
                options,
                run: (c: any) => ({
                  globals: c.globals,
                  middleware: c.var.url,
                  options: c.options,
                }),
              },
            ],
          ]),
        },
      ],
    ])
  }

  const globals = z.object({
    rpcUrl: z
      .string()
      .default('https://default.example')
      .transform((value) => new URL(value)),
  })
  const middlewares = [
    async (c: any, next: () => Promise<void>) => {
      c.set('url', c.globals.rpcUrl.href)
      await next()
    },
  ]
  const vars = z.object({ url: z.string().optional() })

  async function callRecord(
    discovery: 'direct' | 'progressive',
    args: Record<string, unknown>,
    options: z.ZodObject<any> = z.object({ sampleRate: z.number().default(44100) }),
    defaults: Mcp.Defaults = {},
  ) {
    const params =
      discovery === 'direct'
        ? { name: 'audio_record', arguments: args }
        : { name: 'call_write_tool', arguments: { name: 'audio_record', arguments: args } }
    const [, res] = await mcpSession(
      commands(options),
      [
        { id: 1, method: 'initialize', params: initParams },
        { id: 2, method: 'tools/call', params },
      ],
      { defaults, globals, middlewares, tools: { discovery }, vars },
    )
    return res.result
  }

  describe.each(['direct', 'progressive'] as const)('%s discovery', (discovery) => {
    test('applies default globals and option defaults below the call arguments', async () => {
      const path = vi.fn((_path: string[]) => ({ 'sample-rate': 22050 }))
      const defaults = { globals: { rpcUrl: new URL('https://server.example') }, options: path }
      const omitted = await callRecord(discovery, {}, undefined, defaults)
      expect(JSON.parse(omitted.content[0].text)).toEqual({
        globals: { rpcUrl: 'https://server.example/' },
        middleware: 'https://server.example/',
        options: { sampleRate: 22050 },
      })
      expect(path).toHaveBeenCalledWith(['audio', 'record'])

      const passed = await callRecord(
        discovery,
        { rpcUrl: 'https://call.example', sampleRate: 8000 },
        undefined,
        defaults,
      )
      expect(JSON.parse(passed.content[0].text)).toEqual({
        globals: { rpcUrl: 'https://call.example/' },
        middleware: 'https://call.example/',
        options: { sampleRate: 8000 },
      })
    })

    test('parses option defaults with the option schema and keeps its refinements', async () => {
      const options = z
        .object({ max: z.number().default(10), min: z.number().default(0) })
        .refine((value) => value.min <= value.max, { message: 'min must not exceed max' })
      const defaults = { options: () => ({ min: 20 }) }
      const result = await callRecord(discovery, {}, options, defaults)
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('min must not exceed max')
      const valid = await callRecord(discovery, { max: 30 }, options, defaults)
      expect(JSON.parse(valid.content[0].text).options).toEqual({ max: 30, min: 20 })
    })
  })

  test('rejects option defaults for unknown options', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    await expect(
      Mcp.serve('test-cli', '1.0.0', commands(z.object({ sampleRate: z.number() })), {
        defaults: { options: () => ({ bogus: 1 }) },
        input,
        output,
      }),
    ).rejects.toThrow('Unknown config option: bogus')
  })
})
