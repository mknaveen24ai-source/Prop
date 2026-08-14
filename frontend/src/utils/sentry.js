/**
 * Frontend error monitoring.
 *
 * VITE_SENTRY_DSN was defined in frontend/.env for a long time with no SDK
 * installed and no code reading it, so every client-side production error was
 * invisible. This wires it up for real.
 *
 * Disabled by default: with no DSN configured (local dev, or a deploy that has
 * not set FRONTEND_SENTRY_DSN) initSentry() is a no-op and nothing is sent.
 */

import * as Sentry from '@sentry/react'

const DSN = import.meta.env.VITE_SENTRY_DSN
const RELEASE = import.meta.env.VITE_APP_VERSION || '0.0.0'

let enabled = false

/** Field names that must never leave the browser, even inside a stack frame. */
const SENSITIVE_KEYS = /pass(word)?|secret|token|jwt|authorization|cookie|otp|totp|cvv|card|iban|ssn/i

function scrub(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return obj
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEYS.test(key)) obj[key] = '[redacted]'
    else if (typeof obj[key] === 'object') scrub(obj[key], depth + 1)
  }
  return obj
}

export function initSentry() {
  if (!DSN) return

  Sentry.init({
    dsn: DSN,
    release: RELEASE,
    environment: import.meta.env.MODE,

    // Performance sampling is deliberately low — this is a trading UI with very
    // chatty polling, and a high rate would blow through the quota in hours.
    tracesSampleRate: 0.1,
    // Only record a session replay when something actually broke.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1.0,

    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true })
    ],

    // Browser-extension and third-party noise that is not our bug.
    ignoreErrors: [
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
      /^Network Error$/,
      /Loading chunk \d+ failed/
    ],

    beforeSend(event) {
      if (event.request?.headers) delete event.request.headers
      if (event.request?.cookies) delete event.request.cookies
      if (event.extra) scrub(event.extra)
      if (event.contexts) scrub(event.contexts)
      return event
    }
  })

  enabled = true
}

/** Attach the signed-in user so errors are attributable. Never send email/PII. */
export function setSentryUser(user) {
  if (!enabled) return
  Sentry.setUser(user ? { id: String(user.id ?? user.userId ?? '') } : null)
}

/** Manual capture for handled errors worth knowing about. */
export function captureError(error, context) {
  if (!enabled) return
  Sentry.captureException(error, context ? { extra: scrub({ ...context }) } : undefined)
}

export { Sentry }
