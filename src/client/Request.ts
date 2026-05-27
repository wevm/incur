import type { FieldError } from '../Errors.js'
import type * as Formatter from '../Formatter.js'

/** Request accepted by `transport.request()`. */
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
  /** Whether text was truncated by token controls. */
  truncated?: boolean | undefined
}

/** Request metadata. */
export type Meta = {
  /** Canonical command ID. */
  command: string
  /** Suggested next commands. */
  cta?: unknown | undefined
  /** Wall-clock duration. */
  duration: string
  /** Offset to request for the next token window. */
  nextOffset?: number | undefined
  /** Rendered token count before truncation. */
  outputTokenCount?: number | undefined
}

/** Full request success/error envelope. */
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
    }

/** Non-streaming request response. */
export type Response = Envelope

/** Streaming request record. */
export type StreamRecord =
  | { type: 'chunk'; data: unknown }
  | ({ type: 'done' } & Extract<Envelope, { ok: true }>)
  | ({ type: 'error' } & Extract<Envelope, { ok: false }>)

/** Streaming request response. */
export type StreamResponse = {
  stream: true
  records(): AsyncGenerator<StreamRecord, StreamRecord, unknown>
}
