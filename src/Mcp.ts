import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { Readable, Writable } from 'node:stream'

import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options = {},
): Promise<void> {
  const server = new McpServer({ name, version })

  for (const tool of collectTools(commands, [])) {
    const mergedShape: Record<string, any> = {
      ...tool.command.args?.shape,
      ...tool.command.options?.shape,
    }
    const hasInput = Object.keys(mergedShape).length > 0

    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : undefined),
        ...(hasInput ? { inputSchema: mergedShape } : undefined),
      },
      async (...callArgs: any[]) => {
        // registerTool passes (args, extra) when inputSchema is set, (extra) when not
        const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
        const extra = hasInput ? callArgs[1] : callArgs[0]
        return callTool(tool, params, extra)
      },
    )
  }

  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const transport = new StdioServerTransport(input as any, output as any)
  await server.connect(transport)
}

export declare namespace serve {
  /** Options for the MCP server. */
  type Options = {
    /** Override input stream. Defaults to `process.stdin`. */
    input?: Readable | undefined
    /** Override output stream. Defaults to `process.stdout`. */
    output?: Writable | undefined
  }
}

/** @internal Executes a tool call and returns a CallToolResult. */
async function callTool(
  tool: ToolEntry,
  params: Record<string, unknown>,
  extra?: {
    _meta?: { progressToken?: string | number }
    sendNotification?: (n: any) => Promise<void>
  },
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    const { args, options } = splitParams(params, tool.command)
    const parsedArgs = tool.command.args ? tool.command.args.parse(args) : {}
    const parsedOptions = tool.command.options ? tool.command.options.parse(options) : {}
    const parsedEnv = tool.command.env ? tool.command.env.parse(process.env) : {}

    const sentinel = Symbol.for('incur.sentinel')
    const okFn = (data: unknown): never => ({ [sentinel]: 'ok', data }) as never
    const errorFn = (opts: { code: string; message: string }): never =>
      ({ [sentinel]: 'error', ...opts }) as never

    const raw = tool.command.run({
      args: parsedArgs,
      env: parsedEnv,
      options: parsedOptions,
      ok: okFn,
      error: errorFn,
    })

    // Streaming: send progress notifications per chunk, then return buffered result
    if (isAsyncGenerator(raw)) {
      const chunks: unknown[] = []
      const progressToken = extra?._meta?.progressToken
      let i = 0
      for await (const chunk of raw) {
        if (typeof chunk === 'object' && chunk !== null && sentinel in chunk) {
          const tagged = chunk as any
          if (tagged[sentinel] === 'error')
            return {
              content: [{ type: 'text', text: tagged.message ?? 'Command failed' }],
              isError: true,
            }
        }
        chunks.push(chunk)
        if (progressToken !== undefined && extra?.sendNotification)
          await extra.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress: ++i, message: JSON.stringify(chunk) },
          })
      }
      return { content: [{ type: 'text', text: JSON.stringify(chunks) }] }
    }

    const awaited = await raw

    if (typeof awaited === 'object' && awaited !== null && sentinel in awaited) {
      const tagged = awaited as any
      if (tagged[sentinel] === 'error')
        return {
          content: [{ type: 'text', text: tagged.message ?? 'Command failed' }],
          isError: true,
        }
      return { content: [{ type: 'text', text: JSON.stringify(tagged.data ?? null) }] }
    }

    return { content: [{ type: 'text', text: JSON.stringify(awaited ?? null) }] }
  } catch (err) {
    return {
      content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    }
  }
}

/** @internal Type guard for async generators. */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as any).next === 'function'
  )
}

/** @internal A resolved tool entry from the command tree. */
type ToolEntry = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  command: any
}

/** @internal Recursively collects leaf commands as tool entries. */
function collectTools(commands: Map<string, any>, prefix: string[]): ToolEntry[] {
  const result: ToolEntry[] = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) result.push(...collectTools(entry.commands, path))
    else {
      result.push({
        name: path.join('_'),
        description: entry.description,
        inputSchema: buildToolSchema(entry.args, entry.options),
        command: entry,
      })
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** @internal Builds a merged JSON Schema from args and options Zod schemas. */
function buildToolSchema(
  args: any | undefined,
  options: any | undefined,
): { type: 'object'; properties: Record<string, unknown>; required?: string[] } {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const schema of [args, options]) {
    if (!schema) continue
    const json = Schema.toJsonSchema(schema)
    Object.assign(properties, (json.properties as Record<string, unknown>) ?? {})
    required.push(...((json.required as string[]) ?? []))
  }

  if (required.length > 0) return { type: 'object', properties, required }
  return { type: 'object', properties }
}

/** @internal Splits flat params into args vs options using schema shapes. */
function splitParams(
  params: Record<string, unknown>,
  command: any,
): { args: Record<string, unknown>; options: Record<string, unknown> } {
  const argKeys = new Set(command.args ? Object.keys(command.args.shape) : [])
  const a: Record<string, unknown> = {}
  const o: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (argKeys.has(key)) a[key] = value
    else o[key] = value
  }
  return { args: a, options: o }
}
