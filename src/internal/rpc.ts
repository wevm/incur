import { z } from 'zod'

import type { FieldError } from '../Errors.js'
import { IncurError } from '../Errors.js'
import type { Handler as MiddlewareHandler } from '../middleware.js'
import * as Command from './command.js'
import { isRecord } from './helpers.js'

/** @internal Registers the structured RPC executor for a CLI instance. */
export function registerCliExecutor(cli: object, executor: CliExecutor): void {
  cliExecutors.set(cli, executor)
}

/** @internal Executes structured RPC against a registered CLI instance. */
export async function executeCli(
  cli: object,
  input: CliInput,
  options: CliOptions = {},
): Promise<executeRpc.Result> {
  const executor = cliExecutors.get(cli)
  if (!executor) throw new Error('Cannot execute RPC for an unknown CLI instance.')
  return executor(input, options)
}

/** @internal Executes a structured incur RPC request without binding it to a transport. */
export async function executeRpc(
  commands: Map<string, unknown>,
  input: unknown,
  options: executeRpc.Options = {},
): Promise<executeRpc.Result> {
  const start = options.start ?? performance.now()

  function error(code: string, message: string, status: number, command = '/_incur/rpc') {
    return {
      kind: 'json',
      status,
      body: {
        ok: false,
        error: { code, message },
        meta: { command, duration: duration(start) },
      },
    } satisfies executeRpc.JsonResult
  }

  if (!isRecord(input)) return error('VALIDATION_ERROR', 'Request body must be an object.', 400)

  if (typeof input.command !== 'string')
    return error('VALIDATION_ERROR', '`command` must be a string.', 400)
  const command = input.command.trim()
  if (!command) return error('VALIDATION_ERROR', '`command` must be a non-empty string.', 400)

  const args = input.args ?? {}
  const inputOptions = input.options ?? {}
  if (!isRecord(args) || !isRecord(inputOptions))
    return error('VALIDATION_ERROR', '`args` and `options` must be objects.', 400)

  const resolved =
    options.rootCommand && command === options.name
      ? { command: options.rootCommand, middlewares: [], path: command, rest: [] }
      : resolveCommand(commands, command.split(/\s+/))
  if ('fetchGateway' in resolved)
    return error(
      'FETCH_GATEWAY_UNSUPPORTED',
      'Raw fetch gateways cannot be called through structured RPC. Mount the gateway with an OpenAPI spec to generate typed commands, or call the HTTP route directly.',
      400,
      command,
    )
  if (!('command' in resolved) || resolved.rest.length > 0)
    return error('COMMAND_NOT_FOUND', 'Command not found.', 404, command)

  const allMiddleware = [
    ...(options.middlewares ?? []),
    ...resolved.middlewares,
    ...(((resolved.command as RpcCommand).middleware as MiddlewareHandler[] | undefined) ?? []),
  ]

  const result = await Command.execute(resolved.command, {
    agent: true,
    argv: [],
    env: options.env,
    envSource: options.envSource,
    format: 'json',
    formatExplicit: true,
    inputArgs: args,
    inputOptions,
    middlewares: allMiddleware,
    name: options.name ?? resolved.path,
    parseMode: 'structured',
    path: resolved.path,
    vars: options.vars,
    version: options.version,
  })

  if ('stream' in result)
    return {
      kind: 'stream',
      status: 200,
      stream: streamRecords(result.stream, {
        name: options.name ?? resolved.path,
        path: resolved.path,
      }),
    }

  const meta = { command: resolved.path, duration: duration(start) }

  if (!result.ok) {
    const cta = formatCtaBlock(options.name ?? resolved.path, result.cta as CtaBlock | undefined)
    return {
      kind: 'json',
      status: result.error.code === 'VALIDATION_ERROR' ? 400 : 500,
      body: {
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
          ...meta,
          ...(cta ? { cta } : undefined),
        },
      },
    }
  }

  const cta = formatCtaBlock(options.name ?? resolved.path, result.cta as CtaBlock | undefined)
  return {
    kind: 'json',
    status: 200,
    body: {
      ok: true,
      data: result.data,
      meta: {
        ...meta,
        ...(cta ? { cta } : undefined),
      },
    },
  }
}

/** @internal Structured RPC command input for a registered CLI instance. */
export type CliInput = {
  /** Command path, separated by spaces for nested commands. */
  command: string
  /** Structured positional arguments. */
  args?: unknown | undefined
  /** Structured named options. */
  options?: unknown | undefined
}

/** @internal Options for structured RPC command execution against a CLI instance. */
export type CliOptions = {
  /** Environment source used for CLI-level and command-level env parsing. */
  env?: Record<string, string | undefined> | undefined
}

type CliExecutor = (input: CliInput, options?: CliOptions | undefined) => Promise<executeRpc.Result>

