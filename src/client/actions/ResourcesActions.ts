import type * as Client from '../Client.js'
import { ClientError } from '../ClientError.js'
import type * as Resources from '../Resources.js'
import type { ActionClient } from './ActionClient.js'

/** LLM resource action options. */
export type LlmsOptions = { command?: string | undefined; format?: Resources.Format | undefined }

/** Reads compact LLM resources. */
export async function llms(client: ActionClient, options: LlmsOptions = {}): Promise<unknown> {
  const { command, format = 'json' } = options
  return discover(client, {
    resource: 'llms',
    ...(command ? { command } : undefined),
    format,
  })
}

/** Reads full LLM resources. */
export async function llmsFull(client: ActionClient, options: LlmsOptions = {}): Promise<unknown> {
  const { command, format = 'json' } = options
  return discover(client, {
    resource: 'llmsFull',
    ...(command ? { command } : undefined),
    format,
  })
}

/** Reads a command schema. */
export async function schema(
  client: ActionClient,
  command?: Client.CommandScope<any> | undefined,
): Promise<Record<string, unknown>> {
  return discover(client, {
    resource: 'schema',
    ...(command ? { command } : undefined),
  }) as Promise<Record<string, unknown>>
}

/** Reads help text. */
export async function help(
  client: ActionClient,
  command?: Client.CommandScope<any> | undefined,
): Promise<string> {
  return discover(client, {
    resource: 'help',
    ...(command ? { command } : undefined),
  }) as Promise<string>
}

/** Reads the OpenAPI document. */
export async function openapi(client: ActionClient): Promise<Resources.OpenApiDocument> {
  return discover(client, { resource: 'openapi' }) as Promise<Resources.OpenApiDocument>
}

/** Reads the generated skills index. */
export async function skillsIndex(client: ActionClient): Promise<Resources.SkillsIndex> {
  return discover(client, { resource: 'skillsIndex' }) as Promise<Resources.SkillsIndex>
}

/** Reads a generated skill file. */
export async function skill(client: ActionClient, name: string): Promise<string> {
  return discover(client, { resource: 'skill', name }) as Promise<string>
}

/** Reads MCP tool descriptors. */
export async function mcpTools(client: ActionClient): Promise<Resources.McpToolsResponse> {
  return discover(client, { resource: 'mcpTools' }) as Promise<Resources.McpToolsResponse>
}

/** Binds resource actions to a client. */
export function actions(client: ActionClient) {
  return {
    llms(options?: LlmsOptions | undefined) {
      return llms(client, options)
    },
    llmsFull(options?: LlmsOptions | undefined) {
      return llmsFull(client, options)
    },
    schema(command?: Client.CommandScope<any> | undefined) {
      return schema(client, command)
    },
    help(command?: Client.CommandScope<any> | undefined) {
      return help(client, command)
    },
    openapi() {
      return openapi(client)
    },
    skills: {
      index() {
        return skillsIndex(client)
      },
      get(name: string) {
        return skill(client, name)
      },
    },
    mcp: {
      tools() {
        return mcpTools(client)
      },
    },
  }
}

async function discover(client: ActionClient, request: Resources.Request): Promise<unknown> {
  try {
    const response = await client.transport.discover(request)
    if ('body' in response) return response.body
    return response.data
  } catch (error) {
    if (error instanceof ClientError) throw error
    const data = isRecord(error)
      ? {
          ok: false,
          error: {
            code: typeof error.code === 'string' ? error.code : 'RESOURCES_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
          meta: { resource: request.resource },
        }
      : undefined
    throw new ClientError(error instanceof Error ? error.message : 'Resources request failed', {
      cause: error instanceof Error ? error : undefined,
      code: isRecord(error) && typeof error.code === 'string' ? error.code : 'RESOURCES_ERROR',
      data,
      error: isRecord(data) && isRecord(data.error) ? data.error : undefined,
      status: isRecord(error) && typeof error.status === 'number' ? error.status : undefined,
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
