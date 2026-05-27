import { describe, expect, test, vi } from 'vitest'

import { ClientError } from '../ClientError.js'
import { createClient } from '../createClient.js'
import type {
  Request as RpcRequest,
  Response as RpcResponse,
  StreamResponse as RpcStreamResponse,
} from '../Rpc.js'
import type * as HttpTransport from '../transports/HttpTransport.js'

function clientWith(request: (request: RpcRequest) => Promise<RpcResponse | RpcStreamResponse>) {
  type Commands = {
    deploy: { args: {}; options: {}; output: {} }
    list: { args: {}; options: {}; output: { page: number } }
    report: { args: {}; options: {}; output: {} }
    status: { args: {}; options: {}; output: { ok: boolean } }
    unblock: {
      args: { taskId: string }
      options: { dryRun?: boolean | undefined }
      output: { unblocked: boolean }
    }
  }
  const transport = (() => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover: vi.fn(),
    request(r: RpcRequest): Promise<RpcResponse | RpcStreamResponse> {
      return request(r)
    },
  })) satisfies HttpTransport.HttpTransport
  return createClient<Commands, HttpTransport.HttpTransport>({
    outputFormat: 'toon',
    selection: ['items[0]'],
    transport,
  })
}

describe('run action', () => {
  test('merges defaults with per-call output controls and clears selection with undefined', async () => {
    const request = vi.fn(
      async (_request: RpcRequest): Promise<RpcResponse> => ({
        ok: true,
        data: { ok: true },
        output: { text: 'ok' },
        meta: { command: 'status', duration: '1ms' },
      }),
    )
    const client = clientWith(request)

    await client.run('status', {
      outputFormat: 'md',
      selection: undefined,
      outputTokenLimit: 24,
    })

    expect(request).toHaveBeenCalledWith({
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
    const client = clientWith(request)

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
      expect(error.error).toMatchObject({ code: 'NOT_AUTHENTICATED', message: 'Login required.' })
      expect(error.data).toMatchObject({ ok: false, error: { code: 'NOT_AUTHENTICATED' } })
    }
  })

  test('output.next reruns the same command with next outputTokenOffset', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: { page: 1 },
        output: { text: 'one' },
        meta: { command: 'list', duration: '1ms', nextOffset: 5, outputTokenCount: 10 },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { page: 2 },
        output: { text: 'two' },
        meta: { command: 'list', duration: '1ms', outputTokenCount: 10 },
      })
    const client = clientWith(request)
    const result = await client.run('list', { outputTokenLimit: 5 })

    expect(result.output).toMatchObject({ text: 'one', tokenCount: 10, tokenLimit: 5 })
    await expect(result.output?.next?.()).resolves.toMatchObject({ data: { page: 2 } })
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: 'list', outputTokenOffset: 5 }),
    )
  })

  test('normalizes CTA metadata and cta.run inherits client defaults only', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {},
        meta: {
          command: 'report',
          duration: '1ms',
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
      })
      .mockResolvedValueOnce({
        ok: true,
        data: { unblocked: true },
        meta: { command: 'unblock', duration: '1ms' },
      })
    const client = clientWith(request)
    const result = await client.run('report', { outputFormat: 'md' })
    const cta = result.meta.cta?.commands[0]

    expect(cta).toMatchObject({
      command: 'unblock',
      cliCommand: 'unblock t1 --dry-run <dryRun>',
      raw: expect.any(Object),
    })
    if (!cta) throw new Error('expected CTA')
    await expect(cta.run()).resolves.toMatchObject({ data: { unblocked: true } })
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: 'unblock', outputFormat: 'toon' }),
    )
  })

  test('CTA suggestions fail like normal runs when the command is invalid', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {},
        meta: {
          command: 'report',
          duration: '1ms',
          cta: { commands: ['missing'] },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'COMMAND_NOT_FOUND', message: 'Missing command.' },
        meta: { command: 'missing', duration: '1ms' },
      })
    const client = clientWith(request)
    const result = await client.run('report')
    const cta = result.meta.cta?.commands[0]

    expect(cta).toMatchObject({ command: 'missing', cliCommand: 'missing' })
    await expect(cta?.run()).rejects.toMatchObject({ code: 'COMMAND_NOT_FOUND' })
  })
})
