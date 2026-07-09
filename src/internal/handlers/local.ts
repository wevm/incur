import type * as Local from '../../client/Local.js'
import { BaseError } from '../../Errors.js'
import * as SyncMcp from '../../SyncMcp.js'
import * as SyncSkills from '../../SyncSkills.js'
import type * as RuntimeContext from '../runtime-context.js'

/** Local setup/admin failure. */
export class LocalError extends BaseError {
  override name = 'Incur.LocalError'
}

/** Creates the shared in-process local handler. */
export function createLocalHandler(ctx: RuntimeContext.RuntimeCliContext) {
  return {
    local: {
      skills: {
        async add(options: Local.SkillsAddOptions = {}) {
          try {
            return await SyncSkills.sync(ctx.name, ctx.commands, {
              cwd: ctx.sync?.cwd,
              depth: options.depth ?? ctx.sync?.depth ?? 1,
              description: ctx.description,
              global: options.global ?? true,
              include: ctx.sync?.include,
              rootCommand: ctx.rootCommand,
            })
          } catch (error) {
            throw new LocalError('Failed to sync local skills.', {
              cause: error instanceof Error ? error : new Error(String(error)),
            })
          }
        },
        async list(options: Local.SkillsListOptions = {}) {
          try {
            const skills = await SyncSkills.list(ctx.name, ctx.commands, {
              cwd: ctx.sync?.cwd,
              depth: options.depth ?? ctx.sync?.depth ?? 1,
              description: ctx.description,
              include: ctx.sync?.include,
              rootCommand: ctx.rootCommand,
            })
            return { skills }
          } catch (error) {
            throw new LocalError('Failed to list local skills.', {
              cause: error instanceof Error ? error : new Error(String(error)),
            })
          }
        },
      },
      mcp: {
        async add(options: Local.McpAddOptions = {}) {
          try {
            return await SyncMcp.register(ctx.name, {
              agents: options.agents ?? ctx.mcp?.agents,
              command: options.command ?? ctx.mcp?.command,
              global: options.global ?? true,
            })
          } catch (error) {
            throw new LocalError('Failed to register local MCP server.', {
              cause: error instanceof Error ? error : new Error(String(error)),
            })
          }
        },
      },
    },
  }
}
