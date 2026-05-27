import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import * as Cli from '../Cli.js'
import { createClientRequest } from './client-request.js'
import * as CommandTree from './command-tree.js'

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
  return { cli, order, ctx: CommandTree.fromCli(cli) }
}

function request(
  ctx: CommandTree.RuntimeCliContext,
  body: unknown,
  options: createClientRequest.Options = {},
) {
  return createClientRequest(ctx, options).request(body)
}

describe('createClientRequest', () => {
  test('executes root, mounted root, and mounted router commands by canonical ID', async () => {
    const { ctx, order } = createFixture()

    await expect(
      request(ctx, { command: ' root ', args: {}, options: {} }, { env: { API_KEY: 'k' } }),
    ).resolves.toMatchObject({ ok: true, data: { root: true }, meta: { command: 'root' } })
    await expect(
      request(
        ctx,
        { command: 'child', args: { id: 'c1' }, options: { loud: true } },
        { env: { API_KEY: 'k', TOKEN: 't' } },
      ),
    ).resolves.toMatchObject({ ok: true, data: { id: 'c1', loud: true } })
    await expect(
      request(
        ctx,
        { command: 'project list', args: { projectId: 'p1' }, options: { limit: 1 } },
        { env: { API_KEY: 'k' } },
      ),
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

  test('rejects invalid RPC shape, unknown commands, groups, aliases, and raw fetch gateways', async () => {
    const { ctx } = createFixture()
    await expect(request(ctx, { command: '' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RPC_REQUEST' },
    })
    await expect(request(ctx, { command: 'missing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND' },
    })
    await expect(request(ctx, { command: 'project' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_GROUP' },
    })
    await expect(request(ctx, { command: 'alias' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND' },
    })
    await expect(request(ctx, { command: 'raw' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'FETCH_GATEWAY' },
    })
  })

  test('validates structured args, options, CLI env, and command env independently', async () => {
    const { ctx } = createFixture()
    await expect(
      request(
        ctx,
        { command: 'project list', args: {}, options: { limit: 1 } },
        { env: { API_KEY: 'k' } },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(
      request(
        ctx,
        { command: 'project list', args: { projectId: 'p' }, options: { limit: 'bad' } },
        { env: { API_KEY: 'k' } },
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(
      request(ctx, { command: 'project list', args: { projectId: 'p' }, options: {} }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    await expect(
      request(ctx, { command: 'child', args: { id: 'c' }, options: {} }, { env: { API_KEY: 'k' } }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
  })

  test('applies selection, formatting, token metadata, and CTA metadata', async () => {
    const { ctx } = createFixture()
    const response = await request(
      ctx,
      {
        command: 'project list',
        args: { projectId: 'p1' },
        options: {},
        outputFormat: 'json',
        outputTokenCount: true,
        outputTokenLimit: 4,
        selection: ['items[0,1]'],
      },
      { env: { API_KEY: 'k' } },
    )
    expect(response).toMatchObject({
      ok: true,
      data: { items: [{ id: 'a' }] },
      meta: { command: 'project list', nextOffset: 4, outputTokenCount: expect.any(Number) },
      output: { truncated: true },
    })
  })

  test('rejects empty selections and omits token count unless requested', async () => {
    const { ctx } = createFixture()
    await expect(request(ctx, { command: 'project list', selection: [] })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_RPC_REQUEST' },
    })
    await expect(
      request(
        ctx,
        { command: 'project list', args: { projectId: 'p1' }, options: {} },
        { env: { API_KEY: 'k' } },
      ),
    ).resolves.not.toMatchObject({ meta: { outputTokenCount: expect.any(Number) } })
  })

  test('streams chunks, terminal metadata, terminal errors, and cancellation', async () => {
    const { ctx, order } = createFixture()
    const response = await request(ctx, { command: 'project stream' }, { env: { API_KEY: 'k' } })
    if (!('stream' in response)) throw new Error('expected stream')
    const records: unknown[] = []
    for await (const record of response.records()) records.push(record)
    expect(records).toMatchObject([
      { type: 'chunk', data: { step: 1 } },
      { type: 'chunk', data: { step: 2 } },
      { type: 'done', ok: true, meta: { command: 'project stream', cta: expect.any(Object) } },
    ])

    const failed = await request(ctx, { command: 'project fail-stream' }, { env: { API_KEY: 'k' } })
    if (!('stream' in failed)) throw new Error('expected stream')
    const failedRecords: unknown[] = []
    for await (const record of failed.records()) failedRecords.push(record)
    expect(failedRecords.at(-1)).toMatchObject({
      type: 'error',
      ok: false,
      error: { code: 'STREAM_FAILED', retryable: true },
      meta: { command: 'project fail-stream' },
    })

    const cancelled = await request(ctx, { command: 'project stream' }, { env: { API_KEY: 'k' } })
    if (!('stream' in cancelled)) throw new Error('expected stream')
    const iterator = cancelled.records()
    await iterator.next()
    await iterator.return(undefined as any)
    expect(order).toContain('stream:return')
  })
})
