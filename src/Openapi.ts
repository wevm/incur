import type {
  Document,
  OperationObject,
  ParameterObject,
  PathItemObject,
} from '@scalar/openapi-types/3.2'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as Fetch from './Fetch.js'
import { dereference } from './internal/dereference.js'
import * as Schema from './Schema.js'

/** A minimal OpenAPI 3.x spec shape. Accepts both hand-written specs and generated ones (e.g. from `@hono/zod-openapi`). */
export type OpenAPISpec = { paths?: {} | undefined }

/** Options for generating an OpenAPI document from an incur CLI. */
export type GenerateOptions = {
  /** API description. Defaults to the CLI description. */
  description?: string | undefined
  /** Server URLs to advertise in the generated document. */
  servers?: { url: string; description?: string | undefined }[] | undefined
  /** API title. Defaults to the CLI name. */
  title?: string | undefined
  /** API version. Defaults to `0.0.0`. */
  version?: string | undefined
}

/** HTTP methods generated for commands. */
type HttpMethod = 'delete' | 'get' | 'patch' | 'post'

/** Generates an OpenAPI 3.2 document from an incur CLI's command tree. */
export function fromCli(cli: Cli.Cli, options: GenerateOptions = {}): Document {
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const paths: NonNullable<Document['paths']> = {}
  const root = Cli.toRootDefinition.get(cli as unknown as Cli.Root)
  if (root) addCommand(paths, [], root)
  for (const [name, entry] of commands) addEntry(paths, splitCommandName(name), entry)

  return {
    openapi: '3.2.0',
    info: {
      title: options.title ?? cli.name,
      version: options.version ?? '0.0.0',
      ...((options.description ?? cli.description)
        ? { description: options.description ?? cli.description }
        : undefined),
    },
    ...(options.servers ? { servers: options.servers } : undefined),
    paths,
  }
}

/** Internal operation shape after casting. */
type Operation = {
  description?: string | undefined
  operationId?: string | undefined
  parameters?: readonly Parameter[] | undefined
  requestBody?: RequestBody | undefined
  responses?: Record<string, unknown> | undefined
  summary?: string | undefined
}

type Parameter = {
  description?: string | undefined
  in: 'cookie' | 'header' | 'path' | 'query'
  name: string
  required?: boolean | undefined
  schema?: Record<string, unknown> | undefined
}

type RequestBody = {
  content?: Record<string, { schema?: Record<string, unknown> | undefined }> | undefined
  required?: boolean | undefined
}

/** A fetch handler. */
type FetchHandler = (req: Request) => Response | Promise<Response>

/** A generated command entry compatible with incur's internal CommandEntry. */
type GeneratedCommand = {
  args?: z.ZodObject<any> | undefined
  description?: string | undefined
  options?: z.ZodObject<any> | undefined
  run: (context: any) => any
}

function addEntry(paths: NonNullable<Document['paths']>, segments: string[], entry: any) {
  if ('_alias' in entry) return
  if ('_fetch' in entry) return
  if ('_group' in entry) {
    for (const [name, child] of entry.commands)
      addEntry(paths, [...segments, ...splitCommandName(name)], child)
    return
  }
  addCommand(paths, segments, entry)
}

function splitCommandName(name: string) {
  return name.split(/\s+/).filter(Boolean)
}

function addCommand(paths: NonNullable<Document['paths']>, segments: string[], command: any) {
  const argsSchema = command.args ? Schema.toJsonSchema(command.args) : undefined
  const optionsSchema = command.options ? Schema.toJsonSchema(command.options) : undefined
  const outputSchema = command.output ? Schema.toJsonSchema(command.output) : undefined
  const args = objectProperties(argsSchema)
  const requiredArgs = new Set(requiredProperties(argsSchema))
  const method = inferMethod(segments)
  const pathVariants = createPathVariants(segments, args, requiredArgs)

  for (const variant of pathVariants) {
    const parameters: ParameterObject[] = []
    for (const name of variant.args) {
      const schema = args[name] ?? { type: 'string' }
      parameters.push({ name, in: 'path', required: true, schema })
    }
    if (method === 'get' || method === 'delete')
      for (const [name, schema] of Object.entries(objectProperties(optionsSchema)))
        parameters.push({
          name,
          in: 'query',
          ...(requiredProperties(optionsSchema).includes(name) ? { required: true } : undefined),
          schema,
        })

    const operation: OperationObject = {
      operationId: operationId(segments, method, variant.args),
      ...(command.description ? { summary: command.description } : undefined),
      ...(parameters.length ? { parameters } : undefined),
      ...requestBody(method, optionsSchema),
      responses: responses(outputSchema),
    }

    const item = (paths[variant.path] ?? {}) as PathItemObject
    ;(item as any)[method] = operation
    paths[variant.path] = item
  }
}

