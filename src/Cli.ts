import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { estimateTokenCount, sliceByTokens } from 'tokenx'
import type { z } from 'zod'

import * as Completions from './Completions.js'
import type { FieldError } from './Errors.js'
import { IncurError, ParseError, ValidationError } from './Errors.js'
import * as Fetch from './Fetch.js'
import * as Filter from './Filter.js'
import * as Formatter from './Formatter.js'
import * as Help from './Help.js'
import { builtinCommands, type CommandMeta, type Shell, shells } from './internal/command.js'
import * as Command from './internal/command.js'
import { isRecord, suggest } from './internal/helpers.js'
import { detectRunner } from './internal/pm.js'
import type { OneOf } from './internal/types.js'
import * as Mcp from './Mcp.js'
import type { Context as MiddlewareContext, Handler as MiddlewareHandler } from './middleware.js'
import * as Openapi from './Openapi.js'
export type { MiddlewareHandler }
import * as Parser from './Parser.js'
import type { Register } from './Register.js'
import * as Schema from './Schema.js'
import * as Skill from './Skill.js'
import * as SyncMcp from './SyncMcp.js'
import * as SyncSkills from './SyncSkills.js'

/** A CLI application instance. Also used as a command group when mounted on a parent CLI. */
export type Cli<
  commands extends CommandsMap = {},
  vars extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
  globals extends z.ZodObject<any> | undefined = undefined,
> = {
  /** Registers a root command or mounts a sub-CLI as a command group. */
  command: {
    /** Registers a command. Returns the CLI instance for chaining. */
    <
      const name extends string,
      const args extends z.ZodObject<any> | undefined = undefined,
      const cmdEnv extends z.ZodObject<any> | undefined = undefined,
      const options extends z.ZodObject<any> | undefined = undefined,
      const output extends z.ZodType | undefined = undefined,
    >(
      name: name,
      definition: CommandDefinition<args, cmdEnv, options, output, vars, env>,
    ): Cli<
      commands & { [key in name]: { args: InferOutput<args>; options: InferOutput<options> } },
      vars,
      env,
      globals
    >
    /** Mounts a sub-CLI as a command group. */
    <const name extends string, const sub extends CommandsMap>(
      cli: Cli<sub, any, any, any> & { name: name },
    ): Cli<
      commands & { [key in keyof sub & string as `${name} ${key}`]: sub[key] },
      vars,
      env,
      globals
    >
    /** Mounts a root CLI as a single command. */
    <
      const name extends string,
      const args extends z.ZodObject<any> | undefined,
      const opts extends z.ZodObject<any> | undefined,
    >(
      cli: Root<args, opts> & { name: name },
    ): Cli<
      commands & { [key in name]: { args: InferOutput<args>; options: InferOutput<opts> } },
      vars,
      env,
      globals
    >
    /** Mounts a fetch handler as a command, optionally with OpenAPI spec for typed subcommands. */
    <const name extends string>(
      name: name,
      definition: {
        basePath?: string | undefined
        description?: string | undefined
        fetch: FetchHandler
        openapi?: Openapi.OpenAPISpec | undefined
        outputPolicy?: OutputPolicy | undefined
      },
    ): Cli<commands, vars, env, globals>
  }
  /** A short description of the CLI. */
  description?: string | undefined
  /** The env schema, if declared. Use `typeof cli.env` with `middleware<vars, env>()` for typed middleware. */
  env: env
  /** The name of the CLI application. */
  name: string
  /** Handles an incoming HTTP request, resolves the matching command, and returns a JSON Response. */
  fetch(req: Request): Promise<Response>
  /** Parses argv, runs the matched command, and writes the output envelope to stdout. */
  serve(argv?: string[], options?: serve.Options): Promise<void>
  /** Registers middleware that runs around every command. */
  use(handler: MiddlewareHandler<vars, env, globals>): Cli<commands, vars, env, globals>
  /** The vars schema, if declared. Use `typeof cli.vars` with `middleware<vars, env>()` for typed middleware. */
  vars: vars
}

/** Root CLI — a single command with no subcommands. Carries phantom generics for mounting inference. */
export type Root<
  _args extends z.ZodObject<any> | undefined = undefined,
  _options extends z.ZodObject<any> | undefined = undefined,
> = Omit<Cli, 'command'>

/** Extracts the commands map from the registered type. */
export type Commands = Register extends { commands: infer commands extends CommandsMap }
  ? commands
  : {}

/** Call to action. */
export type Cta<commands extends CommandsMap = Commands> =
  | ([keyof commands] extends [never] ? string : (keyof commands & string) | (string & {}))
  | ([keyof commands] extends [never]
      ? {
          /** Positional arguments appended as bare values. */
          args?: Record<string, unknown> | undefined
          /** The command name to run. */
          command: string
          /** A short description of what the command does. */
          description?: string | undefined
          /** Named options formatted as `--key value` flags. */
          options?: Record<string, unknown> | undefined
        }
      :
          | {
              [name in keyof commands & string]: {
                /** Positional arguments appended as bare values. */
                args?:
                  | { [key in keyof commands[name]['args']]?: commands[name]['args'][key] | true }
                  | undefined
                /** The command name to run. */
                command: name
                /** A short description of what the command does. */
                description?: string | undefined
                /** Named options formatted as `--key value` flags. */
                options?:
                  | {
                      [key in keyof commands[name]['options']]?:
                        | commands[name]['options'][key]
                        | true
                    }
                  | undefined
              }
            }[keyof commands & string]
          | {
              /** The command name to run. */
              command: string & {}
              /** A short description of what the command does. */
              description?: string | undefined
            })

/** Creates a CLI with a root handler. Can still register subcommands which take precedence. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
  const vars extends z.ZodObject<any> | undefined = undefined,
  const globals extends z.ZodObject<any> | undefined = undefined,
>(
  name: string,
  definition: create.Options<args, env, opts, output, vars, globals> & { run: Function },
): Cli<
  { [key in typeof name]: { args: InferOutput<args>; options: InferOutput<opts> } },
  vars,
  env,
  globals
>
/** Creates a router CLI that registers subcommands. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
  const vars extends z.ZodObject<any> | undefined = undefined,
  const globals extends z.ZodObject<any> | undefined = undefined,
>(
  name: string,
  definition?: create.Options<args, env, opts, output, vars, globals>,
): Cli<{}, vars, env, globals>
/** Creates a CLI with a root handler from a single options object. Can still register subcommands. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
  const vars extends z.ZodObject<any> | undefined = undefined,
  const globals extends z.ZodObject<any> | undefined = undefined,
>(
  definition: create.Options<args, env, opts, output, vars, globals> & {
    name: string
    run: Function
  },
): Cli<
  {
    [key in (typeof definition)['name']]: { args: InferOutput<args>; options: InferOutput<opts> }
  },
  vars,
  env,
  globals
>
/** Creates a router CLI from a single options object (e.g. package.json). */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
  const vars extends z.ZodObject<any> | undefined = undefined,
  const globals extends z.ZodObject<any> | undefined = undefined,
>(
  definition: create.Options<args, env, opts, output, vars, globals> & { name: string },
): Cli<{}, vars, env, globals>
export function create(
  nameOrDefinition: string | (any & { name: string }),
  definition?: any,
): Cli | Root {
  const name = typeof nameOrDefinition === 'string' ? nameOrDefinition : nameOrDefinition.name
  const def = typeof nameOrDefinition === 'string' ? (definition ?? {}) : nameOrDefinition
  const rootDef = 'run' in def ? (def as CommandDefinition<any, any, any>) : undefined
  const rootFetch = 'fetch' in def ? (def.fetch as FetchHandler) : undefined

  const commands = new Map<string, CommandEntry>()
  const middlewares: MiddlewareHandler[] = []
  const pending: Promise<void>[] = []
  const mcpHandler = createMcpHttpHandler(name, def.version ?? '0.0.0')

  const cli: Cli = {
    name,
    description: def.description,
    env: def.env,
    vars: def.vars,

    command(nameOrCli: any, def?: any): any {
      if (typeof nameOrCli === 'string') {
        if (def && 'fetch' in def && typeof def.fetch === 'function') {
          // OpenAPI + fetch → generate typed command group (async, resolved before serve)
          if (def.openapi) {
            pending.push(
              Openapi.generateCommands(def.openapi, def.fetch, { basePath: def.basePath }).then(
                (generated) => {
                  commands.set(nameOrCli, {
                    _group: true,
                    description: def.description,
                    commands: generated as Map<string, CommandEntry>,
                    ...(def.outputPolicy ? { outputPolicy: def.outputPolicy } : undefined),
                  } as InternalGroup)
                },
              ),
            )
            return cli
          }
          commands.set(nameOrCli, {
            _fetch: true,
            basePath: def.basePath,
            description: def.description,
            fetch: def.fetch,
            ...(def.outputPolicy ? { outputPolicy: def.outputPolicy } : undefined),
          } as InternalFetchGateway)
          return cli
        }
        const globalsDesc = toGlobals.get(cli)
        if (globalsDesc && def?.options) {
          const globalKeys = Object.keys(globalsDesc.schema.shape)
          const optionKeys = Object.keys(def.options.shape)
          for (const key of optionKeys) {
            if (globalKeys.includes(key))
              throw new Error(
                `Command '${nameOrCli}' option '${key}' conflicts with a global option. Choose a different name.`,
              )
          }
        }
        if (globalsDesc?.alias && def?.alias) {
          const globalAliasValues = new Set(Object.values(globalsDesc.alias))
          for (const [name, short] of Object.entries(def.alias as Record<string, string>)) {
            if (globalAliasValues.has(short))
              throw new Error(
                `Command '${nameOrCli}' alias '-${short}' for '${name}' conflicts with a global alias. Choose a different alias.`,
              )
          }
        }
        commands.set(nameOrCli, def)
        return cli
      }
      const mountedRootDef = toRootDefinition.get(nameOrCli)
      if (mountedRootDef) {
        commands.set(nameOrCli.name, mountedRootDef)
        return cli
      }
      const sub = nameOrCli as Cli
      const subCommands = toCommands.get(sub)!
      const subOutputPolicy = toOutputPolicy.get(sub)
      const subMiddlewares = toMiddlewares.get(sub)
      commands.set(sub.name, {
        _group: true,
        description: sub.description,
        commands: subCommands,
        ...(subOutputPolicy ? { outputPolicy: subOutputPolicy } : undefined),
        ...(subMiddlewares?.length ? { middlewares: subMiddlewares } : undefined),
      })
      return cli
    },

    async fetch(req: Request) {
      if (pending.length > 0) await Promise.all(pending)
      const globalsDesc = toGlobals.get(cli)
      return fetchImpl(name, commands, req, {
        envSchema: def.env,
        globals: globalsDesc,
        mcpHandler,
        middlewares,
        name,
        rootCommand: rootDef,
        vars: def.vars,
        version: def.version,
      })
    },

    async serve(argv = process.argv.slice(2), serveOptions: serve.Options = {}) {
      if (pending.length > 0) await Promise.all(pending)
      const globalsDesc = toGlobals.get(cli)
      return serveImpl(name, commands, argv, {
        ...serveOptions,
        aliases: def.aliases,
        config: def.config,
        description: def.description,
        envSchema: def.env,
        format: def.format,
        globals: globalsDesc,
        mcp: def.mcp,
        middlewares,
        outputPolicy: def.outputPolicy,
        rootCommand: rootDef,
        rootFetch,
        sync: def.sync,
        vars: def.vars,
        version: def.version,
      })
    },

    use(handler: MiddlewareHandler): any {
      middlewares.push(handler)
      return cli
    },
  }

  if (rootDef) toRootDefinition.set(cli as unknown as Root, rootDef)
  if (def.options) toRootOptions.set(cli, def.options)
  if (def.config !== undefined) toConfigEnabled.set(cli, true)
  if (def.outputPolicy) toOutputPolicy.set(cli, def.outputPolicy)
  if (def.globals) {
    toGlobals.set(cli, { schema: def.globals, alias: def.globalAlias as any })
    const builtinNames = [
      'verbose',
      'format',
      'json',
      'llms',
      'llmsFull',
      'mcp',
      'help',
      'version',
      'schema',
      'filterOutput',
      'tokenLimit',
      'tokenOffset',
      'tokenCount',
      ...(def.config?.flag ? [def.config.flag, `no${def.config.flag[0].toUpperCase()}${def.config.flag.slice(1)}`] : []),
    ]
    const globalKeys = Object.keys(def.globals.shape)
    for (const key of globalKeys) {
      if (builtinNames.includes(key))
        throw new Error(
          `Global option '${key}' conflicts with a built-in flag. Choose a different name.`,
        )
    }
    // Check globalAlias values against reserved short aliases
    const reservedShorts = new Set(['h'])
    if (def.globalAlias) {
      for (const [name, short] of Object.entries(def.globalAlias as Record<string, string>)) {
        if (reservedShorts.has(short))
          throw new Error(
            `Global alias '-${short}' for '${name}' conflicts with a built-in short flag. Choose a different alias.`,
          )
      }
    }
  }
  toMiddlewares.set(cli, middlewares)
  toCommands.set(cli, commands)
  return cli
}

