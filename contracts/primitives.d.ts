/** A validated decimal string. Runtime validation remains authoritative. */
export type DecimalString = string

/** An RFC 3339/ISO-8601 timestamp string. */
export type IsoTimestamp = string

export type UserId = string
export type AdminId = string
export type AccountId = string
export type TradeId = string
export type PayoutId = string
export type CertificateId = string

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
