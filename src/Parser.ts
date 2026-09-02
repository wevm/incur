import type { z } from 'zod'

import type { FieldError } from './Errors.js'
import { ParseError, ValidationError } from './Errors.js'
import { isRecord, toKebab } from './internal/helpers.js'

/** Parses raw argv tokens against Zod schemas for args and options. */
export function parse<
  const args extends z.ZodObject<any> | undefined = undefined,
  const options extends z.ZodObject<any> | undefined = undefined,
>(argv: string[], options: parse.Options<args, options> = {}): parse.ReturnType<args, options> {
  return parseWithPositionals(argv, options)
}

function parseWithPositionals<
  const args extends z.ZodObject<any> | undefined = undefined,
  const options extends z.ZodObject<any> | undefined = undefined,
>(
  argv: string[],
  options: parse.Options<args, options> = {},
  additionalPositionals: AdditionalPositional[] = [],
): parse.ReturnType<args, options> {
  const { args: argsSchema, options: optionsSchema, alias, defaults } = options
  const optionNames = createOptionNames(optionsSchema, alias)
  const { optionEvents, positionalValues } = resolveArgv(
    argv,
    argsSchema,
    optionsSchema,
    alias,
    additionalPositionals,
  )
  const rawArgvOptions = replayOptionEvents(optionEvents, optionsSchema)

  // Assign positionals to args schema keys in order; a final array key collects the rest
  const rawArgs: Record<string, unknown> = {}
  const keys = Object.keys(argsSchema?.shape ?? {})
  let variadic = false
  if (argsSchema) {
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j]!
      if (isArrayField(key, argsSchema)) {
        if (j !== keys.length - 1)
          throw new Error(`Variadic arg "${key}" must be the last key in the args schema`)
        variadic = true
        const rest = positionalValues.slice(j)
        if (rest.length > 0) rawArgs[key] = rest
      } else if (positionalValues[j] !== undefined) {
        rawArgs[key] = positionalValues[j]!
      }
    }
  }
  if (!variadic && positionalValues.length > keys.length)
    throw new ParseError({ message: 'Unexpected argument' })

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

/** @internal Parser hooks shared with CLI global-option resolution. */
export const internal = {
  parse: parseWithPositionals,
  resolvePositionals,
}

type OptionNames = {
  aliasToName: Map<string, string>
  kebabToCamel: Map<string, string>
  knownOptions: Set<string>
}

type OptionEvent =
  | { type: 'count'; name: string }
  | { type: 'set'; name: string; value: unknown }
  | {
      type: 'assign'
      id?: number | undefined
      name: string
      value: unknown
      positional?: IndexedPositional | undefined
    }

type IndexedPositional = {
  index: number
  order: number
  value: string
}

type AdditionalPositional = IndexedPositional & {
  id: number
}

type AmbiguousPositional =
  | { type: 'additional'; id: number; positional: IndexedPositional }
  | {
      type: 'option'
      event: Extract<OptionEvent, { type: 'assign' }>
      positional: IndexedPositional
    }

const argvOrder = Number.MAX_SAFE_INTEGER