export declare namespace create {
  /** Options for creating a CLI. Provide `run` for a leaf CLI, omit it for a router. */
  type Options<
    args extends z.ZodObject<any> | undefined = undefined,
    env extends z.ZodObject<any> | undefined = undefined,
    options extends z.ZodObject<any> | undefined = undefined,
    output extends z.ZodType | undefined = undefined,
    vars extends z.ZodObject<any> | undefined = undefined,
    globals extends z.ZodObject<any> | undefined = undefined,
  > = {
    /** Map of option names to single-char aliases. */
    alias?: options extends z.ZodObject<any>
      ? Partial<Record<keyof z.output<options>, string>>
      : Record<string, string> | undefined
    /** Alternative binary names for this CLI (e.g. shorter aliases in package.json `bin`). Shell completions are registered for all names. */
    aliases?: string[] | undefined
    /** Zod schema for positional arguments. */
    args?: args | undefined
    /** Enable config-file defaults for command options. */
    config?:
      | {
          /** Global flag name for specifying a config file path (e.g. `'config'` → `--config <path>`). Omit to auto-load only, with no CLI flag. */
          flag?: string | undefined
          /** Ordered list of file paths to search. First existing file wins. Supports `~` for home dir. Defaults to `['<cli>.json']` relative to cwd. */
          files?: string[] | undefined
          /** Custom config loader. Receives the resolved file path (or `undefined` if no file was found). Returns the parsed config tree, or `undefined` for no defaults. When omitted, the framework reads and parses JSON. */
          loader?:
            | ((
                path: string | undefined,
              ) =>
                | Record<string, unknown>
                | undefined
                | Promise<Record<string, unknown> | undefined>)
            | undefined
        }
      | undefined
    /** A short description of what the CLI does. */
    description?: string | undefined
    /** Zod schema for environment variables. Keys are the variable names (e.g. `NPM_TOKEN`). */
    env?: env | undefined
    /** Usage examples for this command. */
    examples?: Example<args, options>[] | undefined
    /** A fetch handler to use as the root command. All argv tokens are interpreted as path segments and curl-style flags. */
    fetch?: FetchHandler | undefined
    /** Default output format. Overridden by `--format` or `--json`. */
    format?: Formatter.Format | undefined
    /** Map of global option names to single-char aliases. */
    globalAlias?: globals extends z.ZodObject<any>
      ? Partial<Record<keyof z.output<globals>, string>>
      : Record<string, string> | undefined
    /** Zod schema for global options available to all commands. Parsed before command resolution and passed to middleware and command handlers. */
    globals?: globals | undefined
    /** Zod schema for named options/flags. */
    options?: options | undefined
    /** Zod schema for the return value. */
    output?: output | undefined
    /**
     * Controls when output data is displayed. Inherited by child commands when set on a group or root CLI.
     *
     * - `'all'` — displays to both humans and agents.
     * - `'agent-only'` — suppresses data output in human/TTY mode while still returning it to agents.
     *
     * @default 'all'
     */
    outputPolicy?: OutputPolicy | undefined
    /** Alternative usage patterns shown in help output. */
    usage?: Usage<args, options>[] | undefined
    /** Zod schema for middleware variables. Keys define variable names, schemas define types and defaults. */
    vars?: vars | undefined
    /** The root command handler. When provided, creates a leaf CLI with no subcommands. */
    run?:
      | ((context: {
          /** Whether the consumer is an agent (stdout is not a TTY). */
          agent: boolean
          /** Positional arguments. */
          args: InferOutput<args>
          /** The binary name the user invoked (e.g. an alias). Falls back to `name` when not resolvable. */
          displayName: string
          /** Parsed environment variables. */
          env: InferOutput<env>
          /** Return an error result with optional CTAs. */
          error: (options: {
            code: string
            cta?: CtaBlock | undefined
            exitCode?: number | undefined
            message: string
            retryable?: boolean | undefined
          }) => never
          /** The resolved output format (e.g. `'toon'`, `'json'`, `'jsonl'`). */
          format: Formatter.Format
          /** Whether the user explicitly passed `--format` or `--json`. */
          formatExplicit: boolean
          /** The CLI name. */
          name: string
          /** Return a success result with optional metadata (e.g. CTAs). */
          ok: (data: InferReturn<output>, meta?: { cta?: CtaBlock | undefined }) => never
          options: InferOutput<options>
          /** Variables set by middleware. */
          var: InferVars<vars>
        }) =>
          | InferReturn<output>
          | Promise<InferReturn<output>>
          | AsyncGenerator<InferReturn<output>, unknown, unknown>)
      | undefined
    /** Options for the built-in `mcp add` command. */
    mcp?:
      | {
          /** Target specific agents by default (e.g. `['claude-code', 'cursor']`). */
          agents?: string[] | undefined
          /** Override the command agents will run to start the MCP server. Auto-detected if omitted. */
          command?: string | undefined
        }
      | undefined
    /** Options for the built-in `skills add` command. */
    sync?:
      | {
          /** Working directory for resolving `include` globs. Pass `import.meta.dirname` when running from a bin entry. Defaults to `process.cwd()`. */
          cwd?: string | undefined
          /** Default grouping depth for skill files. Overridden by `--depth`. Defaults to `1`. */
          depth?: number | undefined
          /** Glob patterns for directories containing SKILL.md files to include (e.g. `"skills/*"`, `"my-skill"`). */
          include?: string[] | undefined
          /** Example prompts shown after sync to help users get started. */
          suggestions?: string[] | undefined
        }
      | undefined
    /** The CLI version string. */
    version?: string | undefined
  }
}

export declare namespace serve {
  /** Options for `serve()`, primarily used for testing. */
  type Options = {
    /** Override environment variable source. Defaults to `process.env`. */
    env?: Record<string, string | undefined> | undefined
    /** Override exit handler. Defaults to `process.exit`. */
    exit?: ((code: number) => void) | undefined
    /** Override stdout writer. Defaults to `process.stdout.write`. */
    stdout?: ((s: string) => void) | undefined
  }
}

