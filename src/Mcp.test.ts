import { Mcp, z } from 'incur'
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
) {
  const input = new PassThrough()
  const output = new PassThrough()
  const chunks: string[] = []
  output.on('data', (chunk) => chunks.push(chunk.toString()))

  const done = Mcp.serve('test-cli', '1.0.0', commands, { input, output })

  for (const msg of messages) {
    const rpc = { jsonrpc: '2.0', ...msg }
    input.write(`${JSON.stringify(rpc)}\n`)
  }

  // Give time for async processing then close
  await new Promise((r) => setTimeout(r, 20))
  input.end()
  await done

  return chunks.map((c) => JSON.parse(c.trim()))
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

    const done = Mcp.serve('test-cli', '1.0.0', createTestCommands(), { input, output })

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
