import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import * as Cli from '../../Cli.js'
import * as Client from '../Client.js'
import { ClientError } from '../ClientError.js'
import * as MemoryClient from '../MemoryClient.js'
import type {
  Request as RpcRequest,
  Response as RpcResponse,
  StreamRecord as RpcStreamRecord,
  StreamResponse as RpcStreamResponse,
} from '../Rpc.js'
import type * as HttpTransport from '../transports/HttpTransport.js'

type LogsCommands = {
  logs: { args: {}; options: {}; output: unknown; stream: true }
}

type MockCommands = {
  deploy: { args: {}; options: {}; output: {} }
  status: { args: {}; options: {}; output: { ok: boolean } }
}

function testClient() {
  const cli = Cli.create('app')
    .command('list', {
      run() {
        return {
          items: Array.from({ length: 200 }, (_, i) => ({
            id: i + 1,
            label: `item-${i + 1}`,
            message: 'alpha beta gamma delta epsilon zeta eta theta iota kappa',
          })),
          page: 1,
        }
      },
    })
    .command('report', {
      run(c) {
        return c.ok(
          {},
          {
            cta: {
              commands: [
                {
                  command: 'unblock',
                  args: { taskId: 't1' },
                  options: { dryRun: true },
                  description: 'Unblock task',
                },
              ],
            },
          },
        )
      },
    })
    .command('status', {
      run() {
        return { items: [{ ok: true }], ok: true }
      },
    })
    .command('unblock', {
      args: z.object({ taskId: z.string() }),
      options: z.object({ dryRun: z.boolean().optional() }),
      run() {
        return { items: [{ unblocked: true }], unblocked: true }
      },
    })
  return MemoryClient.create(cli, {
    outputFormat: 'toon',
    selection: ['items[0]'],
  })
}

function mockClient(request: (request: RpcRequest) => Promise<RpcResponse | RpcStreamResponse>) {
  const transport = (() => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover: vi.fn(),
    request(r: RpcRequest): Promise<RpcResponse | RpcStreamResponse> {
      return request(r)
    },
  })) satisfies HttpTransport.HttpTransport
  return Client.create<MockCommands, HttpTransport.HttpTransport>({ transport })
}

function streamClient(onReturn = vi.fn()) {
  const cli = Cli.create('app').command('logs', {
    async *run(c) {
      try {
        yield { line: 1 }
        yield { line: 2 }
        return c.ok({ lines: 2 })
      } finally {
        onReturn()
      }
    },
  })
  return MemoryClient.create<LogsCommands>(cli)
}

function failingStreamClient() {
  return mockStreamClient([
    { type: 'chunk', data: 1 },
    {
      type: 'error',
      ok: false,
      error: { code: 'DISCONNECTED', message: 'Disconnected.' },
      meta: { command: 'logs', duration: '2ms' },
    },
  ])
}

function mockStreamClient(records: RpcStreamRecord[]) {
  const transport = (() => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover: vi.fn(),
    async request(_request: RpcRequest): Promise<RpcResponse | RpcStreamResponse> {
      return {
        stream: true as const,
        async *records() {
          const terminal = records.at(-1)!
          for (const record of records) yield record
          return terminal
        },
      }
    },
  })) satisfies HttpTransport.HttpTransport
  return Client.create<LogsCommands, HttpTransport.HttpTransport>({ transport })
}

