import type * as SyncMcp from '../SyncMcp.js'
import type * as SyncSkills from '../SyncSkills.js'

/** Options for `local.skills.add()`. */
export type SkillsAddOptions = {
  /** Grouping depth. */
  depth?: number | undefined
  /** Install globally instead of project-local. */
  global?: boolean | undefined
}

/** Options for `local.skills.list()`. */
export type SkillsListOptions = {
  /** Grouping depth. */
  depth?: number | undefined
}

/** Options for `local.mcp.add()`. */
export type McpAddOptions = {
  /** Target agents. */
  agents?: string[] | undefined
  /** Command agents should run. */
  command?: string | undefined
  /** Install globally instead of project-local. */
  global?: boolean | undefined
}

/** Synced skills result. */
export type SyncedSkills = SyncSkills.sync.Result

/** Skills list result. */
export type SkillsList = {
  /** Listed skills. */
  skills: SyncSkills.list.Skill[]
}

/** MCP registration result. */
export type McpRegistration = SyncMcp.register.Result

/** Memory-only local methods exposed by memory transports and clients. */
export type Methods = {
  /** Skill setup actions. */
  skills: {
    /** Sync generated skill files. */
    add(options?: SkillsAddOptions | undefined): Promise<SyncedSkills>
    /** List generated skill files without writing them. */
    list(options?: SkillsListOptions | undefined): Promise<SkillsList>
  }
  /** MCP setup actions. */
  mcp: {
    /** Register the CLI as an MCP server. */
    add(options?: McpAddOptions | undefined): Promise<McpRegistration>
  }
}
