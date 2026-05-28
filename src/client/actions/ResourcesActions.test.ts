import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import * as Cli from '../../Cli.js'
import * as Client from '../Client.js'
import type * as Resources from '../Resources.js'
import * as HttpTransport from '../transports/HttpTransport.js'

function createCli() {
  return Cli.create('app', { description: 'App', version: '1.2.3' }).command('status', {
    description: 'Show status',
    args: z.object({ id: z.string() }),
    options: z.object({ verbose: z.boolean().default(false) }),
    run(c) {
      return { id: c.args.id, verbose: c.options.verbose }
    },
  })
}

function httpClient(cli: Cli.Cli<any, any, any>) {
  const requests: Request[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)
    return cli.fetch(request)
  }) as typeof globalThis.fetch
  return {
    client: Client.create({
      transport: HttpTransport.create({ baseUrl: 'https://example.com', fetch }),
    }),
    requests,
  }
}

function clientWithDiscover(discover: (request: Resources.Request) => Promise<Resources.Response>) {
  return Client.create({
    transport: (() => ({
      config: { key: 'mock', name: 'Mock', type: 'http' as const },
      baseUrl: new URL('https://example.com'),
      discover,
      request: vi.fn(),
    })) satisfies HttpTransport.HttpTransport,
  })
}

describe('resources actions', () => {
  test('routes every resources action through HTTP and preserves structured/text returns', async () => {
    const { client, requests } = httpClient(createCli())

    await expect(client.llms()).resolves.toMatchObject({
      version: 'incur.v1',
      commands: [expect.objectContaining({ name: 'status' })],
    })
    await expect(client.llms({ command: 'status' as never, format: 'md' })).resolves.toContain(
      '| `app status <id>` | Show status |',
    )
    await expect(client.llms({ command: 'status' as never, format: 'jsonl' })).resolves.toContain(
      '"name":"status"',
    )
    await expect(client.llmsFull({ command: 'status' as never })).resolves.toMatchObject({
      version: 'incur.v1',
      commands: [expect.objectContaining({ name: 'status' })],
    })
    await expect(client.schema('status' as never)).resolves.toMatchObject({
      args: { properties: { id: { type: 'string' } }, required: ['id'] },
      options: {
        properties: { verbose: { default: false, type: 'boolean' } },
        required: ['verbose'],
      },
    })
    await expect(client.help('status' as never)).resolves.toContain('Usage: status <id> [options]')
    await expect(client.openapi()).resolves.toMatchObject({
      openapi: '3.2.0',
      info: { title: 'app', version: '1.2.3' },
    })
    await expect(client.skills.index()).resolves.toMatchObject({
      skills: [expect.objectContaining({ name: 'status' })],
    })
    await expect(client.skills.get('status')).resolves.toContain('# app status')
    await expect(client.mcp.tools()).resolves.toMatchObject({
      tools: [expect.objectContaining({ name: 'status' })],
    })

    expect(
      requests.map((request) => ({
        pathname: new URL(request.url).pathname,
        search: new URL(request.url).search,
      })),
    ).toEqual([
      { pathname: '/_incur/llms', search: '?format=json' },
      { pathname: '/_incur/llms', search: '?command=status&format=md' },
      { pathname: '/_incur/llms', search: '?command=status&format=jsonl' },
      { pathname: '/_incur/llms-full', search: '?command=status&format=json' },
      { pathname: '/_incur/schema', search: '?command=status' },
      { pathname: '/_incur/help', search: '?command=status' },
      { pathname: '/openapi.json', search: '' },
      { pathname: '/_incur/skills', search: '' },
      { pathname: '/_incur/skill', search: '?name=status' },
      { pathname: '/_incur/mcp/tools', search: '' },
    ])
  })

  test('normalizes resources failures into ClientError fields', async () => {
    const client = clientWithDiscover(
      vi.fn(async () => {
        throw Object.assign(new Error('Unknown command'), {
          code: 'COMMAND_NOT_FOUND',
          status: 404,
        })
      }),
    )

    await expect(client.help('missing' as never)).rejects.toMatchObject({
      code: 'COMMAND_NOT_FOUND',
      status: 404,
    })
  })
})
