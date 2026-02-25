import { z } from 'zod'
import type { FieldError } from './Errors.js'
import { ClacError, ValidationError } from './Errors.js'
import * as Formatter from './Formatter.js'
import * as Help from './Help.js'
import type { OneOf } from './internal/types.js'
import * as Parser from './Parser.js'
import type { Register } from './Register.js'
import * as Schema from './Schema.js'

/** A CLI application instance. Also used as a command group when mounted on a parent CLI. */
export type Cli<commands extends CommandsMap = {}> = {
  /** Registers a root command or mounts a sub-CLI as a command group. */
  command: {
    /** Registers a command. Returns the CLI instance for chaining. */
    <
      const name extends string,
      const args extends z.ZodObject<any> | undefined = undefined,
      const options extends z.ZodObject<any> | undefined = undefined,
      const output extends z.ZodObject<any> | undefined = undefined,
    >(
      name: name,
      definition: CommandDefinition<args, options, output>,
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

/** CTA type — discriminated union when commands are registered, plain strings otherwise. */
export type Cta<commands extends CommandsMap = Commands> = [keyof commands] extends [never]
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
  : {
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
          | { [key in keyof commands[name]['options']]?: commands[name]['options'][key] | true }
          | undefined
      }
    }[keyof commands & string]

/** Creates a leaf CLI with a root handler and no subcommands. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodObject<any> | undefined = undefined,
>(
  name: string,
  definition: create.Options<args, opts, output> & { run: Function },
): Root<args, opts>
/** Creates a router CLI that registers subcommands. */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodObject<any> | undefined = undefined,
>(name: string, definition?: create.Options<args, opts, output>): Cli
/** Creates a leaf CLI from a single options object (e.g. package.json). */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodObject<any> | undefined = undefined,
>(
  definition: create.Options<args, opts, output> & { name: string; run: Function },
): Root<args, opts>
/** Creates a router CLI from a single options object (e.g. package.json). */
export function create<
  const args extends z.ZodObject<any> | undefined = undefined,
  const opts extends z.ZodObject<any> | undefined = undefined,
  const output extends z.ZodObject<any> | undefined = undefined,
>(definition: create.Options<args, opts, output> & { name: string }): Cli
export function create(nameOrDefinition: string | (any & { name: string }), definition?: any): Cli | Root {
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
          version: def.version,
          description: def.description,
        })
      },
    }
    toRootDefinition.set(leaf, rootDef)
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
    options extends z.ZodObject<any> | undefined = undefined,
    output extends z.ZodObject<any> | undefined = undefined,
  > = {
    /** Map of option names to single-char aliases. */
    alias?: options extends z.ZodObject<any>
      ? Partial<Record<keyof z.output<options>, string>>
      : Record<string, string> | undefined
    /** Zod schema for positional arguments. */
    args?: args
    /** Returns suggested next commands based on the result. */
    cta?: ((result: InferReturn<output>) => Cta[]) | undefined
    /** A short description of what the CLI does. */
    description?: string | undefined
    /** Whether the command may perform destructive operations. */
    destructive?: boolean | undefined
    /** Whether the command can be called multiple times safely. */
    idempotent?: boolean | undefined
    /** Whether the command interacts with external systems. */
    openWorld?: boolean | undefined
    /** Zod schema for named options/flags. */
    options?: options
    /** Zod schema for the return value. */
    output?: output
    /** Whether the command only reads data (no side effects). */
    readOnly?: boolean | undefined
    /** The root command handler. When provided, creates a leaf CLI with no subcommands. */
    run?: (context: {
      args: InferOutput<args>
      options: InferOutput<options>
    }) => InferReturn<output> | Promise<InferReturn<output>>
    /** The CLI version string. */
    version?: string | undefined
  }
}

