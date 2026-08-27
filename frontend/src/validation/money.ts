import type { DecimalString } from '@propfirm/contracts'
import Decimal from 'decimal.js'
import { z } from 'zod'

export const decimalStringSchema: z.ZodType<DecimalString> = z.string().regex(
  /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/
)

export function parseWireMoney(input: unknown): Decimal {
  const result = decimalStringSchema.safeParse(input)
  if (!result.success) throw new Error('Invalid wire-format money')
  const value = new Decimal(result.data)
  if (!value.isFinite()) throw new Error('Invalid wire-format money')
  return value
}
