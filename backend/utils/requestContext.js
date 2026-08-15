'use strict'
/**
 * Per-request context.
 * ─────────────────────────────────────────────────────────────────────────────
 * Carries a request id from the Express middleware down to every logger call
 * made while handling that request, without threading it through hundreds of
 * signatures. AsyncLocalStorage keeps the value attached across awaits, so a
 * log written from deep inside routes/trades.js still lands on the right id.
 *
 * The id also goes out on the X-Request-ID response header and is accepted on
 * the way in, so a frontend error report and its backend log line can be
 * matched up without guessing from timestamps.
 *
 * Reading it is deliberately non-throwing: plenty of code (the trade engine's
 * interval loops, the email worker, startup) runs outside any request, and
 * those callers get undefined rather than an error.
 */

const { AsyncLocalStorage } = require('node:async_hooks')
const { randomUUID } = require('node:crypto')

const storage = new AsyncLocalStorage()

// Bounded so a hostile or broken client cannot push an unbounded string into
// every log line, and stripped to characters that stay readable in a log grep.
const MAX_INBOUND_ID_LENGTH = 64
const SAFE_ID = /^[A-Za-z0-9._:-]+$/

function normalizeIncomingId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().slice(0, MAX_INBOUND_ID_LENGTH)
  if (!trimmed || !SAFE_ID.test(trimmed)) return null
  return trimmed
}

/** The id for the in-flight request, or undefined outside of one. */
function getRequestId() {
  return storage.getStore()?.requestId
}

/** Runs `fn` with `context` attached to the current async execution. */
function runWithContext(context, fn) {
  return storage.run(context, fn)
}

/**
 * Express middleware. Honours an inbound X-Request-ID when it looks sane so a
 * trace survives a proxy hop, otherwise mints one.
 */
function requestContextMiddleware(req, res, next) {
  const requestId = normalizeIncomingId(req.headers['x-request-id']) || randomUUID()
  req.requestId = requestId
  res.setHeader('X-Request-ID', requestId)
  runWithContext({ requestId }, next)
}

module.exports = {
  getRequestId,
  runWithContext,
  requestContextMiddleware,
  normalizeIncomingId,
  MAX_INBOUND_ID_LENGTH
}