/** @internal Shared serve implementation for both router and leaf CLIs. */
// biome-ignore lint/correctness/noUnusedVariables: _
async function serveImpl(
  name: string,
  commands: Map<string, CommandEntry>,
  argv: string[],
  options: serveImpl.Options = {},
) {
  const stdout = options.stdout ?? ((s: string) => process.stdout.write(s))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const human = process.stdout.isTTY === true
  const configEnabled = options.config !== undefined
  const configFlag = options.config?.flag
  const displayName = resolveDisplayName(name, options.aliases)

  function writeln(s: string) {
    stdout(s.endsWith('\n') ? s : `${s}\n`)
  }

  let builtinFlags: ReturnType<typeof extractBuiltinFlags>
  try {
    builtinFlags = extractBuiltinFlags(argv, { configFlag })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (human) writeln(formatHumanError({ code: 'UNKNOWN', message }))
    else writeln(Formatter.format({ code: 'UNKNOWN', message }, 'toon'))
    exit(1)
    return
  }

  const {
    verbose,
    format: formatFlag,
    formatExplicit,
    filterOutput,
    tokenLimit,
    tokenOffset,
    tokenCount,
    llms,
    llmsFull,
    mcp: mcpFlag,
    help,
    version,
    schema,
    configPath,
    configDisabled,
    rest,
  } = builtinFlags

  // Parse global options from argv remainder
  let globals: Record<string, unknown> = {}
  let filtered = rest
  if (options.globals) {
    try {
      const result = Parser.parseGlobals(rest, options.globals.schema, options.globals.alias)
      globals = result.parsed
      filtered = result.rest
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (human) writeln(formatHumanError({ code: 'UNKNOWN', message }))
      else writeln(Formatter.format({ code: 'UNKNOWN', message }, 'toon'))
      exit(1)
      return
    }
  }

  // --mcp: start as MCP stdio server
  if (mcpFlag) {
    await Mcp.serve(name, options.version ?? '0.0.0', commands, {
      middlewares: options.middlewares,
      env: options.envSchema,
      vars: options.vars,
      version: options.version,
    })
    return
  }

  // COMPLETE: dynamic shell completions (called by shell hook at tab-press)
  const completeShell = process.env.COMPLETE as Shell | undefined
  if (completeShell) {
    // Remove separator `--` from argv
    const sepIdx = argv.indexOf('--')
    const words = sepIdx !== -1 ? argv.slice(sepIdx + 1) : argv
    if (words.length === 0) {
      // Registration mode: print shell hook script for primary name + aliases
      const names = [name, ...(options.aliases ?? [])]
      stdout(names.map((n) => Completions.register(completeShell, n)).join('\n'))
    } else {
      const index = Number(process.env._COMPLETE_INDEX ?? words.length - 1)
      const candidates = Completions.complete(
        commands,
        options.rootCommand,
        words,
        index,
        options.globals
          ? { schema: options.globals.schema, alias: options.globals.alias }
          : undefined,
      )
      // Add built-in commands (completions, mcp, skills) to completions
      const current = words[index] ?? ''
      const nonFlags = words.slice(0, index).filter((w) => !w.startsWith('-'))
      if (nonFlags.length <= 1) {
        for (const b of builtinCommands) {
          if (b.name.startsWith(current) && !candidates.some((c) => c.value === b.name))
            candidates.push({
              value: b.name,
              description: b.description,
              ...(b.subcommands ? { noSpace: true } : undefined),
            })
        }
      } else if (nonFlags.length === 2) {
        const parent = nonFlags[nonFlags.length - 1]
        const builtin = builtinCommands.find((b) => b.name === parent && b.subcommands)
        if (builtin?.subcommands)
          for (const sub of builtin.subcommands)
            if (sub.name.startsWith(current))
              candidates.push({ value: sub.name, description: sub.description })
      }
      const out = Completions.format(completeShell, candidates)
      if (out) stdout(out)
    }
    return
  }

  // Skills staleness check (skip for built-in commands)
  let skillsCta: FormattedCtaBlock | undefined
  if (!llms && !llmsFull && !schema && !help && !version) {
    const isSkillsAdd =
      filtered[0] === 'skills' || (filtered[0] === name && filtered[1] === 'skills')
    const isMcpAdd = filtered[0] === 'mcp' || (filtered[0] === name && filtered[1] === 'mcp')
    if (!isSkillsAdd && !isMcpAdd) {
      const stored = SyncSkills.readHash(name)
      if (stored) {
        const groups = new Map<string, string>()
        const entries = collectSkillCommands(commands, [], groups)
        if (Skill.hash(entries) !== stored) {
          const runner = detectRunner()
          const spec = SyncMcp.detectPackageSpecifier(name)
          skillsCta = {
            description: 'Skills are out of date:',
            commands: [
              { command: `${runner} ${spec} skills add`, description: 'sync outdated skills' },
            ],
          }
        }
      }
    }
  }

  if (llms || llmsFull) {
    // Scope to a subtree if command tokens are provided
    let scopedCommands = commands
    const prefix: string[] = []
    let scopedDescription: string | undefined = options.description
    for (const token of filtered) {
      const entry = scopedCommands.get(token)
      if (!entry) break
      if (isGroup(entry)) {
        scopedCommands = entry.commands
        scopedDescription = entry.description
        prefix.push(token)
      } else {
        // Leaf command — scope to just this command
        scopedCommands = new Map([[token, entry]])
        break
      }
    }

    if (llmsFull) {
      if (!formatExplicit || formatFlag === 'md') {
        const groups = new Map<string, string>()
        const cmds = collectSkillCommands(scopedCommands, prefix, groups)
        const scopedName = prefix.length > 0 ? `${name} ${prefix.join(' ')}` : name
        writeln(Skill.generate(scopedName, cmds, groups))
        return
      }
      writeln(
        Formatter.format(
          buildManifest(scopedCommands, prefix, options.globals?.schema),
          formatFlag,
        ),
      )
      return
    }

    if (!formatExplicit || formatFlag === 'md') {
      const groups = new Map<string, string>()
      const cmds = collectSkillCommands(scopedCommands, prefix, groups)
      const scopedName = prefix.length > 0 ? `${name} ${prefix.join(' ')}` : name
      writeln(Skill.index(scopedName, cmds, scopedDescription))
      return
    }
    writeln(
      Formatter.format(
        buildIndexManifest(scopedCommands, prefix, options.globals?.schema),
        formatFlag,
      ),
    )
    return
  }

  // completions <shell>: print shell hook script to stdout
  const completionsIdx = (() => {
    // e.g. `completions bash`
    if (filtered[0] === 'completions') return 0
    // e.g. `my-cli completions bash`
    if (filtered[0] === name && filtered[1] === 'completions') return 1
    // not a completions invocation
    return -1
  })()
  // TODO: refactor built-in command handlers (completions, skills, mcp) into a generic dispatch loop on `builtinCommands`
  if (completionsIdx !== -1 && filtered[completionsIdx] === 'completions') {
    const shell = filtered[completionsIdx + 1]
    if (help || !shell) {
      const b = builtinCommands.find((c) => c.name === 'completions')!
      writeln(
        Help.formatCommand(`${name} completions`, {
          args: b.args,
          description: b.description,
          hideGlobalOptions: true,
          hint: b.hint?.(name),
        }),
      )
      return
    }
    if (!shells.includes(shell as any)) {
      writeln(
        formatHumanError({
          code: 'INVALID_SHELL',
          message: `Unknown shell '${shell}'. Supported: ${shells.join(', ')}`,
        }),
      )
      exit(1)
      return
    }
    const names = [name, ...(options.aliases ?? [])]
    writeln(names.map((n) => Completions.register(shell as Shell, n)).join('\n'))
    return
  }

  // skills add: generate skill files and install via `<pm>x skills add` (only when sync is configured)
  const skillsIdx =
    filtered[0] === 'skills' ? 0 : filtered[0] === name && filtered[1] === 'skills' ? 1 : -1
  if (skillsIdx !== -1 && filtered[skillsIdx] === 'skills') {
    const skillsSub = filtered[skillsIdx + 1]
    if (skillsSub && skillsSub !== 'add') {
      const suggestion = suggest(skillsSub, ['add'])
      const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : ''
      const message = `'${skillsSub}' is not a command for '${name} skills'.${didYouMean}`
      const ctaCommands: FormattedCta[] = []
      if (suggestion) {
        const corrected = argv.map((t) => (t === skillsSub ? suggestion : t))
        ctaCommands.push({ command: `${name} ${corrected.join(' ')}` })
      }
      ctaCommands.push({
        command: `${name} skills --help`,
        description: 'see all available commands',
      })
      const cta: FormattedCtaBlock = {
        description: ctaCommands.length === 1 ? 'Suggested command:' : 'Suggested commands:',
        commands: ctaCommands,
      }
      if (human) {
        writeln(formatHumanError({ code: 'COMMAND_NOT_FOUND', message }))
        writeln(formatHumanCta(cta))
      } else writeln(Formatter.format({ code: 'COMMAND_NOT_FOUND', message, cta }, 'toon'))
      exit(1)
      return
    }
    if (!skillsSub) {
      const b = builtinCommands.find((c) => c.name === 'skills')!
      writeln(formatBuiltinHelp(name, b))
      return
    }
    if (help) {
      const b = builtinCommands.find((c) => c.name === 'skills')!
      writeln(formatBuiltinSubcommandHelp(name, b, 'add'))
      return
    }
    const rest = filtered.slice(skillsIdx + 2)
    const depthArg = rest.indexOf('--depth')
    const depthEq = rest.find((t) => t.startsWith('--depth='))
    const depth =
      depthArg !== -1
        ? Number(rest[depthArg + 1])
        : depthEq
          ? Number(depthEq.split('=')[1])
          : (options.sync?.depth ?? 1)
    const global = rest.includes('--no-global') ? false : undefined
    try {
      stdout('Syncing...')
      const result = await SyncSkills.sync(name, commands, {
        cwd: options.sync?.cwd,
        depth,
        description: options.description,
        global,
        include: options.sync?.include,
      })
      stdout('\r\x1b[K')
      const lines: string[] = []
      const skillLabel = (s: (typeof result.skills)[number]) => s.name
      const maxLen = Math.max(...result.skills.map((s) => skillLabel(s).length))
      for (const s of result.skills) {
        const label = skillLabel(s)
        const padding = s.description
          ? `${' '.repeat(maxLen - label.length)}  ${s.description}`
          : ''
        lines.push(`  ✓ ${label}${padding}`)
      }
      lines.push('')
      lines.push(`${result.skills.length} skill${result.skills.length === 1 ? '' : 's'} synced`)
      const suggestions = options.sync?.suggestions
      if (suggestions && suggestions.length > 0) {
        lines.push('')
        lines.push(`Your agent can now use ${name}. Try asking:`)
        for (const s of suggestions) lines.push(`  "${s}"`)
      }
      lines.push('')
      lines.push(`Run \`${name} --help\` to see the full command reference.`)
      writeln(lines.join('\n'))
      if (verbose || formatExplicit) {
        const output: Record<string, unknown> = { skills: result.paths }
        if (verbose && result.agents.length > 0) output.agents = result.agents
        writeln(Formatter.format(output, formatExplicit ? formatFlag : 'toon'))
      }
    } catch (err) {
      writeln(
        Formatter.format(
          { code: 'SYNC_SKILLS_FAILED', message: err instanceof Error ? err.message : String(err) },
          formatExplicit ? formatFlag : 'toon',
        ),
      )
      exit(1)
    }
    return
  }

  // mcp add: register CLI as MCP server via `npx add-mcp`
  const mcpIdx = filtered[0] === 'mcp' ? 0 : filtered[0] === name && filtered[1] === 'mcp' ? 1 : -1
  if (mcpIdx !== -1 && filtered[mcpIdx] === 'mcp') {
    const mcpSub = filtered[mcpIdx + 1]
    if (mcpSub && mcpSub !== 'add') {
      const suggestion = suggest(mcpSub, ['add'])
      const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : ''
      const message = `'${mcpSub}' is not a command for '${name} mcp'.${didYouMean}`
      const ctaCommands: FormattedCta[] = []
      if (suggestion) {
        const corrected = argv.map((t) => (t === mcpSub ? suggestion : t))
        ctaCommands.push({ command: `${name} ${corrected.join(' ')}` })
      }
      ctaCommands.push({ command: `${name} mcp --help`, description: 'see all available commands' })
      const cta: FormattedCtaBlock = {
        description: ctaCommands.length === 1 ? 'Suggested command:' : 'Suggested commands:',
        commands: ctaCommands,
      }
      if (human) {
        writeln(formatHumanError({ code: 'COMMAND_NOT_FOUND', message }))
        writeln(formatHumanCta(cta))
      } else writeln(Formatter.format({ code: 'COMMAND_NOT_FOUND', message, cta }, 'toon'))
      exit(1)
      return
    }
    if (!mcpSub) {
      const b = builtinCommands.find((c) => c.name === 'mcp')!
      writeln(formatBuiltinHelp(name, b))
      return
    }
    if (help) {
      const b = builtinCommands.find((c) => c.name === 'mcp')!
      writeln(formatBuiltinSubcommandHelp(name, b, 'add'))
      return
    }
    const rest = filtered.slice(mcpIdx + 2)
    const global = rest.includes('--no-global') ? false : true

    // Parse --command / -c and --agent flags from argv
    let command = options.mcp?.command
    const agents: string[] = [...(options.mcp?.agents ?? [])]
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === '--command' || rest[i] === '-c') && rest[i + 1]) command = rest[++i]!
      else if (rest[i] === '--agent' && rest[i + 1]) agents.push(rest[++i]!)
    }

    try {
      stdout('Registering MCP server...')
      const result = await SyncMcp.register(name, {
        command,
        global,
        agents,
      })
      stdout('\r\x1b[K')
      const lines: string[] = []
      lines.push(`✓ Registered ${name} as MCP server`)
      if (result.agents.length > 0) lines.push(`  Agents: ${result.agents.join(', ')}`)
      lines.push('')
      lines.push(`Agents can now use ${name} tools.`)
      const suggestions = options.sync?.suggestions
      if (suggestions && suggestions.length > 0) {
        lines.push('')
        lines.push('Try asking:')
        for (const s of suggestions) lines.push(`  "${s}"`)
      }
      writeln(lines.join('\n'))
      if (verbose || formatExplicit)
        writeln(
          Formatter.format(
            { name, command: result.command, agents: result.agents },
            formatExplicit ? formatFlag : 'toon',
          ),
        )
    } catch (err) {
      writeln(
        Formatter.format(
          { code: 'MCP_ADD_FAILED', message: err instanceof Error ? err.message : String(err) },
          formatExplicit ? formatFlag : 'toon',
        ),
      )
      exit(1)
    }
    return
  }

  // --help takes precedence over --version
  if (version && !help && options.version) {
    writeln(options.version)
    return
  }

  if (filtered.length === 0) {
    if (
      options.rootCommand &&
      human &&
      options.rootCommand.args &&
      hasRequiredArgs(options.rootCommand.args)
    ) {
      // Root command with args but none provided (human mode) — show help
      const cmd = options.rootCommand
      writeln(
        Help.formatCommand(name, {
          alias: cmd.alias as Record<string, string> | undefined,
          aliases: options.aliases,
          configFlag,
          description: cmd.description ?? options.description,
          globals: options.globals,
          version: options.version,
          args: cmd.args,
          env: cmd.env,
          envSource: options.env,
          hint: cmd.hint,
          options: cmd.options,
          examples: formatExamples(cmd.examples),
          usage: cmd.usage,
          commands: commands.size > 0 ? collectHelpCommands(commands) : undefined,
          root: true,
        }),
      )
      return
    }
    if (options.rootCommand || options.rootFetch) {
      // Root command/fetch with no args — treat as root invocation
    } else {
      writeln(
        Help.formatRoot(name, {
          aliases: options.aliases,
          configFlag,
          description: options.description,
          globals: options.globals,
          version: options.version,
          commands: collectHelpCommands(commands),
          root: true,
        }),
      )
      return
    }
  }

  const resolved =
    filtered.length === 0 && options.rootCommand
      ? { command: options.rootCommand, path: name, rest: [] as string[] }
      : filtered.length === 0 && options.rootFetch
        ? {
            fetchGateway: {
              _fetch: true as const,
              fetch: options.rootFetch,
              description: options.description,
            },
            middlewares: [] as MiddlewareHandler[],
            path: name,
            rest: [] as string[],
          }
        : resolveCommand(commands, filtered)

  // --help on a fetch gateway → show fetch-specific help
  if (help && 'fetchGateway' in resolved) {
    const commandName = resolved.path === name ? name : `${name} ${resolved.path}`
    writeln(formatFetchHelp(commandName, resolved.fetchGateway.description))
    return
  }

  // --help after a command → show help for that command
  if (help) {
    if ('help' in resolved || 'error' in resolved) {
      // group or unknown → show root help for that path
      const helpName = 'help' in resolved ? `${name} ${resolved.path}` : name
      const helpDesc = 'help' in resolved ? resolved.description : options.description
      const helpCmds = 'help' in resolved ? resolved.commands : commands
      const isRoot = helpName === name
      // Root with both a handler and subcommands → show command help with subcommands
      if (isRoot && options.rootCommand && helpCmds.size > 0) {
        const cmd = options.rootCommand
        writeln(
          Help.formatCommand(name, {
            alias: cmd.alias as Record<string, string> | undefined,
            aliases: options.aliases,
            configFlag,
            description: cmd.description ?? options.description,
            globals: options.globals,
            version: options.version,
            args: cmd.args,
            env: cmd.env,
            envSource: options.env,
            hint: cmd.hint,
            options: cmd.options,
            examples: formatExamples(cmd.examples),
            usage: cmd.usage,
            commands: collectHelpCommands(helpCmds),
            root: true,
          }),
        )
      } else {
        writeln(
          Help.formatRoot(helpName, {
            aliases: isRoot ? options.aliases : undefined,
            configFlag,
            description: helpDesc,
            globals: options.globals,
            version: isRoot ? options.version : undefined,
            commands: collectHelpCommands(helpCmds),
            root: isRoot,
          }),
        )
      }
    } else if ('command' in resolved) {
      const cmd = resolved.command
      const isRootCmd = resolved.path === name
      const commandName = isRootCmd ? name : `${name} ${resolved.path}`
      const helpSubcommands =
        isRootCmd && options.rootCommand && commands.size > 0
          ? collectHelpCommands(commands)
          : undefined
      writeln(
        Help.formatCommand(commandName, {
          alias: cmd.alias as Record<string, string> | undefined,
          aliases: isRootCmd ? options.aliases : undefined,
          configFlag,
          description: cmd.description,
          globals: options.globals,
          version: isRootCmd ? options.version : undefined,
          args: cmd.args,
          env: cmd.env,
          envSource: options.env,
          hint: cmd.hint,
          options: cmd.options,
          examples: formatExamples(cmd.examples),
          usage: cmd.usage,
          commands: helpSubcommands,
          root: isRootCmd,
        }),
      )
    }
    return
  }

  // --schema: output JSON Schema for a command's args, env, options, output
  if (schema) {
    if ('help' in resolved) {
      writeln(
        Help.formatRoot(`${name} ${resolved.path}`, {
          configFlag,
          description: resolved.description,
          globals: options.globals,
          commands: collectHelpCommands(resolved.commands),
        }),
      )
      return
    }
    if ('error' in resolved) {
      const parent = resolved.path ? `${name} ${resolved.path}` : name
      const suggestion = suggest(resolved.error, resolved.commands.keys())
      const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : ''
      writeln(`Error: '${resolved.error}' is not a command for '${parent}'.${didYouMean}`)
      exit(1)
      return
    }
    if ('fetchGateway' in resolved) {
      writeln('--schema is not supported for fetch commands.')
      exit(1)
      return
    }
    const cmd = resolved.command
    const format = formatExplicit ? formatFlag : 'toon'
    const result: Record<string, unknown> = {}
    if (cmd.args) result.args = Schema.toJsonSchema(cmd.args)
    if (cmd.env) result.env = Schema.toJsonSchema(cmd.env)
    if (cmd.options) result.options = Schema.toJsonSchema(cmd.options)
    if (cmd.output) result.output = Schema.toJsonSchema(cmd.output)
    if (options.globals?.schema) result.globals = Schema.toJsonSchema(options.globals.schema)
    writeln(Formatter.format(result, format))
    return
  }

  if ('help' in resolved) {
    writeln(
      Help.formatRoot(`${name} ${resolved.path}`, {
        configFlag,
        description: resolved.description,
        globals: options.globals,
        commands: collectHelpCommands(resolved.commands),
      }),
    )
    return
  }

  const start = performance.now()

  // Resolve effective format: explicit --format/--json → command default → CLI default → toon
  const resolvedFormat = 'command' in resolved && (resolved as any).command.format
  const format = formatExplicit ? formatFlag : resolvedFormat || options.format || 'toon'

  // Fall back to root fetch when no subcommand matches
  const effective =
    'error' in resolved && options.rootFetch && !resolved.path
      ? {
          fetchGateway: {
            _fetch: true as const,
            fetch: options.rootFetch,
            description: options.description,
          },
          middlewares: [] as MiddlewareHandler[],
          path: name,
          rest: filtered,
        }
      : 'error' in resolved && options.rootCommand && !resolved.path
        ? { command: options.rootCommand, path: name, rest: filtered }
        : resolved

  // Resolve outputPolicy: command/group → CLI-level → default ('all')
  const effectiveOutputPolicy =
    ('outputPolicy' in resolved && resolved.outputPolicy) || options.outputPolicy
  const renderOutput = !(human && !formatExplicit && effectiveOutputPolicy === 'agent-only')

  const filterPaths = filterOutput ? Filter.parse(filterOutput) : undefined

  function truncate(s: string): {
    text: string
    truncated: boolean
    nextOffset?: number | undefined
  } {
    if (tokenLimit == null && tokenOffset == null) return { text: s, truncated: false }
    const total = estimateTokenCount(s)
    const offset = tokenOffset ?? 0
    const end = tokenLimit != null ? offset + tokenLimit : total
    if (offset === 0 && end >= total) return { text: s, truncated: false }
    const sliced = sliceByTokens(s, offset, end)
    const actualEnd = Math.min(end, total)
    const nextOffset = actualEnd < total ? actualEnd : undefined
    return {
      text: `${sliced}\n[truncated: showing tokens ${offset}–${actualEnd} of ${total}]`,
      truncated: true,
      nextOffset,
    }
  }

  function write(output: Output) {
    if (filterPaths && output.ok && output.data != null)
      output = { ...output, data: Filter.apply(output.data, filterPaths) }
    if (skillsCta) {
      const existing = output.meta.cta
      output = {
        ...output,
        meta: {
          ...output.meta,
          cta: existing
            ? {
                description: existing.description,
                commands: [...existing.commands, ...skillsCta.commands],
              }
            : skillsCta,
        },
      }
    }
    if (tokenCount) {
      const base = output.ok ? output.data : output.error
      const formatted = base != null ? Formatter.format(base, format) : ''
      return writeln(String(estimateTokenCount(formatted)))
    }
    const cta = output.meta.cta
    if (human && !verbose) {
      if (output.ok && output.data != null && renderOutput) {
        const t = truncate(Formatter.format(output.data, format))
        writeln(t.text)
      } else if (!output.ok) writeln(formatHumanError(output.error))
      if (cta) writeln(formatHumanCta(cta))
      return
    }
    if (verbose) {
      if (tokenLimit != null || tokenOffset != null) {
        // Truncate data separately so meta (including nextOffset) is always visible
        const dataFormatted =
          output.ok && output.data != null
            ? Formatter.format(output.data, format)
            : !output.ok
              ? Formatter.format(output.error, format)
              : ''
        const t = truncate(dataFormatted)
        if (t.truncated) {
          const envelope: Record<string, unknown> = output.ok
            ? { ok: true, data: t.text }
            : { ok: false, error: t.text }
          const meta: Record<string, unknown> = { ...output.meta }
          if (t.nextOffset != null) meta.nextOffset = t.nextOffset
          envelope.meta = meta
          return writeln(Formatter.format(envelope, format))
        }
      }
      return writeln(Formatter.format(output, format))
    }
    const base = output.ok ? output.data : output.error
    const formatted = Formatter.format(base, format)
    if (!cta) {
      if (formatted) writeln(truncate(formatted).text)
      return
    }
    const payload =
      typeof base === 'object' && base !== null ? { ...base, cta } : { data: base, cta }
    writeln(truncate(Formatter.format(payload, format)).text)
  }

  if ('error' in effective) {
    const helpCmd = effective.path ? `${name} ${effective.path} --help` : `${name} --help`
    const parent = effective.path ? `${name} ${effective.path}` : name
    const candidates = 'commands' in effective ? [...effective.commands.keys()] : []
    if (!effective.path) for (const b of builtinCommands) candidates.push(b.name)
    const suggestion = suggest(effective.error, candidates)
    const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : ''
    const message = `'${effective.error}' is not a command for '${parent}'.${didYouMean}`
    const ctaCommands: FormattedCta[] = []
    if (suggestion) {
      const corrected = argv.map((t) => (t === effective.error ? suggestion : t))
      ctaCommands.push({ command: `${name} ${corrected.join(' ')}` })
    }
    ctaCommands.push({ command: helpCmd, description: 'see all available commands' })
    const cta: FormattedCtaBlock = {
      description: ctaCommands.length === 1 ? 'Suggested command:' : 'Suggested commands:',
      commands: ctaCommands,
    }
    if (human && !verbose) {
      writeln(formatHumanError({ code: 'COMMAND_NOT_FOUND', message }))
      const mergedCta = skillsCta
        ? { ...cta, commands: [...cta.commands, ...skillsCta.commands] }
        : cta
      writeln(formatHumanCta(mergedCta))
      exit(1)
      return
    }
    write({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND', message },
      meta: {
        command: effective.error,
        cta,
        duration: `${Math.round(performance.now() - start)}ms`,
      },
    })
    exit(1)
    return
  }

  // Fetch gateway execution path
  if ('fetchGateway' in effective) {
    const { fetchGateway, path, rest: fetchRest } = effective
    const fetchMiddleware = [
      ...(options.middlewares ?? []),
      ...((effective as any).middlewares ?? []),
    ]

    const runFetch = async () => {
      const input = Fetch.parseArgv(fetchRest)
      if (fetchGateway.basePath) input.path = fetchGateway.basePath + input.path
      const request = Fetch.buildRequest(input)
      const response = await fetchGateway.fetch(request)

      // Streaming path — NDJSON responses pipe through handleStreaming
      if (Fetch.isStreamingResponse(response)) {
        const generator = Fetch.parseStreamingResponse(response)
        await handleStreaming(generator, {
          name,
          path,
          start,
          format,
          formatExplicit,
          human,
          renderOutput,
          verbose,
          truncate,
          write,
          writeln,
          exit,
        })
        return
      }

      const output = await Fetch.parseResponse(response)

      if (output.ok) {
        write({
          ok: true,
          data: output.data,
          meta: {
            command: path,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
      } else {
        write({
          ok: false,
          error: {
            code: `HTTP_${output.status}`,
            message:
              typeof output.data === 'object' && output.data !== null && 'message' in output.data
                ? String((output.data as any).message)
                : typeof output.data === 'string'
                  ? output.data
                  : `HTTP ${output.status}`,
          },
          meta: {
            command: path,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
        exit(1)
      }
    }

    try {
      const cliEnv = options.envSchema
        ? Parser.parseEnv(options.envSchema, options.env ?? process.env)
        : {}
      if (fetchMiddleware.length > 0) {
        const varsMap: Record<string, unknown> = options.vars ? options.vars.parse({}) : {}
        const errorFn = (opts: {
          code: string
          exitCode?: number | undefined
          message: string
          retryable?: boolean | undefined
          cta?: CtaBlock | undefined
        }): never => ({ [sentinel]: 'error', ...opts }) as never
        const mwCtx: MiddlewareContext = {
          agent: !human,
          command: path,
          displayName,
          env: cliEnv,
          error: errorFn,
          format,
          formatExplicit,
          globals,
          name,
          set(key: string, value: unknown) {
            varsMap[key] = value
          },
          var: varsMap,
          version: options.version,
        }
        const handleMwSentinel = (result: unknown) => {
          if (!isSentinel(result) || result[sentinel] !== 'error') return
          const err = result as ErrorResult
          const cta = formatCtaBlock(displayName, err.cta)
          write({
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              ...(err.retryable !== undefined ? { retryable: err.retryable } : undefined),
            },
            meta: {
              command: path,
              duration: `${Math.round(performance.now() - start)}ms`,
              ...(cta ? { cta } : undefined),
            },
          })
          exit(err.exitCode ?? 1)
        }
        const composed = fetchMiddleware.reduceRight(
          (next: () => Promise<void>, mw) => async () => {
            handleMwSentinel(await mw(mwCtx, next))
          },
          runFetch,
        )
        await composed()
      } else {
        await runFetch()
      }
    } catch (error) {
      write({
        ok: false,
        error: {
          code: error instanceof IncurError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        },
        meta: { command: path, duration: `${Math.round(performance.now() - start)}ms` },
      })
      exit(error instanceof IncurError ? (error.exitCode ?? 1) : 1)
    }
    return
  }

  const { command, path, rest: commandRest } = effective

  // Collect middleware: root CLI + groups traversed + per-command
  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...('middlewares' in resolved
      ? (((resolved as any).middlewares as MiddlewareHandler[]) ?? [])
      : []),
    ...((command.middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  if (human)
    emitDeprecationWarnings(
      commandRest,
      command.options,
      command.alias as Record<string, string> | undefined,
    )

  let defaults: Record<string, unknown> | undefined
  if (configEnabled) {
    try {
      defaults = await loadCommandOptionDefaults(name, path, {
        configDisabled,
        configPath,
        files: options.config?.files,
        loader: options.config?.loader,
      })
    } catch (error) {
      write({
        ok: false,
        error: {
          code: error instanceof IncurError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        },
        meta: { command: path, duration: `${Math.round(performance.now() - start)}ms` },
      })
      exit(error instanceof IncurError ? (error.exitCode ?? 1) : 1)
      return
    }
  }

  const result = await Command.execute(command, {
    agent: !human,
    argv: commandRest,
    defaults,
    displayName,
    env: options.envSchema,
    envSource: options.env,
    format,
    formatExplicit,
    globals,
    inputOptions: {},
    middlewares: allMiddleware,
    name,
    path,
    vars: options.vars,
    version: options.version,
  })

  const duration = `${Math.round(performance.now() - start)}ms`

  // Streaming path — async generator
  if ('stream' in result) {
    await handleStreaming(result.stream, {
      name: displayName,
      path,
      start,
      format,
      formatExplicit,
      human,
      renderOutput,
      verbose,
      truncate,
      write,
      writeln,
      exit,
    })
    return
  }

  if (result.ok) {
    const cta = formatCtaBlock(displayName, result.cta as CtaBlock | undefined)
    write({
      ok: true,
      data: result.data,
      meta: {
        command: path,
        duration,
        ...(cta ? { cta } : undefined),
      },
    })
  } else {
    const cta = formatCtaBlock(displayName, result.cta as CtaBlock | undefined)

    if (human && !formatExplicit && result.error.fieldErrors) {
      writeln(
        formatHumanValidationError(
          displayName,
          path,
          command,
          new ValidationError({
            message: result.error.message,
            fieldErrors: result.error.fieldErrors,
          }),
          options.env,
          configFlag,
        ),
      )
      exit(1)
      return
    }

    write({
      ok: false,
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.retryable !== undefined
          ? { retryable: result.error.retryable }
          : undefined),
        ...(result.error.fieldErrors ? { fieldErrors: result.error.fieldErrors } : undefined),
      },
      meta: {
        command: path,
        duration,
        ...(cta ? { cta } : undefined),
      },
    })
    exit(result.exitCode ?? 1)
  }
}

/** @internal Options for fetchImpl. */
declare namespace fetchImpl {
  type Options = {
    /** CLI-level env schema. */
    envSchema?: z.ZodObject<any> | undefined
    /** Global options schema and alias map. */
    globals?: GlobalsDescriptor | undefined
    /** Group-level middleware collected during command resolution. */
    groupMiddlewares?: MiddlewareHandler[] | undefined
    mcpHandler?:
      | ((
          req: Request,
          commands: Map<string, CommandEntry>,
          mcpOptions?: {
            middlewares?: MiddlewareHandler[] | undefined
            env?: z.ZodObject<any> | undefined
            vars?: z.ZodObject<any> | undefined
          },
        ) => Promise<Response>)
      | undefined
    middlewares?: MiddlewareHandler[] | undefined
    /** CLI name. */
    name?: string | undefined
    rootCommand?: CommandDefinition<any, any, any> | undefined
    vars?: z.ZodObject<any> | undefined
    /** CLI version string. */
    version?: string | undefined
  }
}

/** @internal Creates a lazy MCP HTTP handler scoped to a CLI instance. */
function createMcpHttpHandler(name: string, version: string) {
  let transport: any

  return async (
    req: Request,
    commands: Map<string, CommandEntry>,
    mcpOptions?: {
      middlewares?: MiddlewareHandler[] | undefined
      env?: z.ZodObject<any> | undefined
      vars?: z.ZodObject<any> | undefined
    },
  ): Promise<Response> => {
    if (!transport) {
      const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
      const { WebStandardStreamableHTTPServerTransport } =
        await import('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js')

      const server = new McpServer({ name, version })

      for (const tool of Mcp.collectTools(commands, [])) {
        const mergedShape: Record<string, any> = {
          ...tool.command.args?.shape,
          ...tool.command.options?.shape,
        }
        const hasInput = Object.keys(mergedShape).length > 0

        server.registerTool(
          tool.name,
          {
            ...(tool.description ? { description: tool.description } : undefined),
            ...(hasInput ? { inputSchema: mergedShape } : undefined),
          },
          async (...callArgs: any[]) => {
            const params = hasInput ? (callArgs[0] as Record<string, unknown>) : {}
            return Mcp.callTool(tool, params, {
              name,
              version,
              middlewares: mcpOptions?.middlewares,
              env: mcpOptions?.env,
              vars: mcpOptions?.vars,
            })
          },
        )
      }

      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await server.connect(transport)
    }
    return transport.handleRequest(req)
  }
}

/** @internal Handles an HTTP request by resolving a command and returning a JSON Response. */
async function fetchImpl(
  name: string,
  commands: Map<string, CommandEntry>,
  req: Request,
  options: fetchImpl.Options = {},
): Promise<Response> {
  const start = performance.now()

  const url = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)

  // MCP over HTTP: route /mcp to the MCP transport
  if (segments[0] === 'mcp' && segments.length === 1 && options.mcpHandler)
    return options.mcpHandler(req, commands, {
      middlewares: options.middlewares,
      env: options.envSchema,
      vars: options.vars,
    })

  // .well-known/skills/ — Agent Skills Discovery (RFC)
  if (
    segments[0] === '.well-known' &&
    segments[1] === 'skills' &&
    segments.length >= 3 &&
    req.method === 'GET'
  ) {
    const groups = new Map<string, string>()
    const cmds = collectSkillCommands(commands, [], groups)

    // GET /.well-known/skills/index.json
    if (segments[2] === 'index.json' && segments.length === 3) {
      const files = Skill.split(name, cmds, 1, groups)
      const skills = files.map((f) => {
        const descMatch = f.content.match(/^description:\s*(.+)$/m)
        return {
          name: f.dir || name,
          description: descMatch?.[1] ?? '',
          files: ['SKILL.md'],
        }
      })
      return new Response(JSON.stringify({ skills }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
      })
    }

    // GET /.well-known/skills/{skill-name}/SKILL.md
    if (segments.length === 4 && segments[3] === 'SKILL.md') {
      const skillName = segments[2]!
      const files = Skill.split(name, cmds, 1, groups)
      const file = files.find((f) => (f.dir || name) === skillName)
      if (file)
        return new Response(file.content, {
          status: 200,
          headers: { 'content-type': 'text/markdown', 'cache-control': 'public, max-age=300' },
        })
      return new Response('Not Found', { status: 404 })
    }

    return new Response('Not Found', { status: 404 })
  }

  // Parse options from search params (GET) or body (non-GET)
  let inputOptions: Record<string, unknown> = {}
  if (req.method === 'GET') for (const [key, value] of url.searchParams) inputOptions[key] = value
  else {
    try {
      const contentType = req.headers.get('content-type') ?? ''
      if (contentType.includes('application/json'))
        inputOptions = (await req.json()) as Record<string, unknown>
    } catch {}
  }

  function jsonResponse(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Resolve command from path segments
  if (segments.length === 0) {
    // Root path
    if (options.rootCommand)
      return executeCommand(name, options.rootCommand, [], inputOptions, start, options)
    return jsonResponse(
      {
        ok: false,
        error: { code: 'COMMAND_NOT_FOUND', message: 'No root command defined.' },
        meta: { command: '/', duration: `${Math.round(performance.now() - start)}ms` },
      },
      404,
    )
  }

  const resolved = resolveCommand(commands, segments)

  if ('error' in resolved) {
    const parent = resolved.path ? `${name} ${resolved.path}` : name
    const suggestion = suggest(resolved.error, resolved.commands.keys())
    const didYouMean = suggestion ? ` Did you mean '${suggestion}'?` : ''
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'COMMAND_NOT_FOUND',
          message: `'${resolved.error}' is not a command for '${parent}'.${didYouMean}`,
        },
        meta: { command: resolved.error, duration: `${Math.round(performance.now() - start)}ms` },
      },
      404,
    )
  }

  if ('help' in resolved)
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'COMMAND_NOT_FOUND',
          message: `'${resolved.path}' is a command group. Specify a subcommand.`,
        },
        meta: { command: resolved.path, duration: `${Math.round(performance.now() - start)}ms` },
      },
      404,
    )

  if ('fetchGateway' in resolved) return resolved.fetchGateway.fetch(req)

  const { command, path, rest } = resolved
  const groupMiddlewares = 'middlewares' in resolved ? resolved.middlewares : []
  return executeCommand(path, command, rest, inputOptions, start, {
    ...options,
    groupMiddlewares,
  })
}