export declare namespace serve {
  /** Options for `serve()`, primarily used for testing. */
  type Options = {
    /** Override stdout writer. Defaults to `process.stdout.write`. */
    stdout?: ((s: string) => void) | undefined
    /** Override exit handler. Defaults to `process.exit`. */
    exit?: ((code: number) => void) | undefined
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

  const { verbose, format, llms, help, version, rest: filtered } = extractBuiltinFlags(argv)

  if (llms) {
    stdout(Formatter.format(buildManifest(commands), format))
    return
  }

  // --help takes precedence over --version
  if (version && !help && options.version) {
    stdout(options.version)
    return
  }

  if (filtered.length === 0) {
    stdout(
      Help.formatRoot(name, {
        description: options.description,
        commands: collectHelpCommands(commands, []),
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
      stdout(
        Help.formatRoot(helpName, {
          description: helpDesc,
          commands: collectHelpCommands(helpCmds, []),
        }),
      )
    } else {
      stdout(
        Help.formatCommand(`${name} ${resolved.path}`, {
          description: resolved.command.description,
          args: resolved.command.args,
          options: resolved.command.options,
        }),
      )
    }
    return
  }

  if ('help' in resolved) {
    stdout(
      Help.formatRoot(`${name} ${resolved.path}`, {
        description: resolved.description,
        commands: collectHelpCommands(resolved.commands, []),
      }),
    )
    return
  }

  const start = performance.now()

  function write(output: Output) {
    if (verbose) return stdout(Formatter.format(output, format))
    if (output.ok) stdout(Formatter.format(output.data, format))
    else stdout(Formatter.format(output.error, format))
  }

  function writeError(message: string, commandPath: string) {
    write({
      ok: false,
      error: { code: 'COMMAND_NOT_FOUND', message },
      meta: {
        command: commandPath,
        duration: `${Math.round(performance.now() - start)}ms`,
      },
    })
    exit(1)
  }

  if ('error' in resolved) {
    writeError(resolved.error, resolved.path)
    return
  }

  const { command, path, rest } = resolved

  try {
    const { args, options: parsedOptions } = Parser.parse(rest, {
      args: command.args,
      options: command.options,
    })

    const data = await command.run({ args, options: parsedOptions })
    const cta = command.cta ? command.cta(data).map((c) => formatCta(name, c)) : undefined

    write({
      ok: true,
      data,
      meta: {
        command: path,
        duration: `${Math.round(performance.now() - start)}ms`,
        ...(cta ? { cta } : undefined),
      },
    })
  } catch (error) {
    write({
      ok: false,
      error: {
        code: error instanceof ClacError ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ClacError && error.hint ? { hint: error.hint } : undefined),
        ...(error instanceof ClacError ? { retryable: error.retryable } : undefined),
        ...(error instanceof ValidationError ? { fieldErrors: error.fieldErrors } : undefined),
      },
      meta: {
        command: path,
        duration: `${Math.round(performance.now() - start)}ms`,
      },
    })
    exit(1)
  }
}

/** Resolves a command from the tree by walking tokens until a leaf is found. */
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

  if (!first || !commands.has(first))
    return { error: `Unknown command: ${first ?? '(none)'}`, path: first ?? '' }

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
      const available = [...entry.commands.keys()].sort().join(', ')
      return { error: `Unknown subcommand: ${next}. Available: ${available}`, path: path.join(' ') }
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
    version?: string | undefined
  }
}

/** Extracts built-in flags (--verbose, --format, --json, --llms, --help, --version) from argv. */
function extractBuiltinFlags(argv: string[]) {
  let verbose = false
  let llms = false
  let help = false
  let version = false
  let format: Formatter.Format = 'toon'
  const rest: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--verbose') verbose = true
    else if (token === '--llms') llms = true
    else if (token === '--help' || token === '-h') help = true
    else if (token === '--version') version = true
    else if (token === '--json') format = 'json'
    else if (token === '--format' && argv[i + 1]) {
      format = argv[i + 1] as Formatter.Format
      i++
    } else rest.push(token)
  }

  return { verbose, format, llms, help, version, rest }
}

