import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
<<<<<<< HEAD
import * as RuntimeContext from './internal/runtime-context.js'
=======
import * as RuntimeContext from './internal/client-runtime-context.js'
>>>>>>> 3df4c76 (refactor: keep public surface typegen scoped)
import { importCli } from './internal/utils.js'

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the `.d.ts`, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a `.d.ts` declaration string for the `incur` module augmentation. */
export function fromCli(cli: Cli.Cli): string {
<<<<<<< HEAD
  const entries = RuntimeContext.collectStructuredCommands(RuntimeContext.fromCli(cli))
=======
  const entries = RuntimeContext.collectClientCommands(RuntimeContext.fromCli(cli))
>>>>>>> 3df4c76 (refactor: keep public surface typegen scoped)

  const lines: string[] = ['export type Commands = {']

  for (const { id, command } of entries) {
    lines.push(
      `  ${propertyKey(id)}: { args: ${objectSchemaToType(command.args)}; options: ${objectSchemaToType(command.options)}${command.output ? `; output: ${schemaToType(command.output)}` : ''}${isStream(command) ? '; stream: true' : ''} }`,
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
function objectSchemaToType(schema: z.ZodObject<any> | undefined): string {
  if (!schema) return '{}'
  return schemaToType(schema)
}

/** Converts a Zod schema to a TypeScript type string. */
function schemaToType(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  const defs = (json.$defs ?? {}) as Record<string, Record<string, unknown>>
  return resolveType(json, defs)
}

/** Recursively resolves a JSON Schema node to a TypeScript type string. */
function resolveType(
  schema: Record<string, unknown>,
  defs: Record<string, Record<string, unknown>>,
): string {
  if (schema.$ref) {
    const ref = (schema.$ref as string).replace('#/$defs/', '')
    const resolved = defs[ref]
    if (resolved) return resolveType(resolved, defs)
    return 'unknown'
  }

  if ('const' in schema) return JSON.stringify(schema.const)
  if (schema.enum) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ')
  if (schema.anyOf)
    return (schema.anyOf as Record<string, unknown>[]).map((s) => resolveType(s, defs)).join(' | ')

  const type = schema.type as string | string[] | undefined
  if (Array.isArray(type))
    return type
      .map((t) => (t === 'null' ? 'null' : resolveType({ ...schema, type: t }, defs)))
      .join(' | ')

  switch (type) {
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
      const items = schema.items as Record<string, unknown> | undefined
      const itemType = items ? resolveType(items, defs) : 'unknown'
      return itemType.includes(' | ') ? `(${itemType})[]` : `${itemType}[]`
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
      if (!properties || Object.keys(properties).length === 0) return '{}'
      const required = new Set((schema.required as string[] | undefined) ?? [])
<<<<<<< HEAD
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
=======
      const entries = Object.entries(properties).map(
        ([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${resolveType(value, defs)}`,
      )
>>>>>>> 3df4c76 (refactor: keep public surface typegen scoped)
      return `{ ${entries.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

<<<<<<< HEAD
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
=======
function isStream(command: Cli.CommandDefinition<any, any, any, any, any, any>) {
>>>>>>> 3df4c76 (refactor: keep public surface typegen scoped)
  return command.run.constructor.name === 'AsyncGeneratorFunction'
}

function propertyKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}
