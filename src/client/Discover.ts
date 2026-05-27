import type * as Formatter from '../Formatter.js'

/** Request accepted by `transport.discover()`. */
export type Request =
  | { resource: 'llms'; command?: string | undefined; format?: Formatter.Format | undefined }
  | { resource: 'llmsFull'; command?: string | undefined; format?: Formatter.Format | undefined }
  | { resource: 'schema'; command?: string | undefined }
  | { resource: 'help'; command?: string | undefined }
  | { resource: 'openapi'; format?: 'json' | 'yaml' | undefined }
  | { resource: 'skillsIndex' }
  | { resource: 'skill'; name: string }
  | { resource: 'mcpTools' }

/** Response returned by `transport.discover()`. */
export type Response =
  | { contentType: string; body: string }
  | { contentType: string; data: unknown }