function createPathVariants(
  segments: string[],
  args: Record<string, Record<string, unknown>>,
  requiredArgs: Set<string>,
) {
  const names = Object.keys(args)
  const requiredCount = names.findIndex((name) => !requiredArgs.has(name))
  const baseCount = requiredCount === -1 ? names.length : requiredCount
  const variants: { args: string[]; path: `/${string}` }[] = []
  for (let count = baseCount; count <= names.length; count++) {
    const included = names.slice(0, count)
    const suffix = included.map((name) => `{${name}}`)
    variants.push({
      args: included,
      path: `/${[...segments, ...suffix].map(encodePathSegment).join('/')}`,
    })
  }
  if (variants.length === 0)
    variants.push({ args: [], path: `/${segments.map(encodePathSegment).join('/')}` })
  return variants
}

function inferMethod(segments: string[]): HttpMethod {
  const text = segments.map(splitCamelCase).join(' ').toLowerCase()
  if (/\b(delete|remove|rm|destroy|clear)\b/.test(text)) return 'delete'
  if (/\b(update|edit|modify|set|enable|disable|rename|patch)\b/.test(text)) return 'patch'
  if (/\b(get|list|show|read|search|find|status|describe|info|health|check)\b/.test(text))
    return 'get'
  return 'post'
}

function splitCamelCase(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
}

function requestBody(method: HttpMethod, schema?: Record<string, unknown> | undefined) {
  if (!schema || method === 'get' || method === 'delete') return {}
  return {
    requestBody: {
      required: requiredProperties(schema).length > 0,
      content: { 'application/json': { schema } },
    },
  }
}

function responses(schema?: Record<string, unknown> | undefined) {
  return {
    '200': {
      description: 'Command completed successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['ok', 'data', 'meta'],
            properties: {
              ok: { const: true },
              data: schema ?? {},
              meta: metaSchema(),
            },
          },
        },
      },
    },
    '400': errorResponse('Validation error.'),
    '500': errorResponse('Command failed.'),
  }
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['ok', 'error', 'meta'],
          properties: {
            ok: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                retryable: { type: 'boolean' },
              },
            },
            meta: metaSchema(),
          },
        },
      },
    },
  }
}

function metaSchema() {
  return {
    type: 'object',
    required: ['command', 'duration'],
    properties: {
      command: { type: 'string' },
      duration: { type: 'string' },
    },
  }
}

function objectProperties(schema: Record<string, unknown> | undefined) {
  return (schema?.properties ?? {}) as Record<string, Record<string, unknown>>
}

function requiredProperties(schema: Record<string, unknown> | undefined) {
  return (schema?.required ?? []) as string[]
}

function operationId(segments: string[], method: HttpMethod, args: string[]) {
  const raw = [...segments, ...(args.length ? [args.join(' ')] : [])].join(' ')
  const pascal = raw.replace(/(?:^|[\s_-]+)(\w)/g, (_, char: string) => char.toUpperCase())
  return `${method}${pascal}`
}

function encodePathSegment(segment: string) {
  if (segment.startsWith('{') && segment.endsWith('}')) return segment
  return encodeURIComponent(segment)
}

/** Generates incur command entries from an OpenAPI spec. Resolves all `$ref` pointers. */
export async function generateCommands(
  spec: OpenAPISpec,
  fetch: FetchHandler,
  options: { basePath?: string | undefined } = {},
): Promise<Map<string, GeneratedCommand>> {
  const resolved = dereference(structuredClone(spec)) as OpenAPISpec
  const commands = new Map<string, GeneratedCommand>()
  const paths = (resolved.paths ?? {}) as Record<string, Record<string, unknown>>

  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (method.startsWith('x-')) continue
      const op = operation as Operation
      const name = op.operationId ?? `${method}_${path.replace(/[/{}]/g, '_')}`
      const httpMethod = method.toUpperCase()

      const pathParams = (op.parameters ?? []).filter((p) => p.in === 'path')
      const queryParams = (op.parameters ?? []).filter((p) => p.in === 'query')

      const bodySchema = op.requestBody?.content?.['application/json']?.schema
      const bodyProps = (bodySchema?.properties ?? {}) as Record<string, Record<string, unknown>>
      const bodyRequired = new Set((bodySchema?.required as string[]) ?? [])

      // Build args Zod schema from path params
      let argsSchema: z.ZodObject<any> | undefined
      if (pathParams.length > 0) {
        const shape: Record<string, z.ZodType> = {}
        for (const p of pathParams) {
          let zodType = p.schema ? toZod(p.schema) : z.string()
          if (p.description) zodType = zodType.describe(p.description)
          // Path params need coercion from string argv
          shape[p.name] = coerceIfNeeded(zodType)
        }
        argsSchema = z.object(shape)
      }

      // Build options Zod schema from query params + body properties
      const optShape: Record<string, z.ZodType> = {}
      for (const p of queryParams) {
        let zodType = p.schema ? toZod(p.schema) : z.string()
        if (!p.required) zodType = zodType.optional()
        if (p.description) zodType = zodType.describe(p.description)
        optShape[p.name] = coerceIfNeeded(zodType)
      }
      for (const [key, schema] of Object.entries(bodyProps)) {
        let zodType = toZod(schema)
        if (!bodyRequired.has(key)) zodType = zodType.optional()
        optShape[key] = zodType
      }
      const optionsSchema = Object.keys(optShape).length > 0 ? z.object(optShape) : undefined

      commands.set(name, {
        description: op.summary ?? op.description,
        args: argsSchema,
        options: optionsSchema,
        run: createHandler({
          basePath: options.basePath,
          fetch,
          httpMethod,
          path,
          pathParams,
          queryParams,
          bodyProps,
        }),
      })
    }
  }

  return commands
}

