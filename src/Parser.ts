import type { z } from 'zod'

/** Parses raw argv tokens against Zod schemas for args and options. */
export function parse<
  const args extends z.ZodObject<any> | undefined = undefined,
  const options extends z.ZodObject<any> | undefined = undefined,
>(argv: string[], options: parse.Options<args, options> = {}): parse.ReturnType<args, options> {
  const argsSchema = options.args
  const optionsSchema = options.options
  const alias = options.alias

  // Build reverse alias map: short char → long name
  const aliasToName = new Map<string, string>()
  if (alias) for (const [name, short] of Object.entries(alias)) aliasToName.set(short, name)

  // Known option names from schema
  const knownOptions = new Set(optionsSchema ? Object.keys(optionsSchema.shape) : [])

  // First pass: split argv into positional tokens and raw option values
  const positionals: string[] = []
  const rawOptions: Record<string, unknown> = {}

  let i = 0
  while (i < argv.length) {
    const token = argv[i]!

    if (token.startsWith('--no-') && token.length > 5) {
      // --no-flag negation
      const name = token.slice(5)
      if (!knownOptions.has(name)) throw new Error(`Unknown flag: ${token}`)
      rawOptions[name] = false
      i++
    } else if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx !== -1) {
        // --flag=value
        const name = token.slice(2, eqIdx)
        if (!knownOptions.has(name)) throw new Error(`Unknown flag: --${name}`)
        setOption(rawOptions, name, token.slice(eqIdx + 1), optionsSchema)
        i++
      } else {
        // --flag [value]
        const name = token.slice(2)
        if (!knownOptions.has(name)) throw new Error(`Unknown flag: ${token}`)
        if (isBooleanOption(name, optionsSchema)) {
          rawOptions[name] = true
          i++
        } else {
          const value = argv[i + 1]
          if (value === undefined) throw new Error(`Missing value for flag: ${token}`)
          setOption(rawOptions, name, value, optionsSchema)
          i += 2
        }
      }
    } else if (token.startsWith('-') && token.length === 2) {
      // -f [value]
      const short = token.slice(1)
      const name = aliasToName.get(short)
      if (!name) throw new Error(`Unknown flag: ${token}`)
      if (isBooleanOption(name, optionsSchema)) {
        rawOptions[name] = true
        i++
      } else {
        const value = argv[i + 1]
        if (value === undefined) throw new Error(`Missing value for flag: ${token}`)
        setOption(rawOptions, name, value, optionsSchema)
        i += 2
      }
    } else {
      positionals.push(token)
      i++
    }
  }

  // Assign positionals to args schema keys in order
  const rawArgs: Record<string, string> = {}
  if (argsSchema) {
    const keys = Object.keys(argsSchema.shape)
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!
      if (positionals[j] !== undefined) {
        rawArgs[key] = positionals[j]!
      }
    }
  }

  // Validate args through zod
  const args = argsSchema ? argsSchema.parse(rawArgs) : {}

  // Coerce raw option values before zod validation
  if (optionsSchema) {
    for (const [name, value] of Object.entries(rawOptions)) {
      rawOptions[name] = coerce(value, name, optionsSchema)
    }
  }

  // Validate options through zod
  const parsedOptions = optionsSchema ? optionsSchema.parse(rawOptions) : {}

  return { args, options: parsedOptions } as parse.ReturnType<args, options>
}

export declare namespace parse {
  /** Options for parsing. */
  type Options<
    args extends z.ZodObject<any> | undefined = undefined,
    options extends z.ZodObject<any> | undefined = undefined,
  > = {
    /** Zod schema for positional arguments. Keys define order. */
    args?: args
    /** Zod schema for named options/flags. */
    options?: options
    /** Map of option names to single-char aliases. */
    alias?: Record<string, string> | undefined
  }
  /** Parsed result with args and options. */
  type ReturnType<
    args extends z.ZodObject<any> | undefined = undefined,
    options extends z.ZodObject<any> | undefined = undefined,
  > = {
    /** Parsed positional arguments. */
    args: args extends z.ZodObject<any> ? z.output<args> : {}
    /** Parsed named options. */
    options: options extends z.ZodObject<any> ? z.output<options> : {}
  }
}

/** Unwraps ZodDefault/ZodOptional to get the inner type. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema as any
  while (s._zod?.def?.innerType) s = s._zod.def.innerType
  return s
}

/** Checks if an option's inner type is boolean. */
function isBooleanOption(name: string, schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  const field = schema.shape[name]
  if (!field) return false
  return unwrap(field).constructor.name === 'ZodBoolean'
}

/** Checks if an option's inner type is an array. */
function isArrayOption(name: string, schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  const field = schema.shape[name]
  if (!field) return false
  return unwrap(field).constructor.name === 'ZodArray'
}

/** Sets an option value, collecting into arrays for array schemas. */
function setOption(
  raw: Record<string, unknown>,
  name: string,
  value: string,
  schema: z.ZodObject<any> | undefined,
) {
  if (isArrayOption(name, schema)) {
    const existing = raw[name]
    if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      raw[name] = [value]
    }
  } else {
    raw[name] = value
  }
}

/** Coerces a raw string value to the type expected by the schema. */
function coerce(value: unknown, name: string, schema: z.ZodObject<any>): unknown {
  const field = schema.shape[name]
  if (!field) return value
  const inner = unwrap(field)
  const typeName = inner.constructor.name

  if (typeName === 'ZodNumber' && typeof value === 'string') {
    return Number(value)
  }
  if (typeName === 'ZodBoolean' && typeof value === 'string') {
    return value === 'true'
  }
  return value
}
