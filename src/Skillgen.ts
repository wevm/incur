import fs from 'node:fs/promises'
import path from 'node:path'

import * as Cli from './Cli.js'
import { importCli } from './internal/utils.js'
import * as Skill from './Skill.js'

/** Imports a CLI from `input`, generates Markdown skill files, and writes them to `output`. */
export async function generate(input: string, output: string, depth = 1): Promise<string[]> {
  const cli = await importCli(input)
  const commands = Cli.toCommands.get(cli)
  if (!commands) throw new Error('No commands registered on this CLI instance')

  const groups = new Map<string, string>()
  if (cli.description) groups.set(cli.name, cli.description)
  const entries = collectEntries(commands, [], groups)
  const files = Skill.split(cli.name, entries, depth, groups)

  if (depth > 0) await fs.rm(output, { recursive: true, force: true })

  const written: string[] = []
  for (const file of files) {
    const filePath = file.dir
      ? path.join(output, file.dir, 'SKILL.md')
      : path.join(output, 'SKILL.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, `${file.content}\n`)
    written.push(filePath)
  }

  return written
}

/** Recursively collects leaf commands as `Skill.CommandInfo` and group descriptions. */
function collectEntries(
  commands: Map<string, any>,
  prefix: string[],
  groups: Map<string, string> = new Map(),
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if ('_group' in entry && entry._group) {
      if (entry.description) groups.set(path.join(' '), entry.description)
      result.push(...collectEntries(entry.commands, path, groups))
    } else {
      const cmd: Skill.CommandInfo = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description
      if (entry.args) cmd.args = entry.args
      if (entry.env) cmd.env = entry.env
      if (entry.hint) cmd.hint = entry.hint
      if (entry.options) cmd.options = entry.options
      if (entry.output) cmd.output = entry.output
      const examples = Cli.formatExamples(entry.examples)
      if (examples) {
        const cmdName = path.join(' ')
        cmd.examples = examples.map((e) => ({
          ...e,
          command: e.command ? `${cmdName} ${e.command}` : cmdName,
        }))
      }
      result.push(cmd)
    }
  }
  return result.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}
