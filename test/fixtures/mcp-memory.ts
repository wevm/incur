import { Cli } from '../../src/index.js'

const cli = Cli.create('memory-test', {
  mcp: { tools: { discovery: 'direct' } },
  version: '1.0.0',
}).command('ping', { run: () => ({ pong: true }) })

let id = 0

function request(method: string, params: Record<string, unknown> = {}) {
  return cli.fetch(
    new Request('http://localhost/mcp', {
      body: JSON.stringify({ id: ++id, jsonrpc: '2.0', method, params }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      method: 'POST',
    }),
  )
}

async function consume(method: string, params: Record<string, unknown> = {}) {
  const response = await request(method, params)
  await response.text()
}

async function weakResponse() {
  const response = await request('tools/list')
  await response.text()
  return new WeakRef(response)
}

await consume('initialize', {
  capabilities: {},
  clientInfo: { name: 'memory-test', version: '1.0.0' },
  protocolVersion: '2025-03-26',
})

const responses: WeakRef<Response>[] = []
for (let index = 0; index < 100; index++) responses.push(await weakResponse())

const gc = globalThis.gc
if (!gc) throw new Error('garbage collection is unavailable')
for (let index = 0; index < 5; index++) {
  await new Promise(setImmediate)
  gc()
}

console.log(responses.filter((response) => response.deref()).length)
