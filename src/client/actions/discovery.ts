import type { Request as ResourcesRequest } from '../Resources.js'
import { ClientError } from '../ClientError.js'
import type {
  ActionClient,
  CommandScope,
  DiscoveryFormat,
  McpToolsResponse,
  OpenApiDocument,
  SkillsIndex,
} from '../types.js'

/** Runs compact LLM discovery. */
export async function llms(
  client: ActionClient,
  options: { command?: string | undefined; format?: DiscoveryFormat | undefined } = {},
): Promise<unknown> {
  const { command, format = 'json' } = options
  return discover(client, {
    resource: 'llms',
    ...(command ? { command } : undefined),
    format,
  })
}

/** Runs full LLM discovery. */
export async function llmsFull(
  client: ActionClient,
  options: { command?: string | undefined; format?: DiscoveryFormat | undefined } = {},
): Promise<unknown> {
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
  command?: CommandScope<any> | undefined,
): Promise<Record<string, unknown>> {
  return discover(client, {
    resource: 'schema',
    ...(command ? { command } : undefined),
  }) as Promise<Record<string, unknown>>
}

/** Reads help text. */
export async function help(
  client: ActionClient,
  command?: CommandScope<any> | undefined,
): Promise<string> {
  return discover(client, {
    resource: 'help',
    ...(command ? { command } : undefined),
  }) as Promise<string>
}

/** Reads the OpenAPI document. */
export async function openapi(client: ActionClient): Promise<OpenApiDocument> {
  return discover(client, { resource: 'openapi' }) as Promise<OpenApiDocument>
}

/** Reads the generated skills index. */
export async function skillsIndex(client: ActionClient): Promise<SkillsIndex> {
  return discover(client, { resource: 'skillsIndex' }) as Promise<SkillsIndex>
}

/** Reads a generated skill file. */
export async function skill(client: ActionClient, name: string): Promise<string> {
  return discover(client, { resource: 'skill', name }) as Promise<string>
}

/** Reads MCP tool descriptors. */
export async function mcpTools(client: ActionClient): Promise<McpToolsResponse> {
  return discover(client, { resource: 'mcpTools' }) as Promise<McpToolsResponse>
}

async function discover(client: ActionClient, request: ResourcesRequest): Promise<unknown> {
  try {
    const response = await client.transport.discover(request)
    if (
      'body' in response &&
      (request.resource === 'llms' || request.resource === 'llmsFull') &&
      request.format === 'json'
    )
      return JSON.parse(response.body)
    if ('body' in response) return response.body
    return response.data
  } catch (error) {
    if (error instanceof ClientError) throw error
    const data = isRecord(error)
      ? {
          ok: false,
          error: {
            code: typeof error.code === 'string' ? error.code : 'DISCOVERY_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
          meta: { resource: request.resource },
        }
      : undefined
    throw new ClientError(error instanceof Error ? error.message : 'Discovery request failed', {
      cause: error instanceof Error ? error : undefined,
      code: isRecord(error) && typeof error.code === 'string' ? error.code : 'DISCOVERY_ERROR',
      data,
      error: isRecord(data) && isRecord(data.error) ? data.error : undefined,
      status: isRecord(error) && typeof error.status === 'number' ? error.status : undefined,
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
