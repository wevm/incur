import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import { importCli } from './internal/utils.js'

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the `.d.ts`, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a `.ts` declaration string exporting an incur command map type and Register augmentation. */
export function fromCli(cli: Cli.Cli): string {
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const entries = collectEntries(commands, [])

  const lines: string[] = [
    '/** Command map generated from your incur CLI. */',
    'export type Commands = {',
  ]

  for (const { name, args, options, output } of entries) {
    const outputType = output ? `; output: ${schemaToType(output, 'unknown')}` : ''
    lines.push(
      `  /** Generated command ${JSON.stringify(name)}. */`,
      `  '${name}': { args: ${schemaToType(args)}; options: ${schemaToType(options)}${outputType} }`,
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
  )
  return lines.join('\n')
}

/** Recursively collects leaf commands with their full paths and schemas. */
function collectEntries(commands: Map<string, any>, prefix: string[]): Entry[] {
  const result: ReturnType<typeof collectEntries> = []
  for (const [name, entry] of commands) {
    if ('_alias' in entry || '_fetch' in entry) continue
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) result.push(...collectEntries(entry.commands, path))
    else
      result.push({
        name: path.join(' '),
        args: entry.args,
        options: entry.options,
        output: entry.output,
      })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

type Entry = {
  args?: z.ZodObject<any> | undefined
  name: string
  options?: z.ZodObject<any> | undefined
  output?: z.ZodType | undefined
}

/** Converts a Zod schema to a TypeScript type string. Returns `fallback` for undefined schemas. */
function schemaToType(schema: z.ZodType | undefined, fallback = '{}'): string {
  if (!schema) return fallback

  const kind = (schema as any)._def?.type
  if (kind === 'void') return 'void'
  if (kind === 'undefined') return 'undefined'

  let json: Record<string, unknown>
  try {
    json = z.toJSONSchema(schema) as Record<string, unknown>
  } catch (error) {
    throw new TypegenError(
      'Cannot generate TypeScript type for schema unsupported by JSON Schema',
      {
        cause: error,
      },
    )
  }

  const defs = (json.$defs ?? {}) as Record<string, Record<string, unknown>>
  return resolveType(json, defs)
}

/** Error thrown when type generation cannot represent a schema. */
class TypegenError extends Error {
  /** Error class name. */
  override name = 'Incur.TypegenError'
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
      const prefixItems = schema.prefixItems as Record<string, unknown>[] | undefined
      if (prefixItems) {
        const items = schema.items as Record<string, unknown> | undefined
        const entries = prefixItems.map((item) => resolveType(item, defs))
        if (items) entries.push(`...${resolveType(items, defs)}[]`)
        return `[${entries.join(', ')}]`
      }

      const items = schema.items as Record<string, unknown> | undefined
      const itemType = items ? resolveType(items, defs) : 'unknown'
      return itemType.includes(' | ') ? `(${itemType})[]` : `${itemType}[]`
    }
    case 'object': {
      const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
      const additional = schema.additionalProperties
      if (!properties || Object.keys(properties).length === 0) {
        if (isSchema(additional))
          return `Record<${propertyNamesType(schema.propertyNames, defs)}, ${resolveType(
            additional,
            defs,
          )}>`
        return '{}'
      }

      const required = new Set((schema.required as string[] | undefined) ?? [])
      const entries = Object.entries(properties).map(
        ([key, value]) =>
          `${propertyKey(key)}${required.has(key) ? '' : '?'}: ${propertyType(
            resolveType(value, defs),
            required.has(key),
          )}`,
      )
      if (isSchema(additional)) entries.push(`[key: string]: ${resolveType(additional, defs)}`)
      return `{ ${entries.join('; ')} }`
    }
    default:
      if ('not' in schema) return 'never'
      return 'unknown'
  }
}

function isSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function propertyKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}

function propertyNamesType(value: unknown, defs: Record<string, Record<string, unknown>>): string {
  if (isSchema(value)) return resolveType(value, defs)
  return 'string'
}

function propertyType(type: string, required: boolean): string {
  if (required || type.split(' | ').includes('undefined')) return type
  return `${type} | undefined`
}
