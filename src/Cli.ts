import type { z } from 'zod'
import * as Formatter from './Formatter.js'
import * as Parser from './Parser.js'

/** A CLI application instance. */
export type Cli = {
  /** The name of the CLI application. */
  name: string
  /** Registers a command and returns the CLI instance for chaining. */
  command<
    const args extends z.ZodObject<any> | undefined = undefined,
    const options extends z.ZodObject<any> | undefined = undefined,
    const output extends z.ZodObject<any> | undefined = undefined,
  >(name: string, definition: CommandDefinition<args, options, output>): Cli
  /** Parses argv, runs the matched command, and writes the output envelope to stdout. */
  serve(argv?: string[], options?: serve.Options): Promise<void>
}

/** Inferred output type of a Zod schema, or `{}` when the schema is not provided. */
type InferOutput<schema extends z.ZodObject<any> | undefined> =
  schema extends z.ZodObject<any> ? z.output<schema> : {}

/** Inferred return type for a command handler. */
type InferReturn<output extends z.ZodObject<any> | undefined> =
  output extends z.ZodObject<any> ? z.output<output> : unknown

/** A suggested next command returned from the `next` callback. */
type NextCommand = {
  /** The command string to run. */
  command: string
  /** A short description of what the command does. */
  description?: string | undefined
  /** Pre-filled arguments for the command. */
  args?: Record<string, unknown> | undefined
}

/** Defines a command's schema, handler, and metadata. */
type CommandDefinition<
  args extends z.ZodObject<any> | undefined = undefined,
  options extends z.ZodObject<any> | undefined = undefined,
  output extends z.ZodObject<any> | undefined = undefined,
> = {
  /** A short description of what the command does. */
  description?: string | undefined
  /** Zod schema for positional arguments. */
  args?: args
  /** Zod schema for named options/flags. */
  options?: options
  /** Zod schema for the command's return value. */
  output?: output
  /** Map of option names to single-char aliases. */
  alias?: options extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<options>, string>>
    : Record<string, string> | undefined
  /** The command handler. */
  run(context: {
    args: InferOutput<args>
    options: InferOutput<options>
  }): InferReturn<output> | Promise<InferReturn<output>>
  /** Returns suggested next commands based on the result. */
  next?: ((result: InferReturn<output>) => NextCommand[]) | undefined
}

/** Creates a new CLI application. */
export function create(name: string, _options: create.Options = {}): Cli {
  const commands = new Map<string, CommandDefinition<any, any, any>>()

  return {
    name,

    command(name, def) {
      commands.set(name, def as CommandDefinition<any, any, any>)
      return this
    },

    async serve(argv = process.argv.slice(2), options: serve.Options = {}) {
      const stdout = options.stdout ?? ((s: string) => process.stdout.write(s))
      const exit = options.exit ?? ((code: number) => process.exit(code))

      const [commandName, ...rest] = argv
      const start = performance.now()

      function write(envelope: Record<string, unknown>) {
        stdout(Formatter.format(envelope))
      }

      if (!commandName || !commands.has(commandName)) {
        write({
          ok: false,
          error: {
            code: 'COMMAND_NOT_FOUND',
            message: `Unknown command: ${commandName ?? '(none)'}`,
          },
          meta: {
            command: commandName ?? '',
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
        exit(1)
        return
      }

      const command = commands.get(commandName)!

      try {
        const { args, options: parsedOptions } = Parser.parse(rest, {
          args: command.args,
          options: command.options,
        })

        const data = await command.run({ args, options: parsedOptions })

        write({
          ok: true,
          data,
          meta: {
            command: commandName,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
      } catch (error) {
        write({
          ok: false,
          error: {
            code: 'UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
          },
          meta: {
            command: commandName,
            duration: `${Math.round(performance.now() - start)}ms`,
          },
        })
        exit(1)
      }
    },
  }
}

export declare namespace create {
  /** Options for creating a CLI application. */
  type Options = {
    /** The CLI version string. */
    version?: string | undefined
    /** A short description of the CLI. */
    description?: string | undefined
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