/** Splits argv into option events and compatible positional values without validating schemas. */
function resolveArgv(
  argv: string[],
  argsSchema: z.ZodObject<any> | undefined,
  optionsSchema: z.ZodObject<any> | undefined,
  alias: Record<string, string> | undefined,
  additionalPositionals: AdditionalPositional[],
) {
  const optionNames = createOptionNames(optionsSchema, alias)
  const positionals: IndexedPositional[] = []
  const optionEvents: OptionEvent[] = []

  let i = 0
  while (i < argv.length) {
    const token = argv[i]!

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx !== -1) {
        // --flag=value
        const raw = token.slice(2, eqIdx)
        const name = normalizeOptionName(raw, optionNames)
        if (!name) throw new ParseError({ message: `Unknown flag: --${raw}` })
        optionEvents.push({ type: 'set', name, value: token.slice(eqIdx + 1) })
        i++
      } else {
        // --flag [value] or --no-flag
        const raw = token.slice(2)
        const direct = normalizeOptionName(raw, optionNames)
        const negated = raw.startsWith('no-') && direct === undefined
        const name =
          direct ?? (negated ? normalizeOptionName(raw.slice(3), optionNames) : undefined)
        if (!name) throw new ParseError({ message: `Unknown flag: ${token}` })
        if (negated) {
          optionEvents.push({ type: 'assign', name, value: false })
          i++
        } else if (isCountOption(name, optionsSchema)) {
          optionEvents.push({ type: 'count', name })
          i++
        } else if (isBooleanOption(name, optionsSchema)) {
          const value = argv[i + 1]
          const explicit = value === 'true' || value === 'false'
          optionEvents.push({
            type: 'assign',
            name,
            value: explicit ? value === 'true' : true,
            ...(explicit ? { positional: { index: i + 1, order: argvOrder, value } } : undefined),
          })
          i += explicit ? 2 : 1
        } else {
          const value = argv[i + 1]
          if (value === undefined)
            throw new ParseError({ message: `Missing value for flag: ${token}` })
          optionEvents.push({ type: 'set', name, value })
          i += 2
        }
      }
    } else if (token.startsWith('-') && token.length >= 2) {
      // -f or -abc (stacked short aliases)
      const chars = token.slice(1)
      for (let j = 0; j < chars.length; j++) {
        const short = chars[j]!
        const name = optionNames.aliasToName.get(short)
        if (!name) throw new ParseError({ message: `Unknown flag: -${short}` })
        const isLast = j === chars.length - 1
        if (!isLast) {
          if (isCountOption(name, optionsSchema)) optionEvents.push({ type: 'count', name })
          else if (isBooleanOption(name, optionsSchema))
            optionEvents.push({ type: 'assign', name, value: true })
          else
            throw new ParseError({
              message: `Non-boolean flag -${short} must be last in a stacked alias`,
            })
        } else if (isCountOption(name, optionsSchema)) optionEvents.push({ type: 'count', name })
        else if (isBooleanOption(name, optionsSchema)) {
          const value = argv[i + 1]
          const explicit = value === 'true' || value === 'false'
          optionEvents.push({
            type: 'assign',
            name,
            value: explicit ? value === 'true' : true,
            ...(explicit ? { positional: { index: i + 1, order: argvOrder, value } } : undefined),
          })
          if (explicit) i++
        } else {
          const value = argv[i + 1]
          if (value === undefined)
            throw new ParseError({ message: `Missing value for flag: -${short}` })
          optionEvents.push({ type: 'set', name, value })
          i++
        }
      }
      i++
    } else {
      positionals.push({ index: i, order: argvOrder, value: token })
      i++
    }
  }

  const ambiguous: AmbiguousPositional[] = additionalPositionals.map(
    ({ id, index, order, value }) => ({
      type: 'additional',
      id,
      positional: { index, order, value },
    }),
  )
  for (const event of optionEvents)
    if (event.type === 'assign' && event.positional)
      ambiguous.push({ type: 'option', event, positional: event.positional })
  ambiguous.sort((a, b) => comparePositionals(a.positional, b.positional))

  const maximum = maximumPositionals(argsSchema)
  const available =
    maximum === Number.POSITIVE_INFINITY
      ? ambiguous.length
      : Math.max(maximum - positionals.length, 0)
  const selected = new Set<number>()
  for (const candidate of ambiguous.slice(0, available)) {
    positionals.push(candidate.positional)
    if (candidate.type === 'option') candidate.event.value = true
    else selected.add(candidate.id)
  }

  positionals.sort(comparePositionals)
  return {
    optionEvents,
    positionalValues: positionals.map(({ value }) => value),
    selected,
  }
}

/** Returns which additional boolean-looking values fit the command's positional schema. */
function resolvePositionals(
  argv: string[],
  options: parse.Options<any, any>,
  additionalPositionals: AdditionalPositional[],
) {
  return resolveArgv(argv, options.args, options.options, options.alias, additionalPositionals)
    .selected
}

/** Orders removed global values immediately before the argv token that followed them. */
function comparePositionals(a: IndexedPositional, b: IndexedPositional) {
  return a.index - b.index || a.order - b.order
}