/** @internal Executes a resolved command for the fetch handler and returns a JSON Response. */
async function executeCommand(
  path: string,
  command: CommandDefinition<any, any, any>,
  rest: string[],
  inputOptions: Record<string, unknown>,
  start: number,
  options: fetchImpl.Options,
): Promise<Response> {
  function jsonResponse(body: unknown, status: number) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...((options.groupMiddlewares as MiddlewareHandler[] | undefined) ?? []),
    ...((command.middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  const result = await Command.execute(command, {
    agent: true,
    argv: rest,
    env: options.envSchema,
    format: 'json',
    formatExplicit: true,
    inputOptions,
    middlewares: allMiddleware,
    name: options.name ?? path,
    parseMode: 'split',
    path,
    vars: options.vars,
    version: options.version,
  })

  const duration = `${Math.round(performance.now() - start)}ms`

  // Streaming path — async generator → NDJSON response
  if ('stream' in result) {
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder()
        try {
          for await (const value of result.stream) {
            controller.enqueue(
              encoder.encode(JSON.stringify({ type: 'chunk', data: value }) + '\n'),
            )
          }
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: 'done',
                ok: true,
                meta: { command: path },
              }) + '\n',
            ),
          )
        } catch (error) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: 'error',
                ok: false,
                error: {
                  code: 'UNKNOWN',
                  message: error instanceof Error ? error.message : String(error),
                },
              }) + '\n',
            ),
          )
        }
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })
  }

  if (!result.ok) {
    const cta = formatCtaBlock(options.name ?? path, result.cta as CtaBlock | undefined)
    return jsonResponse(
      {
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message,
          ...(result.error.retryable !== undefined
            ? { retryable: result.error.retryable }
            : undefined),
        },
        meta: {
          command: path,
          duration,
          ...(cta ? { cta } : undefined),
        },
      },
      result.error.code === 'VALIDATION_ERROR' ? 400 : 500,
    )
  }

  const cta = formatCtaBlock(options.name ?? path, result.cta as CtaBlock | undefined)
  return jsonResponse(
    {
      ok: true,
      data: result.data,
      meta: {
        command: path,
        duration,
        ...(cta ? { cta } : undefined),
      },
    },
    200,
  )
}

