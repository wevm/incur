import type { z } from 'zod'

import type * as Formatter from './Formatter.js'

/** @internal Infers the output type of a vars schema, or `{}` if undefined. */
type InferVars<vars extends z.ZodObject<any> | undefined> =
  vars extends z.ZodObject<any> ? z.output<vars> : {}

/** @internal Infers the output type of an env schema, or `{}` if undefined. */
type InferEnv<env extends z.ZodObject<any> | undefined> =
  env extends z.ZodObject<any> ? z.output<env> : {}

/** @internal Infers the output type of a globals schema, or `{}` if undefined. */
type InferGlobals<globals extends z.ZodObject<any> | undefined> =
  globals extends z.ZodObject<any> ? z.output<globals> : {}

/** Middleware handler that runs before/after command execution. */
export type Handler<
  vars extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
  globals extends z.ZodObject<any> | undefined = undefined,
> = (context: Context<vars, env, globals>, next: () => Promise<void>) => Promise<void> | void

/** CTA block for middleware error/ok responses. */
type CtaBlock = {
  /** Commands to suggest. */
  commands: (string | { command: string; description?: string | undefined })[]
  /** Human-readable label. Defaults to `"Suggested commands:"`. */
  description?: string | undefined
}

/** Context available inside middleware. */
export type Context<
  vars extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
  globals extends z.ZodObject<any> | undefined = undefined,
> = {
  /** Whether the consumer is an agent (stdout is not a TTY). */
  agent: boolean
  /** The resolved command path. */
  command: string
  /** The binary name the user invoked (e.g. an alias). Falls back to `name` when not resolvable. */
  displayName: string
  /** Parsed environment variables from the CLI-level env schema. */
  env: InferEnv<env>
  /** Return an error result, short-circuiting the middleware chain. */
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
  /** Parsed global options from the CLI-level globals schema. */
  globals: InferGlobals<globals>
  /** The CLI name. */
  name: string
  /** Set a typed variable for downstream middleware and handlers. */
  set<key extends string & keyof InferVars<vars>>(key: key, value: InferVars<vars>[key]): void
  /** Variables set by upstream middleware. */
  var: InferVars<vars>
  /** The CLI version string. */
  version: string | undefined
}

/** Creates a strictly typed middleware handler. Pass the vars schema as a generic for typed `c.set()` and `c.var`, the env schema for typed `c.env`, and the globals schema for typed `c.globals`. */
export default function middleware<
  const vars extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
  const globals extends z.ZodObject<any> | undefined = undefined,
>(handler: Handler<vars, env, globals>): Handler<vars, env, globals> {
  return handler
}
