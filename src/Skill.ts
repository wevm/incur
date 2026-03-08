import { createHash } from 'node:crypto'
import type { z } from 'zod'

import * as Schema from './Schema.js'

/** Information about a single command, passed to `generate()`. */
export type CommandInfo = {
  name: string
  description?: string | undefined
  args?: z.ZodObject<any> | undefined
  env?: z.ZodObject<any> | undefined
  hint?: string | undefined
  options?: z.ZodObject<any> | undefined
  output?: z.ZodType | undefined
  examples?: { command: string; description?: string }[] | undefined
}

/** A skill file entry with its directory name and content. */
export type File = {
  /** Directory name relative to output root (empty string for depth 0). */
  dir: string
  /** Markdown content. */
  content: string
}

/** Generates a compact Markdown command index for `--llms`. */
export function index(name: string, commands: CommandInfo[], description?: string | undefined): string {
  const lines: string[] = [`# ${name}`]
  if (description) lines.push('', description)
  lines.push('')
  lines.push('| Command | Description |')
  lines.push('|---------|-------------|')
  for (const cmd of commands) {
    const signature = buildSignature(name, cmd)
    const desc = cmd.description ?? ''
    lines.push(`| \`${signature}\` | ${desc} |`)
  }
  lines.push('', `Run \`${name} --llms-full\` for full manifest. Run \`${name} <command> --schema\` for argument details.`)
  return lines.join('\n')
}

/** @internal Builds a command signature with arg placeholders. */
function buildSignature(cli: string, cmd: CommandInfo): string {
  const base = `${cli} ${cmd.name}`
  if (!cmd.args) return base
  const shape = cmd.args.shape as Record<string, z.ZodType>
  const json = Schema.toJsonSchema(cmd.args)
  const required = new Set((json.required as string[] | undefined) ?? [])
  const argNames = Object.keys(shape).map((k) => (required.has(k) ? `<${k}>` : `[${k}]`))
  return `${base} ${argNames.join(' ')}`
}

/** Generates a Markdown skill file from a CLI name and collected command data. */
export function generate(
  name: string,
  commands: CommandInfo[],
  groups: Map<string, string> = new Map(),
): string {
  const hasGroups = groups.size > 0
  if (!hasGroups) return commands.map((cmd) => renderCommandBody(name, cmd)).join('\n\n')

  const sections: string[] = [`# ${name}`]
  let lastGroup: string | undefined

  for (const cmd of commands) {
    const segment = cmd.name.split(' ')[0]!
    if (segment !== lastGroup) {
      lastGroup = segment
      const desc = groups.get(segment)
      const heading = desc ? `## ${name} ${segment}\n\n${desc}` : `## ${name} ${segment}`
      sections.push(heading)
    }
    sections.push(renderCommandBody(name, cmd, 3))
  }

  return sections.join('\n\n')
}

/** Splits commands into skill files grouped by depth. */
export function split(
  name: string,
  commands: CommandInfo[],
  depth: number,
  groups: Map<string, string> = new Map(),
): File[] {
  if (depth === 0) return [{ dir: '', content: renderGroup(name, name, commands, groups, name) }]

  const buckets = new Map<string, CommandInfo[]>()
  for (const cmd of commands) {
    const segments = cmd.name.split(' ')
    const key = segments.slice(0, depth).join('-')
    const bucket = buckets.get(key) ?? []
    bucket.push(cmd)
    buckets.set(key, bucket)
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, cmds]) => {
      const prefix = cmds[0]!.name.split(' ').slice(0, depth).join(' ')
      return { dir, content: renderGroup(name, `${name} ${prefix}`, cmds, groups, prefix) }
    })
}

/** @internal Renders a group-level frontmatter + command bodies. */
function renderGroup(
  cli: string,
  title: string,
  cmds: CommandInfo[],
  groups: Map<string, string>,
  prefix?: string | undefined,
): string {
  const groupDesc = prefix ? groups.get(prefix) : undefined
  const childDescs = cmds.map((c) => c.description).filter(Boolean) as string[]
  const descParts: string[] = []
  if (groupDesc) descParts.push(groupDesc.replace(/\.$/, ''))
  if (childDescs.length > 0) descParts.push(childDescs.join(', '))
  const description = descParts.join('. ') || undefined

  const slug = title.replace(/\s+/g, '-')
  const fm = ['---', `name: ${slug}`]
  if (description)
    fm.push(`description: ${description}. Run \`${title} --help\` for usage details.`)
  fm.push(`command: ${title}`, '---')

  const body = cmds.map((cmd) => renderCommandBody(cli, cmd)).join('\n\n---\n\n')
  return `${fm.join('\n')}\n\n${body}`
}