/** @internal Formats a validation error for TTY with usage hint. */
function formatHumanValidationError(
  cli: string,
  path: string,
  command: CommandDefinition<any, any, any>,
  error: ValidationError,
  envSource?: Record<string, string | undefined>,
  configFlag?: string,
): string {
  const lines: string[] = []
  for (const fe of error.fieldErrors) lines.push(`Error: missing required argument <${fe.path}>`)
  lines.push('See below for usage.')
  lines.push('')
  lines.push(
    Help.formatCommand(path === cli ? cli : `${cli} ${path}`, {
      alias: command.alias as Record<string, string> | undefined,
      configFlag,
      description: command.description,
      args: command.args,
      env: command.env,
      envSource,
      hint: command.hint,
      options: command.options,
      examples: formatExamples(command.examples),
      usage: command.usage,
    }),
  )
  return lines.join('\n')
}

/** @internal Resolves a command from the tree by walking tokens until a leaf is found. */
function resolveCommand(
  commands: Map<string, CommandEntry>,
  tokens: string[],
):
  | {
      command: CommandDefinition<any, any, any>
      middlewares: MiddlewareHandler[]
      outputPolicy?: OutputPolicy | undefined
      path: string
      rest: string[]
    }
  | {
      fetchGateway: InternalFetchGateway
      middlewares: MiddlewareHandler[]
      outputPolicy?: OutputPolicy | undefined
      path: string
      rest: string[]
    }
  | {
      help: true
      path: string
      description?: string | undefined
      commands: Map<string, CommandEntry>
    }
  | { error: string; path: string; commands: Map<string, CommandEntry>; rest: string[] } {
  const [first, ...rest] = tokens

  if (!first || !commands.has(first)) return { error: first ?? '(none)', path: '', commands, rest }

  let entry = commands.get(first)!
  const path = [first]
  let remaining = rest
  let inheritedOutputPolicy: OutputPolicy | undefined
  const collectedMiddlewares: MiddlewareHandler[] = []

  // Fetch gateway — all remaining tokens go to the fetch handler
  if (isFetchGateway(entry)) {
    const outputPolicy = entry.outputPolicy ?? inheritedOutputPolicy
    return {
      fetchGateway: entry,
      middlewares: collectedMiddlewares,
      path: path.join(' '),
      rest: remaining,
      ...(outputPolicy ? { outputPolicy } : undefined),
    }
  }

  while (isGroup(entry)) {
    if (entry.outputPolicy) inheritedOutputPolicy = entry.outputPolicy
    if (entry.middlewares) collectedMiddlewares.push(...entry.middlewares)
    const next = remaining[0]
    if (!next)
      return {
        help: true,
        path: path.join(' '),
        description: entry.description,
        commands: entry.commands,
      }

    const child = entry.commands.get(next)
    if (!child) {
      return {
        error: next,
        path: path.join(' '),
        commands: entry.commands,
        rest: remaining.slice(1),
      }
    }

    path.push(next)
    remaining = remaining.slice(1)
    entry = child

    if (isFetchGateway(entry)) {
      const outputPolicy = entry.outputPolicy ?? inheritedOutputPolicy
      return {
        fetchGateway: entry,
        middlewares: collectedMiddlewares,
        path: path.join(' '),
        rest: remaining,
        ...(outputPolicy ? { outputPolicy } : undefined),
      }
    }
  }

  const outputPolicy = entry.outputPolicy ?? inheritedOutputPolicy
  return {
    command: entry,
    middlewares: collectedMiddlewares,
    path: path.join(' '),
    rest: remaining,
    ...(outputPolicy ? { outputPolicy } : undefined),
  }
}

