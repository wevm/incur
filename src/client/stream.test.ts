import { describe, expect, test, vi } from 'vitest'

import * as Client from './Client.js'
import { ClientError } from './ClientError.js'
import type {
  Request as RpcRequest,
  Response as RpcResponse,
  StreamRecord as RpcStreamRecord,
  StreamResponse as RpcStreamResponse,
} from './Rpc.js'
import type * as HttpTransport from './transports/HttpTransport.js'

function streamClient(records: RpcStreamRecord[], onReturn = vi.fn()) {
  type Commands = {
    logs: { args: {}; options: {}; output: unknown; stream: true }
  }
  const transport = (() => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover: vi.fn(),
    async request(_request: RpcRequest): Promise<RpcResponse | RpcStreamResponse> {
      return {
        stream: true as const,
        async *records() {
          const terminal = records.at(-1)!
          try {
            for (const record of records) yield record
            return terminal
          } finally {
            onReturn()
          }
        },
      }
    },
  })) satisfies HttpTransport.HttpTransport
  return Client.create<Commands, HttpTransport.HttpTransport>({ transport })
}

describe('ClientStreamResponse', () => {
  test('default async iteration yields chunks and final resolves terminal metadata', async () => {
    const client = streamClient([
      { type: 'chunk', data: { line: 1 } },
      { type: 'chunk', data: { line: 2 } },
      {
        type: 'done',
        ok: true,
        data: { lines: 2 },
        output: { text: 'lines: 2', format: 'toon', tokenCount: 2 },
        meta: { command: 'logs', duration: '2ms' },
      },
    ])
    const stream = await client.run('logs')
    const chunks: unknown[] = []
    for await (const chunk of stream as AsyncIterable<unknown>) chunks.push(chunk)

    expect(chunks).toEqual([{ line: 1 }, { line: 2 }])
    await expect(stream.final).resolves.toMatchObject({
      data: { lines: 2 },
      output: { text: 'lines: 2', format: 'toon', tokenCount: 2 },
      meta: { command: 'logs' },
    })
  })

  test('records yields terminal errors without throwing, while iteration and final throw', async () => {
    const terminal = {
      type: 'error' as const,
      ok: false as const,
      error: { code: 'DISCONNECTED', message: 'Disconnected.' },
      meta: { command: 'logs', duration: '2ms' },
    }
    const recordsStream = await streamClient([{ type: 'chunk', data: 1 }, terminal]).run('logs')
    const records: unknown[] = []
    for await (const record of recordsStream.records()) records.push(record)
    expect(records.at(-1)).toMatchObject({ type: 'error', error: { code: 'DISCONNECTED' } })

    const iterStream = await streamClient([{ type: 'chunk', data: 1 }, terminal]).run('logs')
    await expect(async () => {
      for await (const _ of iterStream as AsyncIterable<unknown>) {
      }
    }).rejects.toThrow(ClientError)

    const finalStream = await streamClient([terminal]).run('logs')
    await expect(finalStream.final).rejects.toMatchObject({ code: 'DISCONNECTED' })
  })

  test('enforces single-consumer streams and returns the underlying iterator on early exit', async () => {
    const onReturn = vi.fn()
    const stream = await streamClient(
      [
        { type: 'chunk', data: 1 },
        { type: 'done', ok: true, data: undefined, meta: { command: 'logs', duration: '1ms' } },
      ],
      onReturn,
    ).run('logs')

    const iterator = stream[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: 1 })
    expect(() => stream.records()).toThrow(ClientError)
    await iterator.return?.()
    expect(onReturn).toHaveBeenCalled()
  })
})
