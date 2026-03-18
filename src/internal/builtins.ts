import { z } from 'zod'

import type { CommandInfo } from '../Skill.js'

/** A built-in subcommand with options. */
type BuiltinSubcommand = Pick<CommandInfo, 'name' | 'description' | 'options'> & {
  alias?: Record<string, string> | undefined
}

/** A built-in command with optional subcommands. */
type BuiltinCommand = Pick<CommandInfo, 'name' | 'description'> & {
  subcommands?: BuiltinSubcommand[] | undefined
}

/** Built-in command metadata shared by help, completions, and handler logic. */
export const builtinCommands: BuiltinCommand[] = [
  {
    name: 'completions',
    description: 'Generate shell completion script',
  },
  {
    name: 'mcp',
    description: 'Register as MCP server',
    subcommands: [
      {
        name: 'add',
        description: 'Register as MCP server',
        alias: { command: 'c' },
        options: z.object({
          command: z.string().optional().describe('Override the command agents will run (e.g. "pnpm my-cli --mcp")'),
          noGlobal: z.boolean().optional().describe('Install to project instead of globally'),
          agent: z.string().optional().describe('Target a specific agent (e.g. claude-code, cursor)'),
        }),
      },
    ],
  },
  {
    name: 'skills',
    description: 'Sync skill files to agents',
    subcommands: [
      {
        name: 'add',
        description: 'Sync skill files to agents',
        options: z.object({
          depth: z.number().optional().describe('Grouping depth for skill files (default: 1)'),
          noGlobal: z.boolean().optional().describe('Install to project instead of globally'),
        }),
      },
    ],
  },
]
