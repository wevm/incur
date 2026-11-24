import { createHash } from 'node:crypto'
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
  const { cwd, depth = 1, description, global = true } = options
  const root = options.root ?? cwd ?? resolvePackageRoot()

  // Pre-load yaml for the sync call paths below (`Skill.split`, `parseFrontmatter`).
  await Yaml.load()

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectSkillCommands(commands, [], groups, options.rootCommand)
  const files = Skill.split(name, entries, depth, groups, options.command)

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
        for await (const match of fs.glob(globPattern, { cwd: root })) {
          try {
            const content = await fs.readFile(path.resolve(root, match), 'utf8')
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
    // Project installs keep their own metadata, so projects with same-named CLIs stay apart.
    const project = global ? undefined : (cwd ?? process.cwd())

    // Remove stale skills from previous installs
    const currentNames = new Set(paths.map((p) => path.basename(p)))
    const prev = readMeta(name, project)
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
      project,
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
    /** Command the generated skill files show in place of the CLI name, such as `bunx @scope/my-cli`. Defaults to the CLI name. */
    command?: string | undefined
    /** Project directory that `global: false` installs go to. Also resolves `include` globs when `root` is unset. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Install globally (`~/.config/agents/skills/`) instead of project-local. Defaults to `true`. */
    global?: boolean | undefined
    /** Glob patterns for directories containing SKILL.md files to include (e.g. `"skills/*"`, `"my-skill"`). Skill name is the parent directory name. */
    include?: string[] | undefined
    /** Directory that `include` globs resolve against. Defaults to `cwd` when set, otherwise the package root of the running bin (the nearest `package.json` above `process.argv[1]`). */
    root?: string | undefined
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
  const { cwd, depth = 1, description } = options
  const root = options.root ?? cwd ?? resolvePackageRoot()

  // Pre-load yaml for the sync call paths below (`Skill.split`, `parseFrontmatter`).
  await Yaml.load()

  const groups = new Map<string, string>()
  if (description) groups.set(name, description)
  const entries = collectSkillCommands(commands, [], groups, options.rootCommand)
  const files = Skill.split(name, entries, depth, groups, options.command)

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
      for await (const match of fs.glob(globPattern, { cwd: root })) {
        try {
          const content = await fs.readFile(path.resolve(root, match), 'utf8')
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
export function hasInstalledSkills(name: string, options: scope.Options = {}): boolean {
  return readScopeSkills(name, options).size > 0
}

export declare namespace scope {
  /** Selects the skills metadata of one install scope. */
  type Options = {
    /** Project directory of `global: false` installs. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Read the metadata of global installs (`true`, the default) or of the project in `cwd` (`false`). */
    global?: boolean | undefined
  }
}

export declare namespace list {
  /** Options for listing skills. */
  type Options = {
    /** Command the generated skill files show in place of the CLI name, such as `bunx @scope/my-cli`. Defaults to the CLI name. */
    command?: string | undefined
    /** Project directory checked for skills installed with `global: false`. Also resolves `include` globs when `root` is unset. Defaults to `process.cwd()`. */
    cwd?: string | undefined
    /** Grouping depth for skill files. Defaults to `1`. */
    depth?: number | undefined
    /** CLI description, used as the top-level group description. */
    description?: string | undefined
    /** Glob patterns for directories containing SKILL.md files to include. */
    include?: string[] | undefined
    /** Directory that `include` globs resolve against. Defaults to `cwd` when set, otherwise the package root of the running bin (the nearest `package.json` above `process.argv[1]`). */
    root?: string | undefined
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

/** Returns the metadata file path for a CLI's global installs, or for its installs in a project directory. */
function hashPath(name: string, project?: string | undefined): string {
  const dir = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'incur',
  )
  if (project === undefined) return path.join(dir, `${name}.json`)
  const key = createHash('sha256').update(path.resolve(project)).digest('hex').slice(0, 16)
  return path.join(dir, 'projects', key, `${name}.json`)
}

/** @internal Writes the skills metadata for staleness detection and cleanup. */
function writeMeta(
  name: string,
  project: string | undefined,
  hash: string,
  skills: string[],
  paths: string[],
) {
  const file = hashPath(name, project)
  const dir = path.dirname(file)
  if (!fsSync.existsSync(dir)) fsSync.mkdirSync(dir, { recursive: true })
  fsSync.writeFileSync(
    file,
    JSON.stringify({ hash, skills, paths, at: new Date().toISOString() }) + '\n',
  )
}

/** @internal Reads the stored metadata for a CLI's global installs, or for its installs in a project directory. */
function readMeta(
  name: string,
  project?: string | undefined,
): { hash: string; paths?: string[] | undefined; skills?: string[] | undefined } | undefined {
  try {
    return JSON.parse(fsSync.readFileSync(hashPath(name, project), 'utf-8'))
  } catch {
    return undefined
  }
}

/** Reads the names of previously synced skills that are still installed on disk, globally or in the project. */
function readInstalledSkills(
  name: string,
  options: { cwd?: string | undefined } = {},
): Set<string> {
  return new Set([
    ...readScopeSkills(name, options),
    ...readScopeSkills(name, { ...options, global: false }),
  ])
}

/** Reads the names of previously synced skills of one install scope that are still installed on disk. */
function readScopeSkills(name: string, options: scope.Options = {}): Set<string> {
  const { global = true } = options
  const cwd = options.cwd ?? process.cwd()
  const meta = readMeta(name, global ? undefined : cwd)
  if (!meta?.skills?.length) return new Set()

  if (meta.paths?.length) {
    const installed = meta.paths
      .filter((skillPath) => isInstalledSkillPath(skillPath))
      .map((skillPath) => path.basename(skillPath))
    return new Set(installed)
  }

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

/** Reads the stored skills hash for a CLI's global installs, or with `global: false`, for its installs in the project. Returns `undefined` if no hash exists. */
export function readHash(name: string, options: scope.Options = {}): string | undefined {
  const { global = true } = options
  return readMeta(name, global ? undefined : (options.cwd ?? process.cwd()))?.hash
}
