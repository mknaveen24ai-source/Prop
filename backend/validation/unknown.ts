import type { JsonValue } from '@propfirm/contracts'
import { z } from 'zod'

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema)
]))

export class BoundaryValidationError extends Error {
  public readonly issues: z.core.$ZodIssue[]

  public constructor(message: string, issues: z.core.$ZodIssue[]) {
    super(message)
    this.name = 'BoundaryValidationError'
    this.issues = issues
  }
}

export function parseUnknownJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  return parsed
}

export function parseExternal<T>(schema: z.ZodType<T>, input: unknown, boundary: string): T {
  const result = schema.safeParse(input)
  if (!result.success) {
    throw new BoundaryValidationError(`Invalid ${boundary}`, result.error.issues)
  }
  return result.data
}
