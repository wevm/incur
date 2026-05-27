import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { z } from 'zod'

import * as Cli from '../Cli.js'
import type * as ClientDiscover from '../client/Discover.js'
import { BaseError } from '../Errors.js'
import * as Formatter from '../Formatter.js'
import * as Help from '../Help.js'
import * as Mcp from '../Mcp.js'
import * as Openapi from '../Openapi.js'
import * as Skill from '../Skill.js'
import * as CommandTree from './command-tree.js'

/** Discover failure with protocol code and HTTP status metadata. */
export class DiscoverError extends BaseError {
  override name = 'Incur.DiscoverError'
  /** Machine-readable error code. */
  code: string
  /** HTTP status for discovery routes. */
  status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const requestSchema = z.discriminatedUnion('resource', [
  z.object({
    resource: z.literal('llms'),
    command: z.string().optional(),
    format: z.enum(['toon', 'json', 'yaml', 'md', 'jsonl']).optional(),
  }),
  z.object({
    resource: z.literal('llmsFull'),
    command: z.string().optional(),
    format: z.enum(['toon', 'json', 'yaml', 'md', 'jsonl']).optional(),
  }),
  z.object({ resource: z.literal('schema'), command: z.string().optional() }),
  z.object({ resource: z.literal('help'), command: z.string().optional() }),
  z.object({ resource: z.literal('openapi'), format: z.enum(['json', 'yaml']).optional() }),
  z.object({ resource: z.literal('skillsIndex') }),
  z.object({ resource: z.literal('skill'), name: z.string() }),
  z.object({ resource: z.literal('mcpTools') }),
])

/** Creates the shared client discovery executor. */
export function createClientDiscover(ctx: CommandTree.RuntimeCliContext) {
  return {
    async discover(request: unknown): Promise<ClientDiscover.Response> {
      const parsedRequest = requestSchema.safeParse(request)
      if (!parsedRequest.success)
        throw new DiscoverError('VALIDATION_ERROR', 'Invalid discovery request.', 400)
      const parsed = parsedRequest.data
      if (parsed.resource === 'openapi') {
        const spec = openapi(ctx)
        if (parsed.format === 'yaml')
          return { contentType: 'application/yaml', body: yamlStringify(spec) }
        return { contentType: 'application/json', data: spec }
      }
      if (parsed.resource === 'mcpTools')
        return {
          contentType: 'application/json',
          data: { tools: Mcp.collectTools(ctx.commands, []) },
        }

      if (parsed.resource === 'skillsIndex' || parsed.resource === 'skill') {
        const { files } = skills(ctx)
        if (parsed.resource === 'skillsIndex') {
          return {
            contentType: 'application/json',
            data: {
              skills: files.map((file) => {
                const meta = parseFrontmatter(file.content)
                return {
                  name: file.dir || ctx.name,
                  description: meta.description ?? '',
                  files: ['SKILL.md'],
                }
              }),
            },
          }
        }
        if (!safeSkillName(parsed.name))
          throw new DiscoverError('INVALID_SKILL_NAME', 'Unsafe skill name.', 400)
        const file = files.find((value) => (value.dir || ctx.name) === parsed.name)
        if (!file)
          throw new DiscoverError('SKILL_NOT_FOUND', `Unknown skill '${parsed.name}'.`, 404)
        return { contentType: 'text/markdown', body: file.content }
      }

      const scoped = scope(ctx, parsed.command)
      if (parsed.resource === 'help') {
        if (scoped.type === 'command')
          return {
            contentType: 'text/plain',
            body: Help.formatCommand(scoped.id, {
              alias: scoped.command.alias,
              args: scoped.command.args,
              description: scoped.command.description,
              env: scoped.command.env,
              examples: [],
              hint: scoped.command.hint,
              options: scoped.command.options,
              usage: [],
            }),
          }
        return {
          contentType: 'text/plain',
          body: Help.formatRoot(scoped.id, {
            description: scoped.description,
            commands: collect(scoped.commands, [], false).map(({ name, description }) => ({
              name,
              ...(description ? { description } : undefined),
            })),
          }),
        }
      }

      if (parsed.resource === 'schema') {
        if (scoped.type === 'command') {
          const schema = CommandTree.buildInputSchema(scoped.command)
          return { contentType: 'application/json', data: schema ?? {} }
        }
        return {
          contentType: 'application/json',
          data: manifest(scoped.commands, scoped.prefix, true),
        }
      }

      const full = parsed.resource === 'llmsFull'
      const format = parsed.format ?? 'md'
      if (format === 'md') {
        const groups = new Map<string, string>()
        const entries = skillCommands(scoped.commands, scoped.prefix, groups, scoped.rootCommand)
        const name = scoped.prefix.length > 0 ? `${ctx.name} ${scoped.prefix.join(' ')}` : ctx.name
        const body = full
          ? Skill.generate(name, entries, groups)
          : Skill.index(name, entries, scoped.description)
        return { contentType: 'text/markdown', body }
      }
      return {
        contentType: 'text/plain',
        body: Formatter.format(manifest(scoped.commands, scoped.prefix, full), format),
      }
    },
  }
}

function scope(ctx: CommandTree.RuntimeCliContext, command: string | undefined) {
  if (!command)
    return {
      type: 'group' as const,
      id: ctx.name,
      commands: ctx.commands,
      prefix: [] as string[],
      rootCommand: ctx.rootCommand,
      description: ctx.description,
    }
  const resolved = CommandTree.resolveCanonical(ctx, command)
  if ('error' in resolved)
    throw new DiscoverError('COMMAND_NOT_FOUND', `Unknown command '${command}'.`, 404)
  if ('gateway' in resolved)
    throw new DiscoverError('FETCH_GATEWAY', `'${command}' is a raw fetch gateway.`, 400)
  if ('commands' in resolved)
    return {
      type: 'group' as const,
      id: resolved.id,
      commands: resolved.commands,
      prefix: resolved.id.split(' '),
      rootCommand: undefined,
      description: resolved.description,
    }
  return {
    type: 'command' as const,
    id: resolved.id,
    command: resolved.command,
    commands: new Map([[resolved.id.split(' ').at(-1)!, resolved.command]]),
    prefix: resolved.id.split(' ').slice(0, -1),
    rootCommand: undefined,
    description: resolved.command.description,
  }
}

function openapi(ctx: CommandTree.RuntimeCliContext) {
  const cli = { name: ctx.name, description: ctx.description } as any
  Cli.toCommands.set(cli, ctx.commands as any)
  if (ctx.rootCommand) Cli.toRootDefinition.set(cli as Cli.Root, ctx.rootCommand as any)
  return Openapi.fromCli(Object.assign(cli, { env: ctx.env, vars: ctx.vars }), {
    ...(ctx.version !== undefined ? { version: ctx.version } : undefined),
  })
}

function skills(ctx: CommandTree.RuntimeCliContext) {
  const groups = new Map<string, string>()
  const entries = skillCommands(ctx.commands, [], groups, ctx.rootCommand)
  return { files: Skill.split(ctx.name, entries, 1, groups) }
}

function manifest(
  commands: Map<string, CommandTree.CommandEntry>,
  prefix: string[],
  full: boolean,
) {
  return {
    version: 'incur.v1',
    commands: collect(commands, prefix, full).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

function collect(commands: Map<string, CommandTree.CommandEntry>, prefix: string[], full: boolean) {
  const result: {
    name: string
    description?: string | undefined
    schema?: Record<string, unknown> | undefined
  }[] = []
  for (const [name, entry] of commands) {
    if (CommandTree.isAlias(entry) || CommandTree.isFetchGateway(entry)) continue
    const path = [...prefix, name]
    if (CommandTree.isGroup(entry)) result.push(...collect(entry.commands, path, full))
    else {
      const command: (typeof result)[number] = { name: path.join(' ') }
      if (entry.description) command.description = entry.description
      if (full) {
        const input = CommandTree.buildInputSchema(entry)
        if (input || entry.output) {
          command.schema = {}
          if (input?.args) command.schema.args = input.args
          if (input?.env) command.schema.env = input.env
          if (input?.options) command.schema.options = input.options
          if (entry.output) command.schema.output = z.toJSONSchema(entry.output)
        }
      }
      result.push(command)
    }
  }
  return result
}

function skillCommands(
  commands: Map<string, CommandTree.CommandEntry>,
  prefix: string[],
  groups: Map<string, string>,
  rootCommand?: CommandTree.CommandDefinition | undefined,
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  if (rootCommand) result.push(toSkillCommand(rootCommand, undefined))
  for (const [name, entry] of commands) {
    if (CommandTree.isAlias(entry) || CommandTree.isFetchGateway(entry)) continue
    const path = [...prefix, name]
    if (CommandTree.isGroup(entry)) {
      if (entry.description) groups.set(path.join(' '), entry.description)
      result.push(...skillCommands(entry.commands, path, groups))
      continue
    }
    result.push(toSkillCommand(entry, path.join(' ')))
  }
  return result.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

function toSkillCommand(command: CommandTree.CommandDefinition, name: string | undefined) {
  return {
    ...(name ? { name } : undefined),
    ...(command.description ? { description: command.description } : undefined),
    ...(command.args ? { args: command.args } : undefined),
    ...(command.env ? { env: command.env } : undefined),
    ...(command.hint ? { hint: command.hint } : undefined),
    ...(command.options ? { options: command.options } : undefined),
    ...(command.output ? { output: command.output } : undefined),
  } satisfies Skill.CommandInfo
}

function parseFrontmatter(content: string) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  return match ? (yamlParse(match[1]!) as Record<string, string>) : {}
}

function safeSkillName(name: string) {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '..'
}