const cliExecutors = new WeakMap<object, CliExecutor>()

export declare namespace executeRpc {
  /** Options for structured RPC execution. */
  type Options = {
    /** CLI-level env schema. */
    env?: z.ZodObject<any> | undefined
    /** Source for environment variables. Defaults to `process.env`. */
    envSource?: Record<string, string | undefined> | undefined
    /** Root CLI middleware. */
    middlewares?: MiddlewareHandler[] | undefined
    /** CLI name used for command context and CTA formatting. */
    name?: string | undefined
    /** Root command definition for leaf CLIs. */
    rootCommand?: unknown | undefined
    /** Start time used for envelope duration metadata. */
    start?: number | undefined
    /** Vars schema for middleware variables. */
    vars?: z.ZodObject<any> | undefined
    /** CLI version string. */
    version?: string | undefined
  }

  /** Structured RPC execution result. */
  type Result = JsonResult | StreamResult

  /** Non-streaming structured RPC result. */
  type JsonResult = {
    /** Result discriminator for JSON envelope responses. */
    kind: 'json'
    /** Normalized response envelope. */
    body: Envelope
    /** HTTP-compatible status code for adapters that expose RPC over HTTP. */
    status: number
  }

  /** Streaming structured RPC result. */
  type StreamResult = {
    /** Result discriminator for streaming record responses. */
    kind: 'stream'
    /** Normalized stream records. */
    stream: AsyncGenerator<StreamRecord, void, unknown>
    /** HTTP-compatible status code for adapters that expose RPC over HTTP. */
    status: number
  }
}

/** @internal Structured RPC response envelope. */
export type Envelope =
  | {
      /** Command output data. */
      data: unknown
      /** Response metadata. */
      meta: Meta
      /** Whether the command succeeded. */
      ok: true
    }
  | {
      /** Command error. */
      error: RpcError
      /** Response metadata. */
      meta: Meta
      /** Whether the command succeeded. */
      ok: false
    }

/** @internal Structured RPC stream record. */
export type StreamRecord =
  | {
      /** Stream chunk data. */
      data: unknown
      /** Stream record discriminator. */
      type: 'chunk'
    }
  | {
      /** Response metadata. */
      meta: Omit<Meta, 'duration'>
      /** Whether the command succeeded. */
      ok: true
      /** Stream record discriminator. */
      type: 'done'
    }
  | {
      /** Command error. */
      error: Omit<RpcError, 'fieldErrors'>
      /** Response metadata. */
      meta?: Pick<Meta, 'cta'> | undefined
      /** Whether the command succeeded. */
      ok: false
      /** Stream record discriminator. */
      type: 'error'
    }

/** @internal Formats a CTA block into the RPC envelope shape. */
export function formatCtaBlock(
  name: string,
  block: CtaBlock | undefined,
): FormattedCtaBlock | undefined {
  if (!block || block.commands.length === 0) return undefined
  return {
    description:
      block.description ??
      (block.commands.length === 1 ? 'Suggested command:' : 'Suggested commands:'),
    commands: block.commands.map((cta) => formatCta(name, cta)),
  }
}

type Meta = {
  command: string
  cta?: FormattedCtaBlock | undefined
  duration: string
}

type RpcError = {
  code: string
  fieldErrors?: FieldError[] | undefined
  message: string
  retryable?: boolean | undefined
}

type RpcCommand = {
  middleware?: MiddlewareHandler[] | undefined
  outputPolicy?: unknown | undefined
  run: (...args: any[]) => unknown
}

type RpcGroup = {
  _group: true
  commands: Map<string, unknown>
  description?: string | undefined
  middlewares?: MiddlewareHandler[] | undefined
  outputPolicy?: unknown | undefined
}

type RpcFetchGateway = {
  _fetch: true
}

type RpcAlias = {
  _alias: true
  target: string
}

type ResolvedCommand =
  | {
      command: RpcCommand
      middlewares: MiddlewareHandler[]
      path: string
      rest: string[]
    }
  | {
      fetchGateway: RpcFetchGateway
      middlewares: MiddlewareHandler[]
      path: string
      rest: string[]
    }
  | {
      help: true
      path: string
    }
  | { error: string; path: string; rest: string[] }

type CtaBlock = {
  commands: unknown[]
  description?: string | undefined
}

type FormattedCtaBlock = {
  commands: FormattedCta[]
  description: string
}

type FormattedCta = {
  command: string
  description?: string | undefined
}

type Cta =
  | string
  | {
      args?: Record<string, unknown> | undefined
      command: string
      description?: string | undefined
      options?: Record<string, unknown> | undefined
    }

type OkResult = {
  [sentinel]: 'ok'
  cta?: CtaBlock | undefined
  data: unknown
}

