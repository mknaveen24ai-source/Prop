/**
 * Sentry Integration & Graceful Error Tracking Wrapper
 */

import type { ErrorRequestHandler, RequestHandler } from 'express'
import type * as SentryApi from '@sentry/node'
import logger = require('./logger')

function loadSentry(): typeof SentryApi {
  // Intentionally lazy: observability is optional and must not change backend
  // startup/module initialization when SENTRY_DSN is absent.
  return require('@sentry/node') as typeof SentryApi
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

let sentryInitialized = false

function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    logger.info('[Sentry] SENTRY_DSN not set. Sentry error tracking disabled (no-op).')
    return
  }

  try {
    const Sentry = loadSentry()
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1')
    })
    sentryInitialized = true
    logger.info('[Sentry] Sentry initialized successfully.')
  } catch (err: unknown) {
    logger.warn('[Sentry] Failed to initialize @sentry/node:', errorMessage(err))
  }
}

// FIX (SECURITY AUDIT): Sentry was a non-functional integration — the
// request/tracing handlers were hard-coded pass-throughs and the error
// handler never actually reported anything, so ordinary request errors were
// never sent to Sentry under any circumstance. Modern @sentry/node (v8+) no
// longer needs manual request/tracing middleware (auto-instrumentation via
// Sentry.init() handles that), but the error handler MUST call
// captureException itself — Express doesn't do this automatically.
function sentryRequestHandler(): RequestHandler {
  return (_req, _res, next): void => next()
}

function sentryTracingHandler(): RequestHandler {
  return (_req, _res, next): void => next()
}

function sentryErrorHandler(): ErrorRequestHandler {
  return (err: unknown, req, _res, next): void => {
    if (sentryInitialized) {
      captureException(err, {
        method: req?.method,
        path: req?.originalUrl || req?.url,
        userId: req?.user?.userId || null
      })
    }
    next(err)
  }
}

async function flushSentry(timeout = 2000): Promise<void> {
  if (sentryInitialized) {
    try {
      const Sentry = loadSentry()
      await Sentry.flush(timeout)
    } catch (_) {}
  }
}

function captureException(
  error: unknown,
  context: Record<string, unknown> = {}
): void {
  logger.error('[Sentry captureException]', { error: errorMessage(error), context })
  if (sentryInitialized) {
    try {
      const Sentry = loadSentry()
      Sentry.captureException(error, { extra: context })
    } catch (_) {}
  }
}

export {
  initSentry,
  sentryRequestHandler,
  sentryTracingHandler,
  sentryErrorHandler,
  flushSentry,
  captureException
}
