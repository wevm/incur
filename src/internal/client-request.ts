import { estimateTokenCount, sliceByTokens } from 'tokenx'
import { z } from 'zod'

import type * as ClientRequest from '../client/Request.js'
import type { FieldError } from '../Errors.js'
import * as Filter from '../Filter.js'
import * as Formatter from '../Formatter.js'
import * as RuntimeContext from './client-runtime-context.js'
import * as Command from './command.js'

const requestSchema = z.object({
  command: z.string().transform((value) => value.trim().replace(/\s+/g, ' ')),
  args: z.record(z.string(), z.unknown()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  outputFormat: z.enum(['toon', 'json', 'yaml', 'md', 'jsonl']).optional(),
  selection: z.array(z.string().min(1)).nonempty().optional(),
  outputTokenCount: z.boolean().optional(),
  outputTokenLimit: z.number().int().nonnegative().optional(),
  outputTokenOffset: z.number().int().nonnegative().optional(),
})
const sentinel = Symbol.for('incur.sentinel')

/** Creates the shared client request executor. */
export function createClientRequest(
  ctx: RuntimeContext.RuntimeCliContext,
  options: createClientRequest.Options = {},
) {
  return {
    async request(
      request: unknown,
    ): Promise<ClientRequest.Response | ClientRequest.StreamResponse> {
      const start = performance.now()
      const parsed = requestSchema.safeParse(request)
      if (!parsed.success)
        return errorEnvelope('', start, {
          code: 'INVALID_RPC_REQUEST',
          message: 'Invalid RPC request.',
          fieldErrors: parsed.error.issues.map((issue) => ({
            code: issue.code,
            expected: 'valid RPC request',
            received: 'invalid',
            message: issue.message,
            path: issue.path.join('.'),
          })),
        })

      const rpc = parsed.data
      if (!rpc.command)
        return errorEnvelope('', start, {
          code: 'INVALID_RPC_REQUEST',
          message: 'RPC command is required.',
        })

      const resolved = RuntimeContext.resolveCanonical(ctx, rpc.command)
      if ('error' in resolved)
        return errorEnvelope(rpc.command, start, {
          code: resolved.error === 'empty' ? 'INVALID_RPC_REQUEST' : 'COMMAND_NOT_FOUND',
          message:
            resolved.error === 'empty'
              ? 'RPC command is required.'
              : `'${resolved.token}' is not a command for '${resolved.parent}'.`,
        })
      if ('commands' in resolved)
        return errorEnvelope(rpc.command, start, {
          code: 'COMMAND_GROUP',
          message: `'${resolved.id}' is a command group. Specify a subcommand.`,
        })
      if ('gateway' in resolved)
        return errorEnvelope(rpc.command, start, {
          code: 'FETCH_GATEWAY',
          message: `'${resolved.id}' is a raw fetch gateway and cannot be called with structured RPC.`,
        })

      const result = await Command.execute(resolved.command, {
        agent: true,
        argv: [],
        env: ctx.env,
        envSource: options.env,
        format: rpc.outputFormat ?? 'json',
        formatExplicit: true,
        inputOptions: { args: rpc.args ?? {}, options: rpc.options ?? {} },
        middlewares: resolved.middlewares,
        name: ctx.name,
        parseMode: 'structured',
        path: resolved.id,
        vars: ctx.vars,
        version: ctx.version,
      })

      if ('stream' in result) return streamResponse(result.stream, resolved.id, start, rpc)
      if (!result.ok)
        return errorEnvelope(resolved.id, start, result.error, formatCta(ctx.name, result.cta), rpc)
      return successEnvelope(resolved.id, start, result.data, formatCta(ctx.name, result.cta), rpc)
    },
  }
}

export declare namespace createClientRequest {
  /** Execution options. */
  type Options = {
    /** Explicit environment source. */
    env?: Record<string, string | undefined> | undefined
  }
}

function streamResponse(
  stream: AsyncGenerator<unknown, unknown, unknown>,
  command: string,
  start: number,
  request: ClientRequest.Request,
): ClientRequest.StreamResponse {
  return {
    stream: true,
    async *records() {
      let terminal: ClientRequest.StreamRecord
      try {
        while (true) {
          const { value, done } = await stream.next()
          if (done) {
            if (isSentinel(value) && value[sentinel] === 'error') {
              terminal = errorRecord(
                command,
                start,
                sentinelError(value),
                formatCta('', value.cta),
                request,
              )
            } else {
              const data = isSentinel(value) ? value.data : undefined
              terminal = {
                type: 'done',
                ...successEnvelope(
                  command,
                  start,
                  data,
                  formatCta('', isSentinel(value) ? value.cta : undefined),
                  request,
                ),
              }
            }
            yield terminal
            return terminal
          }
          if (isSentinel(value) && value[sentinel] === 'error') {
            terminal = errorRecord(
              command,
              start,
              sentinelError(value),
              formatCta('', value.cta),
              request,
            )
            yield terminal
            return terminal
          }
          yield { type: 'chunk', data: value }
        }
      } catch (error) {
        terminal = errorRecord(
          command,
          start,
          {
            code: 'UNKNOWN',
            message: error instanceof Error ? error.message : String(error),
          },
          undefined,
          request,
        )
        yield terminal
        return terminal
      } finally {
        await stream.return(undefined).catch(() => undefined)
      }
    },
  }
}

function successEnvelope(
  command: string,
  start: number,
  data: unknown,
  cta?: unknown | undefined,
  request: ClientRequest.Request = { command },
): Extract<ClientRequest.Envelope, { ok: true }> {
  const selected = applySelection(data, request.selection)
  const output = renderOutput(selected, request)
  return {
    ok: true,
    data: selected,
    ...(output.text
      ? { output: { text: output.text, ...(output.truncated ? { truncated: true } : undefined) } }
      : undefined),
    meta: meta(command, start, cta, output, request),
  }
}

function errorEnvelope(
  command: string,
  start: number,
  error: {
    code: string
    fieldErrors?: FieldError[] | undefined
    message: string
    retryable?: boolean | undefined
  },
  cta?: unknown | undefined,
  request: ClientRequest.Request = { command },
): Extract<ClientRequest.Envelope, { ok: false }> {
  return {
    ok: false,
    error,
    meta: meta(command, start, cta, renderOutput(undefined, request), request),
  }
}

function errorRecord(
  command: string,
  start: number,
  error: {
    code: string
    fieldErrors?: FieldError[] | undefined
    message: string
    retryable?: boolean | undefined
  },
  cta: unknown | undefined,
  request: ClientRequest.Request,
): Extract<ClientRequest.StreamRecord, { type: 'error' }> {
  return { type: 'error', ...errorEnvelope(command, start, error, cta, request) }
}

function applySelection(data: unknown, selection: string[] | undefined) {
  if (!selection?.length) return data
  return Filter.apply(
    data,
    selection.flatMap((value) => Filter.parse(value)),
  )
}

function renderOutput(data: unknown, request: ClientRequest.Request) {
  const text = Formatter.format(data, request.outputFormat ?? 'json')
  const count = estimateTokenCount(text)
  const offset = request.outputTokenOffset ?? 0
  if (request.outputTokenLimit === undefined && request.outputTokenOffset === undefined)
    return { text, count, truncated: false }
  const end = request.outputTokenLimit === undefined ? count : offset + request.outputTokenLimit
  const sliced = sliceByTokens(text, offset, end)
  return {
    text: sliced,
    count,
    truncated: end < count,
    nextOffset: end < count ? end : undefined,
  }
}

function meta(
  command: string,
  start: number,
  cta: unknown | undefined,
  output: { count: number; nextOffset?: number | undefined },
  request: ClientRequest.Request,
): ClientRequest.Meta {
  return {
    command,
    duration: `${Math.round(performance.now() - start)}ms`,
    ...(cta ? { cta } : undefined),
    ...(request.outputTokenCount ? { outputTokenCount: output.count } : undefined),
    ...(output.nextOffset !== undefined ? { nextOffset: output.nextOffset } : undefined),
  }
}

function formatCta(name: string, block: unknown | undefined) {
  if (!block || typeof block !== 'object' || !('commands' in block)) return undefined
  const commands = (block as { commands: unknown[]; description?: string | undefined }).commands
  if (commands.length === 0) return undefined
  return {
    description:
      (block as { description?: string | undefined }).description ??
      (commands.length === 1 ? 'Suggested command:' : 'Suggested commands:'),
    commands: commands.map((command) => {
      if (typeof command === 'string') return { command: name ? `${name} ${command}` : command }
      if (typeof command === 'object' && command !== null && 'command' in command) return command
      return { command: String(command) }
    }),
  }
}

type SentinelValue = {
  [sentinel]: 'ok' | 'error'
  code?: string | undefined
  cta?: unknown | undefined
  data?: unknown | undefined
  message?: string | undefined
  retryable?: boolean | undefined
}

function isSentinel(value: unknown): value is SentinelValue {
  return typeof value === 'object' && value !== null && sentinel in value
}

function sentinelError(value: {
  code?: string | undefined
  message?: string | undefined
  retryable?: boolean | undefined
}) {
  return {
    code: value.code ?? 'UNKNOWN',
    message: value.message ?? 'Command failed',
    ...(value.retryable !== undefined ? { retryable: value.retryable } : undefined),
  }
}
