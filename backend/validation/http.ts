import type { RequestHandler, Response as ExpressResponse } from 'express'
import type { z } from 'zod'

interface ValidationFailureBody {
  error: string
}

function sendValidationFailure(response: ExpressResponse, boundary: string): void {
  const body: ValidationFailureBody = { error: `Invalid ${boundary}` }
  response.status(400).json(body)
}

export function validateBody<T>(schema: z.ZodType<T>): RequestHandler {
  return (request, response, next): void => {
    const input: unknown = request.body
    const result = schema.safeParse(input)
    if (!result.success) {
      sendValidationFailure(response, 'request body')
      return
    }
    response.locals.validatedBody = result.data
    next()
  }
}

export function validateQuery<T>(schema: z.ZodType<T>): RequestHandler {
  return (request, response, next): void => {
    const input: unknown = request.query
    const result = schema.safeParse(input)
    if (!result.success) {
      sendValidationFailure(response, 'query parameters')
      return
    }
    response.locals.validatedQuery = result.data
    next()
  }
}

export function validateParams<T>(schema: z.ZodType<T>): RequestHandler {
  return (request, response, next): void => {
    const input: unknown = request.params
    const result = schema.safeParse(input)
    if (!result.success) {
      sendValidationFailure(response, 'route parameters')
      return
    }
    response.locals.validatedParams = result.data
    next()
  }
}
