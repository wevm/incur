import { Cli } from '../../src/index.js'

let started = 0
const requests: WeakRef<Request>[] = []
const cli = Cli.create('memory-test', {
  mcp: { tools: { discovery: 'direct' } },
  version: '1.0.0',
})
  .command('ping', { run: () => ({ pong: true }) })
  .command('stall', {
    run: (c) => {
      if (c.request) requests.push(new WeakRef(c.request))
      started++
      return new Promise<never>(() => {})
    },
  })

let id = 0

function request(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal) {
  return cli.fetch(
    new Request('http://localhost/mcp', {
      body: JSON.stringify({ id: ++id, jsonrpc: '2.0', method, params }),
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      method: 'POST',
      ...(signal ? { signal } : {}),
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

let calls: Promise<boolean>[] | undefined = []
let controllers: AbortController[] | undefined = []
for (let index = 0; index < 50; index++) {
  const controller = new AbortController()
  controllers.push(controller)
  calls.push(
    request('tools/call', { name: 'stall', arguments: {} }, controller.signal).then(
      () => false,
      () => true,
    ),
  )
}
while (started < controllers.length) await new Promise(setImmediate)
for (const controller of controllers) controller.abort()
controllers = undefined
const aborted = (await Promise.all(calls)).filter(Boolean).length
calls = undefined

const gc = globalThis.gc
if (!gc) throw new Error('garbage collection is unavailable')
for (let index = 0; index < 5; index++) {
  await new Promise(setImmediate)
  gc()
}

console.log(
  JSON.stringify({
    aborted,
    requests: requests.filter((request) => request.deref()).length,
    responses: responses.filter((response) => response.deref()).length,
  }),
)
