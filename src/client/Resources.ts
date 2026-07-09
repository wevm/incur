import type * as Formatter from '../Formatter.js'
import type * as Client from './Client.js'

/** Resources format. */
export type Format = 'md' | 'json' | 'jsonl' | 'yaml' | 'toon'

/** Resources result for a structured type and format option. */
export type Result<structured, format> = [format] extends [undefined]
  ? structured
  : [format] extends ['json']
    ? structured
    : undefined extends format
      ? structured | string
      : string

/** Resource request accepted by `transport.discover()`. */
export type Request =
  | { resource: 'llms'; command?: string | undefined; format?: Formatter.Format | undefined }
  | { resource: 'llmsFull'; command?: string | undefined; format?: Formatter.Format | undefined }
  | { resource: 'schema'; command?: string | undefined }
  | { resource: 'help'; command?: string | undefined }
  | { resource: 'openapi'; format?: 'json' | 'yaml' | undefined }
  | { resource: 'skillsIndex' }
  | { resource: 'skill'; name: string }
  | { resource: 'mcpTools' }

/** Resource response returned by `transport.discover()`. */
export type Response =
  | { contentType: string; body: string }
  | { contentType: string; data: unknown }

/** LLM manifest. */
export type LlmsManifest<
  commands = Client.Commands,
  scope extends Client.CommandScope<commands> | undefined = undefined,
> = {
  /** Manifest version. */
  version: string
  /** Available commands. */
  commands: LlmsCommand<commands, scope>[]
}

/** Full LLM manifest. */
export type LlmsFullManifest<
  commands = Client.Commands,
  scope extends Client.CommandScope<commands> | undefined = undefined,
> = LlmsManifest<commands, scope>

/** LLM command entry. */
export type LlmsCommand<
  commands = Client.Commands,
  scope extends Client.CommandScope<commands> | undefined = undefined,
> = {
  /** Command name. */
  name: scope extends undefined
    ? Client.CommandId<commands>
    : Extract<Client.CommandId<commands>, `${scope}` | `${scope} ${string}`>
  /** Command description. */
  description?: string | undefined
  /** Command schemas. */
  schema?: CommandSchema<commands, Client.CommandId<commands>> | undefined
}

/** JSON-ish command schema. */
export type CommandSchema<_commands = Client.Commands, _command extends string = string> = Record<
  string,
  unknown
> & {
  /** Args schema. */
  args?: Record<string, unknown> | undefined
  /** Options schema. */
  options?: Record<string, unknown> | undefined
  /** Env schema. */
  env?: Record<string, unknown> | undefined
  /** Output schema. */
  output?: Record<string, unknown> | undefined
}

/** OpenAPI document. */
export type OpenApiDocument = Record<string, unknown> & {
  /** OpenAPI version. */
  openapi?: string | undefined
  /** OpenAPI info object. */
  info?: Record<string, unknown> | undefined
}

/** Skills index. */
export type SkillsIndex = {
  /** Generated skills. */
  skills: { name: string; description: string; files: string[] }[]
}

/** MCP tool descriptor response. */
export type McpToolsResponse<_commands = Client.Commands> = {
  /** MCP tools. */
  tools: Record<string, unknown>[]
}

/** Resources action set. */
export type Actions<commands> = {
  llms: LlmsAction<commands>
  llmsFull: LlmsFullAction<commands>
  schema(command?: Client.CommandScope<commands> | undefined): Promise<CommandSchema<commands>>
  help(command?: Client.CommandScope<commands> | undefined): Promise<string>
  openapi(): Promise<OpenApiDocument>
  skills: {
    index(): Promise<SkillsIndex>
    get(name: string): Promise<string>
  }
  mcp: {
    tools(): Promise<McpToolsResponse<commands>>
  }
}

/** Compact LLM resources action. */
export type LlmsAction<commands> = {
  <
    const scope extends Client.CommandScope<commands> | undefined = undefined,
    const format extends Format | undefined = undefined,
  >(
    options?: { command?: scope | undefined; format?: format | undefined } | undefined,
  ): Promise<Result<LlmsManifest<commands, scope>, format>>
}

/** Full LLM resources action. */
export type LlmsFullAction<commands> = {
  <
    const scope extends Client.CommandScope<commands> | undefined = undefined,
    const format extends Format | undefined = undefined,
  >(
    options?: { command?: scope | undefined; format?: format | undefined } | undefined,
  ): Promise<Result<LlmsFullManifest<commands, scope>, format>>
}
