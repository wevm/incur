import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import * as Cli from '../../Cli.js'
import * as Formatter from '../../Formatter.js'
import * as RuntimeContext from '../runtime-context.js'
import { createRpcHandler, getRpcStatus } from './rpc.js'

function createFixture() {
  const order: string[] = []
  const child = Cli.create('child', {
    args: z.object({ id: z.string() }),
    options: z.object({ loud: z.boolean().default(false) }),
    run(c) {
      order.push(`child:${c.agent}:${c.args.id}:${c.options.loud}:${c.env.TOKEN}`)
      return c.ok({ id: c.args.id, loud: c.options.loud }, { cta: { commands: ['next'] } })
    },
    env: z.object({ TOKEN: z.string() }),
  })

  const router = Cli.create('project')
  router.use(async (_, next) => {
    order.push('group:before')
    await next()
    order.push('group:after')
  })
  router.command('list', {
    args: z.object({ projectId: z.string() }),
    options: z.object({ limit: z.number().default(10) }),
    output: z.object({ items: z.array(z.object({ id: z.string() })) }),
    run(c) {
      order.push(`run:${c.args.projectId}:${c.options.limit}:${(c.var as { root: string }).root}`)
      return { items: [{ id: 'a' }, { id: 'b' }] }
    },
  })
  router.command('stream', {
    async *run(c) {
      try {
        yield { step: 1 }
        yield { step: 2 }
        return c.ok({ done: true }, { cta: { commands: ['project list'] } })
      } finally {
        order.push('stream:return')
      }
    },
  })
  router.command('fail-stream', {
    async *run(c) {
      yield { step: 1 }
      return c.error({ code: 'STREAM_FAILED', message: 'nope', retryable: true })
    },
  })
  router.command('denied', {
    run(c) {
      return c.error({
        code: 'DENIED',
        cta: { commands: ['project list'] },
        message: 'Denied.',
        retryable: true,
      })
    },
  })
  router.command('throw', {
    run() {
      throw new Error('boom')
    },
  })

  const cli = Cli.create('root', {
    vars: z.object({ root: z.string().default('unset') }),
    env: z.object({ API_KEY: z.string() }),
    run() {
      return { root: true }
    },
  })
  cli.use(async (c, next) => {
    order.push(`root:before:${c.env.API_KEY}`)
    c.set('root', 'set')
    await next()
    order.push('root:after')
  })
  cli.command('alias-target', {
    aliases: ['alias'],
    run() {
      return { ok: true }
    },
  })
  cli.command(child)
  cli.command(router)
  cli.command('raw', { fetch: () => new Response('{}') })
  return { cli, order, ctx: RuntimeContext.fromCli(cli) }
}

