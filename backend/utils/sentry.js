/**
 * Sentry Integration & Graceful Error Tracking Wrapper
 */

const logger = require('./logger')

let sentryInitialized = false

function initSentry() {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) {
    logger.info('[Sentry] SENTRY_DSN not set. Sentry error tracking disabled (no-op).')
    return
  }

  try {
    const Sentry = require('@sentry/node')
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1')
    })
    sentryInitialized = true
    logger.info('[Sentry] Sentry initialized successfully.')
  } catch (err) {
    logger.warn('[Sentry] Failed to initialize @sentry/node:', err.message)
  }
}

// FIX (SECURITY AUDIT): Sentry was a non-functional integration — the
// request/tracing handlers were hard-coded pass-throughs and the error
// handler never actually reported anything, so ordinary request errors were
// never sent to Sentry under any circumstance. Modern @sentry/node (v8+) no
// longer needs manual request/tracing middleware (auto-instrumentation via
// Sentry.init() handles that), but the error handler MUST call
// captureException itself — Express doesn't do this automatically.
function sentryRequestHandler() {
  return (req, res, next) => next()
}

function sentryTracingHandler() {
  return (req, res, next) => next()
}

function sentryErrorHandler() {
  return (err, req, res, next) => {
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

async function flushSentry(timeout = 2000) {
  if (sentryInitialized) {
    try {
      const Sentry = require('@sentry/node')
      await Sentry.flush(timeout)
    } catch (_) {}
  }
}

function captureException(error, context = {}) {
  logger.error('[Sentry captureException]', { error: error?.message || error, context })
  if (sentryInitialized) {
    try {
      const Sentry = require('@sentry/node')
      Sentry.captureException(error, { extra: context })
    } catch (_) {}
  }
}

module.exports = {
  initSentry,
  sentryRequestHandler,
  sentryTracingHandler,
  sentryErrorHandler,
  flushSentry,
  captureException
}
