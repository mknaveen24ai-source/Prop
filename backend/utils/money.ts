import type { DecimalString } from '@propfirm/contracts'
import Decimal from 'decimal.js'
import { z } from 'zod'

const decimalSyntax = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

export const decimalStringSchema: z.ZodType<DecimalString> = z.string().regex(decimalSyntax)

export interface DecimalParseOptions {
  allowNegative?: boolean
  maxIntegerDigits?: number
  maxScale?: number
}

export class DecimalStringError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DecimalStringError'
  }
}

function countDigits(value: DecimalString): { integer: number; scale: number } {
  const unsigned = value.startsWith('-') ? value.slice(1) : value
  const [integerPart = '', fractionPart = ''] = unsigned.split('.')
  return { integer: integerPart.length, scale: fractionPart.length }
}

export function parseDecimalString(
  input: unknown,
  options: DecimalParseOptions = {}
): Decimal {
  const result = decimalStringSchema.safeParse(input)
  if (!result.success) throw new DecimalStringError('Expected a non-exponent decimal string')

  const { allowNegative = true, maxIntegerDigits = 100, maxScale = 18 } = options
  const digits = countDigits(result.data)
  if (digits.integer > maxIntegerDigits) {
    throw new DecimalStringError(`Decimal exceeds ${maxIntegerDigits} integer digits`)
  }
  if (digits.scale > maxScale) {
    throw new DecimalStringError(`Decimal exceeds ${maxScale} fractional digits`)
  }

  const value = new Decimal(result.data)
  if (!value.isFinite()) throw new DecimalStringError('Decimal must be finite')
  if (!allowNegative && value.isNegative()) throw new DecimalStringError('Decimal must not be negative')
  return value
}

export function serializeDecimal(value: Decimal): DecimalString {
  if (!value.isFinite()) throw new DecimalStringError('Decimal must be finite')
  if (value.isZero()) return '0'
  return value.toFixed()
}
