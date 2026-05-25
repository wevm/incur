import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as RuntimeContext from './internal/runtime-context.js'
import { importCli } from './internal/utils.js'

/** Error thrown when command type generation cannot emit a stable TypeScript type. */
export class TypegenError extends Error {
  override name = 'Incur.TypegenError'
}

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
    lines.push(`  /** Generated command: ${id} */`)
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
function objectSchemaToType(schema: z.ZodType | undefined): string {
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
  if (schema.not && Object.keys(schema).length === 1) return 'never'

  const type = schema.type as string | string[] | undefined
  if (Array.isArray(type))
    return type
      .map((t) => (t === 'null' ? 'null' : resolveType({ ...schema, type: t }, defs)))
      .join(' | ')

  switch (type) {
    case undefined:
      return 'unknown'
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
      const prefixItems = schema.prefixItems as Record<string, unknown>[] | undefined
      if (prefixItems) {
        const values = prefixItems.map((item) => resolveType(item, defs))
        const rest = items ? `, ...${arrayType(resolveType(items, defs))}` : ''
        return `[${values.join(', ')}${rest}]`
      }
      const itemType = items ? resolveType(items, defs) : 'unknown'
      return arrayType(itemType)
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
      const additional = schema.additionalProperties as
        | Record<string, unknown>
        | boolean
        | undefined
      if ((!properties || Object.keys(properties).length === 0) && additional === undefined)
        return '{}'
      const required = new Set((schema.required as string[] | undefined) ?? [])
      const entries = Object.entries(properties ?? {}).map(([key, value]) => {
        const type = resolveType(value, defs)
        if (required.has(key)) return `${propertyKey(key)}: ${type}`
        return `${propertyKey(key)}?: ${type} | undefined`
      })
      if (additional && typeof additional === 'object') {
        const values = Object.values(properties ?? {}).map((value) => resolveType(value, defs))
        entries.push(`[key: string]: ${union([resolveType(additional, defs), ...values])}`)
      }
      if (additional === true) entries.push('[key: string]: unknown')
      return `{ ${entries.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

function arrayType(type: string) {
  return type.includes(' | ') ? `(${type})[]` : `${type}[]`
}

function union(types: string[]) {
  return [...new Set(types)].join(' | ')
}

function isStream(command: Cli.CommandDefinition<any, any, any, any, any, any>) {
  return command.run.constructor.name === 'AsyncGeneratorFunction'
}

function propertyKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}
