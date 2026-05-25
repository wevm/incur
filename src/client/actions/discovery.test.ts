import { describe, expect, test, vi } from 'vitest'

import type { Request as ResourcesRequest, Response as ResourcesResponse } from '../Resources.js'
import { createClient } from '../createClient.js'
import type * as HttpTransport from '../transports/HttpTransport.js'

function clientWith(discover: (request: ResourcesRequest) => Promise<ResourcesResponse>) {
  const transport = (() => ({
    config: { key: 'mock', name: 'Mock', type: 'http' as const },
    baseUrl: new URL('https://example.com'),
    discover(request: ResourcesRequest): Promise<ResourcesResponse> {
      return discover(request)
    },
    request: vi.fn(),
  })) satisfies HttpTransport.HttpTransport
  return createClient({ transport })
}

describe('discovery actions', () => {
  test('routes every discovery action and preserves structured/text returns', async () => {
    const discover = vi.fn(async (request) => {
      if (request.resource === 'help') return { contentType: 'text/plain', body: 'help' }
      if (request.resource === 'skill') return { contentType: 'text/markdown', body: '# Skill' }
      return { contentType: 'application/json', data: { resource: request.resource } }
    })
    const client = clientWith(discover)

    await expect(client.llms()).resolves.toEqual({ resource: 'llms' })
    await expect(client.llms({ command: 'project' as never, format: 'md' })).resolves.toEqual({
      resource: 'llms',
    })
    await expect(client.llmsFull({ command: 'project' as never })).resolves.toEqual({
      resource: 'llmsFull',
    })
    await expect(client.schema('project report' as never)).resolves.toEqual({ resource: 'schema' })
    await expect(client.help('project report' as never)).resolves.toBe('help')
    await expect(client.openapi()).resolves.toEqual({ resource: 'openapi' })
    await expect(client.skills.index()).resolves.toEqual({ resource: 'skillsIndex' })
    await expect(client.skills.get('deploy')).resolves.toBe('# Skill')
    await expect(client.mcp.tools()).resolves.toEqual({ resource: 'mcpTools' })

    expect(discover.mock.calls.map(([request]) => request)).toEqual([
      { resource: 'llms' },
      { resource: 'llms', command: 'project', format: 'md' },
      { resource: 'llmsFull', command: 'project' },
      { resource: 'schema', command: 'project report' },
      { resource: 'help', command: 'project report' },
      { resource: 'openapi' },
      { resource: 'skillsIndex' },
      { resource: 'skill', name: 'deploy' },
      { resource: 'mcpTools' },
    ])
  })

  test('normalizes discovery failures into ClientError fields', async () => {
    const client = clientWith(
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
