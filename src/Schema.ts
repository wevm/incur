import { z } from 'zod'

/**
 * Converts a Zod schema to a JSON Schema object. Strips the `$schema`
 * meta-property. Represents bigints and dates as `{ type: "string" }`
 * since JSON lacks native types for them.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    unrepresentable: 'any',
    override: (ctx) => {
      const type = ctx.zodSchema._zod?.def?.type
      if (type === 'bigint' || type === 'date') ctx.jsonSchema.type = 'string'
    },
  }) as Record<string, unknown>
  delete result.$schema
  return result
}
