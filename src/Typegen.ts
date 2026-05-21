import fs from 'node:fs/promises'
import { z } from 'zod'

import * as Cli from './Cli.js'
import { objectSchemaToType, propertyKey } from './internal/ts.js'
import { importCli } from './internal/utils.js'

/** Imports a CLI from `input` (must `export default` a `Cli`), generates the `.d.ts`, and writes it to `output`. */
export async function generate(input: string, output: string): Promise<void> {
  const cli = await importCli(input)
  await Cli.ready(cli)
  await fs.writeFile(output, fromCli(cli))
}

/** Generates a `.d.ts` declaration string for the `incur` module augmentation. */
export function fromCli(cli: Cli.Cli): string {
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const entries = collectEntries(commands, [])

  const lines: string[] = ["declare module 'incur' {", '  interface Register {', '    commands: {']

  for (const { name, args, options } of entries)
    lines.push(
      `      ${propertyKey(name)}: { args: ${objectSchemaToType(args)}; options: ${objectSchemaToType(options)} }`,
    )

  lines.push('    }', '  }', '}', '')
  return lines.join('\n')
}

/** Recursively collects leaf commands with their full paths and schemas. */
function collectEntries(
  commands: Map<string, any>,
  prefix: string[],
): { name: string; args?: z.ZodObject<any>; options?: z.ZodObject<any> }[] {
  const result: ReturnType<typeof collectEntries> = []
  for (const [name, entry] of commands) {
    if ('_alias' in entry && entry._alias) {
      const target = commands.get(entry.target)
      if (!target) continue
      const path = [...prefix, name]
      result.push({ name: path.join(' '), args: target.args, options: target.options })
      continue
    }
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) result.push(...collectEntries(entry.commands, path))
    else result.push({ name: path.join(' '), args: entry.args, options: entry.options })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}
