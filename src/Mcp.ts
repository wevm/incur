import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server'
import type { Readable, Writable } from 'node:stream'
import { z } from 'zod'

import * as Command from './internal/command.js'
import type { Handler as MiddlewareHandler } from './middleware.js'
import * as Schema from './Schema.js'

/** Starts a stdio MCP server that exposes commands as tools. */
export async function serve(
  name: string,
  version: string,
  commands: Map<string, any>,
  options: serve.Options = {},
): Promise<void> {
  const server = new McpServer(
    { name, version },
    options.instructions ? { instructions: options.instructions } : undefined,
  )

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
        ...(hasInput ? { inputSchema: z.object(mergedShape) } : undefined),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : undefined),
        ...(tool.annotations ? { annotations: tool.annotations } : undefined),
        ...(tool.instructions ? { _meta: { instructions: tool.instructions } } : undefined),
      } as never,
      async (...callArgs: any[]) => {
        // registerTool passes (args, extra) when inputSchema is set, (extra) when not
        const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
        const extra = hasInput ? callArgs[1] : callArgs[0]
        return callTool(tool, params, {
          extra,
          sendNotification: (n) => server.server.notification(n),
          name,
          version,
          middlewares: options.middlewares,
          env: options.env,
          vars: options.vars,
        })
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
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Override input stream. Defaults to `process.stdin`. */
    input?: Readable | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
    /** Override output stream. Defaults to `process.stdout`. */
    output?: Writable | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    /** CLI version string. */
    version?: string | undefined
    /** Instructions describing how to use the server and its features. Only effective on the root CLI. */
    instructions?: string | undefined
  }
}

/** @internal Executes a tool call and returns a CallToolResult. */
export async function callTool(
  tool: ToolEntry,
  params: Record<string, unknown>,
  options: {
    extra?: {
      mcpReq?: { _meta?: { progressToken?: string | number } }
    }
    sendNotification?: (n: ProgressNotification) => Promise<void>
    name?: string | undefined
    version?: string | undefined
    middlewares?: MiddlewareHandler[] | undefined
    env?: z.ZodObject<any> | undefined
    vars?: z.ZodObject<any> | undefined
  } = {},
): Promise<{
  content: { type: 'text'; text: string }[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
}> {
  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...((tool.middlewares as MiddlewareHandler[] | undefined) ?? []),
    ...((tool.command.middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  const result = await Command.execute(tool.command, {
    agent: true,
    argv: [],
    env: options.env,
    format: 'json',
    formatExplicit: true,
    inputOptions: params,
    middlewares: allMiddleware,
    name: options.name ?? tool.name,
    parseMode: 'flat',
    path: tool.name,
    vars: options.vars,
    version: options.version,
  })

  if ('stream' in result) {
    // Streaming: send progress notifications per chunk, then return buffered result
    const chunks: unknown[] = []
    const progressToken = options.extra?.mcpReq?._meta?.progressToken
    let i = 0
    try {
      for await (const chunk of result.stream) {
        chunks.push(chunk)
        if (progressToken !== undefined && options.sendNotification)
          await options.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress: ++i, message: JSON.stringify(chunk) },
          })
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(chunks) }] }
  }

  if (!result.ok)
    return {
      content: [{ type: 'text', text: result.error.message ?? 'Command failed' }],
      isError: true,
    }

  const data = result.data ?? null
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    ...(data !== null && tool.outputSchema
      ? { structuredContent: data as Record<string, unknown> }
      : undefined),
  }
}

/** @internal A progress notification sent during streaming tool calls. */
type ProgressNotification = {
  method: 'notifications/progress'
  params: { progressToken: string | number; progress: number; message: string }
}

/** @internal A resolved tool entry from the command tree. */
export type ToolEntry = {
  name: string
  description?: string | undefined
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  outputSchema?: Record<string, unknown> | undefined
  annotations?:
    | {
        title?: string
        readOnlyHint?: boolean
        destructiveHint?: boolean
        idempotentHint?: boolean
        openWorldHint?: boolean
      }
    | undefined
  instructions?: string | undefined
  command: any
  middlewares?: MiddlewareHandler[] | undefined
}

/** @internal Recursively collects leaf commands as tool entries. */
export function collectTools(
  commands: Map<string, any>,
  prefix: string[],
  parentMiddlewares: MiddlewareHandler[] = [],
): ToolEntry[] {
  const result: ToolEntry[] = []
  for (const [name, entry] of commands) {
    if ('_alias' in entry) continue
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      const groupMw = [
        ...parentMiddlewares,
        ...((entry.middlewares as MiddlewareHandler[] | undefined) ?? []),
      ]
      result.push(...collectTools(entry.commands, path, groupMw))
    } else {
      result.push({
        name: path.join('_'),
        description: entry.description,
        inputSchema: buildToolSchema(entry.args, entry.options),
        ...(entry.output
          ? { outputSchema: Schema.toJsonSchema(entry.output) as Record<string, unknown> }
          : undefined),
        ...(entry.mcp?.annotations ? { annotations: entry.mcp.annotations } : undefined),
        ...(entry.mcp?.instructions ? { instructions: entry.mcp.instructions } : undefined),
        command: entry,
        ...(parentMiddlewares.length > 0 ? { middlewares: parentMiddlewares } : undefined),
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
