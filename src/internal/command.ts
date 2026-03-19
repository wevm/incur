import { z } from 'zod'

import type { FieldError } from '../Errors.js'
import { IncurError, ValidationError } from '../Errors.js'
import type { Context as MiddlewareContext, Handler as MiddlewareHandler } from '../middleware.js'
import * as Parser from '../Parser.js'

/** @internal Sentinel symbol for `ok()` and `error()` return values. */
const sentinel = Symbol.for('incur.sentinel')

/** @internal CTA block for command output. */
export type CtaBlock = {
  commands: unknown[]
  description?: string | undefined
}

/** @internal A tagged ok result. */
type OkResult = {
  [sentinel]: 'ok'
  data: unknown
  cta?: CtaBlock | undefined
}

/** @internal A tagged error result. */
type ErrorResult = {
  [sentinel]: 'error'
  code: string
  message: string
  retryable?: boolean | undefined
  exitCode?: number | undefined
  cta?: CtaBlock | undefined
}

/** @internal Unified command execution used by CLI, HTTP, and MCP transports. */
export async function execute(command: any, options: execute.Options): Promise<execute.Result> {
  const {
    argv,
    inputOptions,
    agent,
    format,
    formatExplicit,
    name,
    path,
    version,
    envSource = process.env,
    env: envSchema,
    vars: varsSchema,
    middlewares = [],
  } = options
  const parseMode = options.parseMode ?? 'argv'

  const varsMap: Record<string, unknown> = varsSchema ? varsSchema.parse({}) : {}
  let result: execute.Result | undefined
  // For streaming with middleware: runCommand suspends on streamConsumed so middleware "after"
  // runs after the stream is consumed. The wrapped generator resolves it in its finally block.
  // resultReady signals that result has been set (for streams, before the chain finishes).
  let streamConsumed: Promise<void> | undefined
  let resolveStreamConsumed: (() => void) | undefined
  let resolveResultReady: (() => void) | undefined
  const resultReady = new Promise<void>((r) => {
    resolveResultReady = r
  })

  const runCommand = async () => {
    // Parse args and options
    let args: Record<string, unknown>
    let parsedOptions: Record<string, unknown>

    if (parseMode === 'argv') {
      // CLI mode: parse both args and options from argv tokens
      const parsed = Parser.parse(argv, {
        alias: command.alias as Record<string, string> | undefined,
        args: command.args,
        options: command.options,
      })
      args = parsed.args
      parsedOptions = parsed.options
    } else if (parseMode === 'split') {
      // HTTP mode: positional args from URL path segments, options from body/query
      const parsed = Parser.parse(argv, { args: command.args })
      args = parsed.args
      parsedOptions = command.options ? command.options.parse(inputOptions) : {}
    } else {
      // MCP mode: all params come from inputOptions, split into args vs options
      const split = splitParams(inputOptions, command)
      args = command.args ? command.args.parse(split.args) : {}
      parsedOptions = command.options ? command.options.parse(split.options) : {}
    }

    // Parse env
    const commandEnv = command.env ? Parser.parseEnv(command.env, envSource) : {}

    // Build sentinel helpers
    const okFn = (data: unknown, meta: { cta?: CtaBlock | undefined } = {}): never =>
      ({ [sentinel]: 'ok', data, cta: meta.cta }) as never
    const errorFn = (opts: {
      code: string
      cta?: CtaBlock | undefined
      exitCode?: number | undefined
      message: string
      retryable?: boolean | undefined
    }): never => ({ [sentinel]: 'error', ...opts }) as never

    const raw = command.run({
      agent,
      args,
      env: commandEnv,
      error: errorFn,
      format,
      formatExplicit,
      name,
      ok: okFn,
      options: parsedOptions,
      var: varsMap,
      version,
    })

    // Streaming: wrap the generator so middleware "after" runs after consumption.
    // When middleware is active, runCommand suspends until the stream is fully consumed,
    // keeping the middleware chain alive around the stream's lifetime.
    if (isAsyncGenerator(raw)) {
      if (middlewares.length > 0) {
        streamConsumed = new Promise<void>((r) => {
          resolveStreamConsumed = r
        })
        async function* wrapped() {
          try {
            yield* raw as AsyncGenerator<unknown, unknown, unknown>
          } finally {
            resolveStreamConsumed!()
          }
        }
        result = { stream: wrapped() }
        resolveResultReady!()
        await streamConsumed
      } else {
        result = { stream: raw }
      }
      return
    }

    const awaited = await raw

    if (isSentinel(awaited)) {
      if (awaited[sentinel] === 'ok') {
        const ok = awaited as OkResult
        result = { ok: true, data: ok.data, ...(ok.cta ? { cta: ok.cta } : undefined) }
      } else {
        const err = awaited as ErrorResult
        result = {
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            ...(err.retryable !== undefined ? { retryable: err.retryable } : undefined),
          },
          ...(err.cta ? { cta: err.cta } : undefined),
          ...(err.exitCode !== undefined ? { exitCode: err.exitCode } : undefined),
        }
      }
      return
    }

    result = { ok: true, data: awaited }
  }

  try {
    // Parse CLI-level env
    const cliEnv = envSchema ? Parser.parseEnv(envSchema, envSource) : {}

    if (middlewares.length > 0) {
      const errorFn = (opts: {
        code: string
        cta?: CtaBlock | undefined
        exitCode?: number | undefined
        message: string
        retryable?: boolean | undefined
      }): never => {
        // Side-effect: set result directly (handles both `return c.error()` and bare `c.error()`)
        result = {
          ok: false,
          error: {
            code: opts.code,
            message: opts.message,
            ...(opts.retryable !== undefined ? { retryable: opts.retryable } : undefined),
          },
          ...(opts.cta ? { cta: opts.cta } : undefined),
          ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : undefined),
        }
        return undefined as never
      }

      const mwCtx: MiddlewareContext = {
        agent,
        command: path,
        env: cliEnv,
        error: errorFn,
        format: format as any,
        formatExplicit,
        name,
        set(key: string, value: unknown) {
          varsMap[key] = value
        },
        var: varsMap,
        version,
      }

      const composed = middlewares.reduceRight(
        (next: () => Promise<void>, mw) => async () => {
          await mw(mwCtx, next)
        },
        runCommand,
      )
      // Start the chain and race against resultReady. For streams with middleware,
      // runCommand suspends on streamConsumed (keeping middleware "after" deferred)
      // but signals resultReady so we can return the stream immediately. The transport
      // consumes the stream, which resolves streamConsumed, letting middleware "after" run.
      const chainPromise = composed()
      await Promise.race([chainPromise, resultReady])
      if (streamConsumed) return result!
      await chainPromise
    } else {
      await runCommand()
    }
  } catch (error) {
    if (error instanceof ValidationError)
      return {
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          fieldErrors: error.fieldErrors,
        },
      }
    return {
      ok: false,
      error: {
        code: error instanceof IncurError ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof IncurError ? { retryable: error.retryable } : undefined),
      },
      ...(error instanceof IncurError && error.exitCode !== undefined
        ? { exitCode: error.exitCode }
        : undefined),
    }
  }

  return result ?? { ok: true, data: undefined }
}

