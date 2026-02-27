import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { formatExamples } from './Cli.js'
import * as Agents from './internal/agents.js'
import * as Skill from './Skill.js'

/** Generates skill files from a command map and installs them natively. */
export async function sync(
  name: string,
  commands: Map<string, any>,
  options: sync.Options = {},
): Promise<sync.Result> {
  const cwd = options.cwd ?? resolvePackageRoot()
  const { depth = 1, description, global = true } = options

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectEntries(commands, [], groups)
  const files = Skill.split(name, entries, depth, groups)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `incur-skills-${name}-`))
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

    // Include additional SKILL.md files matched by glob patterns
    if (options.include) {
      for (const pattern of options.include) {
        const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
        for await (const match of fs.glob(globPattern, { cwd })) {
          try {
            const content = await fs.readFile(path.resolve(cwd, match), 'utf8')
            const nameMatch = content.match(/^name:\s*(.+)$/m)
            const skillName =
              pattern === '_root' ? (nameMatch?.[1] ?? name) : path.basename(path.dirname(match))
            const dest = path.join(tmpDir, skillName, 'SKILL.md')
            await fs.mkdir(path.dirname(dest), { recursive: true })
            await fs.writeFile(dest, content)
            if (!skills.some((s) => s.name === skillName)) {
              const descMatch = content.match(/^description:\s*(.+)$/m)
              skills.push({ name: skillName, description: descMatch?.[1], external: true })
            }
          } catch {}
        }
      }
    }

    const { paths, agents } = Agents.install(tmpDir, { global, cwd })

    // Write skills hash for staleness detection
    const entries = collectEntries(commands, [])
    writeHash(name, Skill.hash(entries))

    return { skills, paths, agents }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

export declare namespace sync {
  /** Options for syncing skills. */
  type Options = {
    /** Working directory for resolving `include` globs. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Install globally (`~/.config/agents/skills/`) instead of project-local. Defaults to `true`. */
    global?: boolean | undefined
    /** Glob patterns for directories containing SKILL.md files to include (e.g. `"skills/*"`, `"my-skill"`). Skill name is the parent directory name. */
    include?: string[] | undefined
  }
  /** Result of a sync operation. */
  type Result = {
    /** Per-agent install details (non-universal agents only). */
    agents: import('./internal/agents.js').install.AgentInstall[]
    /** Canonical install paths. */
    paths: string[]
    /** Synced skills with metadata. */
    skills: Skill[]
  }
  /** A synced skill entry. */
  type Skill = {
    /** Description extracted from the skill frontmatter. */
    description?: string | undefined
    /** Whether this skill was included from a local file (not generated from commands). */
    external?: boolean | undefined
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

/** Resolves the package root from the executing bin script (`process.argv[1]`). Walks up from the bin's directory looking for `package.json`. Falls back to `process.cwd()`. */
function resolvePackageRoot(): string {
  const bin = process.argv[1]
  if (!bin) return process.cwd()
  let dir = path.dirname(fsSync.realpathSync(bin))
  const root = path.parse(dir).root
  while (dir !== root) {
    try {
      fsSync.accessSync(path.join(dir, 'package.json'))
      return dir
    } catch {}
    dir = path.dirname(dir)
  }
  return process.cwd()
}

/** Returns the hash file path for a CLI. */
function hashPath(name: string): string {
  const dir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(dir, 'incur', `${name}.json`)
}

/** @internal Writes the skills hash for staleness detection. */
function writeHash(name: string, hash: string) {
  const file = hashPath(name)
  const dir = path.dirname(file)
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(file, JSON.stringify({ hash, at: new Date().toISOString() }) + '\n')
}

/** Reads the stored skills hash for a CLI. Returns `undefined` if no hash exists. */
export function readHash(name: string): string | undefined {
  try {
    const data = JSON.parse(fsSync.readFileSync(hashPath(name), 'utf-8'))
    return data.hash
  } catch {
    return undefined
  }
}