describe('createRpcHandler', () => {
  test('executes root, mounted root, and mounted router commands by canonical ID', async () => {
    const { ctx, order } = createFixture()

    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
        command: ' root ',
        args: {},
        options: {},
      }),
    ).resolves.toMatchObject({ ok: true, data: { root: true }, meta: { command: 'root' } })
    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k', TOKEN: 't' } }).request({
        command: 'child',
        args: { id: 'c1' },
        options: { loud: true },
      }),
    ).resolves.toMatchObject({ ok: true, data: { id: 'c1', loud: true } })
    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
        command: 'project list',
        args: { projectId: 'p1' },
        options: { limit: 1 },
      }),
    ).resolves.toMatchObject({
      ok: true,
      data: { items: [{ id: 'a' }, { id: 'b' }] },
      meta: { command: 'project list' },
    })

    expect(order).toEqual([
      'root:before:k',
      'root:after',
      'root:before:k',
      'child:true:c1:true:t',
      'root:after',
      'root:before:k',
      'group:before',
      'run:p1:1:set',
      'group:after',
      'root:after',
    ])
  })

  test('rejects malformed RPC requests with field errors', async () => {
    const { ctx } = createFixture()
    const { request } = createRpcHandler(ctx)
    const cases = [
      null,
      {},
      { command: 1 },
      { command: 'project list', args: [] },
      { command: 'project list', options: [] },
      { command: 'project list', outputFormat: 'xml' },
      { command: 'project list', outputTokenLimit: -1 },
      { command: 'project list', outputTokenOffset: 1.5 },
      { command: 'project list', selection: [] },
    ]

    for (const item of cases) {
      const response = await request(item)
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'INVALID_RPC_REQUEST',
          fieldErrors: expect.arrayContaining([
            expect.objectContaining({ message: expect.any(String) }),
          ]),
        },
      })
    }
  })

  test('rejects unknown commands, groups, aliases, and raw fetch gateways', async () => {
    const { ctx } = createFixture()
    const { request } = createRpcHandler(ctx)
    await expect(request({ command: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RPC_REQUEST' },
    })
    await expect(request({ command: 'missing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND' },
    })
    await expect(request({ command: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_GROUP' },
    })
    await expect(request({ command: 'alias' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND' },
    })
    await expect(request({ command: 'raw' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'FETCH_GATEWAY' },
    })
  })

  test('validates structured args, options, CLI env, and command env independently', async () => {
    const { ctx } = createFixture()
    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
        command: 'project list',
        args: {},
        options: { limit: 1 },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
        command: 'project list',
        args: { projectId: 'p' },
        options: { limit: 'bad' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(
      createRpcHandler(ctx).request({
        command: 'project list',
        args: { projectId: 'p' },
        options: {},
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
        command: 'child',
        args: { id: 'c' },
        options: {},
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  test('returns command error envelopes with retryable and CTA metadata', async () => {
    const { ctx } = createFixture()
    const response = await createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
      command: 'project denied',
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'DENIED', message: 'Denied.', retryable: true },
      meta: {
        command: 'project denied',
        cta: {
          commands: [{ command: 'root project list' }],
          description: 'Suggested command:',
        },
      },
    })
  })

  test('returns thrown errors as unknown command failures', async () => {
    const { ctx } = createFixture()
    await expect(
      createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({ command: 'project throw' }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN', message: 'boom' },
      meta: { command: 'project throw' },
    })
  })

  test('applies selection, formatting, token metadata, and CTA metadata', async () => {
    const { ctx } = createFixture()
    const response = await createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
      command: 'project list',
      args: { projectId: 'p1' },
      options: {},
      outputFormat: 'json',
      outputTokenCount: true,
      outputTokenLimit: 4,
      selection: ['items[0,1]'],
    })
    expect(response).toMatchObject({
      ok: true,
      data: { items: [{ id: 'a' }] },
      meta: { command: 'project list' },
      output: {
        format: 'json',
        nextOffset: 4,
        tokenCount: expect.any(Number),
        tokenLimit: 4,
        tokenOffset: 0,
        truncated: true,
      },
    })
    if ('stream' in response || !response.ok || !response.output)
      throw new Error('expected success')
    expect(response.meta).not.toHaveProperty('nextOffset')
    expect(response.meta).not.toHaveProperty('outputTokenCount')
  })

  test('rejects empty selections and omits token count unless requested', async () => {
    const { ctx } = createFixture()
    await expect(
      createRpcHandler(ctx).request({ command: 'project list', selection: [] }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RPC_REQUEST' },
    })
    const response = await createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
      command: 'project list',
      args: { projectId: 'p1' },
      options: {},
    })
    if ('stream' in response || !response.ok || !response.output)
      throw new Error('expected success')
    expect(response.output).toMatchObject({ format: Formatter.defaultFormat })
    expect(response.output).not.toHaveProperty('tokenCount')
    expect(response.output).not.toHaveProperty('tokenLimit')
    expect(response.output).not.toHaveProperty('tokenOffset')
    expect(response.output).not.toHaveProperty('nextOffset')

    const counted = await createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request({
      command: 'project list',
      args: { projectId: 'p1' },
      options: {},
      outputTokenCount: true,
    })
    expect(counted).toMatchObject({
      ok: true,
      output: { format: Formatter.defaultFormat, tokenCount: expect.any(Number) },
    })
    if ('stream' in counted || !counted.ok || !counted.output) throw new Error('expected success')
    expect(counted.output).not.toHaveProperty('tokenLimit')
    expect(counted.output).not.toHaveProperty('tokenOffset')
    expect(counted.output).not.toHaveProperty('nextOffset')
    expect(counted.output).not.toHaveProperty('truncated')
  })

  test('keeps token metadata on output for non-truncated and offset-only requests', async () => {
    const { ctx } = createFixture()
    const request = createRpcHandler(ctx, { env: { API_KEY: 'k' } }).request
    const limited = await request({
      command: 'project list',
      args: { projectId: 'p1' },
      options: {},
      outputTokenLimit: 100,
    })
    expect(limited).toMatchObject({
      ok: true,
      output: {
        format: Formatter.defaultFormat,
        tokenCount: expect.any(Number),
        tokenLimit: 100,
        tokenOffset: 0,
      },
    })
    if ('stream' in limited || !limited.ok || !limited.output) throw new Error('expected success')
    expect(limited.output).not.toHaveProperty('nextOffset')
    expect(limited.output).not.toHaveProperty('truncated')

    const offset = await request({
      command: 'project list',
      args: { projectId: 'p1' },
      options: {},
      outputTokenOffset: 1,
    })
    expect(offset).toMatchObject({
      ok: true,
      output: {
        format: Formatter.defaultFormat,
        tokenCount: expect.any(Number),
        tokenOffset: 1,
        truncated: true,
      },
    })
    if ('stream' in offset || !offset.ok || !offset.output) throw new Error('expected success')
    expect(offset.output).not.toHaveProperty('nextOffset')
  })

  test('streams chunks, terminal metadata, terminal errors, and cancellation', async () => {
    const { ctx, order } = createFixture()
    const { request } = createRpcHandler(ctx, { env: { API_KEY: 'k' } })
    const response = await request({
      command: 'project stream',
      outputTokenCount: true,
      outputTokenLimit: 1,
    })
    if (!('stream' in response)) throw new Error('expected stream')
    const records: unknown[] = []
    for await (const record of response.records()) records.push(record)
    expect(records).toMatchObject([
      { type: 'chunk', data: { step: 1 } },
      { type: 'chunk', data: { step: 2 } },
      {
        type: 'done',
        ok: true,
        meta: { command: 'project stream', cta: expect.any(Object) },
        output: {
          format: Formatter.defaultFormat,
          tokenCount: expect.any(Number),
          tokenLimit: 1,
          tokenOffset: 0,
          truncated: true,
        },
      },
    ])

    const failed = await request({ command: 'project fail-stream' })
    if (!('stream' in failed)) throw new Error('expected stream')
    const failedRecords: unknown[] = []
    for await (const record of failed.records()) failedRecords.push(record)
    expect(failedRecords.at(-1)).toMatchObject({
      type: 'error',
      ok: false,
      error: { code: 'STREAM_FAILED', retryable: true },
      meta: { command: 'project fail-stream' },
    })

    const cancelled = await request({ command: 'project stream' })
    if (!('stream' in cancelled)) throw new Error('expected stream')
    const iterator = cancelled.records()
    await iterator.next()
    await iterator.return(undefined as any)
    expect(order).toContain('stream:return')
  })

  test('maps RPC error codes to HTTP statuses', () => {
    expect(getRpcStatus('COMMAND_NOT_FOUND')).toBe(404)
    expect(getRpcStatus('VALIDATION_ERROR')).toBe(400)
    expect(getRpcStatus('INVALID_RPC_REQUEST')).toBe(400)
    expect(getRpcStatus('COMMAND_GROUP')).toBe(400)
    expect(getRpcStatus('FETCH_GATEWAY')).toBe(400)
    expect(getRpcStatus('UNKNOWN')).toBe(500)
  })
})
