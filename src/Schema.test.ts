import { Schema, z } from 'incur'

describe('toJsonSchema', () => {
  test('converts z.string()', () => {
    expect(Schema.toJsonSchema(z.string())).toEqual({ type: 'string' })
  })

  test('converts z.number()', () => {
    expect(Schema.toJsonSchema(z.number())).toEqual({ type: 'number' })
  })

  test('converts z.boolean()', () => {
    expect(Schema.toJsonSchema(z.boolean())).toEqual({ type: 'boolean' })
  })

  test('converts z.enum()', () => {
    expect(Schema.toJsonSchema(z.enum(['open', 'closed']))).toEqual({
      type: 'string',
      enum: ['open', 'closed'],
    })
  })

  test('converts z.array()', () => {
    expect(Schema.toJsonSchema(z.array(z.string()))).toEqual({
      type: 'array',
      items: { type: 'string' },
    })
  })

  test('converts z.object() with required fields', () => {
    expect(Schema.toJsonSchema(z.object({ name: z.string(), count: z.number() }))).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['name', 'count'],
      additionalProperties: false,
    })
  })

  test('.optional() removes from required', () => {
    expect(
      Schema.toJsonSchema(
        z.object({
          name: z.string(),
          age: z.number().optional(),
        }),
      ),
    ).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['name'],
      additionalProperties: false,
    })
  })

  test('.default() adds default to schema', () => {
    const result = Schema.toJsonSchema(
      z.object({
        state: z.enum(['open', 'closed']).default('open'),
      }),
    )
    expect(result).toMatchObject({
      properties: {
        state: { type: 'string', enum: ['open', 'closed'], default: 'open' },
      },
    })
  })

  test('.describe() adds description', () => {
    const result = Schema.toJsonSchema(
      z.object({
        name: z.string().describe('The user name'),
      }),
    )
    expect(result).toMatchObject({
      properties: {
        name: { type: 'string', description: 'The user name' },
      },
    })
  })

  test('.meta({ deprecated: true }) adds deprecated to JSON Schema', () => {
    const result = Schema.toJsonSchema(
      z.object({
        zone: z.string().optional().describe('Availability zone').meta({ deprecated: true }),
      }),
    )
    expect(result).toMatchObject({
      properties: {
        zone: { type: 'string', description: 'Availability zone', deprecated: true },
      },
    })
  })

  test('converts z.bigint() as string', () => {
    expect(Schema.toJsonSchema(z.bigint())).toEqual({ type: 'string' })
  })

  test('converts z.coerce.bigint() as string', () => {
    expect(Schema.toJsonSchema(z.coerce.bigint())).toEqual({ type: 'string' })
  })

  test('converts z.object() with bigint field', () => {
    expect(
      Schema.toJsonSchema(z.object({ amount: z.coerce.bigint().describe('Token amount') })),
    ).toEqual({
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Token amount' },
      },
      required: ['amount'],
      additionalProperties: false,
    })
  })

  test('converts z.date() as string', () => {
    expect(Schema.toJsonSchema(z.date())).toEqual({ type: 'string' })
  })

  test('converts z.coerce.date() as string', () => {
    expect(Schema.toJsonSchema(z.coerce.date())).toEqual({ type: 'string' })
  })

  test('full object with optional, default, and describe', () => {
    const result = Schema.toJsonSchema(
      z.object({
        name: z.string().describe('User name'),
        state: z.enum(['open', 'closed']).default('open').describe('Filter state'),
        limit: z.number().optional().describe('Max items'),
      }),
    )
    expect(result).toMatchInlineSnapshot(`
      {
        "additionalProperties": false,
        "properties": {
          "limit": {
            "description": "Max items",
            "type": "number",
          },
          "name": {
            "description": "User name",
            "type": "string",
          },
          "state": {
            "default": "open",
            "description": "Filter state",
            "enum": [
              "open",
              "closed",
            ],
            "type": "string",
          },
        },
        "required": [
          "name",
          "state",
        ],
        "type": "object",
      }
    `)
  })
})
