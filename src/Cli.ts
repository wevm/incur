import type { z } from 'zod'

import type { FieldError } from './Errors.js'
import { IncurError, ValidationError } from './Errors.js'
import * as Formatter from './Formatter.js'
import * as Help from './Help.js'
import { detectRunner } from './internal/pm.js'
import type { OneOf } from './internal/types.js'
import * as Mcp from './Mcp.js'
import * as Parser from './Parser.js'
import type { Register } from './Register.js'
import * as Schema from './Schema.js'
import * as Skill from './Skill.js'
import * as SyncMcp from './SyncMcp.js'
import * as SyncSkills from './SyncSkills.js'

/** A CLI application instance. Also used as a command group when mounted on a parent CLI. */
export type Cli<commands extends CommandsMap = {}> = {
  /** Registers a root command or mounts a sub-CLI as a command group. */
  command: {
    /** Registers a command. Returns the CLI instance for chaining. */
    <
      const name extends string,
      const args extends z.ZodObject<any> | undefined = undefined,
      const env extends z.ZodObject<any> | undefined = undefined,
      const options extends z.ZodObject<any> | undefined = undefined,
      const output extends z.ZodType | undefined = undefined,
    >(
      name: name,
      definition: CommandDefinition<args, env, options, output>,
    ): Cli<commands & { [key in name]: { args: InferOutput<args>; options: InferOutput<options> } }>
    /** Mounts a sub-CLI as a command group. */
    <const name extends string, const sub extends CommandsMap>(
      cli: Cli<sub> & { name: name },
    ): Cli<commands & { [key in keyof sub & string as `${name} ${key}`]: sub[key] }>
    /** Mounts a root CLI as a single command. */
    <
      const name extends string,
      const args extends z.ZodObject<any> | undefined,
      const opts extends z.ZodObject<any> | undefined,
    >(
      cli: Root<args, opts> & { name: name },
    ): Cli<commands & { [key in name]: { args: InferOutput<args>; options: InferOutput<opts> } }>
  }
  /** A short description of the CLI. */
  description?: string | undefined
  /** The name of the CLI application. */
  name: string
  /** Parses argv, runs the matched command, and writes the output envelope to stdout. */
  serve(argv?: string[], options?: serve.Options): Promise<void>
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

/** Creates a leaf CLI with a root handler and no subcommands. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
>(
  name: string,
  definition: create.Options<args, env, opts, output> & { run: Function },
): Root<args, opts>
/** Creates a router CLI that registers subcommands. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
>(name: string, definition?: create.Options<args, env, opts, output>): Cli
/** Creates a leaf CLI from a single options object (e.g. package.json). */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
>(
  definition: create.Options<args, env, opts, output> & { name: string; run: Function },
): Root<args, opts>
/** Creates a router CLI from a single options object (e.g. package.json). */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodType | undefined = undefined,
>(definition: create.Options<args, env, opts, output> & { name: string }): Cli
export function create(
  nameOrDefinition: string | (any & { name: string }),
  definition?: any,
): Cli | Root {
  const name = typeof nameOrDefinition === 'string' ? nameOrDefinition : nameOrDefinition.name
  const def = typeof nameOrDefinition === 'string' ? (definition ?? {}) : nameOrDefinition
  if ('run' in def) {
    const rootDef = def as CommandDefinition<any, any, any>
    const leafCommands = new Map<string, CommandEntry>()
    leafCommands.set(name, rootDef)

    const leaf: Root = {
      name,
      description: def.description,
      async serve(argv = process.argv.slice(2), options: serve.Options = {}) {
        return serveImpl(name, leafCommands, [name, ...argv], {
          ...options,
          description: def.description,
          format: def.format,
          mcp: def.mcp,
          sync: def.sync,
          version: def.version,
        })
      },
    }
    toRootDefinition.set(leaf, rootDef)
    toCommands.set(leaf as unknown as Cli, leafCommands)
    return leaf
  }

  const commands = new Map<string, CommandEntry>()

  const cli: Cli = {
    name,
    description: def.description,

    command(nameOrCli: any, def?: any): any {
      if (typeof nameOrCli === 'string') {
        commands.set(nameOrCli, def)
        return cli
      }
      const rootDef = toRootDefinition.get(nameOrCli)
      if (rootDef) {
        commands.set(nameOrCli.name, rootDef)
        return cli
      }
      const sub = nameOrCli as Cli
      const subCommands = toCommands.get(sub)!
      commands.set(sub.name, { _group: true, description: sub.description, commands: subCommands })
      return cli
    },

    async serve(argv = process.argv.slice(2), serveOptions: serve.Options = {}) {
      return serveImpl(name, commands, argv, {
        ...serveOptions,
        description: def.description,
        format: def.format,
        mcp: def.mcp,
        sync: def.sync,
        version: def.version,
      })
    },
  }

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
  > = {
    /** Map of option names to single-char aliases. */
    alias?: options extends z.ZodObject<any>
      ? Partial<Record<keyof z.output<options>, string>>
      : Record<string, string> | undefined
    /** Zod schema for positional arguments. */
    args?: args | undefined
    /** A short description of what the CLI does. */
    description?: string | undefined
    /** Zod schema for environment variables. Keys are the variable names (e.g. `NPM_TOKEN`). */
    env?: env | undefined
    /** Usage examples for this command. */
    examples?: Example<args, options>[] | undefined
    /** Default output format. Overridden by `--format` or `--json`. */
    format?: Formatter.Format | undefined
    /** Zod schema for named options/flags. */
    options?: options | undefined
    /** Zod schema for the return value. */
    output?: output | undefined
    /** Alternative usage patterns shown in help output. */
    usage?: Usage<args, options>[] | undefined
    /** The root command handler. When provided, creates a leaf CLI with no subcommands. */
    run?:
      | ((context: {
          args: InferOutput<args>
          /** Parsed environment variables. */
          env: InferOutput<env>
          /** Return an error result with optional CTAs. */
          error: (options: {
            code: string
            cta?: CtaBlock | undefined
            message: string
            retryable?: boolean | undefined
          }) => never
          /** Return a success result with optional metadata (e.g. CTAs). */
          ok: (data: InferReturn<output>, meta?: { cta?: CtaBlock | undefined }) => never
          options: InferOutput<options>
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

  const {
    verbose,
    format: formatFlag,
    formatExplicit,
    llms,
    mcp: mcpFlag,
    help,
    version,
    rest: filtered,
  } = extractBuiltinFlags(argv)

  // --mcp: start as MCP stdio server
  if (mcpFlag) {
    await Mcp.serve(name, options.version ?? '0.0.0', commands)
    return
  }

  // Human mode: default unless --verbose or explicit --format/--json override
  const human = !formatExplicit && !verbose

  function writeln(s: string) {
    stdout(s.endsWith('\n') ? s : `${s}\n`)
  }

  // Skills staleness check (skip for built-in commands)
  if (!llms && !help && !version) {
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
          process.stderr.write(
            `⚠ Skills are out of date. Run '${runner} ${spec} skills add' to update.\n\n`,
          )
        }
      }
    }
  }

  if (llms) {
    // Scope to a subtree if command tokens are provided
    let scopedCommands = commands
    const prefix: string[] = []
    for (const token of filtered) {
      const entry = scopedCommands.get(token)
      if (!entry) break
      if (isGroup(entry)) {
        scopedCommands = entry.commands
        prefix.push(token)
      } else {
        // Leaf command — scope to just this command
        scopedCommands = new Map([[token, entry]])
        break
      }
    }

    if (!formatExplicit || formatFlag === 'md') {
      const groups = new Map<string, string>()
      const cmds = collectSkillCommands(scopedCommands, prefix, groups)
      const scopedName = prefix.length > 0 ? `${name} ${prefix.join(' ')}` : name
      writeln(Skill.generate(scopedName, cmds, groups))
      return
    }
    writeln(Formatter.format(buildManifest(scopedCommands, prefix), formatFlag))
    return
  }

  // skills add: generate skill files and install via `<pm>x skills add` (only when sync is configured)
  const skillsIdx =
    filtered[0] === 'skills' ? 0 : filtered[0] === name && filtered[1] === 'skills' ? 1 : -1
  if (skillsIdx !== -1 && filtered[skillsIdx] === 'skills' && filtered[skillsIdx + 1] === 'add') {
    if (help) {
      writeln(
        [
          `${name} skills add — Sync skill files to your agent`,
          '',
          `Usage: ${name} skills add [options]`,
          '',
          'Options:',
          '  --depth <number>  Grouping depth for skill files (default: 1)',
          '  --no-global       Install to project instead of globally',
        ].join('\n'),
      )
      return
    }
    const rest = filtered.slice(skillsIdx + 2)
    const depthArg = rest.indexOf('--depth')
    const depth = depthArg !== -1 ? Number(rest[depthArg + 1]) : (options.sync?.depth ?? 1)
    const global = rest.includes('--no-global') ? false : undefined
    try {
      if (human) stdout('Syncing...')
      const result = await SyncSkills.sync(name, commands, {
        cwd: options.sync?.cwd,
        depth,
        description: options.description,
        global,
        include: options.sync?.include,
      })
      if (human) {
        stdout('\r\x1b[K')
        const lines: string[] = []
        const skillLabel = (s: (typeof result.skills)[number]) =>
          s.external || s.name === name ? s.name : `${name}-${s.name}`
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
      } else
        writeln(Formatter.format({ skills: result.paths }, formatExplicit ? formatFlag : 'toon'))
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
  if (mcpIdx !== -1 && filtered[mcpIdx] === 'mcp' && filtered[mcpIdx + 1] === 'add') {
    if (help) {
      writeln(
        [
          `${name} mcp add — Register as an MCP server for your agent`,
          '',
          `Usage: ${name} mcp add [options]`,
          '',
          'Options:',
          '  -c, --command <cmd>  Override the command agents will run (e.g. "pnpm my-cli --mcp")',
          '  --no-global          Install to project instead of globally',
          '  --agent <agent>      Target a specific agent (e.g. claude-code, cursor)',
        ].join('\n'),
      )
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
      if (human) stdout('Registering MCP server...')
      const result = await SyncMcp.register(name, {
        command,
        global,
        agents,
      })
      if (human) {
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
      } else
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
    writeln(
      Help.formatRoot(name, {
        description: options.description,
        version: options.version,
        commands: collectHelpCommands(commands),
        root: true,
      }),
    )
    return
  }

  const resolved = resolveCommand(commands, filtered)

  // --help after a command → show help for that command
  if (help) {
    if ('help' in resolved || 'error' in resolved) {
      // group or unknown → show root help for that path
      const helpName = 'help' in resolved ? `${name} ${resolved.path}` : name
      const helpDesc = 'help' in resolved ? resolved.description : options.description
      const helpCmds = 'help' in resolved ? resolved.commands : commands
      const isRoot = helpName === name
      writeln(
        Help.formatRoot(helpName, {
          description: helpDesc,
          version: isRoot ? options.version : undefined,
          commands: collectHelpCommands(helpCmds),
          root: isRoot,
        }),
      )
    } else {
      const isRootCmd = resolved.path === name
      const commandName = isRootCmd ? name : `${name} ${resolved.path}`
      writeln(
        Help.formatCommand(commandName, {
          alias: resolved.command.alias as Record<string, string> | undefined,
          description: resolved.command.description,
          version: isRootCmd ? options.version : undefined,
          args: resolved.command.args,
          env: resolved.command.env,
          hint: resolved.command.hint,
          options: resolved.command.options,
          examples: formatExamples(resolved.command.examples),
          usage: resolved.command.usage,
          root: isRootCmd,
        }),
      )
    }
    return
  }

  if ('help' in resolved) {
    writeln(
      Help.formatRoot(`${name} ${resolved.path}`, {
        description: resolved.description,
        commands: collectHelpCommands(resolved.commands),
      }),
    )
    return
  }

  const start = performance.now()

  // Resolve effective format: explicit --format/--json → command default → CLI default → toon
  const resolvedFormat = 'command' in resolved && resolved.command.format
  const format = formatExplicit ? formatFlag : resolvedFormat || options.format || 'toon'

  function write(output: Output) {
    const cta = output.meta.cta
    if (human) {
      if (output.ok && output.data != null) writeln(Formatter.format(output.data, format))
      else if (!output.ok) writeln(formatHumanError(output.error))
      if (cta) writeln(formatHumanCta(cta))
      return
    }
    if (verbose) return writeln(Formatter.format(output, format))
    const base = output.ok ? output.data : output.error
    const formatted = Formatter.format(base, format)
    if (!cta) {
      if (formatted) writeln(formatted)
      return
    }
    const payload =
      typeof base === 'object' && base !== null ? { ...base, cta } : { data: base, cta }
    writeln(Formatter.format(payload, format))
  }

  if ('error' in resolved) {
    const helpCmd = resolved.path ? `${name} ${resolved.path} --help` : `${name} --help`
    const message = `'${resolved.error}' is not a command. See '${helpCmd}' for a list of available commands.`
    if (human) {
      writeln(formatHumanError({ code: 'COMMAND_NOT_FOUND', message }))
      exit(1)
      return
    }
    write({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND', message },
      meta: {
        command: resolved.error,
        duration: `${Math.round(performance.now() - start)}ms`,
      },
    })
    exit(1)
    return
  }

  const { command, path, rest } = resolved

  try {
    const { args, options: parsedOptions } = Parser.parse(rest, {
      alias: command.alias as Record<string, string> | undefined,
      args: command.args,
      options: command.options,
    })

    const envSource = options.env ?? process.env
    const env = command.env ? Parser.parseEnv(command.env, envSource) : {}

    const okFn = (data: unknown, meta: { cta?: CtaBlock | undefined } = {}): never => {
      return { [sentinel]: 'ok', data, cta: meta.cta } as never
    }
    const errorFn = (opts: {
      code: string
      message: string
      retryable?: boolean | undefined
      cta?: CtaBlock | undefined
    }): never => {
      return { [sentinel]: 'error', ...opts } as never
    }

    const result = command.run({
      args,
      env,
      options: parsedOptions,
      ok: okFn,
      error: errorFn,
    })

    // Streaming path — async generator
    if (isAsyncGenerator(result)) {
      await handleStreaming(result, {
        name,
        path,
        start,
        format,
        formatExplicit,
        human,
        verbose,
        write,
        writeln,
        exit,
      })
      return
    }

    const awaited = await result

    if (isSentinel(awaited)) {
      const cta = formatCtaBlock(name, awaited.cta)
      if (awaited[sentinel] === 'ok') {
        write({
          ok: true,
          data: awaited.data,
          meta: {
            command: path,
            duration: `${Math.round(performance.now() - start)}ms`,
            ...(cta ? { cta } : undefined),
          },
        })
      } else {
        write({
          ok: false,
          error: {
            code: awaited.code,
            message: awaited.message,
            ...(awaited.retryable !== undefined ? { retryable: awaited.retryable } : undefined),
          },
          meta: {
            command: path,
            duration: `${Math.round(performance.now() - start)}ms`,
            ...(cta ? { cta } : undefined),
          },
        })
        exit(1)
      }
    } else {
      write({
        ok: true,
        data: awaited,
        meta: {
          command: path,
          duration: `${Math.round(performance.now() - start)}ms`,
        },
      })
    }
  } catch (error) {
    const errorOutput: Output = {
      ok: false,
      error: {
        code:
          error instanceof IncurError
            ? error.code
            : error instanceof ValidationError
              ? 'VALIDATION_ERROR'
              : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof IncurError ? { retryable: error.retryable } : undefined),
        ...(error instanceof ValidationError ? { fieldErrors: error.fieldErrors } : undefined),
      },
      meta: {
        command: path,
        duration: `${Math.round(performance.now() - start)}ms`,
      },
    }

    if (human && error instanceof ValidationError) {
      writeln(formatHumanValidationError(name, path, command, error))
      exit(1)
      return
    }

    write(errorOutput)
    exit(1)
  }
}

/** @internal Formats a validation error for TTY with usage hint. */
function formatHumanValidationError(
  cli: string,
  path: string,
  command: CommandDefinition<any, any, any>,
  error: ValidationError,
): string {
  const lines: string[] = []
  for (const fe of error.fieldErrors) lines.push(`Error: missing required argument <${fe.path}>`)
  lines.push('See below for usage.')
  lines.push('')
  lines.push(
    Help.formatCommand(path === cli ? cli : `${cli} ${path}`, {
      alias: command.alias as Record<string, string> | undefined,
      description: command.description,
      args: command.args,
      env: command.env,
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
  | { command: CommandDefinition<any, any, any>; path: string; rest: string[] }
  | {
      help: true
      path: string
      description?: string | undefined
      commands: Map<string, CommandEntry>
    }
  | { error: string; path: string } {
  const [first, ...rest] = tokens

  if (!first || !commands.has(first)) return { error: first ?? '(none)', path: '' }

  let entry = commands.get(first)!
  const path = [first]
  let remaining = rest

  while (isGroup(entry)) {
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
      return { error: next, path: path.join(' ') }
    }

    path.push(next)
    remaining = remaining.slice(1)
    entry = child
  }

  return { command: entry, path: path.join(' '), rest: remaining }
}

/** @internal Options for serveImpl, extending public serve.Options with internal metadata. */
declare namespace serveImpl {
  type Options = serve.Options & {
    description?: string | undefined
    /** CLI-level default output format. */
    format?: Formatter.Format | undefined
    mcp?:
      | {
          agents?: string[] | undefined
          command?: string | undefined
        }
      | undefined
    sync?:
      | {
          cwd?: string | undefined
          depth?: number | undefined
          include?: string[] | undefined
          suggestions?: string[] | undefined
        }
      | undefined
    version?: string | undefined
  }
}

/** @internal Extracts built-in flags (--verbose, --format, --json, --llms, --help, --version) from argv. */
function extractBuiltinFlags(argv: string[]) {
  let verbose = false
  let llms = false
  let mcp = false
  let help = false
  let version = false
  let format: Formatter.Format = 'toon'
  let formatExplicit = false
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--verbose') verbose = true
    else if (token === '--llms') llms = true
    else if (token === '--mcp') mcp = true
    else if (token === '--help' || token === '-h') help = true
    else if (token === '--version') version = true
    else if (token === '--json') {
      format = 'json'
      formatExplicit = true
    } else if (token === '--format' && argv[i + 1]) {
      format = argv[i + 1] as Formatter.Format
      formatExplicit = true
      i++
    } else rest.push(token)
  }

  return { verbose, format, formatExplicit, llms, mcp, help, version, rest }
}

/** @internal Collects immediate child commands/groups for help output. */
function collectHelpCommands(
  commands: Map<string, CommandEntry>,
): { name: string; description?: string | undefined }[] {
  const result: { name: string; description?: string | undefined }[] = []
  for (const [name, entry] of commands) {
    if (isGroup(entry)) result.push({ name, description: entry.description })
    else result.push({ name, description: entry.description })
  }
  return result.sort((a, b) => a.name.localeCompare(b.name))
}

/** Shape of the commands map accumulated through `.command()` chains. */
export type CommandsMap = Record<
  string,
  { args: Record<string, unknown>; options: Record<string, unknown> }
>

/** @internal Entry stored in a command map — either a leaf definition or a group. */
type CommandEntry = CommandDefinition<any, any, any> | InternalGroup

/** @internal A command group's internal storage. */
type InternalGroup = {
  _group: true
  description?: string | undefined
  commands: Map<string, CommandEntry>
}

/** @internal Type guard for command groups. */
function isGroup(entry: CommandEntry): entry is InternalGroup {
  return '_group' in entry
}

/** @internal Maps CLI instances to their command maps. */
export const toCommands = new WeakMap<Cli, Map<string, CommandEntry>>()

/** @internal Maps root CLI instances to their command definitions. */
const toRootDefinition = new WeakMap<Root, CommandDefinition<any, any, any>>()

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
  cta?: CtaBlock | undefined
}

/** @internal A CTA block with a description and list of suggested commands. */
type CtaBlock<commands extends CommandsMap = Commands> = {
  /** Commands to suggest. */
  commands: Cta<commands>[]
  /** Human-readable label. Defaults to `"Suggested commands:"`. */
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
  for (const c of cta.commands) {
    const desc = c.description ? `  ${c.description}` : ''
    lines.push(`  ${c.command}${desc}`)
  }
  return lines.join('\n')
}

/** @internal Type guard for sentinel results. */
function isSentinel(value: unknown): value is OkResult | ErrorResult {
  return typeof value === 'object' && value !== null && sentinel in value
}

/** @internal Type guard for async generators returned by streaming `run` handlers. */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as any).next === 'function'
  )
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
    verbose: boolean
    write: (output: Output) => void
    writeln: (s: string) => void
    exit: (code: number) => void
  },
) {
  // Incremental: human, no explicit format (default toon), or explicit jsonl
  // Buffered: explicit json/yaml/toon/md
  const useJsonl = !ctx.human && ctx.formatExplicit && ctx.format === 'jsonl'
  const incremental = ctx.human || useJsonl || !ctx.formatExplicit

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
            ctx.exit(1)
            return
          }
        }
        if (useJsonl) ctx.writeln(JSON.stringify({ type: 'chunk', data: value }))
        else ctx.writeln(Formatter.format(value, 'toon'))
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
        ctx.exit(1)
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
      ctx.exit(1)
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
            ctx.exit(1)
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
        ctx.exit(1)
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
      ctx.exit(1)
    }
  }
}

