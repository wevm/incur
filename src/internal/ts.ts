import { z } from 'zod'

export function propertyKey(key: string): string {
  return JSON.stringify(key)
}

export function schemaHasProperties(schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  return Object.keys(schema.shape).length > 0
}

export function schemaHasRequiredProperties(schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  return ((json.required as string[] | undefined) ?? []).length > 0
}

/** Converts a Zod schema to a TypeScript type string. */
export function schemaToType(schema: z.ZodType | undefined): string {
  if (!schema) return '{}'
  const json = z.toJSONSchema(schema) as Record<string, unknown>
  const defs = (json.$defs ?? {}) as Record<string, Record<string, unknown>>
  return resolveType(json, defs)
}

/** Converts a Zod object schema to a TypeScript object type string. */
export function objectSchemaToType(schema: z.ZodObject<any> | undefined): string {
  if (!schema) return '{}'
  return schemaToType(schema)
}

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
        return required.has(key)
          ? `${propertyKey(key)}: ${type}`
          : `${propertyKey(key)}?: ${type} | undefined`
      })
      return `{ ${entries.join('; ')} }`
    }
    default:
      return 'unknown'
  }
}
