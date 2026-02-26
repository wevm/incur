import { z } from 'zod'

/** Formats help text for a router CLI or command group. */
export function formatRoot(name: string, options: formatRoot.Options = {}): string {
  const { description, commands = [] } = options
  const lines: string[] = []

  // Header
  lines.push(description ? `${name} \u2014 ${description}` : name)
  lines.push('')

  // Synopsis
  lines.push(`Usage: ${name} <command>`)

  // Commands
  if (commands.length > 0) {
    lines.push('')
    lines.push('Commands:')
    const maxLen = Math.max(...commands.map((c) => c.name.length))
    for (const cmd of commands) {
      if (cmd.description) {
        const padding = ' '.repeat(maxLen - cmd.name.length)
        lines.push(`  ${cmd.name}${padding}  ${cmd.description}`)
      } else lines.push(`  ${cmd.name}`)
    }
  }

  lines.push(...globalOptionsLines())

  return lines.join('\n')
}

export declare namespace formatRoot {
  type Options = {
    /** Commands to list. */
    commands?: { name: string; description?: string | undefined }[] | undefined
    /** A short description of the CLI or group. */
    description?: string | undefined
  }
}

export declare namespace formatCommand {
  type Options = {
    /** Map of option names to single-char aliases. */
    alias?: Record<string, string> | undefined
    /** Zod schema for positional arguments. */
    args?: z.ZodObject<any> | undefined
    /** A short description of what the command does. */
    description?: string | undefined
    /** Zod schema for environment variables. */
    env?: z.ZodObject<any> | undefined
    /** Formatted usage examples. */
    examples?: { command: string; description?: string }[] | undefined
    /** Plain text hint displayed after examples and before global options. */
    hint?: string | undefined
    /** Zod schema for named options/flags. */
    options?: z.ZodObject<any> | undefined
  }
}

/** Formats help text for a leaf command. */
export function formatCommand(name: string, options: formatCommand.Options = {}): string {
  const { alias, description, args, env, hint, options: opts, examples } = options
  const lines: string[] = []

  // Header
  lines.push(description ? `${name} \u2014 ${description}` : name)
  lines.push('')

  // Synopsis
  const synopsis = buildSynopsis(name, args)
  lines.push(`Usage: ${synopsis}`)

  // Arguments
  if (args) {
    const entries = argsEntries(args)
    if (entries.length > 0) {
      lines.push('')
      lines.push('Arguments:')
      const maxLen = Math.max(...entries.map((e) => e.name.length))
      for (const entry of entries)
        lines.push(`  ${entry.name}${' '.repeat(maxLen - entry.name.length)}  ${entry.description}`)
    }
  }

  // Options
  if (opts) {
    const entries = optionEntries(opts, alias)
    if (entries.length > 0) {
      lines.push('')
      lines.push('Options:')
      const maxLen = Math.max(...entries.map((e) => e.flag.length))
      for (const entry of entries) {
        const padding = ' '.repeat(maxLen - entry.flag.length)
        const desc =
          entry.defaultValue !== undefined
            ? `${entry.description} (default: ${entry.defaultValue})`
            : entry.description
        lines.push(`  ${entry.flag}${padding}  ${desc}`)
      }
    }
  }

  // Environment Variables
  if (env) {
    const entries = envEntries(env)
    if (entries.length > 0) {
      lines.push('')
      lines.push('Environment Variables:')
      const maxLen = Math.max(...entries.map((e) => e.name.length))
      for (const entry of entries) {
        const padding = ' '.repeat(maxLen - entry.name.length)
        const desc =
          entry.defaultValue !== undefined
            ? `${entry.description} (default: ${entry.defaultValue})`
            : entry.description
        lines.push(`  ${entry.name}${padding}  ${desc}`)
      }
    }
  }

  // Examples
  if (examples && examples.length > 0) {
    lines.push('')
    lines.push('Examples:')
    const maxLen = Math.max(
      ...examples.map((e) => (e.command ? `$ ${name} ${e.command}` : `$ ${name}`).length),
    )
    for (const ex of examples) {
      const cmd = ex.command ? `$ ${name} ${ex.command}` : `$ ${name}`
      if (ex.description)
        lines.push(`  ${cmd}${' '.repeat(maxLen - cmd.length)}  ${ex.description}`)
      else lines.push(`  ${cmd}`)
    }
  }

  // Hint
  if (hint) {
    lines.push('')
    lines.push(hint)
  }

  lines.push(...globalOptionsLines())

  return lines.join('\n')
}

