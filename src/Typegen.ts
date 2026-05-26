import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as RuntimeContext from './internal/runtime-context.js'
import { importCli } from './internal/utils.js'

/** Error thrown when command type generation cannot emit a stable TypeScript type. */
export class TypegenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }

  override name = 'Incur.TypegenError'
}

type JsonSchema = Record<string, unknown> | boolean

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the `.d.ts`, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a `.d.ts` declaration string for the `incur` module augmentation. */
export function fromCli(cli: Cli.Cli): string {
  const entries = RuntimeContext.collectStructuredCommands(RuntimeContext.fromCli(cli))

  const lines: string[] = ['export type Commands = {']

  for (const { id, command } of entries) {
    const context = `command ${JSON.stringify(id)}`
    lines.push(
      `  ${propertyKey(id)}: { args: ${objectSchemaToType(command.args, `${context} args`)}; options: ${objectSchemaToType(command.options, `${context} options`)}${command.output ? `; output: ${schemaToType(command.output, `${context} output`)}` : ''}${isStream(command) ? '; stream: true' : ''} }`,
    )
  }

  lines.push(
    '}',
    '',
    "declare module 'incur' {",
    '  interface Register {',
    '    commands: Commands',
    '  }',
    '}',
    '',
    "declare module 'incur/client' {",
    '  interface Register {',
    '    commands: Commands',
    '  }',
    '}',
    '',
  )
  return lines.join('\n')
}

/** Converts a Zod object schema to a TypeScript type string. Returns `{}` for undefined schemas. */
function objectSchemaToType(schema: z.ZodType | undefined, context: string): string {
  if (!schema) return '{}'
  return schemaToType(schema, context)
}

/** Converts a Zod schema to a TypeScript type string. */
function schemaToType(schema: z.ZodType, context: string): string {
  const json = (() => {
    try {
      return z.toJSONSchema(schema)
    } catch (error) {
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: Zod could not convert the schema to JSON Schema. ${errorMessage(error)}`,
        { cause: error },
      )
    }
  })()
  if (!isRecord(json))
    throw new TypegenError(
      `Cannot generate TypeScript for ${context}: JSON Schema root is invalid.`,
    )
  const defs = json.$defs
  if (defs !== undefined && !isSchemaMap(defs))
    throw new TypegenError(
      `Cannot generate TypeScript for ${context}: JSON Schema $defs is invalid.`,
    )
  return resolveType(json, defs ?? {}, context)
}

/** Recursively resolves a JSON Schema node to a TypeScript type string. */
function resolveType(
  schema: JsonSchema,
  defs: Record<string, JsonSchema>,
  context: string,
  seen: Set<string> = new Set(),
): string {
  if (typeof schema === 'boolean') return schema ? 'unknown' : 'never'

  if (schema.$ref) {
    if (typeof schema.$ref !== 'string')
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: JSON Schema $ref is invalid.`,
      )
    if (!schema.$ref.startsWith('#/$defs/'))
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: unsupported JSON Schema reference "${schema.$ref}".`,
      )
    const ref = schema.$ref.replace('#/$defs/', '')
    if (seen.has(ref))
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: recursive JSON Schema reference "${schema.$ref}" is not supported.`,
      )
    const resolved = defs[ref]
    if (resolved) return resolveType(resolved, defs, context, new Set([...seen, ref]))
    throw new TypegenError(
      `Cannot generate TypeScript for ${context}: unresolved JSON Schema reference "${schema.$ref}".`,
    )
  }

  if ('const' in schema) return literalType(schema.const, context)
  if (schema.enum) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0)
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: JSON Schema enum is invalid.`,
      )
    return schema.enum.map((v) => literalType(v, context)).join(' | ')
  }
  if (schema.anyOf)
    return union(
      schemaArray(schema.anyOf, context, 'anyOf').map((s) => resolveType(s, defs, context, seen)),
    )
  if (schema.not && semanticKeys(schema).length === 1) return 'never'

  const type = schema.type as string | string[] | undefined
  if (Array.isArray(type))
    return type
      .map((t) => {
        if (typeof t !== 'string' || t.length === 0)
          throw new TypegenError(
            `Cannot generate TypeScript for ${context}: JSON Schema type array is invalid.`,
          )
        return t === 'null' ? 'null' : resolveType({ ...schema, type: t }, defs, context, seen)
      })
      .join(' | ')

  switch (type) {
    case undefined:
      if (semanticKeys(schema).length === 0) return 'unknown'
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: JSON Schema node is missing a supported type.`,
      )
    case 'string':
      return 'string'
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'null':
      return 'null'
    case 'array': {
      const items = schema.items as JsonSchema | undefined
      const prefixItems = schema.prefixItems as JsonSchema[] | undefined
      if (prefixItems) {
        const values = schemaArray(prefixItems, context, 'prefixItems').map((item) =>
          resolveType(item, defs, context, seen),
        )
        const rest =
          items !== undefined ? `, ...${arrayType(resolveType(items, defs, context, seen))}` : ''
        return `[${values.join(', ')}${rest}]`
      }
      const itemType = items !== undefined ? resolveType(items, defs, context, seen) : 'unknown'
      return arrayType(itemType)
    }
    case 'object': {
      const properties = schema.properties
      if (properties !== undefined && !isSchemaMap(properties))
        throw new TypegenError(
          `Cannot generate TypeScript for ${context}: JSON Schema object properties are invalid.`,
        )
      assertSupportedPropertyNames(schema, context)
      const additional = schema.additionalProperties as JsonSchema | boolean | undefined
      if ((!properties || Object.keys(properties).length === 0) && additional === undefined)
        return '{}'
      const required = new Set((schema.required as string[] | undefined) ?? [])
      const entries = Object.entries(properties ?? {}).map(([key, value]) => {
<<<<<<< HEAD
        const type = resolveType(value, defs)
        if (required.has(key)) return `${propertyKey(key)}: ${type}`
        return `${propertyKey(key)}?: ${type} | undefined`
=======
        const type = resolveType(value, defs, context, seen)
        return required.has(key)
          ? `${propertyKey(key)}: ${type}`
          : `${propertyKey(key)}?: ${type} | undefined`
>>>>>>> 0a77e57 (fix: tighten typed client typegen surface)
      })
      if (additional && typeof additional === 'object') {
        const values = Object.entries(properties ?? {}).map(([key, value]) => {
          const type = resolveType(value, defs, context, seen)
          return required.has(key) ? type : `${type} | undefined`
        })
        entries.push(
          `[key: string]: ${union([resolveType(additional, defs, context, seen), ...values])}`,
        )
      }
      if (additional === true) entries.push('[key: string]: unknown')
      return `{ ${entries.join('; ')} }`
    }
    default:
      throw new TypegenError(
        `Cannot generate TypeScript for ${context}: unsupported JSON Schema type "${String(type)}".`,
      )
  }
}