/** @internal Splits flat params into args vs options using schema shapes. */
function splitParams(
  params: Record<string, unknown>,
  command: any,
): { args: Record<string, unknown>; options: Record<string, unknown> } {
  const argKeys = new Set(command.args ? Object.keys(command.args.shape) : [])
  const a: Record<string, unknown> = {}
  const o: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params))
    if (argKeys.has(key)) a[key] = value
    else o[key] = value
  return { args: a, options: o }
}

export declare namespace execute {
  /** Options for the unified execute function. */
  type Options = {
    /** Whether the consumer is an agent. */
    agent: boolean
    /** Raw positional tokens (already separated from flags). For HTTP/MCP, pass `[]`. */
    argv: string[]
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Source for environment variables. Defaults to `process.env`. */
    envSource?: Record<string, string | undefined> | undefined
    /** The resolved output format. */
    format: string
    /** Whether the format was explicitly requested. */
    formatExplicit: boolean
    /** Raw parsed options (from query params, JSON body, or MCP params). For CLI, pass `{}`. */
    inputOptions: Record<string, unknown>
    /** Middleware handlers (root + group + command, already collected). */
    middlewares?: MiddlewareHandler[] | undefined
    /** The CLI name. */
    name: string
    /**
     * How to parse input:
     * - `'argv'` (default): parse both args and options from argv tokens (CLI mode)
     * - `'split'`: args from argv, options from inputOptions (HTTP mode)
     * - `'flat'`: all params from inputOptions, split by schema shapes (MCP mode)
     */
    parseMode?: 'argv' | 'split' | 'flat' | undefined
    /** The resolved command path. */
    path: string
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    /** CLI version string. */
    version: string | undefined
  }

