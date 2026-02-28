import type { z } from 'zod'

/** @internal Infers the output type of a vars schema, or `{}` if undefined. */
type InferVars<vars extends z.ZodObject<any> | undefined> =
  vars extends z.ZodObject<any> ? z.output<vars> : {}

/** @internal Infers the output type of an env schema, or `{}` if undefined. */
type InferEnv<env extends z.ZodObject<any> | undefined> =
  env extends z.ZodObject<any> ? z.output<env> : {}

/** Middleware handler that runs before/after command execution. */
export type Handler<
  vars extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
> = (
  context: Context<vars, env>,
  next: () => Promise<void>,
) => Promise<void> | void

/** Context available inside middleware. */
export type Context<
  vars extends z.ZodObject<any> | undefined = undefined,
  env extends z.ZodObject<any> | undefined = undefined,
> = {
  /** Whether the consumer is an agent (stdout is not a TTY). */
  agent: boolean
  /** The resolved command path. */
  command: string
  /** Parsed environment variables from the CLI-level env schema. */
  env: InferEnv<env>
  /** Set a typed variable for downstream middleware and handlers. */
  set<key extends string & keyof InferVars<vars>>(key: key, value: InferVars<vars>[key]): void
  /** Variables set by upstream middleware. */
  var: InferVars<vars>
}

/** Creates a strictly typed middleware handler. Pass the vars schema as a generic for typed `c.set()` and `c.var`, and the env schema for typed `c.env`. */
export default function middleware<
  const vars extends z.ZodObject<any> | undefined = undefined,
  const env extends z.ZodObject<any> | undefined = undefined,
>(handler: Handler<vars, env>): Handler<vars, env> {
  return handler
}