function arrayType(type: string) {
  return type.includes(' | ') ? `(${type})[]` : `${type}[]`
}

function union(types: string[]) {
  return [...new Set(types)].join(' | ')
}

<<<<<<< HEAD
function isStream(command: Cli.CommandDefinition<any, any, any, any, any, any>) {
=======
function semanticKeys(schema: Record<string, unknown>) {
  return Object.keys(schema).filter((key) => !['$schema', 'description', 'title'].includes(key))
}

function schemaArray(value: unknown, context: string, key: string): JsonSchema[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypegenError(
      `Cannot generate TypeScript for ${context}: JSON Schema ${key} is invalid.`,
    )
  if (value.every((item) => typeof item === 'boolean' || isRecord(item))) return value
  throw new TypegenError(
    `Cannot generate TypeScript for ${context}: JSON Schema ${key} is invalid.`,
  )
}

function isSchemaMap(value: unknown): value is Record<string, JsonSchema> {
  return (
    isRecord(value) &&
    Object.values(value).every((schema) => typeof schema === 'boolean' || isRecord(schema))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function literalType(value: unknown, context: string) {
  const type = JSON.stringify(value)
  if (type !== undefined) return type
  throw new TypegenError(
    `Cannot generate TypeScript for ${context}: JSON Schema literal is invalid.`,
  )
}

function assertSupportedPropertyNames(schema: Record<string, unknown>, context: string) {
  if (schema.propertyNames === undefined) return
  if (schema.propertyNames === true) return
  if (isRecord(schema.propertyNames) && schema.propertyNames.type === 'string') return
  throw new TypegenError(
    `Cannot generate TypeScript for ${context}: non-string JSON Schema property names are not supported.`,
  )
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isStream(command: CommandTree.CommandDefinition) {
>>>>>>> 0a77e57 (fix: tighten typed client typegen surface)
  return command.run.constructor.name === 'AsyncGeneratorFunction'
}

function propertyKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}