/** Replays option assignments after positional ambiguity has been resolved. */
function replayOptionEvents(
  events: OptionEvent[],
  schema: z.ZodObject<any> | undefined,
  positionals?: ReadonlySet<number> | undefined,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {}
  for (const event of events) {
    if (event.type === 'count') raw[event.name] = ((raw[event.name] as number) ?? 0) + 1
    else if (event.type === 'set') setOption(raw, event.name, event.value, schema)
    else raw[event.name] = event.id !== undefined && positionals?.has(event.id) ? true : event.value
  }
  return raw
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

/** Checks if a field's inner type is an array. */
function isArrayField(name: string, schema: z.ZodObject<any> | undefined): boolean {
  if (!schema) return false
  const field = schema.shape[name]
  if (!field) return false
  return unwrap(field).constructor.name === 'ZodArray'
}

/** Returns the most positional tokens accepted by a schema, or infinity for a variadic arg. */
function maximumPositionals(schema: z.ZodObject<any> | undefined): number {
  if (!schema) return 0
  const keys = Object.keys(schema.shape)
  const last = keys.at(-1)
  return last && isArrayField(last, schema) ? Number.POSITIVE_INFINITY : keys.length
}

/** Sets an option value, collecting into arrays for array schemas. */
function setOption(
  raw: Record<string, unknown>,
  name: string,
  value: unknown,
  schema: z.ZodObject<any> | undefined,
) {
  if (isArrayField(name, schema)) {
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
export function zodParse(schema: z.ZodObject<any>, data: Record<string, unknown>) {
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

/** Parses known global options from argv, passing unknown flags and positionals through to `rest`. */
export function parseGlobals<const globals extends z.ZodObject<any>>(
  argv: string[],
  schema: globals,
  alias?: Record<string, string>,
  options: parseGlobals.Options = {},
): { parsed: z.output<globals>; rest: string[] } {
  const optionNames = createOptionNames(schema, alias)

  const rest: string[] = []
  const optionEvents: OptionEvent[] = []
  let booleanId = 0

  function assignBoolean(name: string, value: boolean, positional?: string | undefined) {
    if (positional === undefined) {
      optionEvents.push({ type: 'assign', name, value })
      return
    }
    const id = booleanId++
    options.onBooleanValue?.({ id, index: rest.length, name, value: positional })
    optionEvents.push({ type: 'assign', id, name, value })
  }

  let i = 0
  while (i < argv.length) {
    const token = argv[i]!

    if (token === '--') {
      for (let j = i; j < argv.length; j++) rest.push(argv[j]!)
      break
    }

    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=')
      if (eqIdx !== -1) {
        // --flag=value
        const raw = token.slice(2, eqIdx)
        const name = normalizeOptionName(raw, optionNames)
        if (!name) {
          rest.push(token)
        } else {
          optionEvents.push({ type: 'set', name, value: token.slice(eqIdx + 1) })
        }
        i++
      } else {
        // --flag [value] or --no-flag
        const raw = token.slice(2)
        const direct = normalizeOptionName(raw, optionNames)
        const negated = raw.startsWith('no-') && direct === undefined
        const name =
          direct ?? (negated ? normalizeOptionName(raw.slice(3), optionNames) : undefined)
        if (!name) {
          // Unknown flag — pass through as-is
          rest.push(token)
          i++
        } else if (negated) {
          assignBoolean(name, false)
          i++
        } else if (isCountOption(name, schema)) {
          optionEvents.push({ type: 'count', name })
          i++
        } else if (isBooleanOption(name, schema)) {
          const value = argv[i + 1]
          const explicit = value === 'true' || value === 'false'
          assignBoolean(name, explicit ? value === 'true' : true, explicit ? value : undefined)
          i += explicit ? 2 : 1
        } else {
          const value = argv[i + 1]
          if (value === undefined)
            throw new ParseError({ message: `Missing value for flag: ${token}` })
          optionEvents.push({ type: 'set', name, value })
          i += 2
        }
      }
    } else if (token.startsWith('-') && !token.startsWith('--') && token.length >= 2) {
      // Short flag(s)
      const chars = token.slice(1)
      let allKnown = true
      for (let j = 0; j < chars.length; j++) {
        if (!optionNames.aliasToName.has(chars[j]!)) {
          allKnown = false
          break
        }
      }

      if (!allKnown) {
        // Unknown short flag — pass through as-is
        rest.push(token)
        i++
      } else {
        for (let j = 0; j < chars.length; j++) {
          const short = chars[j]!
          const name = optionNames.aliasToName.get(short)!
          const isLast = j === chars.length - 1
          if (!isLast) {
            if (isCountOption(name, schema)) optionEvents.push({ type: 'count', name })
            else if (isBooleanOption(name, schema)) assignBoolean(name, true)
            else
              throw new ParseError({
                message: `Non-boolean flag -${short} must be last in a stacked alias`,
              })
          } else if (isCountOption(name, schema)) optionEvents.push({ type: 'count', name })
          else if (isBooleanOption(name, schema)) {
            const value = argv[i + 1]
            const explicit = value === 'true' || value === 'false'
            assignBoolean(name, explicit ? value === 'true' : true, explicit ? value : undefined)
            if (explicit) i++
          } else {
            const value = argv[i + 1]
            if (value === undefined)
              throw new ParseError({ message: `Missing value for flag: -${short}` })
            optionEvents.push({ type: 'set', name, value })
            i++
          }
        }
        i++
      }
    } else {
      // Positional — pass through
      rest.push(token)
      i++
    }
  }

  const rawOptions = replayOptionEvents(optionEvents, schema, options.positionals)
  if (options.validate === false) return { parsed: rawOptions as z.output<globals>, rest }

  // Coerce raw option values before zod validation
  for (const [name, value] of Object.entries(rawOptions))
    rawOptions[name] = coerce(value, name, schema)

  const parsed = zodParse(schema, rawOptions) as z.output<globals>
  return { parsed, rest }
}

export declare namespace parseGlobals {
  /** @internal A spaced boolean value that may instead belong to command positionals. */
  type BooleanValue = {
    /** Stable occurrence ID within one parse. */
    id: number
    /** Insertion index in the filtered argv. */
    index: number
    /** Global option name. */
    name: string
    /** Literal value. */
    value: string
  }
  /** Options for parsing global flags. */
  type Options = {
    /** @internal Receives spaced boolean values for command-aware resolution. */
    onBooleanValue?: ((value: BooleanValue) => void) | undefined
    /** @internal IDs that should be treated as command positionals instead of global values. */
    positionals?: ReadonlySet<number> | undefined
    /** Whether to validate parsed globals against the schema. */
    validate?: boolean | undefined
  }
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
