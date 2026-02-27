import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Agent configuration for skill installation. */
export type Agent = {
  /** Display name. */
  name: string
  /** Absolute path to the global skills directory. */
  globalSkillsDir: string
  /** Project-relative skills directory path. */
  projectSkillsDir: string
  /** Whether this agent uses the canonical `.agents/skills` path. */
  universal: boolean
  /** Checks if the agent is installed on the system. */
  detect(): boolean
}

const home = os.homedir()
const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude')
const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, '.codex')

/** All known agent definitions. */
export const all: Agent[] = [
  // Universal agents (project skillsDir = .agents/skills)
  { name: 'Amp', globalSkillsDir: path.join(configHome, 'agents', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(configHome, 'amp')) },
  { name: 'Cline', globalSkillsDir: path.join(home, '.agents', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(home, '.cline')) },
  { name: 'Codex', globalSkillsDir: path.join(codexHome, 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(codexHome) },
  { name: 'Cursor', globalSkillsDir: path.join(home, '.cursor', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(home, '.cursor')) },
  { name: 'Gemini CLI', globalSkillsDir: path.join(home, '.gemini', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(home, '.gemini')) },
  { name: 'GitHub Copilot', globalSkillsDir: path.join(home, '.copilot', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(home, '.copilot')) },
  { name: 'Kimi CLI', globalSkillsDir: path.join(configHome, 'agents', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(home, '.kimi')) },
  { name: 'OpenCode', globalSkillsDir: path.join(configHome, 'opencode', 'skills'), projectSkillsDir: '.agents/skills', universal: true, detect: () => fs.existsSync(path.join(configHome, 'opencode')) },

  // Non-universal agents (need symlink from their skills dir to canonical)
  { name: 'Claude Code', globalSkillsDir: path.join(claudeHome, 'skills'), projectSkillsDir: '.claude/skills', universal: false, detect: () => fs.existsSync(claudeHome) },
  { name: 'Windsurf', globalSkillsDir: path.join(home, '.codeium', 'windsurf', 'skills'), projectSkillsDir: '.windsurf/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.codeium', 'windsurf')) },
  { name: 'Continue', globalSkillsDir: path.join(home, '.continue', 'skills'), projectSkillsDir: '.continue/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.continue')) },
  { name: 'Roo', globalSkillsDir: path.join(home, '.roo', 'skills'), projectSkillsDir: '.roo/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.roo')) },
  { name: 'Kilo', globalSkillsDir: path.join(home, '.kilocode', 'skills'), projectSkillsDir: '.kilocode/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.kilocode')) },
  { name: 'Goose', globalSkillsDir: path.join(configHome, 'goose', 'skills'), projectSkillsDir: '.goose/skills', universal: false, detect: () => fs.existsSync(path.join(configHome, 'goose')) },
  { name: 'Augment', globalSkillsDir: path.join(home, '.augment', 'skills'), projectSkillsDir: '.augment/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.augment')) },
  { name: 'Trae', globalSkillsDir: path.join(home, '.trae', 'skills'), projectSkillsDir: '.trae/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.trae')) },
  { name: 'Junie', globalSkillsDir: path.join(home, '.junie', 'skills'), projectSkillsDir: '.junie/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.junie')) },
  { name: 'Crush', globalSkillsDir: path.join(configHome, 'crush', 'skills'), projectSkillsDir: '.crush/skills', universal: false, detect: () => fs.existsSync(path.join(configHome, 'crush')) },
  { name: 'Kiro CLI', globalSkillsDir: path.join(home, '.kiro', 'skills'), projectSkillsDir: '.kiro/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.kiro')) },
  { name: 'Qwen Code', globalSkillsDir: path.join(home, '.qwen', 'skills'), projectSkillsDir: '.qwen/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.qwen')) },
  { name: 'OpenHands', globalSkillsDir: path.join(home, '.openhands', 'skills'), projectSkillsDir: '.openhands/skills', universal: false, detect: () => fs.existsSync(path.join(home, '.openhands')) },
]

/** Detects which agents are installed on the system. */
export function detect(): Agent[] {
  return all.filter((a) => a.detect())
}

