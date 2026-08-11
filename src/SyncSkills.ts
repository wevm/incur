import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { collectSkillCommands, parseSkillFrontmatter } from './Cli.js'
import * as Agents from './internal/agents.js'
import * as Yaml from './internal/yaml.js'
import type * as Mcp from './Mcp.js'
import * as Skill from './Skill.js'

/** Generates skill files from a command map and installs them natively. */
export async function sync(
  name: string,
  commands: Map<string, any>,
  options: sync.Options = {},
): Promise<sync.Result> {
  const { depth = 1, description, global = true } = options
  const cwd = options.cwd ?? (global ? resolvePackageRoot() : process.cwd())

  // Pre-load yaml for the sync call paths below (`Skill.split`, `parseFrontmatter`).
  await Yaml.load()

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectSkillCommands(commands, [], groups, options.rootCommand)
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
      const meta = parseSkillFrontmatter(file.content)
      skills.push({ name: meta.name ?? (file.dir || name), description: meta.description })
    }

    // Include additional SKILL.md files matched by glob patterns
    if (options.include) {
      for (const pattern of options.include) {
        const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
        for await (const match of fs.glob(globPattern, { cwd })) {
          try {
            const content = await fs.readFile(path.resolve(cwd, match), 'utf8')
            const meta = parseSkillFrontmatter(content)
            const skillName =
              pattern === '_root' ? (meta.name ?? name) : path.basename(path.dirname(match))
            const dest = path.join(tmpDir, skillName, 'SKILL.md')
            await fs.mkdir(path.dirname(dest), { recursive: true })
            await fs.writeFile(dest, content)
            if (!skills.some((s) => s.name === skillName))
              skills.push({ name: skillName, description: meta.description, external: true })
          } catch {}
        }
      }
    }

    const { paths, agents } = Agents.install(tmpDir, { global, cwd })

    // Remove stale skills from previous installs
    const currentNames = new Set(paths.map((p) => path.basename(p)))
    const prev = readMeta(name)
    if (prev?.skills) {
      for (const old of prev.skills) {
        if (currentNames.has(old)) continue
        Agents.remove(old, { global, cwd })
      }
    }

    // Write skills hash + names for staleness detection
    const hashEntries = collectSkillCommands(commands, [], new Map(), options.rootCommand)
    writeMeta(
      name,
      Skill.hash(hashEntries),
      [...currentNames],
      [...paths, ...agents.map((agent) => agent.path)],
    )

    return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), paths, agents }
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
    /** Root command definition (when the CLI itself has a `run` handler). */
    rootCommand?:
      | {
          description?: string | undefined
          args?: any
          destructive?: boolean | undefined
          env?: any
          hint?: string | undefined
          mcp?: false | { annotations?: Mcp.ToolAnnotations | undefined } | undefined
          options?: any
          output?: any
          examples?: any[] | undefined
        }
      | undefined
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

