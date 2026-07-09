import { BaseError } from '../Errors.js'
import type * as Rpc from './Rpc.js'

/** Error thrown by client transports. */
export class ClientError extends BaseError {
  override name = 'Incur.ClientError'
  /** Machine-readable error code. */
  code: string | undefined
  /** Full error envelope or diagnostic payload. */
  data: unknown | undefined
  /** RPC error object. */
  error: Rpc.Error | undefined
  /** Field validation errors. */
  fieldErrors: Rpc.Error['fieldErrors'] | undefined
  /** Response metadata. */
  meta: Rpc.Meta | undefined
  /** Whether the operation can be retried. */
  retryable: boolean | undefined
  /** HTTP status when available. */
  status: number | undefined

  constructor(message: string, options: ClientError.Options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.code = options.code
    this.data = options.data
    this.error = options.error
    this.fieldErrors = options.fieldErrors
    this.meta = options.meta
    this.retryable = options.retryable
    this.status = options.status
  }
}

export declare namespace ClientError {
  /** Client error constructor options. */
  type Options = BaseError.Options & {
    /** Machine-readable error code. */
    code?: string | undefined
    /** Full error envelope or diagnostic payload. */
    data?: unknown | undefined
    /** RPC error object. */
    error?: Rpc.Error | undefined
    /** Field validation errors. */
    fieldErrors?: Rpc.Error['fieldErrors'] | undefined
    /** Response metadata. */
    meta?: Rpc.Meta | undefined
    /** Whether the operation can be retried. */
    retryable?: boolean | undefined
    /** HTTP status when available. */
    status?: number | undefined
  }
}
