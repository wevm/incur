import { Parser, z } from 'incur'

describe('parse', () => {
  test('returns empty args and options when no schemas', () => {
    expect(Parser.parse([])).toEqual({ args: {}, options: {} })
  })

  test('parses positional args in schema key order', () => {
    const result = Parser.parse(['hello', 'world'], {
      args: z.object({ greeting: z.string(), name: z.string() }),
    })
    expect(result.args).toEqual({ greeting: 'hello', name: 'world' })
  })

  test('parses --flag value options', () => {
    const result = Parser.parse(['--state', 'open'], {
      options: z.object({ state: z.string() }),
    })
    expect(result.options).toEqual({ state: 'open' })
  })

  test('parses --flag=value syntax', () => {
    const result = Parser.parse(['--state=closed'], {
      options: z.object({ state: z.string() }),
    })
    expect(result.options).toEqual({ state: 'closed' })
  })

  test('parses -f value short aliases', () => {
    const result = Parser.parse(['-s', 'open'], {
      options: z.object({ state: z.string() }),
      alias: { state: 's' },
    })
    expect(result.options).toEqual({ state: 'open' })
  })

  test('parses --verbose as true', () => {
    const result = Parser.parse(['--verbose'], {
      options: z.object({ verbose: z.boolean() }),
    })
    expect(result.options).toEqual({ verbose: true })
  })

  test('parses --no-verbose as false', () => {
    const result = Parser.parse(['--no-verbose'], {
      options: z.object({ verbose: z.boolean() }),
    })
    expect(result.options).toEqual({ verbose: false })
  })

  test('parses repeated flags as array', () => {
    const result = Parser.parse(['--label', 'bug', '--label', 'feature'], {
      options: z.object({ label: z.array(z.string()) }),
    })
    expect(result.options).toEqual({ label: ['bug', 'feature'] })
  })

  test('coerces string to number', () => {
    const result = Parser.parse(['--limit', '10'], {
      options: z.object({ limit: z.number() }),
    })
    expect(result.options).toEqual({ limit: 10 })
  })

  test('coerces string to boolean', () => {
    const result = Parser.parse(['--dry', 'true'], {
      options: z.object({ dry: z.boolean() }),
    })
    expect(result.options).toEqual({ dry: true })
  })

  test('applies default values for missing options', () => {
    const result = Parser.parse([], {
      options: z.object({ limit: z.number().default(30) }),
    })
    expect(result.options).toEqual({ limit: 30 })
  })

  test('allows optional fields to be omitted', () => {
    const result = Parser.parse([], {
      options: z.object({ verbose: z.boolean().optional() }),
    })
    expect(result.options).toEqual({})
  })

  test('throws ParseError on unknown flags', () => {
    expect(() =>
      Parser.parse(['--unknown', 'val'], {
        options: z.object({ state: z.string() }),
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ParseError' }))
  })

  test('throws ValidationError on missing required positional args', () => {
    expect(() =>
      Parser.parse([], {
        args: z.object({ name: z.string() }),
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ValidationError' }))
  })

  test('throws ValidationError on enum mismatch', () => {
    expect(() =>
      Parser.parse(['--state', 'invalid'], {
        options: z.object({ state: z.enum(['open', 'closed']) }),
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ValidationError' }))
  })

  test('stacks boolean short aliases (-vD)', () => {
    const result = Parser.parse(['-vD'], {
      options: z.object({
        verbose: z.boolean().default(false),
        debug: z.boolean().default(false),
      }),
      alias: { verbose: 'v', debug: 'D' },
    })
    expect(result.options).toEqual({ verbose: true, debug: true })
  })

  test('last flag in stack takes a value (-vDf json)', () => {
    const result = Parser.parse(['-vDf', 'json'], {
      options: z.object({
        verbose: z.boolean().default(false),
        debug: z.boolean().default(false),
        format: z.string().default('text'),
      }),
      alias: { verbose: 'v', debug: 'D', format: 'f' },
    })
    expect(result.options).toEqual({ verbose: true, debug: true, format: 'json' })
  })

  test('throws ParseError for non-boolean mid-stack', () => {
    expect(() =>
      Parser.parse(['-fv'], {
        options: z.object({
          format: z.string(),
          verbose: z.boolean().default(false),
        }),
        alias: { format: 'f', verbose: 'v' },
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ParseError' }))
  })

  test('throws ParseError when last flag in stack is missing a value', () => {
    expect(() =>
      Parser.parse(['-vf'], {
        options: z.object({
          verbose: z.boolean().default(false),
          format: z.string(),
        }),
        alias: { verbose: 'v', format: 'f' },
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ParseError' }))
  })

  test('single boolean short alias still works (-v)', () => {
    const result = Parser.parse(['-v'], {
      options: z.object({ verbose: z.boolean().default(false) }),
      alias: { verbose: 'v' },
    })
    expect(result.options).toEqual({ verbose: true })
  })

  test('throws ParseError for unknown alias in stack', () => {
    expect(() =>
      Parser.parse(['-vx'], {
        options: z.object({
          verbose: z.boolean().default(false),
        }),
        alias: { verbose: 'v' },
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ParseError' }))
  })

  test('detects boolean through nested optional+default', () => {
    const result = Parser.parse(['--verbose'], {
      options: z.object({ verbose: z.boolean().default(false).optional() }),
    })
    expect(result.options).toEqual({ verbose: true })
  })

  test('detects array through z.optional()', () => {
    const result = Parser.parse(['--label', 'bug', '--label', 'fix'], {
      options: z.object({ label: z.array(z.string()).optional() }),
    })
    expect(result.options).toEqual({ label: ['bug', 'fix'] })
  })

  test('detects array through z.default()', () => {
    const result = Parser.parse(['--label', 'bug', '--label', 'fix'], {
      options: z.object({ label: z.array(z.string()).default([]) }),
    })
    expect(result.options).toEqual({ label: ['bug', 'fix'] })
  })

  test('count defaults to 0 when flag not provided', () => {
    const result = Parser.parse([], {
      options: z.object({ verbose: z.number().default(0).meta({ count: true }) }),
    })
    expect(result.options).toEqual({ verbose: 0 })
  })

  test('count single flag increments to 1', () => {
    const result = Parser.parse(['--verbose'], {
      options: z.object({ verbose: z.number().default(0).meta({ count: true }) }),
    })
    expect(result.options).toEqual({ verbose: 1 })
  })

  test('count repeated flags increment', () => {
    const result = Parser.parse(['--verbose', '--verbose'], {
      options: z.object({ verbose: z.number().default(0).meta({ count: true }) }),
    })
    expect(result.options).toEqual({ verbose: 2 })
  })

  test('count stacked alias increments', () => {
    const result = Parser.parse(['-vv'], {
      options: z.object({ verbose: z.number().default(0).meta({ count: true }) }),
      alias: { verbose: 'v' },
    })
    expect(result.options).toEqual({ verbose: 2 })
  })

  test('count mixed stacking with boolean', () => {
    const result = Parser.parse(['-vvD'], {
      options: z.object({
        verbose: z.number().default(0).meta({ count: true }),
        debug: z.boolean().default(false),
      }),
      alias: { verbose: 'v', debug: 'D' },
    })
    expect(result.options).toEqual({ verbose: 2, debug: true })
  })

  test('count .describe() works', () => {
    const result = Parser.parse(['-v'], {
      options: z.object({
        verbose: z.number().default(0).meta({ count: true }).describe('Verbosity level'),
      }),
      alias: { verbose: 'v' },
    })
    expect(result.options).toEqual({ verbose: 1 })
  })

  test('parses positional args and options together', () => {
    const result = Parser.parse(['myrepo', '--limit', '5'], {
      args: z.object({ repo: z.string() }),
      options: z.object({ limit: z.number() }),
    })
    expect(result.args).toEqual({ repo: 'myrepo' })
    expect(result.options).toEqual({ limit: 5 })
  })

  test('applies config defaults when argv omits an option', () => {
    const result = Parser.parse([], {
      defaults: { limit: 10 },
      options: z.object({ limit: z.number().default(30) }),
    })
    expect(result.options).toEqual({ limit: 10 })
  })

  test('argv overrides config defaults', () => {
    const result = Parser.parse(['--limit', '5'], {
      defaults: { limit: 10 },
      options: z.object({ limit: z.number().default(30) }),
    })
    expect(result.options).toEqual({ limit: 5 })
  })

  test('argv arrays replace config arrays', () => {
    const result = Parser.parse(['--label', 'bug', '--label', 'feature'], {
      defaults: { label: ['ops'] },
      options: z.object({ label: z.array(z.string()).default([]) }),
    })
    expect(result.options).toEqual({ label: ['bug', 'feature'] })
  })

  test('kebab-case config keys map to camelCase schema names', () => {
    const result = Parser.parse([], {
      defaults: { 'save-dev': true } as any,
      options: z.object({ saveDev: z.boolean().default(false) }),
    })
    expect(result.options).toEqual({ saveDev: true })
  })

  test('throws ParseError on unknown config option keys', () => {
    expect(() =>
      Parser.parse([], {
        defaults: { missing: true } as any,
        options: z.object({ saveDev: z.boolean().default(false) }),
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ParseError' }))
  })

  test('throws ValidationError for invalid config defaults when argv does not override them', () => {
    expect(() =>
      Parser.parse([], {
        defaults: { limit: 'oops' } as any,
        options: z.object({ limit: z.number() }),
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ValidationError' }))
  })

  test('argv overrides invalid config defaults', () => {
    const result = Parser.parse(['--limit', '5'], {
      defaults: { limit: 'oops' } as any,
      options: z.object({ limit: z.number() }),
    })
    expect(result.options).toEqual({ limit: 5 })
  })

  test('defaults with no options schema throws on non-empty defaults', () => {
    expect(() =>
      Parser.parse([], {
        defaults: { limit: 10 } as any,
      }),
    ).toThrow(expect.objectContaining({ name: 'Incur.ParseError' }))
  })

  test('defaults with no options schema and empty defaults is a no-op', () => {
    const result = Parser.parse([], { defaults: {} as any })
    expect(result.options).toEqual({})
  })

  test('config array defaults are used when argv omits the option', () => {
    const result = Parser.parse([], {
      defaults: { label: ['bug', 'feature'] },
      options: z.object({ label: z.array(z.string()).default([]) }),
    })
    expect(result.options).toEqual({ label: ['bug', 'feature'] })
  })

  test('refined option schemas validate only the merged winning values', () => {
    const result = Parser.parse(['--min', '1', '--max', '3'], {
      defaults: { min: 'oops' } as any,
      options: z
        .object({ min: z.number(), max: z.number() })
        .refine((value) => value.min < value.max, { message: 'min must be less than max' }),
    })
    expect(result.options).toEqual({ min: 1, max: 3 })
  })
})
