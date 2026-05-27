import type * as Local from '../Local.js'
import type { ActionClient } from '../types.js'

/** Runs memory-local `skills add`. */
export function skillsAdd(client: ActionClient, options?: Local.SkillsAddOptions | undefined) {
  return local(client).skills.add(options)
}

/** Runs memory-local `skills list`. */
export function skillsList(client: ActionClient, options?: Local.SkillsListOptions | undefined) {
  return local(client).skills.list(options)
}

/** Runs memory-local `mcp add`. */
export function mcpAdd(client: ActionClient, options?: Local.McpAddOptions | undefined) {
  return local(client).mcp.add(options)
}

function local(client: ActionClient) {
  return client.transport.local as {
    skills: {
      add(options?: Local.SkillsAddOptions | undefined): Promise<unknown>
      list(options?: Local.SkillsListOptions | undefined): Promise<Local.SkillsList>
    }
    mcp: {
      add(options?: Local.McpAddOptions | undefined): Promise<unknown>
    }
  }
}
