import { z } from 'zod'

/** Formats help text for a router CLI or command group. */
export function formatRoot(name: string, options: formatRoot.Options = {}): string {
  const { aliases, description, version, commands = [], root = false } = options
  const lines: string[] = []

  // Header
  const title = version ? `${name}@${version}` : name
  lines.push(description ? `${title} \u2014 ${description}` : title)
  if (aliases?.length) lines.push(`Aliases: ${aliases.join(', ')}`)
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

  lines.push(...globalOptionsLines(root))

  return lines.join('\n')
}

export declare namespace formatRoot {
  type Options = {
    /** Alternative binary names for this CLI. */
    aliases?: string[] | undefined
    /** Commands to list. */
    commands?: { name: string; description?: string | undefined }[] | undefined
    /** A short description of the CLI or group. */
    description?: string | undefined
    /** Show root-level built-in commands and flags. */
    root?: boolean | undefined
    /** CLI version string. */
    version?: string | undefined
  }
}

export declare namespace formatCommand {
  type Options = {
    /** Map of option names to single-char aliases. */
    alias?: Record<string, string> | undefined
    /** Alternative binary names for this CLI. */
    aliases?: string[] | undefined
    /** Zod schema for positional arguments. */
    args?: z.ZodObject<any> | undefined
    /** Subcommands to list (for CLIs with both a root handler and subcommands). */
    commands?: { name: string; description?: string | undefined }[] | undefined
    /** A short description of what the command does. */
    description?: string | undefined
    /** Zod schema for environment variables. */
    env?: z.ZodObject<any> | undefined
    /** Override environment variable source for "set:" display. Defaults to `process.env`. */
    envSource?: Record<string, string | undefined> | undefined
    /** Formatted usage examples. */
    examples?: { command: string; description?: string }[] | undefined
    /** Plain text hint displayed after examples and before global options. */
    hint?: string | undefined
    /** Zod schema for named options/flags. */
    options?: z.ZodObject<any> | undefined
    /** Show root-level built-in commands and flags. */
    root?: boolean | undefined
    /** Alternative usage patterns. */
    usage?:
      | {
          args?: Partial<Record<string, true>> | undefined
          options?: Partial<Record<string, true>> | undefined
          prefix?: string | undefined
          suffix?: string | undefined
        }[]
      | undefined
    /** CLI version string. */
    version?: string | undefined
  }
}

/** Formats help text for a leaf command. */
export function formatCommand(name: string, options: formatCommand.Options = {}): string {
  const {
    alias,
    aliases,
    description,
    version,
    args,
    env,
    envSource,
    hint,
    root = false,
    options: opts,
    examples,
  } = options
  const lines: string[] = []

  // Header
  const title = version ? `${name}@${version}` : name
  lines.push(description ? `${title} \u2014 ${description}` : title)
  if (aliases?.length) lines.push(`Aliases: ${aliases.join(', ')}`)
  lines.push('')

  // Synopsis
  const { usage } = options
  if (usage && usage.length > 0) {
    const usageLines = usage.map((u) => {
      const parts: string[] = []
      if (u.prefix) parts.push(u.prefix)
      parts.push(name)
      if (u.args) for (const key of Object.keys(u.args)) parts.push(`<${key}>`)
      if (u.options) for (const key of Object.keys(u.options)) parts.push(`--${key} <${key}>`)
      if (u.suffix) parts.push(u.suffix)
      return parts.join(' ')
    })
    const pad = ' '.repeat('Usage: '.length)
    lines.push(`Usage: ${usageLines[0]}`)
    for (const line of usageLines.slice(1)) lines.push(`${pad}${line}`)
  } else {
    const synopsis = buildSynopsis(name, args)
    const commandSuffix = options.commands && options.commands.length > 0 ? ' | <command>' : ''
    lines.push(`Usage: ${synopsis}${opts ? ' [options]' : ''}${commandSuffix}`)
  }

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
        const prefix = entry.deprecated ? '[deprecated] ' : ''
        const desc =
          entry.defaultValue !== undefined
            ? `${prefix}${entry.description} (default: ${entry.defaultValue})`
            : `${prefix}${entry.description}`
        lines.push(`  ${entry.flag}${padding}  ${desc}`)
      }
    }
  }

  // Examples
  if (examples && examples.length > 0) {
    lines.push('')
    lines.push('Examples:')
    const maxLen = Math.max(
      ...examples.map((e) => (e.command ? `${name} ${e.command}` : name).length),
    )
    for (const ex of examples) {
      const cmd = ex.command ? `${name} ${ex.command}` : name
      if (ex.description)
        lines.push(`  ${cmd}${' '.repeat(maxLen - cmd.length)}  # ${ex.description}`)
      else lines.push(`  ${cmd}`)
    }
  }

  // Hint
  if (hint) {
    lines.push('')
    lines.push(hint)
  }

  // Subcommands (for CLIs with both a root handler and subcommands)
  const { commands } = options
  if (commands && commands.length > 0) {
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

  lines.push(...globalOptionsLines(root))

  // Environment Variables
  if (env) {
    const entries = envEntries(env)
    if (entries.length > 0) {
      lines.push('')
      lines.push('Environment Variables:')
      const maxLen = Math.max(...entries.map((e) => e.name.length))
      for (const entry of entries) {
        const padding = ' '.repeat(maxLen - entry.name.length)
        const parts: string[] = [entry.description]
        const source = envSource ?? process.env
        if (entry.name in source) parts.push(`set: ${redact(source[entry.name]!)}`)
        if (entry.defaultValue !== undefined) parts.push(`default: ${entry.defaultValue}`)
        const desc = parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0]
        lines.push(`  ${entry.name}${padding}  ${desc}`)
      }
    }
  }

  return lines.join('\n')
}