describe('run action', () => {
  test('merges defaults with per-call output controls and clears selection with undefined', async () => {
    const client = testClient()
    const request = vi.spyOn(client.transport, 'request')

    await client.run('status', {
      outputFormat: 'md',
      selection: undefined,
      outputTokenLimit: 24,
    })

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'status',
        args: {},
        options: {},
        outputFormat: 'md',
        outputTokenLimit: 24,
      }),
    )
    expect(request.mock.calls[0]?.[0]).toEqual({
      command: 'status',
      args: {},
      options: {},
      outputFormat: 'md',
      outputTokenLimit: 24,
    })
  })

  test('throws ClientError for failed envelopes and preserves public fields', async () => {
    const request = vi.fn(
      async (_request: RpcRequest): Promise<RpcResponse> => ({
        ok: false,
        error: {
          code: 'NOT_AUTHENTICATED',
          fieldErrors: [
            {
              path: 'token',
              code: 'invalid',
              expected: 'string',
              received: 'missing',
              message: 'Required',
            },
          ],
          message: 'Login required.',
          retryable: false,
        },
        meta: { command: 'deploy', duration: '2ms' },
        status: 401,
      }),
    )
    const client = mockClient(request)

    await expect(client.run('deploy')).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
      error: { message: 'Login required.' },
      fieldErrors: [expect.objectContaining({ path: 'token' })],
      meta: { command: 'deploy' },
      retryable: false,
      status: 401,
    })
    try {
      await client.run('deploy')
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError)
      if (!(error instanceof ClientError)) throw error
      expect(error.error).toMatchObject({
        code: 'NOT_AUTHENTICATED',
        message: 'Login required.',
      })
      expect(error.data).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } })
    }
  })

  test('output.next reruns the same command with next outputTokenOffset', async () => {
    const client = testClient()
    const request = vi.spyOn(client.transport, 'request')
    const result = await client.run('list', { selection: undefined, outputTokenLimit: 5 })

    expect(result.output).toMatchObject({ tokenLimit: 5, tokenOffset: 0 })
    expect(result.output?.next).toBeDefined()
    await expect(result.output?.next?.()).resolves.toMatchObject({ data: { page: 1 } })
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: 'list', outputTokenOffset: 5 }),
    )
  })

  test('throws ClientError for malformed output payloads', async () => {
    const request = vi.fn(
      async (_request: RpcRequest): Promise<RpcResponse> => ({
        ok: true,
        data: { ok: true },
        output: { format: 'json' } as never,
        meta: { command: 'status', duration: '1ms' },
      }),
    )
    const client = mockClient(request)

    await expect(client.run('status')).rejects.toThrow(ClientError)
    await expect(client.run('status')).rejects.toMatchObject({
      message: 'Malformed RPC output.',
    })
  })

  test('normalizes CTA metadata and cta.run inherits client defaults only', async () => {
    const client = testClient()
    const request = vi.spyOn(client.transport, 'request')
    const result = await client.run('report', { outputFormat: 'md' })
    const cta = result.meta.cta?.commands[0]

    expect(cta).toMatchObject({
      command: 'unblock',
      cliCommand: 'unblock t1 --dry-run <dryRun>',
      raw: expect.any(Object),
    })
    if (!cta) throw new Error('expected CTA')
    await expect(cta.run()).resolves.toMatchObject({ ok: true })
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: { taskId: 't1' },
        command: 'unblock',
        options: { dryRun: true },
        outputFormat: 'toon',
        selection: ['items[0]'],
      }),
    )
  })

  test('CTA suggestions fail like normal runs when the command is invalid', async () => {
    const cli = Cli.create('app').command('report', {
      run(c) {
        return c.ok({}, { cta: { commands: [{ command: 'missing' }] } })
      },
    })
    const client = MemoryClient.create(cli)
    const result = await client.run('report', { selection: undefined })
    const cta = result.meta.cta?.commands[0]

    expect(cta).toMatchObject({ command: 'missing', cliCommand: 'missing' })
    await expect(cta?.run()).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
  })

  describe('stream responses', () => {
    test('default async iteration yields chunks and final resolves terminal metadata', async () => {
      const client = streamClient()
      const stream = await client.run('logs')
      const chunks: unknown[] = []
      for await (const chunk of stream as AsyncIterable<unknown>) chunks.push(chunk)

      expect(chunks).toEqual([{ line: 1 }, { line: 2 }])
      await expect(stream.final).resolves.toMatchObject({
        data: { lines: 2 },
        output: { format: 'toon' },
        meta: { command: 'logs' },
      })
    })

    test('records yields terminal errors without throwing, while iteration and final throw', async () => {
      const recordsStream = await failingStreamClient().run('logs')
      const records: unknown[] = []
      for await (const record of recordsStream.records()) records.push(record)
      expect(records.at(-1)).toMatchObject({ type: 'error', error: { code: 'DISCONNECTED' } })

      const iterStream = await failingStreamClient().run('logs')
      await expect(
        (async () => {
          for await (const _ of iterStream as AsyncIterable<unknown>) {
          }
        })(),
      ).rejects.toThrow(ClientError)

      const finalStream = await failingStreamClient().run('logs')
      await expect(finalStream.final).rejects.toMatchObject({ code: 'DISCONNECTED' })
    })

    test('enforces single-consumer streams and returns the underlying iterator on early exit', async () => {
      const onReturn = vi.fn()
      const stream = await streamClient(onReturn).run('logs')

      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ value: { line: 1 } })
      expect(() => stream.records()).toThrow(ClientError)
      await iterator.return?.()
      expect(onReturn).toHaveBeenCalled()
    })
  })
})