type ErrorResult = {
  [sentinel]: 'error'
  code: string
  cta?: CtaBlock | undefined
  exitCode?: number | undefined
  message: string
  retryable?: boolean | undefined
}

const sentinel = Symbol.for('incur.sentinel')

async function* streamRecords(
  stream: AsyncGenerator<unknown, unknown, unknown>,
  options: { name: string; path: string },
): AsyncGenerator<StreamRecord, void, unknown> {
  let completed = false
  try {
    let returnValue: unknown
    while (true) {
      const { value, done } = await stream.next()
      if (done) {
        returnValue = value
        break
      }
      if (isSentinel(value) && value[sentinel] === 'error') {
        yield errorRecord(value, options.name)
        completed = true
        return
      }
      yield { type: 'chunk', data: value }
    }
    if (isSentinel(returnValue) && returnValue[sentinel] === 'error') {
      yield errorRecord(returnValue, options.name)
      completed = true
      return
    }
    const cta =
      isSentinel(returnValue) && returnValue[sentinel] === 'ok'
        ? formatCtaBlock(options.name, returnValue.cta)
        : undefined
    yield {
      type: 'done',
      ok: true,
      meta: {
        command: options.path,
        ...(cta ? { cta } : undefined),
      },
    }
    completed = true
  } catch (error) {
    yield {
      type: 'error',
      ok: false,
      error: {
        code: error instanceof IncurError ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof IncurError && error.retryable !== undefined
          ? { retryable: error.retryable }
          : undefined),
      },
    }
    completed = true
  } finally {
    if (!completed) await stream.return(undefined)
  }
}

function errorRecord(error: ErrorResult, name: string): StreamRecord {
  const cta = formatCtaBlock(name, error.cta)
  return {
    type: 'error',
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryable !== undefined ? { retryable: error.retryable } : undefined),
    },
    ...(cta ? { meta: { cta } } : undefined),
  }
}

function resolveCommand(commands: Map<string, unknown>, tokens: string[]): ResolvedCommand {
  const [first, ...rest] = tokens

  if (!first || !commands.has(first)) return { error: first ?? '(none)', path: '', rest }

  let entry = resolveAlias(commands, commands.get(first)!)
  const path = [first]
  let remaining = rest
  const middlewares: MiddlewareHandler[] = []

  if (isFetchGateway(entry))
    return { fetchGateway: entry, middlewares, path: path.join(' '), rest: remaining }

  while (isGroup(entry)) {
    if (entry.middlewares) middlewares.push(...entry.middlewares)
    const next = remaining[0]
    if (!next) return { help: true, path: path.join(' ') }

    const rawChild = entry.commands.get(next)
    if (!rawChild) return { error: next, path: path.join(' '), rest: remaining.slice(1) }

    entry = resolveAlias(entry.commands, rawChild)
    path.push(next)
    remaining = remaining.slice(1)

    if (isFetchGateway(entry))
      return { fetchGateway: entry, middlewares, path: path.join(' '), rest: remaining }
  }

  return { command: entry as RpcCommand, middlewares, path: path.join(' '), rest: remaining }
}

function resolveAlias(commands: Map<string, unknown>, entry: unknown): unknown {
  if (isAlias(entry)) return commands.get(entry.target)!
  return entry
}

function isAlias(entry: unknown): entry is RpcAlias {
  return isRecord(entry) && entry._alias === true && typeof entry.target === 'string'
}

function isGroup(entry: unknown): entry is RpcGroup {
  return isRecord(entry) && entry._group === true && entry.commands instanceof Map
}

function isFetchGateway(entry: unknown): entry is RpcFetchGateway {
  return isRecord(entry) && entry._fetch === true
}

function isSentinel(value: unknown): value is OkResult | ErrorResult {
  return typeof value === 'object' && value !== null && sentinel in value
}

function formatCta(name: string, cta: unknown): FormattedCta {
  if (typeof cta === 'string') return { command: `${name} ${cta}` }
  if (!isRpcCta(cta)) return { command: `${name} ${String(cta)}` }
  const prefix = cta.command === name || cta.command.startsWith(`${name} `) ? '' : `${name} `
  let command = `${prefix}${cta.command}`
  if (cta.args)
    for (const [key, value] of Object.entries(cta.args))
      command += value === true ? ` <${key}>` : ` ${value}`
  if (cta.options)
    for (const [key, value] of Object.entries(cta.options))
      command += value === true ? ` --${key} <${key}>` : ` --${key} ${value}`
  return { command, ...(cta.description ? { description: cta.description } : undefined) }
}

function isRpcCta(value: unknown): value is Exclude<Cta, string> {
  return isRecord(value) && typeof value.command === 'string'
}

function duration(start: number) {
  return `${Math.round(performance.now() - start)}ms`
}