/** @internal Options for serveImpl, extending public serve.Options with internal metadata. */
declare namespace serveImpl {
  type Options = serve.Options & {
    /** Alternative binary names for this CLI. */
    aliases?: string[] | undefined
    config?:
      | {
          flag?: string | undefined
          files?: string[] | undefined
          loader?:
            | ((
                path: string | undefined,
              ) =>
                | Record<string, unknown>
                | undefined
                | Promise<Record<string, unknown> | undefined>)
            | undefined
        }
      | undefined
    description?: string | undefined
    /** CLI-level env schema. Parsed before middleware runs. */
    envSchema?: z.ZodObject<any> | undefined
    /** CLI-level default output format. */
    format?: Formatter.Format | undefined
    /** Global options schema and alias map. */
    globals?: GlobalsDescriptor | undefined
    /** Middleware handlers registered on the root CLI. */
    middlewares?: MiddlewareHandler[] | undefined
    /** CLI-level default output policy. */
    outputPolicy?: OutputPolicy | undefined
    mcp?:
      | {
          agents?: string[] | undefined
          command?: string | undefined
        }
      | undefined
    /** Root command handler, invoked when no subcommand matches. */
    rootCommand?: CommandDefinition<any, any, any> | undefined
    /** Root fetch handler, invoked when no subcommand matches and no rootCommand is set. */
    rootFetch?: FetchHandler | undefined
    sync?:
      | {
          cwd?: string | undefined
          depth?: number | undefined
          include?: string[] | undefined
          suggestions?: string[] | undefined
        }
      | undefined
    /** Zod schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    version?: string | undefined
  }
}

/** @internal Extracts built-in flags (--verbose, --format, --json, --llms, --help, --version) from argv. */
function extractBuiltinFlags(argv: string[], options: extractBuiltinFlags.Options = {}) {
  let verbose = false
  let llms = false
  let llmsFull = false
  let mcp = false
  let help = false
  let version = false
  let schema = false
  let format: Formatter.Format = 'toon'
  let formatExplicit = false
  let configPath: string | undefined
  let configDisabled = false
  let filterOutput: string | undefined
  let tokenLimit: number | undefined
  let tokenOffset: number | undefined
  let tokenCount = false
  const rest: string[] = []

  const cfgFlag = options.configFlag ? `--${options.configFlag}` : undefined
  const cfgFlagEq = options.configFlag ? `--${options.configFlag}=` : undefined
  const noCfgFlag = options.configFlag ? `--no-${options.configFlag}` : undefined

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--verbose') verbose = true
    else if (token === '--llms') llms = true
    else if (token === '--llms-full') llmsFull = true
    else if (token === '--mcp') mcp = true
    else if (token === '--help' || token === '-h') help = true
    else if (token === '--version') version = true
    else if (token === '--schema') schema = true
    else if (token === '--json') {
      format = 'json'
      formatExplicit = true
    } else if (token === '--format' && argv[i + 1]) {
      format = argv[i + 1] as Formatter.Format
      formatExplicit = true
      i++
    } else if (cfgFlag && token === cfgFlag) {
      const value = argv[i + 1]
      if (value === undefined)
        throw new ParseError({ message: `Missing value for flag: ${cfgFlag}` })
      configPath = value
      configDisabled = false
      i++
    } else if (cfgFlagEq && token.startsWith(cfgFlagEq)) {
      const value = token.slice(cfgFlagEq.length)
      if (value.length === 0)
        throw new ParseError({ message: `Missing value for flag: ${cfgFlag}` })
      configPath = value
      configDisabled = false
    } else if (noCfgFlag && token === noCfgFlag) {
      configPath = undefined
      configDisabled = true
    } else if (token === '--filter-output' && argv[i + 1]) {
      filterOutput = argv[i + 1]!
      i++
    } else if (token === '--token-limit' && argv[i + 1]) {
      tokenLimit = Number(argv[i + 1])
      i++
    } else if (token === '--token-offset' && argv[i + 1]) {
      tokenOffset = Number(argv[i + 1])
      i++
    } else if (token === '--token-count') tokenCount = true
    else rest.push(token)
  }

  return {
    verbose,
    format,
    formatExplicit,
    configPath,
    configDisabled,
    filterOutput,
    tokenLimit,
    tokenOffset,
    tokenCount,
    llms,
    llmsFull,
    mcp,
    help,
    version,
    schema,
    rest,
  }
}

declare namespace extractBuiltinFlags {
  type Options = {
    configFlag?: string | undefined
  }
}

/** @internal Loads config-backed option defaults for the active command. */
async function loadCommandOptionDefaults(
  cli: string,
  path: string,
  options: loadCommandOptionDefaults.Options = {},
): Promise<Record<string, unknown> | undefined> {
  if (options.configDisabled) return undefined

  const { loader } = options

  // Resolve the target file path
  let targetPath: string | undefined
  if (options.configPath) {
    targetPath = resolveConfigPath(options.configPath)
  } else {
    const searchPaths = options.files ?? [`${cli}.json`]
    targetPath = await findFirstExisting(searchPaths)
  }

  // Load and parse the config
  let parsed: Record<string, unknown>
  if (loader) {
    const result = await loader(targetPath)
    if (result === undefined) return undefined
    if (!isRecord(result))
      throw new ParseError({ message: 'Config loader must return a plain object or undefined' })
    parsed = result
  } else {
    if (!targetPath) return undefined
    const result = await readJsonConfig(targetPath, !!options.configPath)
    if (!result) return undefined
    parsed = result
  }

  // Extract the command section from the config tree
  return extractCommandSection(parsed, cli, path)
}

declare namespace loadCommandOptionDefaults {
  type Options = {
    configDisabled?: boolean | undefined
    configPath?: string | undefined
    files?: string[] | undefined
    loader?:
      | ((
          path: string | undefined,
        ) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>)
      | undefined
  }
}

/** @internal Resolves a config file path, expanding `~` to home dir. */
function resolveConfigPath(filePath: string): string {
  if (filePath.startsWith('~/') || filePath === '~') {
    return path.join(os.homedir(), filePath.slice(1))
  }
  return path.resolve(process.cwd(), filePath)
}

/** @internal Returns the first readable file from a list of paths, or `undefined`. */
async function findFirstExisting(paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    const resolved = resolveConfigPath(p)
    try {
      await fs.access(resolved, fs.constants.R_OK)
      return resolved
    } catch {}
  }
  return undefined
}

/** @internal Reads and parses a JSON config file. */
async function readJsonConfig(
  targetPath: string,
  explicit: boolean,
): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(targetPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (explicit) throw new ParseError({ message: `Config file not found: ${targetPath}` })
      return undefined
    }
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ParseError({
      message: `Invalid JSON config file: ${targetPath}`,
      cause: error instanceof Error ? error : undefined,
    })
  }

  if (!isRecord(parsed))
    throw new ParseError({
      message: `Invalid config file: expected a top-level object in ${targetPath}`,
    })
  return parsed
}

/** @internal Walks the nested config tree to extract option defaults for a command path. */
function extractCommandSection(
  parsed: Record<string, unknown>,
  cli: string,
  path: string,
): Record<string, unknown> | undefined {
  const segments = path === cli ? [] : path.split(' ')
  let node: unknown = parsed
  for (const seg of segments) {
    if (!isRecord(node)) return undefined
    const commands = node.commands
    if (!isRecord(commands)) return undefined
    node = commands[seg]
    if (node === undefined) return undefined
  }
  if (!isRecord(node))
    throw new ParseError({
      message: `Invalid config section for '${path}': expected an object`,
    })

  const options = node.options
  if (options === undefined) return undefined
  if (!isRecord(options))
    throw new ParseError({
      message: `Invalid config 'options' for '${path}': expected an object`,
    })
  return Object.keys(options).length > 0 ? options : undefined
}