function createHandler(config: {
  basePath?: string | undefined
  bodyProps: Record<string, Record<string, unknown>>
  fetch: FetchHandler
  httpMethod: string
  path: string
  pathParams: Parameter[]
  queryParams: Parameter[]
}) {
  return async (context: any) => {
    const { args = {}, options = {} } = context

    // Build URL path with interpolated path params
    let urlPath = (config.basePath ?? '') + config.path
    for (const p of config.pathParams) {
      const value = args[p.name]
      if (value !== undefined) urlPath = urlPath.replace(`{${p.name}}`, String(value))
    }

    // Build query string from query params
    const query = new URLSearchParams()
    for (const p of config.queryParams) {
      const value = options[p.name]
      if (value !== undefined) query.set(p.name, String(value))
    }

    // Build body from body properties
    let body: string | undefined
    const bodyKeys = Object.keys(config.bodyProps)
    if (bodyKeys.length > 0) {
      const bodyObj: Record<string, unknown> = {}
      for (const key of bodyKeys) if (options[key] !== undefined) bodyObj[key] = options[key]
      if (Object.keys(bodyObj).length > 0) body = JSON.stringify(bodyObj)
    }

    const input: Fetch.FetchInput = {
      path: urlPath,
      method: config.httpMethod,
      headers: new Headers(),
      body,
      query,
    }

    if (body) input.headers.set('content-type', 'application/json')

    const request = Fetch.buildRequest(input)
    const response = await config.fetch(request)
    const output = await Fetch.parseResponse(response)

    if (!output.ok)
      return context.error({
        code: `HTTP_${output.status}`,
        message:
          typeof output.data === 'object' && output.data !== null && 'message' in output.data
            ? String((output.data as any).message)
            : typeof output.data === 'string'
              ? output.data
              : `HTTP ${output.status}`,
      })

    return output.data
  }
}

/** Converts a JSON Schema object to a Zod schema. */
function toZod(schema: Record<string, unknown>): z.ZodType {
  return z.fromJSONSchema(schema)
}

/** Wraps a Zod schema with coercion if the base type is number or boolean (argv is always strings). */
function coerceIfNeeded(schema: z.ZodType): z.ZodType {
  const isOptional = schema instanceof z.ZodOptional
  const inner = isOptional ? schema.unwrap() : schema

  const coerced = (() => {
    // Direct number
    if (inner instanceof z.ZodNumber)
      return isOptional ? z.coerce.number().optional() : z.coerce.number()
    // Direct boolean
    if (inner instanceof z.ZodBoolean)
      return isOptional ? z.coerce.boolean().optional() : z.coerce.boolean()
    // Union containing number or boolean (e.g. type: ["number", "null"] from OpenAPI 3.1)
    if (inner instanceof z.ZodUnion) {
      const options = (inner as any)._zod?.def?.options as z.ZodType[] | undefined
      if (options?.some((o: z.ZodType) => o instanceof z.ZodNumber))
        return isOptional ? z.coerce.number().optional() : z.coerce.number()
      if (options?.some((o: z.ZodType) => o instanceof z.ZodBoolean))
        return isOptional ? z.coerce.boolean().optional() : z.coerce.boolean()
    }
    // No coercion needed
    return undefined
  })()

  if (!coerced) return schema
  const desc = (schema as any).description ?? (inner as any).description
  return desc ? coerced.describe(desc) : coerced
}
