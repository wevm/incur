import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import { importCli } from './internal/utils.js'

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the `.d.ts`, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a `.d.ts` declaration string for the `incur` module augmentation. */
export function fromCli(cli: Cli.Cli): string {
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const entries = collectEntries(commands, [])

  const lines: string[] = ["declare module 'incur' {", '  interface Register {', '    commands: {']

  for (const { name, args, options } of entries)
    lines.push(
      `      '${name}': { args: ${schemaToType(args)}; options: ${schemaToType(options)} }`,
    )

  lines.push('    }', '  }', '}', '')
  return lines.join('\n')
}

/** Recursively collects leaf commands with their full paths and schemas. */
function collectEntries(
  commands: Map<string, any>,
  prefix: string[],
): { name: string; args?: z.ZodObject<any>; options?: z.ZodObject<any> }[] {
  const result: ReturnType<typeof collectEntries> = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      if (entry.default) result.push({ name: path.join(' '), args: entry.default.args, options: entry.default.options })
      result.push(...collectEntries(entry.commands, path))
    }
    else result.push({ name: path.join(' '), args: entry.args, options: entry.options })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** Converts a Zod object schema to a TypeScript type string. Returns `{}` for undefined schemas. */
function schemaToType(schema: z.ZodObject<any> | undefined): string {
  if (!schema) return '{}'
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  const defs = (json.$defs ?? {}) as Record<string, Record<string, unknown>>
  const properties = json.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties || Object.keys(properties).length === 0) return '{}'
  const required = new Set((json.required as string[] | undefined) ?? [])
  const entries = Object.entries(properties).map(
    ([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${resolveType(value, defs)}`,
  )
  return `{ ${entries.join('; ')} }`
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
      const entries = Object.entries(properties).map(
        ([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${resolveType(value, defs)}`,
      )
      return `{ ${entries.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}