/** @internal Collects immediate child commands/groups for help output. */
function collectHelpCommands(
  commands: Map<string, CommandEntry>,
): { name: string; description?: string | undefined }[] {
  const result: { name: string; description?: string | undefined }[] = []
  for (const [name, entry] of commands) {
    result.push({ name, description: entry.description })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** @internal Formats group-level help for a built-in command (e.g. `cli skills`). */
function formatBuiltinHelp(cli: string, builtin: (typeof builtinCommands)[number]): string {
  return Help.formatRoot(`${cli} ${builtin.name}`, {
    description: builtin.description,
    commands: builtin.subcommands?.map((s) => ({ name: s.name, description: s.description })),
  })
}

/** @internal Formats subcommand-level help for a built-in command (e.g. `cli skills add --help`). */
function formatBuiltinSubcommandHelp(
  cli: string,
  builtin: (typeof builtinCommands)[number],
  subName: string,
): string {
  const sub = builtin.subcommands?.find((s) => s.name === subName)
  return Help.formatCommand(`${cli} ${builtin.name} ${subName}`, {
    alias: sub?.alias,
    description: sub?.description,
    hideGlobalOptions: true,
    options: sub?.options,
  })
}

/** @internal Formats help text for a fetch gateway command. */
function formatFetchHelp(name: string, description?: string): string {
  const lines: string[] = []
  if (description) lines.push(`${name} — ${description}`)
  else lines.push(name)
  lines.push('')
  lines.push(`Usage: ${name} <path> [options]`)
  lines.push('')
  lines.push('Path segments are joined into the request URL path.')
  lines.push('')
  lines.push('Options:')
  lines.push('  -X, --method <METHOD>     HTTP method (default: GET, POST if body present)')
  lines.push('  -H, --header "Key: Val"   Set a request header (repeatable)')
  lines.push('  -d, --data <json>          Request body (implies POST)')
  lines.push('      --body <json>          Request body (implies POST)')
  lines.push('  --<key> <value>            Query string parameter')
  return lines.join('\n')
}

/** Shape of the commands map accumulated through `.command()` chains. */
export type CommandsMap = Record<
  string,
  { args: Record<string, unknown>; options: Record<string, unknown> }
>

/** @internal Entry stored in a command map — either a leaf definition, a group, or a fetch gateway. */
type CommandEntry = CommandDefinition<any, any, any> | InternalGroup | InternalFetchGateway

/** Controls when output data is displayed. `'all'` displays to both humans and agents. `'agent-only'` suppresses data output in human/TTY mode. */
export type OutputPolicy = 'agent-only' | 'all'

/** A standard Fetch API handler. */
type FetchHandler = (req: Request) => Response | Promise<Response>

/** @internal A command group's internal storage. */
type InternalGroup = {
  _group: true
  description?: string | undefined
  middlewares?: MiddlewareHandler[] | undefined
  outputPolicy?: OutputPolicy | undefined
  commands: Map<string, CommandEntry>
}

/** @internal A fetch gateway entry. */
type InternalFetchGateway = {
  _fetch: true
  basePath?: string | undefined
  description?: string | undefined
  fetch: FetchHandler
  outputPolicy?: OutputPolicy | undefined
}

/** @internal Type guard for command groups. */
function isGroup(entry: CommandEntry): entry is InternalGroup {
  return '_group' in entry
}

/** @internal Type guard for fetch gateways. */
function isFetchGateway(entry: CommandEntry): entry is InternalFetchGateway {
  return '_fetch' in entry
}

/** @internal Maps CLI instances to their command maps. */
export const toCommands = new WeakMap<Cli, Map<string, CommandEntry>>()

/** @internal Maps CLI instances to their middleware arrays. */
const toMiddlewares = new WeakMap<Cli, MiddlewareHandler[]>()

/** @internal Maps root CLI instances to their command definitions. */
export const toRootDefinition = new WeakMap<Root, CommandDefinition<any, any, any>>()

/** @internal Maps CLI instances to their root options schema. */
export const toRootOptions = new WeakMap<Cli, z.ZodObject<any>>()

/** @internal Maps CLI instances to whether config file loading is enabled. */
export const toConfigEnabled = new WeakMap<Cli, boolean>()

/** @internal Maps CLI instances to their output policy. */
const toOutputPolicy = new WeakMap<Cli, OutputPolicy>()

/** Descriptor for a CLI's custom global options schema and aliases. */
export type GlobalsDescriptor = { schema: z.ZodObject<any>; alias?: Record<string, string> | undefined }

/** @internal Maps CLI instances to their globals schema and alias map. */
const toGlobals = new WeakMap<Cli, GlobalsDescriptor>()

/** @internal Sentinel symbol for `ok()` and `error()` return values. */
const sentinel = Symbol.for('incur.sentinel')

/** @internal A tagged ok result returned by the `ok` context helper. */
type OkResult = {
  [sentinel]: 'ok'
  data: unknown
  cta?: CtaBlock | undefined
}

/** @internal A tagged error result returned by the `error` context helper. */
type ErrorResult = {
  [sentinel]: 'error'
  code: string
  message: string
  retryable?: boolean | undefined
  exitCode?: number | undefined
  cta?: CtaBlock | undefined
}

/** @internal A CTA block with a description and list of suggested commands. */
type CtaBlock<commands extends CommandsMap = Commands> = {
  /** Commands to suggest. */
  commands: Cta<commands>[]
  /** Human-readable label. Defaults to `"Suggested command:"` or `"Suggested commands:"` based on count. */
  description?: string | undefined
}

/** @internal Formats an error for human-readable TTY output. */
function formatHumanError(error: {
  code: string
  message: string
  fieldErrors?: FieldError[] | undefined
}): string {
  const prefix =
    error.code === 'UNKNOWN' || error.code === 'COMMAND_NOT_FOUND'
      ? 'Error'
      : `Error (${error.code})`
  let out = `${prefix}: ${error.message}`
  if (error.fieldErrors) for (const fe of error.fieldErrors) out += `\n  ${fe.path}: ${fe.message}`
  return out
}

/** @internal Formats a CTA block for human-readable TTY output. */
function formatHumanCta(cta: FormattedCtaBlock): string {
  const lines: string[] = ['', cta.description]
  const maxLen = Math.max(...cta.commands.map((c) => c.command.length))
  for (const c of cta.commands) {
    const desc = c.description ? `  ${''.padEnd(maxLen - c.command.length)}# ${c.description}` : ''
    lines.push(`  ${c.command}${desc}`)
  }
  return lines.join('\n')
}

/** @internal Type guard for sentinel results. */
function hasRequiredArgs(args: z.ZodObject<z.ZodRawShape>): boolean {
  return Object.values(args.shape).some((field) => field._zod.optout !== 'optional')
}

function isSentinel(value: unknown): value is OkResult | ErrorResult {
  return typeof value === 'object' && value !== null && sentinel in value
}

/** @internal Handles streaming output from an async generator `run` handler. */
async function handleStreaming(
  generator: AsyncGenerator<unknown, unknown, unknown>,
  ctx: {
    name: string
    path: string
    start: number
    format: Formatter.Format
    formatExplicit: boolean
    human: boolean
    renderOutput: boolean
    verbose: boolean
    truncate: (s: string) => { text: string; truncated: boolean; nextOffset?: number | undefined }
    write: (output: Output) => void
    writeln: (s: string) => void
    exit: (code: number) => void
  },
) {
  // Incremental: no explicit format (default toon), or explicit jsonl
  // Buffered: explicit json/yaml/toon/md
  const useJsonl = ctx.format === 'jsonl'
  const incremental = useJsonl || (!ctx.formatExplicit && ctx.format === 'toon')

  if (incremental) {
    // Incremental output: write each chunk as it arrives
    try {
      let returnValue: unknown
      while (true) {
        const { value, done } = await generator.next()
        if (done) {
          returnValue = value
          break
        }
        if (isSentinel(value)) {
          const tagged = value as any
          if (tagged[sentinel] === 'error') {
            if (useJsonl)
              ctx.writeln(
                JSON.stringify({
                  type: 'error',
                  ok: false,
                  error: {
                    code: tagged.code,
                    message: tagged.message,
                    ...(tagged.retryable !== undefined
                      ? { retryable: tagged.retryable }
                      : undefined),
                  },
                }),
              )
            else ctx.writeln(formatHumanError({ code: tagged.code, message: tagged.message }))
            ctx.exit(tagged.exitCode ?? 1)
            return
          }
        }
        if (useJsonl) ctx.writeln(JSON.stringify({ type: 'chunk', data: value }))
        else if (ctx.renderOutput)
          ctx.writeln(ctx.truncate(Formatter.format(value, ctx.format)).text)
      }

      // Handle return value — error() or ok() sentinel
      if (isSentinel(returnValue) && returnValue[sentinel] === 'error') {
        const err = returnValue as ErrorResult
        if (useJsonl)
          ctx.writeln(
            JSON.stringify({
              type: 'error',
              ok: false,
              error: {
                code: err.code,
                message: err.message,
                ...(err.retryable !== undefined ? { retryable: err.retryable } : undefined),
              },
            }),
          )
        else ctx.writeln(formatHumanError({ code: err.code, message: err.message }))
        ctx.exit(err.exitCode ?? 1)
        return
      }

      const cta =
        isSentinel(returnValue) && returnValue[sentinel] === 'ok'
          ? formatCtaBlock(ctx.name, (returnValue as OkResult).cta)
          : undefined

      if (useJsonl)
        ctx.writeln(
          JSON.stringify({
            type: 'done',
            ok: true,
            meta: {
              command: ctx.path,
              duration: `${Math.round(performance.now() - ctx.start)}ms`,
              ...(cta ? { cta } : undefined),
            },
          }),
        )
      else if (cta) ctx.writeln(formatHumanCta(cta))
    } catch (error) {
      if (useJsonl)
        ctx.writeln(
          JSON.stringify({
            type: 'error',
            ok: false,
            error: {
              code: error instanceof IncurError ? error.code : 'UNKNOWN',
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        )
      else
        ctx.writeln(
          formatHumanError({
            code: 'UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
          }),
        )
      ctx.exit(error instanceof IncurError ? (error.exitCode ?? 1) : 1)
    }
  } else {
    // Buffered output: collect all chunks, write as single value
    const chunks: unknown[] = []
    try {
      let returnValue: unknown
      while (true) {
        const { value, done } = await generator.next()
        if (done) {
          returnValue = value
          break
        }
        if (isSentinel(value)) {
          const tagged = value as any
          if (tagged[sentinel] === 'error') {
            ctx.write({
              ok: false,
              error: {
                code: tagged.code,
                message: tagged.message,
                ...(tagged.retryable !== undefined ? { retryable: tagged.retryable } : undefined),
              },
              meta: {
                command: ctx.path,
                duration: `${Math.round(performance.now() - ctx.start)}ms`,
              },
            })
            ctx.exit(tagged.exitCode ?? 1)
            return
          }
        }
        chunks.push(value)
      }

      if (isSentinel(returnValue) && returnValue[sentinel] === 'error') {
        const err = returnValue as ErrorResult
        ctx.write({
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            ...(err.retryable !== undefined ? { retryable: err.retryable } : undefined),
          },
          meta: {
            command: ctx.path,
            duration: `${Math.round(performance.now() - ctx.start)}ms`,
          },
        })
        ctx.exit(err.exitCode ?? 1)
        return
      }

      const cta =
        isSentinel(returnValue) && returnValue[sentinel] === 'ok'
          ? formatCtaBlock(ctx.name, (returnValue as OkResult).cta)
          : undefined

      ctx.write({
        ok: true,
        data: chunks,
        meta: {
          command: ctx.path,
          duration: `${Math.round(performance.now() - ctx.start)}ms`,
          ...(cta ? { cta } : undefined),
        },
      })
    } catch (error) {
      ctx.write({
        ok: false,
        error: {
          code: error instanceof IncurError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        },
        meta: {
          command: ctx.path,
          duration: `${Math.round(performance.now() - ctx.start)}ms`,
        },
      })
      ctx.exit(error instanceof IncurError ? (error.exitCode ?? 1) : 1)
    }
  }
}

/** @internal Formats a CTA block into the output envelope shape. */
function formatCtaBlock(name: string, block: CtaBlock | undefined): FormattedCtaBlock | undefined {
  if (!block || block.commands.length === 0) return undefined
  return {
    description:
      block.description ??
      (block.commands.length === 1 ? 'Suggested command:' : 'Suggested commands:'),
    commands: block.commands.map((c) => formatCta(name, c)),
  }
}

/** @internal Formats a CTA by prefixing the CLI name. Handles string and object forms. */
function formatCta(name: string, cta: Cta): FormattedCta {
  if (typeof cta === 'string') return { command: `${name} ${cta}` }
  const prefix = cta.command === name || cta.command.startsWith(`${name} `) ? '' : `${name} `
  let cmd = `${prefix}${cta.command}`
  if (cta.args)
    for (const [key, value] of Object.entries(cta.args))
      cmd += value === true ? ` <${key}>` : ` ${value}`
  if (cta.options)
    for (const [key, value] of Object.entries(cta.options))
      cmd += value === true ? ` --${key} <${key}>` : ` --${key} ${value}`
  return { command: cmd, ...(cta.description ? { description: cta.description } : undefined) }
}

/** @internal Builds the `--llms` index manifest (name + description only) from the command tree. */
function buildIndexManifest(
  commands: Map<string, CommandEntry>,
  prefix: string[] = [],
  globalsSchema?: z.ZodObject<any>,
) {
  return {
    version: 'incur.v1',
    commands: collectIndexCommands(commands, prefix).sort((a, b) => a.name.localeCompare(b.name)),
    ...(globalsSchema ? { globals: Schema.toJsonSchema(globalsSchema) } : undefined),
  }
}

/** @internal Recursively collects leaf commands with name + description only. */
function collectIndexCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
): { name: string; description?: string | undefined }[] {
  const result: { name: string; description?: string | undefined }[] = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if (isGroup(entry)) {
      result.push(...collectIndexCommands(entry.commands, path))
    } else {
      const cmd: (typeof result)[number] = { name: path.join(' ') }
      if (isFetchGateway(entry)) {
        if (entry.description) cmd.description = entry.description
      } else if (entry.description) cmd.description = entry.description
      result.push(cmd)
    }
  }
  return result
}

/** @internal Builds the `--llms` manifest from the command tree. */
function buildManifest(
  commands: Map<string, CommandEntry>,
  prefix: string[] = [],
  globalsSchema?: z.ZodObject<any>,
) {
  return {
    version: 'incur.v1',
    commands: collectCommands(commands, prefix).sort((a, b) => a.name.localeCompare(b.name)),
    ...(globalsSchema ? { globals: Schema.toJsonSchema(globalsSchema) } : undefined),
  }
}

/** @internal Recursively collects leaf commands with their full paths. */
function collectCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
): {
  name: string
  description?: string | undefined
  schema?: Record<string, unknown> | undefined
  examples?: { command: string; description?: string | undefined }[] | undefined
}[] {
  const result: ReturnType<typeof collectCommands> = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if (isFetchGateway(entry)) {
      const cmd: (typeof result)[number] = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description
      result.push(cmd)
    } else if (isGroup(entry)) {
      result.push(...collectCommands(entry.commands, path))
    } else {
      const cmd: (typeof result)[number] = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description

      const inputSchema = buildInputSchema(entry.args, entry.env, entry.options)
      const outputSchema = entry.output ? Schema.toJsonSchema(entry.output) : undefined
      if (inputSchema || outputSchema) {
        cmd.schema = {}
        if (inputSchema?.args) cmd.schema.args = inputSchema.args
        if (inputSchema?.env) cmd.schema.env = inputSchema.env
        if (inputSchema?.options) cmd.schema.options = inputSchema.options
        if (outputSchema) cmd.schema.output = outputSchema
      }

      const examples = formatExamples(entry.examples)
      if (examples) {
        const cmdName = path.join(' ')
        cmd.examples = examples.map((e) => ({
          ...e,
          command: e.command ? `${cmdName} ${e.command}` : cmdName,
        }))
      }
      result.push(cmd)
    }
  }
  return result
}