/** @internal Formats a CTA block into the output envelope shape. */
function formatCtaBlock(name: string, block: CtaBlock | undefined): FormattedCtaBlock | undefined {
  if (!block || block.commands.length === 0) return undefined
  return {
    description: block.description ?? 'Suggested commands:',
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

/** @internal Builds the `--llms` manifest from the command tree. */
function buildManifest(commands: Map<string, CommandEntry>, prefix: string[] = []) {
  return {
    version: 'incur.v1',
    commands: collectCommands(commands, prefix).sort((a, b) => a.name.localeCompare(b.name)),
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
    if (isGroup(entry)) {
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
    if (isGroup(entry)) {
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
  }
}

/** @internal Defines a command's schema, handler, and metadata. */
type CommandDefinition<
  args extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
  options extends z.ZodObject<any> | undefined = undefined,
  output extends z.ZodType | undefined = undefined,
> = {
  /** Map of option names to single-char aliases. */
  alias?: options extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<options>, string>>
    : Record<string, string> | undefined
  /** Zod schema for positional arguments. */
  args?: args | undefined
  /** A short description of what the command does. */
  description?: string | undefined
  /** Zod schema for environment variables. Keys are the variable names (e.g. `NPM_TOKEN`). */
  env?: env | undefined
  /** Usage examples for this command. */
  examples?: Example<args, options>[] | undefined
  /** Default output format. Overridden by `--format` or `--json`. */
  format?: Formatter.Format | undefined
  /** Plain text hint displayed after examples and before global options. */
  hint?: string | undefined
  /** Zod schema for named options/flags. */
  options?: options | undefined
  /** Zod schema for the command's return value. */
  output?: output | undefined
  /** Alternative usage patterns shown in help output. */
  usage?: Usage<args, options>[] | undefined
  /** The command handler. Return a value for single-return, or use `async *run` to stream chunks. */
  run(context: {
    args: InferOutput<args>
    /** Parsed environment variables. */
    env: InferOutput<env>
    /** Return an error result with optional CTAs. */
    error: (options: {
      code: string
      cta?: CtaBlock | undefined
      message: string
      retryable?: boolean | undefined
    }) => never
    /** Return a success result with optional metadata (e.g. CTAs). */
    ok: (data: InferReturn<output>, meta?: { cta?: CtaBlock | undefined }) => never
    options: InferOutput<options>
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
