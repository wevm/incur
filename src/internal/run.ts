import type { z } from 'zod'

import type * as Formatter from '../Formatter.js'

/** @internal Human-only output channel exposed to command handlers. */
export type Human = {
  /** Whether human output is currently active. */
  enabled: boolean
  /** Terminal stream for third-party TTY helpers when available. */
  stream?: NodeJS.WriteStream | undefined
  /** Writes raw text to the human-only channel. */
  write(text: string): void
  /** Writes a line to the human-only channel. */
  writeln(text: string): void
}

/** @internal Full command context passed to `run()` handlers. */
export type RunContext<
  args extends z.ZodObject<any> | undefined,
  env extends z.ZodObject<any> | undefined,
  options extends z.ZodObject<any> | undefined,
  output extends z.ZodType | undefined,
  vars extends z.ZodObject<any> | undefined,
  cta = unknown,
> = {
  /** Whether the consumer is an agent (stdout is not a TTY). */
  agent: boolean
  /** Positional arguments. */
  args: InferOutput<args>
  /** Parsed environment variables. */
  env: InferOutput<env>
  /** Return an error result with optional CTAs. */
  error: (options: {
    code: string
    cta?: cta | undefined
    exitCode?: number | undefined
    message: string
    retryable?: boolean | undefined
  }) => never
  /** The resolved output format (e.g. `'toon'`, `'json'`, `'jsonl'`). */
  format: Formatter.Format
  /** Whether the user explicitly passed `--format` or `--json`. */
  formatExplicit: boolean
  /** Human-only output helpers. */
  human: Human
  /** The CLI name. */
  name: string
  /** Return a success result with optional metadata (e.g. CTAs). */
  ok: (data: InferReturn<output>, meta?: { cta?: cta | undefined }) => never
  /** Parsed named options/flags. */
  options: InferOutput<options>
  /** Variables set by middleware. */
  var: InferVars<vars>
  /** The CLI version string. */
  version: string | undefined
}

/** @internal Creates a stable human output helper that no-ops when disabled. */
export function createHuman(options: createHuman.Options = {}): Human {
  const { enabled = false, stream, write = noop } = options
  if (!enabled) return { enabled: false, write: noop, writeln: noop }

  const human = {
    enabled: true,
    write,
    writeln(text: string) {
      write(text.endsWith('\n') ? text : `${text}\n`)
    },
  }

  if (!stream) return human
  return { ...human, stream }
}

export declare namespace createHuman {
  /** Options for `createHuman()`. */
  type Options = {
    /** Whether the human-only channel should emit output. */
    enabled?: boolean | undefined
    /** Live terminal stream for third-party UI helpers. */
    stream?: NodeJS.WriteStream | undefined
    /** Sink used for human-only writes. */
    write?: ((text: string) => void) | undefined
  }
}

/** @internal Returns the assembled `run()` context without further mutation. */
export function createRunContext<
  args extends z.ZodObject<any> | undefined,
  env extends z.ZodObject<any> | undefined,
  options extends z.ZodObject<any> | undefined,
  output extends z.ZodType | undefined,
  vars extends z.ZodObject<any> | undefined,
  cta = unknown,
>(
  context: RunContext<args, env, options, output, vars, cta>,
): RunContext<args, env, options, output, vars, cta> {
  return context
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

function noop(_text: string) {}