  /** Result of executing a command. */
  type Result =
    | { ok: true; data: unknown; cta?: CtaBlock | undefined }
    | {
        ok: false
        error: {
          code: string
          message: string
          retryable?: boolean | undefined
          fieldErrors?: FieldError[] | undefined
        }
        cta?: CtaBlock | undefined
        exitCode?: number | undefined
      }
    | { stream: AsyncGenerator<unknown, unknown, unknown> }
}

/** @internal Type guard for sentinel results. */
function isSentinel(value: unknown): value is OkResult | ErrorResult {
  return typeof value === 'object' && value !== null && sentinel in value
}

/** @internal Type guard for async generators. */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as any).next === 'function'
  )
}

/** Common metadata shared by command definitions and built-in commands. */
export type CommandMeta<options extends z.ZodObject<any> | undefined = undefined> = {
  /** Map of option names to single-char aliases. */
  alias?: options extends z.ZodObject<any>
    ? Partial<Record<keyof z.output<options>, string>>
    : Record<string, string> | undefined
  /** A short description of what the command does. */
  description?: string | undefined
  /** Zod schema for named options/flags. */
  options?: options | undefined
}

/** @internal Creates a builtin subcommand with typesafe alias inference. */
function subcommand<const options extends z.ZodObject<any> | undefined = undefined>(
  def: CommandMeta<options> & { name: string },
) {
  return def
}

/** Supported shell names for completions. */
export const shells = ['bash', 'fish', 'nushell', 'zsh'] as const

/** A supported shell name. */
export type Shell = (typeof shells)[number]

/** Built-in command metadata shared by help, completions, and handler logic. */
export const builtinCommands = [
  {
    name: 'completions',
    description: 'Generate shell completion script',
    args: z.object({
      shell: z.enum(shells).describe('Shell to generate completions for'),
    }),
    hint(name) {
      const rows = [
        ['bash', `eval "$(${name} completions bash)"`, '# add to ~/.bashrc'],
        ['fish', `${name} completions fish | source`, '# add to ~/.config/fish/config.fish'],
        ['nushell', `see \`${name} completions nushell\``, '# add to config.nu'],
        ['zsh', `eval "$(${name} completions zsh)"`, '# add to ~/.zshrc'],
      ] as const
      const shellW = Math.max(...rows.map((r) => r[0].length))
      const cmdW = Math.max(...rows.map((r) => r[1].length))
      return (
        'Setup:\n' +
        rows
          .map(([s, cmd, comment]) => `  ${s.padEnd(shellW)}  ${cmd.padEnd(cmdW)}  ${comment}`)
          .join('\n')
      )
    },
  },
  {
    name: 'mcp',
    description: 'Register as MCP server',
    subcommands: [
      subcommand({
        name: 'add',
        description: 'Register as MCP server',
        alias: { command: 'c' },
        options: z.object({
          agent: z
            .string()
            .optional()
            .describe('Target a specific agent (e.g. claude-code, cursor)'),
          command: z
            .string()
            .optional()
            .describe('Override the command agents will run (e.g. "pnpm my-cli --mcp")'),
          noGlobal: z.boolean().optional().describe('Install to project instead of globally'),
        }),
      }),
    ],
  },
  {
    name: 'skills',
    description: 'Sync skill files to agents',
    subcommands: [
      subcommand({
        name: 'add',
        description: 'Sync skill files to agents',
        options: z.object({
          depth: z.number().optional().describe('Grouping depth for skill files (default: 1)'),
          noGlobal: z.boolean().optional().describe('Install to project instead of globally'),
        }),
      }),
    ],
  },
] satisfies {
  name: string
  args?: z.ZodObject<any> | undefined
  description: string
  hint?: ((name: string) => string) | undefined
  subcommands?: (CommandMeta<z.ZodObject<any>> & { name: string })[] | undefined
}[]
