import { ClientError } from '../ClientError.js'
import type * as Local from '../Local.js'
import type { ActionClient } from './ActionClient.js'

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

/** Binds memory-local actions to a client. */
export function actions(client: ActionClient) {
  return {
    skills: {
      add(options?: Local.SkillsAddOptions | undefined) {
        return skillsAdd(client, options)
      },
      list(options?: Local.SkillsListOptions | undefined) {
        return skillsList(client, options)
      },
    },
    mcp: {
      add(options?: Local.McpAddOptions | undefined) {
        return mcpAdd(client, options)
      },
    },
  }
}

function local(client: ActionClient): Local.Methods {
  const { local } = client.transport
  if (!local) throw new ClientError('Local actions require a memory client.')
  return local
}