/** Recursively collects command names and descriptions for help output. */
function collectHelpCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
): { name: string; description?: string | undefined }[] {
  const result: { name: string; description?: string | undefined }[] = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if (isGroup(entry)) result.push(...collectHelpCommands(entry.commands, path))
    else result.push({ name: path.join(' '), description: entry.description })
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

/** @internal Formats a CTA by prefixing the CLI name and folding `args` and `options` into the command string. */
function formatCta(name: string, cta: Cta): FormattedCta {
  let cmd = `${name} ${cta.command}`
  if (cta.args)
    for (const [key, value] of Object.entries(cta.args))
      cmd += value === true ? ` <${key}>` : ` ${value}`
  if (cta.options)
    for (const [key, value] of Object.entries(cta.options))
      cmd += value === true ? ` --${key} <${key}>` : ` --${key} ${value}`
  return { command: cmd, ...(cta.description ? { description: cta.description } : undefined) }
}

/** Builds the `--llms` manifest from the command tree. */
function buildManifest(commands: Map<string, CommandEntry>) {
  return {
    version: 'clac.v1',
    commands: collectCommands(commands, []).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** Recursively collects leaf commands with their full paths. */
function collectCommands(
  commands: Map<string, CommandEntry>,
  prefix: string[],
): {
  name: string
  description?: string
  schema?: Record<string, unknown>
  annotations?: Record<string, boolean>
}[] {
  const result: ReturnType<typeof collectCommands> = []
  for (const [name, entry] of commands) {
    const path = [...prefix, name]
    if (isGroup(entry)) {
      result.push(...collectCommands(entry.commands, path))
    } else {
      const cmd: (typeof result)[number] = { name: path.join(' ') }
      if (entry.description) cmd.description = entry.description

      const inputSchema = buildInputSchema(entry.args, entry.options)
      const outputSchema = entry.output ? Schema.toJsonSchema(entry.output) : undefined
      if (inputSchema || outputSchema) {
        cmd.schema = {}
        if (inputSchema) cmd.schema.input = inputSchema
        if (outputSchema) cmd.schema.output = outputSchema
      }

      const annotations = buildAnnotations(entry)
      if (annotations) cmd.annotations = annotations
      result.push(cmd)
    }
  }
  return result
}

/** Extracts annotation flags from a command definition, mapped to MCP-style keys. */
function buildAnnotations(
  entry: CommandDefinition<any, any, any>,
): Record<string, boolean> | undefined {
  const map: Record<string, boolean> = {}
  let has = false
  if (entry.readOnly !== undefined) {
    map.readOnlyHint = entry.readOnly
    has = true
  }
  if (entry.destructive !== undefined) {
    map.destructiveHint = entry.destructive
    has = true
  }
  if (entry.idempotent !== undefined) {
    map.idempotentHint = entry.idempotent
    has = true
  }
  if (entry.openWorld !== undefined) {
    map.openWorldHint = entry.openWorld
    has = true
  }
  return has ? map : undefined
}

/** Merges args + options schemas into a single input JSON Schema. */
function buildInputSchema(
  args: z.ZodObject<any> | undefined,
  options: z.ZodObject<any> | undefined,
): Record<string, unknown> | undefined {
  if (!args && !options) return undefined
  const merged = z.object({
    ...(args?.shape ?? {}),
    ...(options?.shape ?? {}),
  })
  return Schema.toJsonSchema(merged)
}

/** Inferred output type of a Zod schema, or `{}` when the schema is not provided. */
type InferOutput<schema extends z.ZodObject<any> | undefined> =
  schema extends z.ZodObject<any> ? z.output<schema> : {}

/** Inferred return type for a command handler. */
type InferReturn<output extends z.ZodObject<any> | undefined> =
  output extends z.ZodObject<any> ? z.output<output> : unknown

/** The output envelope written to stdout. */
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
        /** Actionable hint for the user. */
        hint?: string | undefined
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

declare namespace Output {
  /** Shared metadata included in every envelope. */
  type Meta = {
    /** The command that was invoked. */
    command: string
    /** Wall-clock duration of the command. */
    duration: string
    /** Suggested next commands. Present on success envelopes only. */
    cta?: FormattedCta[] | undefined
  }
}

/** Defines a command's schema, handler, and metadata. */
type CommandDefinition<
  args extends z.ZodObject<any> | undefined = undefined,
  options extends z.ZodObject<any> | undefined = undefined,
  output extends z.ZodObject<any> | undefined = undefined,
> = {
  /** Map of option names to single-char aliases. */
  alias?: options extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<options>, string>>
    : Record<string, string> | undefined
  /** Zod schema for positional arguments. */
  args?: args
  /** Returns suggested next commands based on the result. */
  cta?: ((result: InferReturn<output>) => Cta[]) | undefined
  /** A short description of what the command does. */
  description?: string | undefined
  /** Whether the command may perform destructive operations. */
  destructive?: boolean | undefined
  /** Whether the command can be called multiple times safely. */
  idempotent?: boolean | undefined
  /** Whether the command interacts with external systems. */
  openWorld?: boolean | undefined
  /** Zod schema for named options/flags. */
  options?: options
  /** Zod schema for the command's return value. */
  output?: output
  /** Whether the command only reads data (no side effects). */
  readOnly?: boolean | undefined
  /** The command handler. */
  run(context: {
    args: InferOutput<args>
    options: InferOutput<options>
  }): InferReturn<output> | Promise<InferReturn<output>>
}

/** A formatted CTA as it appears in the output envelope. */
type FormattedCta = {
  /** The full command string with args and options folded in. */
  command: string
  /** A short description of what the command does. */
  description?: string | undefined
}