/** Lists skills derived from a CLI's command map with install status. */
export async function list(
  name: string,
  commands: Map<string, any>,
  options: list.Options = {},
): Promise<list.Skill[]> {
  const { depth = 1, description } = options
  const cwd = options.cwd ?? process.cwd()

  // Pre-load yaml for the sync call paths below (`Skill.split`, `parseFrontmatter`).
  await Yaml.load()

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectSkillCommands(commands, [], groups, options.rootCommand)
  const files = Skill.split(name, entries, depth, groups)

  const skills: list.Skill[] = []
  const installed = readInstalledSkills(name, { cwd })

  for (const file of files) {
    const meta = parseSkillFrontmatter(file.content)
    const skillName = meta.name ?? (file.dir || name)
    skills.push({
      name: skillName,
      description: meta.description,
      installed: installed.has(skillName),
    })
  }

  // Include additional SKILL.md files matched by glob patterns
  if (options.include) {
    for (const pattern of options.include) {
      const globPattern = pattern === '_root' ? 'SKILL.md' : path.join(pattern, 'SKILL.md')
      for await (const match of fs.glob(globPattern, { cwd })) {
        try {
          const content = await fs.readFile(path.resolve(cwd, match), 'utf8')
          const meta = parseSkillFrontmatter(content)
          const skillName =
            pattern === '_root' ? (meta.name ?? name) : path.basename(path.dirname(match))
          if (!skills.some((s) => s.name === skillName)) {
            skills.push({
              name: skillName,
              description: meta.description,
              installed: installed.has(skillName),
            })
          }
        } catch {}
      }
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

/** Returns whether any previously synced skills are still installed on disk. */
export function hasInstalledSkills(
  name: string,
  options: { cwd?: string | undefined } = {},
): boolean {
  return readInstalledSkills(name, options).size > 0
}

export declare namespace list {
  /** Options for listing skills. */
  type Options = {
    /** Working directory for resolving `include` globs. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Glob patterns for directories containing SKILL.md files to include. */
    include?: string[] | undefined
    /** Root command definition (when the CLI itself is a command). */
    rootCommand?:
      | {
          description?: string | undefined
          args?: any
          destructive?: boolean | undefined
          env?: any
          hint?: string | undefined
          mcp?: false | { annotations?: Mcp.ToolAnnotations | undefined } | undefined
          options?: any
          output?: any
          examples?: any[] | undefined
        }
      | undefined
  }
  /** A skill entry with install status. */
  type Skill = {
    /** Description extracted from the skill frontmatter. */
    description?: string | undefined
    /** Whether this skill is currently installed. */
    installed: boolean
    /** Skill name. */
    name: string
  }
}

/** Resolves the package root from the executing bin script (`process.argv[1]`). Walks up from the bin's directory looking for `package.json`. Falls back to `process.cwd()`. */
function resolvePackageRoot(): string {
  const bin = process.argv[1]
  if (!bin) return process.cwd()
  let dir = path.dirname(
    (() => {
      try {
        // resolve symlinks for normal bin scripts
        return fsSync.realpathSync(bin)
      } catch {
        // Bun compiled binaries use a virtual `/$bunfs/` path for argv[1]
        return process.execPath
      }
    })(),
  )
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

/** @internal Writes the skills metadata for staleness detection and cleanup. */
function writeMeta(name: string, hash: string, skills: string[], paths: string[]) {
  const file = hashPath(name)
  const dir = path.dirname(file)
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(
    file,
    JSON.stringify({ hash, skills, paths, at: new Date().toISOString() }) + '\n',
  )
}

/** @internal Reads the stored metadata for a CLI. */
function readMeta(
  name: string,
): { hash: string; paths?: string[] | undefined; skills?: string[] | undefined } | undefined {
  try {
    return JSON.parse(fsSync.readFileSync(hashPath(name), 'utf-8'))
  } catch {
    return undefined
  }
}

/** Reads the names of previously synced skills that are still installed on disk. */
function readInstalledSkills(
  name: string,
  options: { cwd?: string | undefined } = {},
): Set<string> {
  const meta = readMeta(name)
  if (!meta?.skills?.length) return new Set()

  if (meta.paths?.length) {
    const installed = meta.paths
      .filter((skillPath) => isInstalledSkillPath(skillPath))
      .map((skillPath) => path.basename(skillPath))
    return new Set(installed)
  }

  const cwd = options.cwd ?? process.cwd()
  const bases = [path.join(os.homedir(), '.agents', 'skills'), path.join(cwd, '.agents', 'skills')]
  const installed = meta.skills.filter((skill) =>
    bases.some((base) => isInstalledSkillPath(path.join(base, skill))),
  )
  return new Set(installed)
}

/** Returns whether a skill directory currently contains a skill file. */
function isInstalledSkillPath(skillPath: string): boolean {
  return fsSync.existsSync(path.join(skillPath, 'SKILL.md'))
}

/** Reads the stored skills hash for a CLI. Returns `undefined` if no hash exists. */
export function readHash(name: string): string | undefined {
  return readMeta(name)?.hash
}