/** Builds the synopsis string with `<required>` and `[optional]` placeholders. */
function buildSynopsis(name: string, args?: z.ZodObject<any>): string {
  if (!args) return name
  const parts = [name]
  for (const [key, schema] of Object.entries(args.shape))
    parts.push((schema as z.ZodType)._zod.optout === 'optional' ? `[${key}]` : `<${key}>`)
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
  const entries: {
    flag: string
    description: string
    defaultValue?: unknown
    deprecated?: boolean | undefined
  }[] = []
  for (const [key, field] of Object.entries(schema.shape)) {
    const type = resolveTypeName(field)
    const short = alias?.[key]
    const kebab = toKebab(key)
    const flag = short ? `--${kebab}, -${short} <${type}>` : `--${kebab} <${type}>`
    const defaultValue = extractDefault(field)
    const deprecated = extractDeprecated(field)
    entries.push({ flag, description: (field as any).description ?? '', defaultValue, deprecated })
  }
  return entries
}

/** Resolves a human-readable type name from a Zod schema. */
function resolveTypeName(schema: unknown): string {
  if (isCountSchema(schema)) return 'count'
  const unwrapped = unwrap(schema)
  if (unwrapped instanceof z.ZodString) return 'string'
  if (unwrapped instanceof z.ZodNumber) return 'number'
  if (unwrapped instanceof z.ZodBoolean) return 'boolean'
  if (unwrapped instanceof z.ZodArray) return 'array'
  if (unwrapped instanceof z.ZodEnum) {
    const values = Object.values((unwrapped as any)._zod.def.entries) as string[]
    return values.join('|')
  }
  if (unwrapped instanceof z.ZodUnion) {
    const options = (unwrapped as any)._zod?.def?.options as z.ZodType[] | undefined
    if (options?.every((o: z.ZodType) => o instanceof z.ZodLiteral)) {
      const values = options.map((o: z.ZodType) => String((o as any)._zod.def.values[0]))
      return values.join('|')
    }
  }
  return 'value'
}

/** Checks if a schema is a count type (`.meta({ count: true })`). */
function isCountSchema(schema: unknown): boolean {
  const s = schema as any
  return typeof s?.meta === 'function' && s.meta()?.count === true
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

/** Reads the `deprecated` flag from a Zod schema's `.meta()`. */
function extractDeprecated(schema: unknown): boolean | undefined {
  const meta = (schema as any)?.meta?.()
  return meta?.deprecated === true ? true : undefined
}

/** Converts a camelCase string to kebab-case. */
function toKebab(str: string): string {
  return str.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** Renders the built-in commands and global options block. Root-only items are hidden for subcommands. */
function globalOptionsLines(root = false): string[] {
  const lines: string[] = []

  if (root) {
    const builtins = [
      { name: 'completions', desc: 'Generate shell completion script' },
      { name: 'mcp add', desc: 'Register as an MCP server' },
      { name: 'skills add', desc: 'Sync skill files to your agent' },
    ]
    const maxCmd = Math.max(...builtins.map((b) => b.name.length))
    lines.push(
      '',
      'Built-in Commands:',
      ...builtins.map((b) => `  ${b.name}${' '.repeat(maxCmd - b.name.length)}  ${b.desc}`),
    )
  }

  const flags = [
    {
      flag: '--filter-output <keys>',
      desc: 'Filter output by key paths (e.g. foo,bar.baz,a[0,3])',
    },
    { flag: '--format <toon|json|yaml|md|jsonl>', desc: 'Output format' },
    { flag: '--help', desc: 'Show help' },
    { flag: '--llms, --llms-full', desc: 'Print LLM-readable manifest' },
    ...(root ? [{ flag: '--mcp', desc: 'Start as MCP stdio server' }] : []),
    { flag: '--schema', desc: 'Show JSON Schema for a command' },
    { flag: '--token-count', desc: 'Print token count of output (instead of output)' },
    { flag: '--token-limit <n>', desc: 'Limit output to n tokens' },
    { flag: '--token-offset <n>', desc: 'Skip first n tokens of output' },
    { flag: '--verbose', desc: 'Show full output envelope' },
    ...(root ? [{ flag: '--version', desc: 'Show version' }] : []),
  ]
  const maxLen = Math.max(...flags.map((f) => f.flag.length))
  lines.push(
    '',
    'Global Options:',
    ...flags.map((f) => `  ${f.flag}${' '.repeat(maxLen - f.flag.length)}  ${f.desc}`),
  )

  return lines
}

/** Redacts a value, showing only the last 3 characters. */
function redact(value: string): string {
  if (value.length <= 3) return '••••'
  return `••••${value.slice(-3)}`
}
