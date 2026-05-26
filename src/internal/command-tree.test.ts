import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import * as Cli from '../Cli.js'
import * as CommandTree from './command-tree.js'

describe('command-tree', () => {
  test('collects canonical client command IDs and excludes aliases/raw gateways', () => {
    const root = Cli.create('root', {
      run() {
        return null
      },
    })
    const mounted = Cli.create('mounted', {
      run() {
        return null
      },
    })
    const nested = Cli.create('nested').command('leaf', {
      run() {
        return null
      },
    })
    const router = Cli.create('project').command(nested)
    root.command('target', {
      aliases: ['alias'],
      run() {
        return null
      },
    })
    root.command('raw', { fetch: () => new Response('{}') })
    root.command(mounted)
    root.command(router)

    const ctx = CommandTree.fromCli(root)
    expect(CommandTree.collectClientCommands(ctx).map((entry) => entry.id)).toEqual([
      'mounted',
      'project nested leaf',
      'root',
      'target',
    ])
    expect(CommandTree.resolveCanonical(ctx, 'alias')).toMatchObject({ error: 'unknown' })
    expect(CommandTree.resolveCanonical(ctx, 'raw')).toMatchObject({ gateway: expect.any(Object) })
  })

  test('includes OpenAPI-mounted operations without serving first', () => {
    const cli = Cli.create('app').command('api', {
      fetch: (req) =>
        new Response(JSON.stringify({ id: new URL(req.url).pathname.split('/').pop() }), {
          headers: { 'content-type': 'application/json' },
        }),
      openapi: {
        paths: {
          '/users/{id}': {
            get: {
              operationId: 'getUser',
              parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['id'],
                        properties: { id: { type: 'string' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })

    const command = CommandTree.collectClientCommands(CommandTree.fromCli(cli))[0]!
    expect(command.id).toBe('api getUser')
    expect(command.command.args?.shape.id).toBeDefined()
    expect(command.command.output).toBeDefined()
  })

  test('builds separate input schemas', () => {
    const command = {
      args: z.object({ id: z.string() }),
      env: z.object({ TOKEN: z.string() }),
      options: z.object({ limit: z.number().optional() }),
      run() {},
    }
    expect(CommandTree.buildInputSchema(command)).toMatchObject({
      args: { properties: { id: { type: 'string' } } },
      env: { properties: { TOKEN: { type: 'string' } } },
      options: { properties: { limit: { type: 'number' } } },
    })
  })
})
