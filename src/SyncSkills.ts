import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatExamples } from './Cli.js'
import { detectRunner } from './internal/pm.js'
import * as Skill from './Skill.js'

/** Generates skill files from a command map and installs them via `skills add`. */
export async function sync(
  name: string,
  commands: Map<string, any>,
  options: sync.Options = {},
): Promise<sync.Result> {
  const { depth = 1, description, global = true } = options

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectEntries(commands, [], groups)
  const files = Skill.split(name, entries, depth, groups)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `clac-skills-${name}-`))
  try {
    const skills: sync.Skill[] = []
    for (const file of files) {
      const filePath = file.dir
        ? path.join(tmpDir, file.dir, 'SKILL.md')
        : path.join(tmpDir, 'SKILL.md')
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, `${file.content}\n`)
      const descMatch = file.content.match(/^description:\s*(.+)$/m)
      skills.push({ name: file.dir || name, description: descMatch?.[1] })
    }

    const runner = options.runner ?? detectRunner()
    const [cmd, ...prefix] = runner.split(' ')
    const flags = ['--yes', ...(global ? ['--global'] : [])]
    const { stdout } = await exec(cmd!, [...prefix, 'skills', 'add', tmpDir, ...flags])

    // Extract installed paths from `skills add` output (lines like "✓ ~/path/to/skill")
    const paths = stdout
      .split('\n')
      .filter((l) => l.includes('✓'))
      .map((l) => l.replace(/.*✓\s*/, '').replace(/[│┃|]/g, '').trim())
      .filter(Boolean)

    return { skills, paths }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

export declare namespace sync {
  /** Options for syncing skills. */
  type Options = {
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Install globally (`~/.config/agents/skills/`) instead of project-local. Defaults to `true`. */
    global?: boolean | undefined
    /** Override the package manager runner (e.g. `npx`, `pnpx`, `bunx`). Auto-detected if omitted. */
    runner?: string | undefined
  }
  /** Result of a sync operation. */
  type Result = {
    /** Installed paths reported by `skills add`. */
    paths: string[]
    /** Synced skills with metadata. */
    skills: Skill[]
  }
  /** A synced skill entry. */
  type Skill = {
    /** Description extracted from the skill frontmatter. */
    description?: string | undefined
    /** Skill directory name. */
    name: string
  }
}

/** Recursively collects leaf commands as `Skill.CommandInfo`. */
function collectEntries(
  commands: Map<string, any>,
  prefix: string[],
  groups: Map<string, string> = new Map(),
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  for (const [name, entry] of commands) {
    const entryPath = [...prefix, name]
    if ('_group' in entry && entry._group) {
      if (entry.description) groups.set(entryPath.join(' '), entry.description)
      result.push(...collectEntries(entry.commands, entryPath, groups))
    } else {
      const cmd: Skill.CommandInfo = { name: entryPath.join(' ') }
      if (entry.description) cmd.description = entry.description
      if (entry.args) cmd.args = entry.args
      if (entry.env) cmd.env = entry.env
      if (entry.hint) cmd.hint = entry.hint
      if (entry.options) cmd.options = entry.options
      if (entry.output) cmd.output = entry.output
      const examples = formatExamples(entry.examples)
      if (examples) {
        const cmdName = entryPath.join(' ')
        cmd.examples = examples.map((e) => ({
          ...e,
          command: e.command ? `${cmdName} ${e.command}` : cmdName,
        }))
      }
      result.push(cmd)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** Promisified execFile with stderr in error message. */
function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        const msg = stderr?.trim() || stdout?.trim() || error.message
        reject(new Error(msg))
      } else resolve({ stdout, stderr })
    })
  })
}
