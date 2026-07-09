import type { FieldError } from '../Errors.js'
import type * as Formatter from '../Formatter.js'

/** RPC request accepted by `transport.request()`. */
export type Request = {
  /** Canonical command ID. */
  command: string
  /** Structured positional arguments. */
  args?: Record<string, unknown> | undefined
  /** Structured named options. */
  options?: Record<string, unknown> | undefined
  /** Output format for rendered text. */
  outputFormat?: Formatter.Format | undefined
  /** Output selection paths. */
  selection?: string[] | undefined
  /** Whether token metadata should be included. */
  outputTokenCount?: boolean | undefined
  /** Maximum rendered output tokens to return. */
  outputTokenLimit?: number | undefined
  /** Rendered output token offset. */
  outputTokenOffset?: number | undefined
}

/** Rendered output payload. */
export type Output = {
  /** Rendered output text. */
  text: string
  /** Rendered format. */
  format?: Formatter.Format | undefined
  /** Offset to request for the next token window. */
  nextOffset?: number | undefined
  /** Rendered token count before truncation. */
  tokenCount?: number | undefined
  /** Requested token limit. */
  tokenLimit?: number | undefined
  /** Requested token offset. */
  tokenOffset?: number | undefined
  /** Whether text was truncated by token controls. */
  truncated?: boolean | undefined
}

/** RPC response metadata. */
export type Meta = {
  /** Canonical command ID. */
  command: string
  /** Suggested next commands. */
  cta?: unknown | undefined
  /** Wall-clock duration. */
  duration: string
}

/** Full RPC success/error envelope. */
export type Envelope =
  | {
      ok: true
      data: unknown
      output?: Output | undefined
      meta: Meta
    }
  | {
      ok: false
      error: {
        code: string
        fieldErrors?: FieldError[] | undefined
        message: string
        retryable?: boolean | undefined
      }
      meta: Meta
      /** HTTP status when the response came from an HTTP transport. */
      status?: number | undefined
    }

/** RPC error object. */
export type Error = Extract<Envelope, { ok: false }>['error']

/** Non-streaming RPC response. */
export type Response = Envelope

/** Streaming RPC record. */
export type StreamRecord =
  | { type: 'chunk'; data: unknown }
  | ({ type: 'done' } & Extract<Envelope, { ok: true }>)
  | ({ type: 'error' } & Extract<Envelope, { ok: false }>)

/** Streaming RPC response. */
export type StreamResponse = {
  stream: true
  records(): AsyncGenerator<StreamRecord, StreamRecord, unknown>
}
