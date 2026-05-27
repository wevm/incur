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
  const entries = Cli.collectSkillCommands(
    commands,
    [],
    groups,
    Cli.toRootDefinition.get(cli as unknown as Cli.Root),
  )
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