/** @internal Recursively collects leaf commands as `Skill.CommandInfo` for `--llms --format md`. */
function collectSkillCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
  groups: Map<string, string>,
): Skill.CommandInfo[] {
  const result: Skill.CommandInfo[] = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if (isFetchGateway(entry)) {
      const cmd: Skill.CommandInfo = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description
      cmd.hint = 'Fetch gateway. Pass path segments and curl-style flags (-X, -H, -d, --key value).'
      result.push(cmd)
    } else if (isGroup(entry)) {
      if (entry.description) groups.set(path.join(' '), entry.description)
      result.push(...collectSkillCommands(entry.commands, path, groups))
    } else {
      const cmd: Skill.CommandInfo = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description
      if (entry.args) cmd.args = entry.args
      if (entry.env) cmd.env = entry.env
      if (entry.hint) cmd.hint = entry.hint
      if (entry.options) cmd.options = entry.options
      if (entry.output) cmd.output = entry.output
      const examples = formatExamples(entry.examples)
      if (examples) {
        const cmdName = path.join(' ')
        cmd.examples = examples.map((e) => ({
          ...e,
          command: e.command ? `${cmdName} ${e.command}` : cmdName,
        }))
      }
      result.push(cmd)
    }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** @internal Formats examples into `{ command, description }` objects. `command` is the args/options suffix only. */
export function formatExamples(
  examples: Example<any, any>[] | undefined,
): { command: string; description?: string }[] | undefined {
  if (!examples || examples.length === 0) return undefined
  return examples.map((ex) => {
    const parts: string[] = []
    if (ex.args) for (const value of Object.values(ex.args)) parts.push(String(value))
    if (ex.options)
      for (const [key, value] of Object.entries(ex.options)) parts.push(`--${key} ${value}`)
    const result: { command: string; description?: string } = { command: parts.join(' ') }
    if (ex.description) result.description = ex.description
    return result
  })
}

/** @internal Builds separate args, env, and options JSON Schemas. */
function buildInputSchema(
  args: z.ZodObject<any> | undefined,
  env: z.ZodObject<any> | undefined,
  options: z.ZodObject<any> | undefined,
):
  | {
      args?: Record<string, unknown> | undefined
      env?: Record<string, unknown> | undefined
      options?: Record<string, unknown> | undefined
    }
  | undefined {
  if (!args && !env && !options) return undefined
  const result: {
    args?: Record<string, unknown> | undefined
    env?: Record<string, unknown> | undefined
    options?: Record<string, unknown> | undefined
  } = {}
  if (args) result.args = Schema.toJsonSchema(args)
  if (env) result.env = Schema.toJsonSchema(env)
  if (options) result.options = Schema.toJsonSchema(options)
  return result
}

/** @internal A usage example for a command, typed against its args and options schemas. */
type Example<
  args extends z.ZodObject<any> | undefined,
  options extends z.ZodObject<any> | undefined,
> = {
  /** Positional arguments for this example. */
  args?: args extends z.ZodObject<any> ? Partial<z.output<args>> | undefined : undefined
  /** A short description of what this example demonstrates. */
  description?: string | undefined
  /** Named options for this example. */
  options?: options extends z.ZodObject<any> ? Partial<z.output<options>> | undefined : undefined
}

/** @internal A usage pattern shown in help output. */
type Usage<
  args extends z.ZodObject<any> | undefined,
  options extends z.ZodObject<any> | undefined,
> = {
  /** Positional arguments to include. Use `true` to show as `<name>`. */
  args?: args extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<args>, true>> | undefined
    : undefined
  /** Named options to include. Use `true` to show as `--name <name>`. */
  options?: options extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<options>, true>> | undefined
    : undefined
  /** Text prepended before the command (e.g. `"cat file.txt |"`). */
  prefix?: string | undefined
  /** Text appended after the command (e.g. `"| head"`). */
  suffix?: string | undefined
}

/** @internal Inferred output type of a Zod schema, or `{}` when the schema is not provided. */
type InferOutput<schema extends z.ZodObject<any> | undefined> =
  schema extends z.ZodObject<any> ? z.output<schema> : {}

/** @internal Inferred return type for a command handler. */
type InferReturn<output extends z.ZodType | undefined> = output extends z.ZodType
  ? z.output<output>
  : unknown

/** @internal Inferred vars type from a Zod schema, or `{}` when no schema is provided. */
type InferVars<vars extends z.ZodObject<any> | undefined> =
  vars extends z.ZodObject<any> ? z.output<vars> : {}

/** @internal The output envelope written to stdout. */
type Output = OneOf<
  | {
      /** The command's return data. */
      data: unknown
      /** Request metadata. */
      meta: Output.Meta
      /** Whether the command succeeded. */
      ok: true
    }
  | {
      /** Error details. */
      error: {
        /** Machine-readable error code. */
        code: string
        /** Per-field validation errors. */
        fieldErrors?: FieldError[] | undefined
        /** Human-readable error message. */
        message: string
        /** Whether the operation can be retried. */
        retryable?: boolean | undefined
      }
      /** Request metadata. */
      meta: Output.Meta
      /** Whether the command succeeded. */
      ok: false
    }
>

/** @internal */
declare namespace Output {
  /** Shared metadata included in every envelope. */
  type Meta = {
    /** The command that was invoked. */
    command: string
    /** Suggested next commands. */
    cta?: FormattedCtaBlock | undefined
    /** Wall-clock duration of the command. */
    duration: string
    /** Offset to pass as `--token-offset` to fetch the next page of truncated output. */
    nextOffset?: number | undefined
  }
}

/** @internal Defines a command's schema, handler, and metadata. */
type CommandDefinition<
  args extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
  options extends z.ZodObject<any> | undefined = undefined,
  output extends z.ZodType | undefined = undefined,
  vars extends z.ZodObject<any> | undefined = undefined,
  cliEnv extends z.ZodObject<any> | undefined = undefined,
> = CommandMeta<options> & {
  /** Zod schema for positional arguments. */
  args?: args | undefined
  /** Zod schema for environment variables. Keys are the variable names (e.g. `NPM_TOKEN`). */
  env?: env | undefined
  /** Usage examples for this command. */
  examples?: Example<args, options>[] | undefined
  /** Default output format. Overridden by `--format` or `--json`. */
  format?: Formatter.Format | undefined
  /** Plain text hint displayed after examples and before global options. */
  hint?: string | undefined
  /** Zod schema for the command's return value. */
  output?: output | undefined
  /**
   * Controls when output data is displayed. Inherited by child commands when set on a group.
   *
   * - `'all'` — displays to both humans and agents.
   * - `'agent-only'` — suppresses data output in human/TTY mode while still returning it to agents.
   *
   * @default 'all'
   */
  outputPolicy?: OutputPolicy | undefined
  /** Middleware that runs only for this command, after root and group middleware. */
  middleware?: MiddlewareHandler<vars, cliEnv>[] | undefined
  /** Alternative usage patterns shown in help output. */
  usage?: Usage<args, options>[] | undefined
  /** The command handler. Return a value for single-return, or use `async *run` to stream chunks. */
  run(context: {
    /** Whether the consumer is an agent (stdout is not a TTY). */
    agent: boolean
    /** Positional arguments. */
    args: InferOutput<args>
    /** The binary name the user invoked (e.g. an alias). Falls back to `name` when not resolvable. */
    displayName: string
    /** Parsed environment variables. */
    env: InferOutput<env>
    /** Return an error result with optional CTAs. */
    error: (options: {
      code: string
      cta?: CtaBlock | undefined
      exitCode?: number | undefined
      message: string
      retryable?: boolean | undefined
    }) => never
    /** The resolved output format (e.g. `'toon'`, `'json'`, `'jsonl'`). */
    format: Formatter.Format
    /** Whether the user explicitly passed `--format` or `--json`. */
    formatExplicit: boolean
    /** The CLI name. */
    name: string
    /** Return a success result with optional metadata (e.g. CTAs). */
    ok: (data: InferReturn<output>, meta?: { cta?: CtaBlock | undefined }) => never
    options: InferOutput<options>
    /** Variables set by middleware. */
    var: InferVars<vars>
    /** The CLI version string. */
    version: string | undefined
  }):
    | InferReturn<output>
    | Promise<InferReturn<output>>
    | AsyncGenerator<InferReturn<output>, unknown, unknown>
}

/** @internal A formatted CTA block as it appears in the output envelope. */
type FormattedCtaBlock = {
  /** Formatted command suggestions. */
  commands: FormattedCta[]
  /** Human-readable label for the CTA block. */
  description: string
}

/** @internal A formatted CTA as it appears in the output envelope. */
type FormattedCta = {
  /** The full command string with args and options folded in. */
  command: string
  /** A short description of what the command does. */
  description?: string | undefined
}

/** @internal Scans argv for deprecated flags and writes warnings to stderr. */
function emitDeprecationWarnings(
  argv: string[],
  optionsSchema: z.ZodObject<any> | undefined,
  alias?: Record<string, string> | undefined,
) {
  if (!optionsSchema) return
  const shape = optionsSchema.shape as Record<string, any>
  const deprecatedFlags = new Set<string>()
  const deprecatedShorts = new Map<string, string>()
  for (const key of Object.keys(shape)) {
    const meta = shape[key]?.meta?.()
    if (meta?.deprecated) {
      const kebab = key.replace(/[A-Z]/g, (c: string) => `-${c.toLowerCase()}`)
      deprecatedFlags.add(kebab)
      if (alias?.[key]) deprecatedShorts.set(alias[key]!, kebab)
    }
  }
  if (deprecatedFlags.size === 0) return
  for (const token of argv) {
    if (token.startsWith('--')) {
      const stripped = token.split('=')[0]!.slice(2)
      const raw =
        !deprecatedFlags.has(stripped) && stripped.startsWith('no-') ? stripped.slice(3) : stripped
      if (deprecatedFlags.has(raw)) process.stderr.write(`Warning: --${raw} is deprecated\n`)
    } else if (token.startsWith('-') && token.length >= 2) {
      for (const ch of token.slice(1))
        if (deprecatedShorts.has(ch))
          process.stderr.write(`Warning: --${deprecatedShorts.get(ch)} is deprecated\n`)
    }
  }
}

/** @internal Resolves the display name from `process.argv[1]` basename. Returns the basename if it matches `name` or one of the `aliases`, otherwise falls back to `name`. */
function resolveDisplayName(name: string, aliases?: string[]): string {
  const bin = process.argv[1]
  if (!bin) return name
  const basename = path.basename(bin)
  if (basename === name) return name
  if (aliases?.includes(basename)) return basename
  return name
}