/**
 * Installs skill directories to the canonical location and creates symlinks for
 * detected non-universal agents.
 *
 * @param sourceDir - Directory containing skill subdirectories (each with a `SKILL.md`).
 * @param options - Installation options.
 * @returns Installed canonical paths.
 */
export function install(
  sourceDir: string,
  options: install.Options = {},
): install.Result {
  const isGlobal = options.global !== false
  const cwd = options.cwd || process.cwd()
  const base = isGlobal ? home : cwd
  const canonicalBase = path.join(base, '.agents', 'skills')
  const detected = options.agents ?? detect()

  const paths: string[] = []
  const agents: install.AgentInstall[] = []

  for (const skill of discoverSkills(sourceDir)) {
    const canonicalDir = path.join(canonicalBase, skill.name)

    // Copy to canonical location
    fs.rmSync(canonicalDir, { recursive: true, force: true })
    fs.mkdirSync(canonicalDir, { recursive: true })
    fs.cpSync(skill.dir, canonicalDir, { recursive: true })
    paths.push(canonicalDir)

    // Create symlinks for non-universal agents
    for (const agent of detected) {
      if (agent.universal) continue
      const agentSkillsDir = isGlobal ? agent.globalSkillsDir : path.join(cwd, agent.projectSkillsDir)
      const agentDir = path.join(agentSkillsDir, skill.name)

      // Skip if agent dir resolves to canonical (no symlink needed)
      if (agentDir === canonicalDir) continue

      try {
        fs.rmSync(agentDir, { recursive: true, force: true })
        fs.mkdirSync(path.dirname(agentDir), { recursive: true })
        // Resolve through any existing symlinks in parent directories
        const realLinkDir = resolveParent(path.dirname(agentDir))
        const realTarget = resolveParent(canonicalDir)
        const rel = path.relative(realLinkDir, realTarget)
        fs.symlinkSync(rel, agentDir)
        agents.push({ agent: agent.name, path: agentDir, mode: 'symlink' })
      } catch {
        // Fallback to copy if symlink fails (e.g. Windows without permissions)
        try {
          fs.cpSync(canonicalDir, agentDir, { recursive: true })
          agents.push({ agent: agent.name, path: agentDir, mode: 'copy' })
        } catch {}
      }
    }
  }

  return { paths, agents }
}

export declare namespace install {
  type Options = {
    /** Override detected agents. */
    agents?: Agent[] | undefined
    /** Working directory for project-local installs. */
    cwd?: string | undefined
    /** Install globally. Defaults to `true`. */
    global?: boolean | undefined
  }
  type Result = {
    /** Canonical install paths. */
    paths: string[]
    /** Per-agent install details (non-universal agents only). */
    agents: AgentInstall[]
  }
  type AgentInstall = {
    /** Agent display name. */
    agent: string
    /** Installed path. */
    path: string
    /** Whether it was symlinked or copied. */
    mode: 'symlink' | 'copy'
  }
}

/** Discovers skill directories within a source directory. */
function discoverSkills(dir: string): { name: string; dir: string }[] {
  const results: { name: string; dir: string }[] = []

  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const subDir = path.join(dir, entry.name)
    const skillPath = path.join(subDir, 'SKILL.md')
    if (!fs.existsSync(skillPath)) continue
    const content = fs.readFileSync(skillPath, 'utf8')
    const nameMatch = content.match(/^name:\s*(.+)$/m)
    results.push({ name: nameMatch?.[1] ?? entry.name, dir: subDir })
  }

  // Root-level SKILL.md (depth 0 / single skill)
  if (results.length === 0 && fs.existsSync(path.join(dir, 'SKILL.md'))) {
    const content = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    const nameMatch = content.match(/^name:\s*(.+)$/m)
    results.push({ name: nameMatch?.[1] ?? 'skill', dir })
  }

  return results
}

/** Resolves parent directories through symlinks. */
function resolveParent(dir: string): string {
  try {
    return fs.realpathSync(dir)
  } catch {
    // Parent may not exist yet — resolve what we can
    const parent = path.dirname(dir)
    if (parent === dir) return dir
    try {
      return path.join(fs.realpathSync(parent), dir.slice(parent.length))
    } catch {
      return dir
    }
  }
}