/** Builds the synopsis string with `<required>` and `[optional]` placeholders. */
function buildSynopsis(name: string, args?: z.ZodObject<any>): string {
  if (!args) return name
  const parts = [name]
  for (const [key, schema] of Object.entries(args.shape))
    parts.push((schema as any).isOptional() ? `[${key}]` : `<${key}>`)
  return parts.join(' ')
}

/** Extracts arg entries from a Zod object schema. */
function argsEntries(schema: z.ZodObject<any>) {
  const entries: { name: string; description: string }[] = []
  for (const [key, field] of Object.entries(schema.shape))
    entries.push({ name: key, description: (field as any).description ?? '' })
  return entries
}

/** Extracts env var entries from a Zod object schema. */
function envEntries(schema: z.ZodObject<any>) {
  const entries: { name: string; description: string; defaultValue?: unknown }[] = []
  for (const [key, field] of Object.entries(schema.shape)) {
    const defaultValue = extractDefault(field)
    entries.push({ name: key, description: (field as any).description ?? '', defaultValue })
  }
  return entries
}

/** Extracts option entries from a Zod object schema. */
function optionEntries(schema: z.ZodObject<any>, alias?: Record<string, string> | undefined) {
  const entries: { flag: string; description: string; defaultValue?: unknown }[] = []
  for (const [key, field] of Object.entries(schema.shape)) {
    const type = resolveTypeName(field)
    const short = alias?.[key]
    const kebab = toKebab(key)
    const flag = short ? `--${kebab}, -${short} <${type}>` : `--${kebab} <${type}>`
    const defaultValue = extractDefault(field)
    entries.push({ flag, description: (field as any).description ?? '', defaultValue })
  }
  return entries
}

/** Resolves a human-readable type name from a Zod schema. */
function resolveTypeName(schema: unknown): string {
  const unwrapped = unwrap(schema)
  if (unwrapped instanceof z.ZodString) return 'string'
  if (unwrapped instanceof z.ZodNumber) return 'number'
  if (unwrapped instanceof z.ZodBoolean) return 'boolean'
  if (unwrapped instanceof z.ZodArray) return 'array'
  return 'value'
}

/** Unwraps optional/default/nullable wrappers to get the inner type. */
function unwrap(schema: unknown): unknown {
  if (schema instanceof z.ZodOptional) return unwrap(schema.unwrap())
  if (schema instanceof z.ZodDefault) return unwrap(schema.removeDefault())
  if (schema instanceof z.ZodNullable) return unwrap(schema.unwrap())
  return schema
}

/** Extracts the default value from a Zod schema, if any. */
function extractDefault(schema: unknown): unknown {
  if (schema instanceof z.ZodDefault) {
    const raw = schema._def.defaultValue
    const value = typeof raw === 'function' ? raw() : raw
    if (Array.isArray(value) && value.length === 0) return undefined
    return value
  }
  if (schema instanceof z.ZodOptional) return extractDefault(schema.unwrap())
  return undefined
}

/** Converts a camelCase string to kebab-case. */
function toKebab(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** Renders the built-in commands and global options block shared by all help output. */
function globalOptionsLines(): string[] {
  const builtins = [{ name: 'skills add', desc: 'Sync skill files to your agent' }]
  const maxCmd = Math.max(...builtins.map((b) => b.name.length))
  const flags = [
    { flag: '--format <toon|json|yaml|md>', desc: 'Output format' },
    { flag: '--help', desc: 'Show help' },
    { flag: '--llms', desc: 'Print LLM-readable manifest' },
    { flag: '--verbose', desc: 'Show full output envelope' },
    { flag: '--version', desc: 'Show version' },
  ]
  const maxLen = Math.max(...flags.map((f) => f.flag.length))
  return [
    '',
    'Built-in Commands:',
    ...builtins.map((b) => `  ${b.name}${' '.repeat(maxCmd - b.name.length)}  ${b.desc}`),
    '',
    'Global Options:',
    ...flags.map((f) => `  ${f.flag}${' '.repeat(maxLen - f.flag.length)}  ${f.desc}`),
  ]
}
