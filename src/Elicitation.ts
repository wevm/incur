import { z } from 'zod'

import { IncurError } from './Errors.js'
import * as Schema from './Schema.js'

/** User action returned by an MCP elicitation request. */
export type Action = 'accept' | 'decline' | 'cancel'

/** Primitive value that MCP form elicitation can return. */
export type ContentValue = boolean | number | string | string[]

/** Result returned by a form elicitation request. */
export type FormResult<schema extends z.ZodObject<any>> =
  | {
      /** User accepted and submitted form content. */
      action: 'accept'
      /** Submitted content parsed by the requested schema. */
      content: z.output<schema>
    }
  | {
      /** User explicitly declined or dismissed the request. */
      action: 'decline' | 'cancel'
      /** Form content is omitted unless the user accepts. */
      content?: undefined
    }

/** Result returned by a URL elicitation request. */
export type UrlResult =
  | {
      /** User consented to opening the URL. */
      action: 'accept'
      /** URL mode does not return submitted content through MCP. */
      content?: undefined
    }
  | {
      /** User explicitly declined or dismissed the request. */
      action: 'decline' | 'cancel'
      /** URL mode does not return submitted content through MCP. */
      content?: undefined
    }

/** Options for requesting non-sensitive structured input through MCP form mode. */
export type FormOptions<schema extends z.ZodObject<any>> = {
  /** Stable request key used to match 2026 MRTR input responses. */
  key?: string | undefined
  /** Human-readable explanation of why the input is needed. */
  message: string
  /** Flat object schema describing the requested form content. */
  schema: schema
}

/** Options for requesting user consent to open an external URL through MCP URL mode. */
export type UrlOptions = {
  /** Unique elicitation identifier. Generated automatically when omitted. */
  elicitationId?: string | undefined
  /** Stable request key used to match 2026 MRTR input responses. */
  key?: string | undefined
  /** Human-readable explanation of why the URL interaction is needed. */
  message: string
  /** URL to show to the user. */
  url: string | URL
}

/** API exposed to command handlers as `c.elicit`. */
export type Client = {
  /** Request non-sensitive structured input from the user through MCP form mode. */
  form: <const schema extends z.ZodObject<any>>(
    options: FormOptions<schema>,
  ) => Promise<FormResult<schema>>
  /** Request consent to open an external URL through MCP URL mode. */
  url: (options: UrlOptions) => Promise<UrlResult>
  /** Return a URL elicitation required error for clients that retry after completion. */
  requireUrl: (options: UrlOptions) => never
}

/** Wire-shape for MCP form mode request params. */
export type FormRequestParams = {
  /** Elicitation mode. */
  mode: 'form'
  /** Human-readable explanation of why the input is needed. */
  message: string
  /** Restricted flat JSON Schema for the expected response. */
  requestedSchema: RequestedSchema
}

/** Wire-shape for MCP URL mode request params. */
export type UrlRequestParams = {
  /** Elicitation mode. */
  mode: 'url'
  /** Unique elicitation identifier. */
  elicitationId: string
  /** Human-readable explanation of why the URL interaction is needed. */
  message: string
  /** Valid URL string. */
  url: string
}

/** Adapter used by transports that can send MCP elicitation requests. */
export type Adapter = {
  /** Send a form mode elicitation request. */
  form: (params: FormRequestParams, options?: { key?: string | undefined }) => Promise<RawResult>
  /** Throw or send a URL elicitation required error. */
  requireUrl: (params: UrlRequestParams, options?: { key?: string | undefined }) => never
  /** Send a URL mode elicitation request. */
  url: (params: UrlRequestParams, options?: { key?: string | undefined }) => Promise<RawResult>
}

/** JSON Schema accepted by MCP form elicitation. */
export type RequestedSchema = {
  /** Schema type, always object. */
  type: 'object'
  /** Flat primitive properties. */
  properties: Record<string, unknown>
  /** Required property names. */
  required?: string[] | undefined
}

type RawResult = {
  action: Action
  content?: Record<string, ContentValue> | undefined
}

/** Creates a command-context elicitation client from a transport adapter. */
export function create(adapter?: Adapter | undefined): Client {
  return {
    async form(options) {
      const requestedSchema = toRequestedSchema(options.schema)
      const result = await supported(adapter).form(
        {
          mode: 'form',
          message: options.message,
          requestedSchema,
        },
        { key: options.key },
      )
      if (result.action !== 'accept') return { action: result.action }
      return { action: 'accept', content: options.schema.parse(result.content ?? {}) }
    },
    requireUrl(options) {
      supported(adapter).requireUrl(toUrlParams(options), { key: options.key })
      throw new IncurError({
        code: 'ELICITATION_UNREACHABLE',
        message: 'URL elicitation did not throw as expected.',
      })
    },
    async url(options) {
      const result = await supported(adapter).url(toUrlParams(options), { key: options.key })
      return { action: result.action }
    },
  }
}

function supported(adapter?: Adapter | undefined): Adapter {
  if (adapter) return adapter
  throw new IncurError({
    code: 'ELICITATION_UNSUPPORTED',
    message: 'Elicitation is only available when this command is running as an MCP tool.',
  })
}

function toUrlParams(options: UrlOptions): UrlRequestParams {
  let url: string
  try {
    url = new URL(String(options.url)).toString()
  } catch (cause) {
    throw new IncurError({
      code: 'INVALID_ELICITATION_URL',
      message: 'URL elicitation requires a valid URL.',
      cause: cause instanceof Error ? cause : undefined,
    })
  }
  return {
    mode: 'url',
    elicitationId: options.elicitationId ?? crypto.randomUUID(),
    message: options.message,
    url,
  }
}

function toRequestedSchema(schema: z.ZodObject<any>): RequestedSchema {
  const json = Schema.toJsonSchema(schema)
  if (json.type !== 'object' || typeof json.properties !== 'object' || json.properties === null)
    throw unsupportedSchema('Form elicitation schemas must be flat objects.')

  const properties = json.properties as Record<string, unknown>
  for (const [key, property] of Object.entries(properties)) validateProperty(key, property)

  const required = Array.isArray(json.required) ? (json.required as string[]) : undefined
  if (required) return { type: 'object', properties, required }
  return { type: 'object', properties }
}

function validateProperty(key: string, property: unknown) {
  if (!isObject(property)) throw unsupportedSchema(`Property "${key}" must be a JSON object.`)
  if ('properties' in property) throw unsupportedSchema(`Property "${key}" must not be nested.`)

  const type = property.type
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return
  if (type === 'array') {
    validateArrayProperty(key, property)
    return
  }
  throw unsupportedSchema(`Property "${key}" must be a primitive or enum field.`)
}

function validateArrayProperty(key: string, property: Record<string, unknown>) {
  const items = property.items
  if (!isObject(items)) throw unsupportedSchema(`Property "${key}" must define array items.`)
  if (items.type === 'string' && Array.isArray(items.enum)) return
  if (Array.isArray(items.anyOf) && items.anyOf.every(isConstOption)) return
  throw unsupportedSchema(`Property "${key}" arrays must be string enum multi-selects.`)
}

function isConstOption(value: unknown) {
  return isObject(value) && typeof value.const === 'string'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unsupportedSchema(message: string) {
  return new IncurError({ code: 'UNSUPPORTED_ELICITATION_SCHEMA', message })
}
