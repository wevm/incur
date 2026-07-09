import { z } from 'zod'

import * as Cli from '../../Cli.js'
import type * as Resources from '../../client/Resources.js'
import { BaseError } from '../../Errors.js'
import * as Formatter from '../../Formatter.js'
import * as Help from '../../Help.js'
import * as Mcp from '../../Mcp.js'
import * as Openapi from '../../Openapi.js'
import * as Skill from '../../Skill.js'
import * as RuntimeContext from '../runtime-context.js'
import * as Yaml from '../yaml.js'

/** Resources failure with protocol code and HTTP status metadata. */
export class ResourcesError extends BaseError {
  override name = 'Incur.ResourcesError'
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

/** Creates the shared in-process resources handler. */
export function createResourcesHandler(ctx: RuntimeContext.RuntimeCliContext) {
  return {
    async discover(request: unknown): Promise<Resources.Response> {
      const parsedRequest = requestSchema.safeParse(request)
      if (!parsedRequest.success)
        throw new ResourcesError('VALIDATION_ERROR', 'Invalid discovery request.', 400)
      const parsed = parsedRequest.data
      if (parsed.resource === 'openapi') {
        const spec = openapi(ctx)
        if (parsed.format === 'yaml')
          return { contentType: 'application/yaml', body: (await Yaml.load()).stringify(spec) }
        return { contentType: 'application/json', data: spec }
      }
      if (parsed.resource === 'mcpTools')
        return {
          contentType: 'application/json',
          data: { tools: Mcp.collectTools(ctx.commands, []) },
        }

      if (parsed.resource === 'skillsIndex' || parsed.resource === 'skill') {
        await Yaml.load()
        const { files } = skills(ctx)
        if (parsed.resource === 'skillsIndex') {
          return {
            contentType: 'application/json',
            data: {
              skills: files.map((file) => {
                const meta = Cli.parseSkillFrontmatter(file.content)
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
          throw new ResourcesError('INVALID_SKILL_NAME', 'Unsafe skill name.', 400)
        const file = files.find((value) => (value.dir || ctx.name) === parsed.name)
        if (!file)
          throw new ResourcesError('SKILL_NOT_FOUND', `Unknown skill '${parsed.name}'.`, 404)
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
            commands: Cli.buildIndexManifest(scoped.commands, []).commands.map(
              ({ name, description }) => ({
                name,
                ...(description ? { description } : undefined),
              }),
            ),
          }),
        }
      }

      if (parsed.resource === 'schema') {
        if (scoped.type === 'command') {
          const schema = Cli.buildCommandSchema(scoped.command)
          return { contentType: 'application/json', data: schema ?? {} }
        }
        return {
          contentType: 'application/json',
          data: Cli.buildManifest(scoped.commands, scoped.prefix),
        }
      }

      const full = parsed.resource === 'llmsFull'
      const format = parsed.format ?? 'md'
      const data = full
        ? Cli.buildManifest(scoped.commands, scoped.prefix)
        : Cli.buildIndexManifest(scoped.commands, scoped.prefix)
      if (format === 'json') return { contentType: 'application/json', data }
      if (format === 'md') {
        const groups = new Map<string, string>()
        const entries = Cli.collectSkillCommands(
          scoped.commands,
          scoped.prefix,
          groups,
          scoped.rootCommand,
        )
        const name = scoped.prefix.length > 0 ? `${ctx.name} ${scoped.prefix.join(' ')}` : ctx.name
        const body = full
          ? Skill.generate(name, entries, groups)
          : Skill.index(name, entries, scoped.description)
        return { contentType: 'text/markdown', body }
      }
      return {
        contentType: 'text/plain',
        body: Formatter.format(data, format),
      }
    },
  }
}

function scope(ctx: RuntimeContext.RuntimeCliContext, command: string | undefined) {
  if (!command)
    return {
      type: 'group' as const,
      id: ctx.name,
      commands: ctx.commands,
      prefix: [] as string[],
      rootCommand: ctx.rootCommand,
      description: ctx.description,
    }
  const resolved = RuntimeContext.resolveCanonical(ctx, command)
  if ('error' in resolved)
    throw new ResourcesError('COMMAND_NOT_FOUND', `Unknown command '${command}'.`, 404)
  if ('gateway' in resolved)
    throw new ResourcesError('FETCH_GATEWAY', `'${command}' is a raw fetch gateway.`, 400)
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

function openapi(ctx: RuntimeContext.RuntimeCliContext) {
  const cli = { name: ctx.name, description: ctx.description } as any
  Cli.toCommands.set(cli, ctx.commands as any)
  if (ctx.rootCommand) Cli.toRootDefinition.set(cli as Cli.Root, ctx.rootCommand as any)
  return Openapi.fromCli(Object.assign(cli, { env: ctx.env, vars: ctx.vars }), {
    ...(ctx.version !== undefined ? { version: ctx.version } : undefined),
  })
}

function skills(ctx: RuntimeContext.RuntimeCliContext) {
  const groups = new Map<string, string>()
  const entries = Cli.collectSkillCommands(ctx.commands, [], groups, ctx.rootCommand)
  return { files: Skill.split(ctx.name, entries, 1, groups) }
}

function safeSkillName(name: string) {
  return name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '..'
}
