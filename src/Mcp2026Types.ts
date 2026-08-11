import { z } from 'zod'

/** MCP 2026 release-candidate protocol version advertised by incur. */
export const draftProtocolVersion = 'DRAFT-2026-v1'

/** MCP 2026 final protocol version planned by the release candidate. */
export const protocolVersion2026 = '2026-07-28'

/** Protocol versions supported by incur's MCP server implementation. */
export const supportedProtocolVersions = [
  draftProtocolVersion,
  protocolVersion2026,
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

/** Canonical MCP Apps extension identifier. */
export const appsExtensionId = 'io.modelcontextprotocol/ui'

/** MCP Apps compatibility extension identifier used by the draft lifecycle examples. */
export const appsExtensionAlias = 'io.modelcontextprotocol/apps'

/** MCP Tasks extension identifier. */
export const tasksExtensionId = 'io.modelcontextprotocol/tasks'

/** OAuth client credentials authorization extension identifier. */
export const oauthClientCredentialsExtensionId = 'io.modelcontextprotocol/oauth-client-credentials'

/** Enterprise-managed authorization extension identifier. */
export const enterpriseManagedAuthorizationExtensionId =
  'io.modelcontextprotocol/enterprise-managed-authorization'

/** MCP Apps HTML resource MIME type. */
export const appResourceMimeType = 'text/html;profile=mcp-app'

/** Authorization extension options for remote MCP deployments. */
export type AuthorizationOptions = {
  /** Advertise and accept OAuth client credentials bearer-token authentication. */
  oauthClientCredentials?: ExtensionSettings | undefined
  /** Advertise and accept enterprise-managed authorization bearer-token authentication. */
  enterpriseManagedAuthorization?: ExtensionSettings | undefined
  /** Validate a request before MCP handling. */
  authorize?: ((context: AuthorizationContext) => boolean | Promise<boolean>) | undefined
}

/** Extension settings object advertised in MCP capabilities. */
export type ExtensionSettings = boolean | Record<string, unknown>

/** Context supplied to the MCP authorization hook. */
export type AuthorizationContext = {
  /** Incoming HTTP request. */
  request: Request
  /** Bearer token from the Authorization header, if present. */
  bearerToken?: string | undefined
  /** MCP method being handled. */
  method: string
  /** Parsed JSON-RPC params. */
  params?: Record<string, unknown> | undefined
}

/** Cache hint fields required on MCP 2026 cacheable results. */
export type CacheOptions = {
  /** Freshness hint in milliseconds. */
  ttlMs: number
  /** Whether the result may be cached across users. */
  cacheScope: 'public' | 'private'
}

/** Icon metadata for MCP tools, prompts, resources, and apps. */
export type Icon = {
  /** Icon URL. */
  src: string
  /** Optional MIME type, such as `image/svg+xml`. */
  mimeType?: string | undefined
  /** Optional size hints, such as `48x48` or `any`. */
  sizes?: string[] | undefined
}

/** MCP content annotations shared by resources and tool results. */
export type Annotations = {
  /** Intended audience for this content. */
  audience?: ('user' | 'assistant')[] | undefined
  /** Relative priority from 0 to 1. */
  priority?: number | undefined
  /** ISO timestamp for the last modification time. */
  lastModified?: string | undefined
}

/** MCP tool behavior annotations. */
export type ToolAnnotations = {
  /** Human-readable title. */
  title?: string | undefined
  /** Whether the tool only reads state. */
  readOnlyHint?: boolean | undefined
  /** Whether the tool may modify state. */
  destructiveHint?: boolean | undefined
  /** Whether repeated calls with the same input are expected to be idempotent. */
  idempotentHint?: boolean | undefined
  /** Whether the tool interacts with open external systems. */
  openWorldHint?: boolean | undefined
}

/** MCP tool metadata supplied by a command definition. */
export type ToolMetadata = {
  /** Human-readable display title. */
  title?: string | undefined
  /** Tool icons. */
  icons?: Icon[] | undefined
  /** Tool behavior annotations. */
  annotations?: ToolAnnotations | undefined
  /** HTTP header mappings keyed by input property name. */
  headers?: Record<string, string> | undefined
  /** MCP Apps UI resource for this tool. */
  app?: { resourceUri: string } | undefined
  /** Cache hints for list results involving this tool. */
  cache?: CacheOptions | undefined
  /** Task execution options for long-running tools. */
  task?: TaskOptions | undefined
}

/** MCP task execution options. */
export type TaskOptions = {
  /** Whether the tool should always return a task handle. */
  required?: boolean | undefined
  /** Time-to-live for task state in milliseconds. */
  ttlMs?: number | undefined
  /** Suggested polling interval in milliseconds. */
  pollIntervalMs?: number | undefined
}

/** Text resource content. */
export type TextResourceContent = {
  /** Resource URI. */
  uri: string
  /** MIME type. */
  mimeType?: string | undefined
  /** Text content. */
  text: string
  /** Optional annotations. */
  annotations?: Annotations | undefined
}

/** Binary resource content. */
export type BlobResourceContent = {
  /** Resource URI. */
  uri: string
  /** MIME type. */
  mimeType?: string | undefined
  /** Base64-encoded binary content. */
  blob: string
  /** Optional annotations. */
  annotations?: Annotations | undefined
}

/** MCP resource content. */
export type ResourceContent = TextResourceContent | BlobResourceContent

/** MCP resource definition. */
export type ResourceDefinition = {
  /** Programmatic name. */
  name: string
  /** Resource URI. */
  uri: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** MIME type. */
  mimeType?: string | undefined
  /** Resource size in bytes. */
  size?: number | undefined
  /** Icons. */
  icons?: Icon[] | undefined
  /** Annotations. */
  annotations?: Annotations | undefined
  /** Cache hints for reads. */
  cache?: CacheOptions | undefined
  /** Reads resource contents. */
  read: () => ResourceContent | ResourceContent[] | Promise<ResourceContent | ResourceContent[]>
}

/** MCP resource template definition. */
export type ResourceTemplateDefinition = {
  /** Programmatic name. */
  name: string
  /** URI template. */
  uriTemplate: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** MIME type. */
  mimeType?: string | undefined
  /** Icons. */
  icons?: Icon[] | undefined
  /** Annotations. */
  annotations?: Annotations | undefined
  /** Completion handlers keyed by template variable. */
  complete?:
    | Record<string, (value: string, context: CompletionContext) => string[] | Promise<string[]>>
    | undefined
}

/** Context supplied to MCP completion callbacks. */
export type CompletionContext = {
  /** Already resolved variables or arguments. */
  arguments?: Record<string, string> | undefined
}

/** MCP prompt message. */
export type PromptMessage = {
  /** Message role. */
  role: 'user' | 'assistant'
  /** Message content block. */
  content: ContentBlock
}

/** MCP prompt definition. */
export type PromptDefinition = {
  /** Programmatic name. */
  name: string
  /** Human-readable title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** Arguments schema. */
  args?: z.ZodObject<any> | undefined
  /** Icons. */
  icons?: Icon[] | undefined
  /** Completion handlers keyed by argument name. */
  complete?:
    | Record<string, (value: string, context: CompletionContext) => string[] | Promise<string[]>>
    | undefined
  /** Renders prompt messages. */
  get: (args: Record<string, string>) => PromptMessage[] | Promise<PromptMessage[]>
}

/** MCP App definition. */
export type AppDefinition = {
  /** Programmatic app name. */
  name: string
  /** UI resource URI, typically `ui://...`. */
  resourceUri: string
  /** HTML text served as the app resource. */
  html: string | (() => string | Promise<string>)
  /** Display title. */
  title?: string | undefined
  /** Description. */
  description?: string | undefined
  /** Icons. */
  icons?: Icon[] | undefined
}

/** MCP content block returned by tools and prompts. */
export type ContentBlock =
  | { type: 'text'; text: string; annotations?: Annotations | undefined }
  | { type: 'image'; data: string; mimeType: string; annotations?: Annotations | undefined }
  | { type: 'audio'; data: string; mimeType: string; annotations?: Annotations | undefined }
  | {
      type: 'resource_link'
      uri: string
      name: string
      description?: string | undefined
      mimeType?: string | undefined
      annotations?: Annotations | undefined
    }
  | { type: 'resource'; resource: ResourceContent }

/** Creates a text MCP content block. */
export function text(text: string, annotations?: Annotations | undefined): ContentBlock {
  return annotations ? { type: 'text', text, annotations } : { type: 'text', text }
}

/** Creates an image MCP content block. */
export function image(
  data: string,
  mimeType: string,
  annotations?: Annotations | undefined,
): ContentBlock {
  return annotations
    ? { type: 'image', data, mimeType, annotations }
    : { type: 'image', data, mimeType }
}

/** Creates an audio MCP content block. */
export function audio(
  data: string,
  mimeType: string,
  annotations?: Annotations | undefined,
): ContentBlock {
  return annotations
    ? { type: 'audio', data, mimeType, annotations }
    : { type: 'audio', data, mimeType }
}

/** Creates a resource link MCP content block. */
export function resourceLink(
  uri: string,
  name: string,
  options: {
    description?: string | undefined
    mimeType?: string | undefined
    annotations?: Annotations | undefined
  } = {},
): ContentBlock {
  return { type: 'resource_link', uri, name, ...options }
}

/** Creates an embedded resource MCP content block. */
export function embeddedResource(resource: ResourceContent): ContentBlock {
  return { type: 'resource', resource }
}
