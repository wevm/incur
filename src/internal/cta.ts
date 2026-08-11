/** @internal A CTA block before command names are expanded. */
export type CtaBlock = {
  commands: unknown[]
  description?: string | undefined
}

/** @internal A formatted CTA block as it appears in output metadata. */
export type FormattedCtaBlock = {
  /** Formatted command suggestions. */
  commands: FormattedCta[]
  /** Human-readable label for the CTA block. */
  description: string
}

/** @internal A formatted CTA as it appears in output metadata. */
export type FormattedCta = {
  /** The full command string with args and options folded in. */
  command: string
  /** A short description of what the command does. */
  description?: string | undefined
}

type Cta =
  | string
  | {
      args?: Record<string, unknown> | undefined
      command: string
      description?: string | undefined
      options?: Record<string, unknown> | undefined
    }

/** @internal Formats a CTA block into the output metadata shape. */
export function formatCtaBlock(
  name: string,
  block: CtaBlock | undefined,
): FormattedCtaBlock | undefined {
  if (!block || block.commands.length === 0) return undefined
  return {
    description:
      block.description ??
      (block.commands.length === 1 ? 'Suggested command:' : 'Suggested commands:'),
    commands: block.commands.map((c) => formatCta(name, c as Cta)),
  }
}

/** @internal Renders a formatted CTA block as plain text for inline tool output. */
export function renderCtaText(block: FormattedCtaBlock): string {
  const lines = [block.description]
  for (const c of block.commands)
    lines.push(`  ${c.command}${c.description ? ` - ${c.description}` : ''}`)
  return lines.join('\n')
}

/** @internal Formats a CTA by prefixing the CLI name. */
function formatCta(name: string, cta: Cta): FormattedCta {
  if (typeof cta === 'string') return { command: `${name} ${cta}` }
  const prefix = cta.command === name || cta.command.startsWith(`${name} `) ? '' : `${name} `
  let cmd = `${prefix}${cta.command}`
  if (cta.args)
    for (const [key, value] of Object.entries(cta.args))
      cmd += value === true ? ` <${key}>` : ` ${value}`
  if (cta.options)
    for (const [key, value] of Object.entries(cta.options))
      cmd += value === true ? ` --${key} <${key}>` : ` --${key} ${value}`
  return { command: cmd, ...(cta.description ? { description: cta.description } : undefined) }
}
