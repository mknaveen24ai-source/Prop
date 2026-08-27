import type { JsonValue } from './primitives'

/** Existing endpoints use one of these bodies; migration preserves that choice. */
export type LegacyErrorResponse =
  | { error: string }
  | { message: string }

export interface ErrorResponseV1 {
  error: {
    code: string
    message: string
    details?: JsonValue
  }
}

export interface SocketErrorV1 {
  version: 1
  code: string
  message: string
  retryable: boolean
  details?: JsonValue
}
