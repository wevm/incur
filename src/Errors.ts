/** Base error with shortMessage, details from cause chain, and walk(). */
export class BaseError extends Error {
  override name = 'Incur.BaseError'
  /** The short, human-readable error message (without details). */
  shortMessage: string
  /** Details extracted from the cause's message, if any. */
  details: string | undefined

  constructor(shortMessage: string, options: BaseError.Options = {}) {
    const details = options.cause instanceof Error ? options.cause.message : undefined
    const message = details ? `${shortMessage}\n\nDetails: ${details}` : shortMessage
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.shortMessage = shortMessage
    this.details = details
  }

  /**
   * Traverses the cause chain.
   * Without a callback, returns the deepest cause.
   * With a callback, returns the first cause where `fn` returns `true`.
   */
  walk(fn?: ((error: unknown) => boolean) | undefined): unknown {
    return walk(this, fn)
  }
}

export declare namespace BaseError {
  /** Options for constructing a BaseError. */
  type Options = {
    /** The underlying cause of this error. */
    cause?: Error | undefined
  }
}

/** CLI error with code, hint, and retryable flag. */
export class IncurError extends BaseError {
  override name = 'Incur.IncurError'
  /** Machine-readable error code (e.g. `'NOT_AUTHENTICATED'`). */
  code: string
  /** Actionable hint for the user. */
  hint: string | undefined
  /** Whether the operation can be retried. */
  retryable: boolean
  /** Process exit code. When set, `serve()` uses this instead of `1`. */
  exitCode: number | undefined

  constructor(options: IncurError.Options) {
    super(options.message, options.cause ? { cause: options.cause } : undefined)
    this.code = options.code
    this.hint = options.hint
    this.retryable = options.retryable ?? false
    this.exitCode = options.exitCode
  }
}

export declare namespace IncurError {
  /** Options for constructing a IncurError. */
  type Options = {
    /** Machine-readable error code. */
    code: string
    /** Human-readable error message. */
    message: string
    /** Actionable hint for the user. */
    hint?: string | undefined
    /** Whether the operation can be retried. Defaults to `false`. */
    retryable?: boolean | undefined
    /** Process exit code. When set, `serve()` uses this instead of `1`. */
    exitCode?: number | undefined
    /** The underlying cause. */
    cause?: Error | undefined
  }
}

/** A field-level validation error detail. */
export type FieldError = {
  /** The Zod issue code. */
  code?: string | undefined
  /** Whether the input was missing entirely. */
  missing?: boolean | undefined
  /** The field path that failed validation. */
  path: string
  /** The expected value or type. */
  expected: string
  /** The value that was received. */
  received: string
  /** Human-readable validation message. */
  message: string
}

/** Validation error with per-field error details. */
export class ValidationError extends BaseError {
  override name = 'Incur.ValidationError'
  /** Per-field validation errors. */
  fieldErrors: FieldError[]

  constructor(options: ValidationError.Options) {
    super(options.message, options.cause ? { cause: options.cause } : undefined)
    this.fieldErrors = options.fieldErrors ?? []
  }
}

export declare namespace ValidationError {
  /** Options for constructing a ValidationError. */
  type Options = {
    /** Human-readable error message. */
    message: string
    /** Per-field validation errors. */
    fieldErrors?: FieldError[] | undefined
    /** The underlying cause. */
    cause?: Error | undefined
  }
}

/** Error thrown when argument parsing fails (unknown flags, missing values). */
export class ParseError extends BaseError {
  override name = 'Incur.ParseError'

  constructor(options: ParseError.Options) {
    super(options.message, options.cause ? { cause: options.cause } : undefined)
  }
}

export declare namespace ParseError {
  /** Options for constructing a ParseError. */
  type Options = {
    /** Human-readable error message. */
    message: string
    /** The underlying cause. */
    cause?: Error | undefined
  }
}

/** Walks the cause chain, returning the deepest cause or the first matching cause. */
function walk(error: unknown, fn?: ((error: unknown) => boolean) | undefined): unknown {
  if (fn) {
    // Find first matching cause (not self)
    let current = (error as any)?.cause
    while (current) {
      if (fn(current)) return current
      current = (current as any)?.cause
    }
    return undefined
  }
  // Return deepest cause
  let current = error
  while ((current as any)?.cause) current = (current as any).cause
  return current
}
