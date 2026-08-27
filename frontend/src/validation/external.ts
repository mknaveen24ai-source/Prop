import type { z } from 'zod'

export class ExternalDataError extends Error {
  public readonly issues: z.core.$ZodIssue[]

  public constructor(boundary: string, issues: z.core.$ZodIssue[]) {
    super(`Invalid ${boundary}`)
    this.name = 'ExternalDataError'
    this.issues = issues
  }
}

export function parseExternal<T>(schema: z.ZodType<T>, input: unknown, boundary: string): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new ExternalDataError(boundary, result.error.issues)
  return result.data
}

export async function parseJsonResponse<T>(
  response: Pick<Response, 'json'>,
  schema: z.ZodType<T>,
  boundary: string
): Promise<T> {
  const input: unknown = await response.json()
  return parseExternal(schema, input, boundary)
}
