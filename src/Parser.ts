import type { z } from 'zod'

import type { FieldError } from './Errors.js'
import { ParseError, ValidationError } from './Errors.js'
import { isRecord, toKebab } from './internal/helpers.js'

/** Parses raw argv tokens against Zod schemas for args and options. */
export function parse<
  const args extends z.ZodObject<any> | undefined = undefined,
  const options extends z.ZodObject<any> | undefined = undefined,
>(argv: string[], options: parse.Options<args, options> = {}): parse.ReturnType<args, options> {
  const { args: argsSchema, options: optionsSchema, alias, defaults } = options

  const optionNames = createOptionNames(optionsSchema, alias)

  // First pass: split argv into positional tokens and raw option values
  const positionals: string[] = []
  const rawArgvOptions: Record<string, unknown> = {}

  let i = 0
  while (i < argv.length) {
    const token = argv[i]!

    if (token.startsWith('--no-') && token.length > 5) {
      // --no-flag negation
      const name = normalizeOptionName(token.slice(5), optionNames)
      if (!name) throw new ParseError({ message: `Unknown flag: ${token}` })
      rawArgvOptions[name] = false
      i++
    } else if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx !== -1) {
        // --flag=value
        const raw = token.slice(2, eqIdx)
        const name = normalizeOptionName(raw, optionNames)
        if (!name) throw new ParseError({ message: `Unknown flag: --${raw}` })
        setOption(rawArgvOptions, name, token.slice(eqIdx + 1), optionsSchema)
        i++
      } else {
        // --flag [value]
        const name = normalizeOptionName(token.slice(2), optionNames)
        if (!name) throw new ParseError({ message: `Unknown flag: ${token}` })
        if (isCountOption(name, optionsSchema)) {
          rawArgvOptions[name] = ((rawArgvOptions[name] as number) ?? 0) + 1
          i++
        } else if (isBooleanOption(name, optionsSchema)) {
          rawArgvOptions[name] = true
          i++
        } else {
          const value = argv[i + 1]
          if (value === undefined)
            throw new ParseError({ message: `Missing value for flag: ${token}` })
          setOption(rawArgvOptions, name, value, optionsSchema)
          i += 2
        }
      }
    } else if (token.startsWith('-') && !token.startsWith('--') && token.length >= 2) {
      // -f or -abc (stacked short aliases)
      const chars = token.slice(1)
      for (let j = 0; j < chars.length; j++) {
        const short = chars[j]!
        const name = optionNames.aliasToName.get(short)
        if (!name) throw new ParseError({ message: `Unknown flag: -${short}` })
        const isLast = j === chars.length - 1
        if (!isLast) {
          if (isCountOption(name, optionsSchema)) {
            rawArgvOptions[name] = ((rawArgvOptions[name] as number) ?? 0) + 1
          } else if (isBooleanOption(name, optionsSchema)) {
            rawArgvOptions[name] = true
          } else {
            throw new ParseError({
              message: `Non-boolean flag -${short} must be last in a stacked alias`,
            })
          }
        } else if (isCountOption(name, optionsSchema)) {
          rawArgvOptions[name] = ((rawArgvOptions[name] as number) ?? 0) + 1
        } else if (isBooleanOption(name, optionsSchema)) {
          rawArgvOptions[name] = true
        } else {
          const value = argv[i + 1]
          if (value === undefined)
            throw new ParseError({ message: `Missing value for flag: -${short}` })
          setOption(rawArgvOptions, name, value, optionsSchema)
          i++
        }
      }
      i++
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
  const args = argsSchema ? zodParse(argsSchema, rawArgs) : {}

  const rawDefaults = normalizeOptionDefaults(defaults, optionsSchema, optionNames)

  // Coerce raw option values before zod validation
  if (optionsSchema) {
    for (const [name, value] of Object.entries(rawArgvOptions)) {
      rawArgvOptions[name] = coerce(value, name, optionsSchema)
    }
  }

  const mergedOptions = { ...rawDefaults, ...rawArgvOptions }

  // Validate options through zod
  const parsedOptions = optionsSchema ? zodParse(optionsSchema, mergedOptions) : {}

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
    /** Config-backed option defaults merged before argv parsing. */
    defaults?: options extends z.ZodObject<any> ? Partial<z.input<options>> | undefined : undefined
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

type OptionNames = {
  aliasToName: Map<string, string>
  kebabToCamel: Map<string, string>
  knownOptions: Set<string>
}

/** Builds lookup tables for option names and short aliases. */
function createOptionNames(
  schema: z.ZodObject<any> | undefined,
  alias: Record<string, string> | undefined,
): OptionNames {
  const aliasToName = new Map<string, string>()
  if (alias) for (const [name, short] of Object.entries(alias)) aliasToName.set(short, name)

  const knownOptions = new Set(schema ? Object.keys(schema.shape) : [])
  const kebabToCamel = new Map<string, string>()
  for (const name of knownOptions) {
    const kebab = toKebab(name)
    if (kebab !== name) kebabToCamel.set(kebab, name)
  }

  return { aliasToName, kebabToCamel, knownOptions }
}

/** Normalizes a long option name, accepting kebab-case aliases for camelCase schema keys. */
function normalizeOptionName(raw: string, options: OptionNames): string | undefined {
  const name = options.kebabToCamel.get(raw) ?? raw
  return options.knownOptions.has(name) ? name : undefined
}

/** Normalizes config-backed defaults and validates config structure/key names. */
function normalizeOptionDefaults(
  defaults: unknown,
  schema: z.ZodObject<any> | undefined,
  optionNames: OptionNames,
): Record<string, unknown> {
  if (defaults === undefined) return {}
  if (!isRecord(defaults))
    throw new ParseError({
      message: 'Invalid config section: expected an object of option defaults',
    })
  if (!schema) {
    const [first] = Object.keys(defaults)
    if (first) throw new ParseError({ message: `Unknown config option: ${first}` })
    return {}
  }

  const normalized: Record<string, unknown> = {}
  for (const [rawName, value] of Object.entries(defaults)) {
    const name = normalizeOptionName(rawName, optionNames)
    if (!name) throw new ParseError({ message: `Unknown config option: ${rawName}` })
    normalized[name] = value
  }
  return normalized
}

/** Unwraps ZodDefault/ZodOptional to get the inner type. */
function unwrap(schema: z.ZodType): z.ZodType {
  let s = schema as any
  while (s.def?.innerType) s = s.def.innerType
  return s
}

/** Checks if an option's inner type is boolean. */
function isBooleanOption(name: string, schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  const field = schema.shape[name]
  if (!field) return false
  return unwrap(field).constructor.name === 'ZodBoolean'
}

/** Checks if an option is a count type (z.count()). */
function isCountOption(name: string, schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  const field = schema.shape[name]
  if (!field) return false
  return typeof field.meta === 'function' && field.meta()?.count === true
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

/** Wraps zod schema.parse(), converting ZodError to ValidationError. */
function zodParse(schema: z.ZodObject<any>, data: Record<string, unknown>) {
  try {
    return schema.parse(data)
  } catch (err: any) {
    const issues: any[] = err?.issues ?? err?.error?.issues ?? []
    const fieldErrors: FieldError[] = issues.map((issue: any) => ({
      code: issue.code,
      missing: !hasPath(data, issue.path ?? []),
      path: (issue.path ?? []).join('.'),
      expected: issue.expected ?? '',
      received: issue.received ?? '',
      message: issue.message ?? '',
    }))
    throw new ValidationError({
      message: issues.map((i: any) => i.message).join('; ') || 'Validation failed',
      fieldErrors,
      cause: err instanceof Error ? err : undefined,
    })
  }
}

/** Checks whether the raw input contains the full issue path. */
function hasPath(data: Record<string, unknown>, path: PropertyKey[]): boolean {
  if (path.length === 0) return true

  let current: unknown = data
  for (const part of path) {
    if (!isRecord(current) && !Array.isArray(current)) return false
    if (!(part in current)) return false
    current = (current as any)[part]
  }

  return true
}

/** Parses environment variables against a Zod schema. Falls back to `process.env` → `Deno.env` when no source is provided. */
export function parseEnv<const env extends z.ZodObject<any>>(
  schema: env,
  source: Record<string, string | undefined> = defaultEnvSource(),
): z.output<env> {
  const raw: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(schema.shape)) {
    const value = source[key]
    if (value !== undefined) raw[key] = coerceEnv(value, field as z.ZodType)
  }
  return zodParse(schema, raw) as z.output<env>
}

/** Coerces an env var string to the type expected by the schema field. */
function coerceEnv(value: string, field: z.ZodType): unknown {
  const inner = unwrap(field)
  const typeName = inner.constructor.name
  if (typeName === 'ZodNumber') return Number(value)
  if (typeName === 'ZodBoolean') return value === 'true' || value === '1'
  return value
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

/** Returns the best available env source for the current runtime. */
export function defaultEnvSource(): Record<string, string | undefined> {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as any
    if (g.process?.env) return g.process.env
    if (g.Deno?.env) return new Proxy({}, { get: (_, key) => g.Deno.env.get(key) }) as any
  }
  return {}
}
