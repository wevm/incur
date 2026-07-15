import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as McpSource from './McpSource.js'

function serve(cli: { serve: Cli.Cli['serve'] }, argv: string[]) {
  let output = ''
  let exitCode: number | undefined
  return cli
    .serve(argv, {
      stdout: (s) => (output += s),
      exit: (c) => {
        exitCode = c
      },
    })
    .then(() => ({ output, exitCode }))
}

function json(output: string) {
  return JSON.parse(output.replace(/"duration": "[^"]+"/g, '"duration": "<stripped>"'))
}

function createRemoteCli() {
  return Cli.create('remote', { version: '1.0.0' })
    .command('search', {
      description: 'Search docs',
      options: z.object({
        query: z.string().describe('Search query'),
        limit: z.coerce.number().optional().describe('Result limit'),
      }),
      output: z.object({ query: z.string(), limit: z.number().optional() }),
      run: (context) => context.options,
    })
    .command('fail', {
      options: z.object({ message: z.string() }),
      run: (context) => context.error({ code: 'REMOTE', message: context.options.message }),
    })
}

function mountRemote(remote = createRemoteCli()) {
  return Cli.create('local', { mcp: { tools: { discovery: 'direct' } } }).command('docs', {
    description: 'Docs tools',
    mcp: { url: new URL('http://mcp.local/mcp'), fetch: (request) => remote.fetch(request) },
  })
}

describe('remote MCP command sources', () => {
  test('mounts remote MCP tools as subcommands', async () => {
    const cli = mountRemote()

    const result = await serve(cli, [
      'docs',
      'search',
      '--query',
      'tempo',
      '--limit',
      '2',
      '--json',
    ])

    expect({ exitCode: result.exitCode, body: json(result.output) }).toMatchInlineSnapshot(`
      {
        "body": {
          "limit": 2,
          "query": "tempo",
        },
        "exitCode": undefined,
      }
    `)
  })

  test('proxies generated subcommands through cli.fetch', async () => {
    const cli = mountRemote()
    const response = await cli.fetch(
      new Request('http://localhost/docs/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'tempo', limit: 3 }),
      }),
    )
    const body = await response.json()
    body.meta.duration = '<stripped>'

    expect({ status: response.status, body }).toMatchInlineSnapshot(`
      {
        "body": {
          "data": {
            "limit": 3,
            "query": "tempo",
          },
          "meta": {
            "command": "docs search",
            "duration": "<stripped>",
          },
          "ok": true,
        },
        "status": 200,
      }
    `)
  })

  test('preserves remote tool schemas on generated commands', async () => {
    const cli = mountRemote()

    const result = await serve(cli, ['docs', 'search', '--help'])

    expect(result.output).toMatchInlineSnapshot(`
      "local docs search — Search docs\n\nUsage: local docs search [options]\n\nOptions:\n  --query <string>  Search query\n  --limit <number>  Result limit\n\nGlobal Options:\n  --filter-output <keys>              Filter output by key paths (e.g. foo,bar.baz,a[0,3])\n  --format <toon|json|yaml|md|jsonl>  Output format\n  --full-output                       Show full output envelope\n  --help                              Show help\n  --llms, --llms-full                 Print LLM-readable manifest\n  --schema                            Show JSON Schema for command\n  --token-count                       Print token count of output (instead of output)\n  --token-limit <n>                   Limit output to n tokens\n  --token-offset <n>                  Skip first n tokens of output\n"
    `)
  })

  test('pages through progressive remote tool catalogs', async () => {
    const remote = Cli.create('remote')
    for (let index = 0; index < 21; index++)
      remote.command(`tool-${index}`, { run: () => ({ index }) })
    const cli = mountRemote(remote)

    const result = await serve(cli, ['docs', 'tool-20', '--json'])

    expect({ exitCode: result.exitCode, body: json(result.output) }).toEqual({
      body: { index: 20 },
      exitCode: undefined,
    })
  })

  test('propagates remote MCP tool errors', async () => {
    const cli = mountRemote()

    const result = await serve(cli, ['docs', 'fail', '--message', 'boom', '--json'])

    expect({ exitCode: result.exitCode, body: json(result.output) }).toMatchInlineSnapshot(`
      {
        "body": {
          "code": "MCP_TOOL_ERROR",
          "message": "boom",
        },
        "exitCode": 1,
      }
    `)
  })

  test('re-exposes proxied tools through MCP with group name prefixes', async () => {
    const cli = mountRemote()
    const response = await cli.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    )

    expect(await response.json()).toMatchInlineSnapshot(`
      {
        "id": 1,
        "jsonrpc": "2.0",
        "result": {
          "tools": [
            {
              "execution": {
                "taskSupport": "forbidden",
              },
              "inputSchema": {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "properties": {
                  "message": {
                    "type": "string",
                  },
                },
                "required": [
                  "message",
                ],
                "type": "object",
              },
              "name": "docs_fail",
            },
            {
              "description": "Search docs",
              "execution": {
                "taskSupport": "forbidden",
              },
              "inputSchema": {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "properties": {
                  "limit": {
                    "description": "Result limit",
                    "type": "number",
                  },
                  "query": {
                    "description": "Search query",
                    "type": "string",
                  },
                },
                "required": [
                  "query",
                ],
                "type": "object",
              },
              "name": "docs_search",
              "outputSchema": {
                "additionalProperties": false,
                "properties": {
                  "limit": {
                    "type": "number",
                  },
                  "query": {
                    "type": "string",
                  },
                },
                "required": [
                  "query",
                ],
                "type": "object",
              },
            },
          ],
        },
      }
    `)
  })

  test('parses text/event-stream JSON-RPC responses', async () => {
    const fetch = async (request: Request) => {
      const message = await request.json()
      if (message.method === 'tools/list')
        return new Response(
          `event: message\ndata: {"jsonrpc":"2.0","id":"other","result":{}}\n\ndata: {"jsonrpc":"2.0","id":"${message.id}","result":{"tools":[{"name":"echo"}]}}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      return Response.json({ jsonrpc: '2.0', id: message.id, result: {} })
    }

    await expect(McpSource.resolve({ url: 'https://example.com/mcp', fetch })).resolves
      .toMatchInlineSnapshot(`
      {
        "session": {
          "fetch": [Function],
          "initialized": true,
          "url": "https://example.com/mcp",
        },
        "tools": [
          {
            "name": "echo",
          },
        ],
      }
    `)
  })
})
