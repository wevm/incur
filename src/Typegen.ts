import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import * as RuntimeContext from './internal/runtime-context.js'
import { importCli } from './internal/utils.js'

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the `.d.ts`, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a `.d.ts` declaration string for the `incur` module augmentation. */
export function fromCli(cli: Cli.Cli): string {
  const entries = RuntimeContext.collectStructuredCommands(RuntimeContext.fromCli(cli))

  const lines: string[] = ["declare module 'incur' {", '  interface Register {', '    commands: {']

  for (const { id, command } of entries)
    lines.push(
      `      ${propertyKey(id)}: { args: ${objectSchemaToType(command.args)}; options: ${objectSchemaToType(command.options)}${command.output ? `; output: ${schemaToType(command.output)}` : ''}${isStream(command) ? '; stream: true' : ''} }`,
    )

  lines.push('    }', '  }', '}', '')
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
      const entries = Object.entries(properties).map(([key, value]) => {
        const type = resolveType(value, defs)
        if (required.has(key)) return `${propertyKey(key)}: ${type}`
        return `${propertyKey(key)}?: ${type} | undefined`
      })
      return `{ ${entries.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}

function propertyKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)
}

function isStream(command: Cli.CommandDefinition<any, any, any, any, any, any>) {
  return command.run.constructor.name === 'AsyncGeneratorFunction'
}