/** @internal Renders a command's heading and sections without frontmatter. */
function renderCommandBody(cli: string, cmd: CommandInfo, level = 1): string {
  const fullName = `${cli} ${cmd.name}`
  const sections: string[] = []
  const h = (n: number) => '#'.repeat(n)

  let heading = `${h(level)} ${fullName}`
  if (cmd.description) heading += `\n\n${cmd.description}`
  sections.push(heading)

  const sub = h(level + 1)

  // Arguments table
  if (cmd.args) {
    const shape = cmd.args.shape as Record<string, z.ZodType>
    const json = Schema.toJsonSchema(cmd.args)
    const required = new Set((json.required as string[] | undefined) ?? [])
    const properties = json.properties as Record<string, Record<string, unknown>> | undefined
    const rows = Object.entries(shape).map(([key, field]) => {
      const prop = properties?.[key]
      const type = resolveTypeName(prop)
      const req = required.has(key) ? 'yes' : 'no'
      const desc = field.description ?? ''
      return `| \`${key}\` | \`${type}\` | ${req} | ${desc} |`
    })
    sections.push(
      `${sub} Arguments\n\n| Name | Type | Required | Description |\n|------|------|----------|-------------|\n${rows.join('\n')}`,
    )
  }

  // Environment Variables table
  if (cmd.env) {
    const shape = cmd.env.shape as Record<string, z.ZodType>
    const json = Schema.toJsonSchema(cmd.env)
    const required = new Set((json.required as string[] | undefined) ?? [])
    const properties = json.properties as Record<string, Record<string, unknown>> | undefined
    const rows = Object.entries(shape).map(([key, field]) => {
      const prop = properties?.[key]
      const type = resolveTypeName(prop)
      const def = prop?.default !== undefined ? String(prop.default) : ''
      const req = required.has(key) ? 'yes' : 'no'
      const desc = field.description ?? ''
      return `| \`${key}\` | \`${type}\` | ${req} | ${def ? `\`${def}\`` : ''} | ${desc} |`
    })
    sections.push(
      `${sub} Environment Variables\n\n| Name | Type | Required | Default | Description |\n|------|------|----------|---------|-------------|\n${rows.join('\n')}`,
    )
  }

  // Options table
  if (cmd.options) {
    const shape = cmd.options.shape as Record<string, z.ZodType>
    const json = Schema.toJsonSchema(cmd.options)
    const properties = json.properties as Record<string, Record<string, unknown>> | undefined
    const rows = Object.entries(shape).map(([key, field]) => {
      const prop = properties?.[key]
      const type = resolveTypeName(prop)
      const def = prop?.default !== undefined ? String(prop.default) : ''
      const rawDesc = field.description ?? ''
      const desc = prop?.deprecated ? `**Deprecated.** ${rawDesc}` : rawDesc
      return `| \`--${key}\` | \`${type}\` | ${def ? `\`${def}\`` : ''} | ${desc} |`
    })
    sections.push(
      `${sub} Options\n\n| Flag | Type | Default | Description |\n|------|------|---------|-------------|\n${rows.join('\n')}`,
    )
  }

  // Output table
  if (cmd.output) {
    const outputSchema = Schema.toJsonSchema(cmd.output)
    const table = schemaToTable(outputSchema)
    if (table) sections.push(`${sub} Output\n\n${table}`)
    else {
      const type = resolveTypeName(outputSchema)
      sections.push(`${sub} Output\n\nType: \`${type}\``)
    }
  }

  // Examples
  if (cmd.examples && cmd.examples.length > 0) {
    const lines = cmd.examples.map((ex) => {
      const comment = ex.description ? `# ${ex.description}\n` : ''
      return `${comment}${cli} ${ex.command}`
    })
    sections.push(`${sub} Examples\n\n\`\`\`sh\n${lines.join('\n\n')}\n\`\`\``)
  }

  // Hint
  if (cmd.hint) sections.push(`> ${cmd.hint}`)

  return sections.join('\n\n')
}

/** Computes a deterministic hash of command structure for staleness detection. */
export function hash(commands: CommandInfo[]): string {
  const data = commands.map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    args: cmd.args ? Schema.toJsonSchema(cmd.args) : undefined,
    env: cmd.env ? Schema.toJsonSchema(cmd.env) : undefined,
    options: cmd.options ? Schema.toJsonSchema(cmd.options) : undefined,
    output: cmd.output ? Schema.toJsonSchema(cmd.output) : undefined,
  }))
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)
}

/** @internal Renders a JSON Schema object as a Markdown table. Returns `undefined` for non-object schemas. */
function schemaToTable(schema: Record<string, unknown>, prefix = ''): string | undefined {
  if (schema.type !== 'object') return undefined
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties || Object.keys(properties).length === 0) return undefined
  const required = new Set((schema.required as string[] | undefined) ?? [])

  const rows: string[] = []
  for (const [key, prop] of Object.entries(properties)) {
    const name = prefix ? `${prefix}.${key}` : key
    const type = resolveTypeName(prop)
    const req = required.has(key) ? 'yes' : 'no'
    const desc = (prop.description as string) ?? ''
    rows.push(`| \`${name}\` | \`${type}\` | ${req} | ${desc} |`)

    // Expand nested objects inline
    if (prop.type === 'object' && prop.properties) {
      const nested = schemaToTable(prop, name)
      if (nested) {
        const lines = nested.split('\n')
        rows.push(...lines.slice(2)) // skip header + separator
      }
    }

    // Expand array item objects inline
    if (prop.type === 'array' && prop.items) {
      const items = prop.items as Record<string, unknown>
      if (items.type === 'object' && items.properties) {
        const nested = schemaToTable(items, `${name}[]`)
        if (nested) {
          const lines = nested.split('\n')
          rows.push(...lines.slice(2))
        }
      }
    }
  }

  return `| Field | Type | Required | Description |\n|-------|------|----------|-------------|\n${rows.join('\n')}`
}

/** @internal Resolves a simple type name from a JSON Schema property. */
function resolveTypeName(prop: Record<string, unknown> | undefined): string {
  if (!prop) return 'unknown'
  const type = prop.type as string | undefined
  if (type) return type === 'integer' ? 'number' : type
  return 'unknown'
}
