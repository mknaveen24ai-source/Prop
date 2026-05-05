// ── Environment variable validation ────────────────────────────────────────
// Called at server startup. In production, missing critical vars abort startup.
// In development, they warn so the server still starts for local testing.

const REQUIRED_IN_PROD = [
  'DATABASE_URL',
  'JWT_SECRET',
  'ADMIN_JWT_SECRET',
  'ADMIN_PASSWORD',    // required to log into the admin panel
]

const RECOMMENDED = [
  'FRONTEND_URL',
  'PORT',
  'DWX_PATH',
  'PRICE_HISTORY_RETAIN_DAYS',
  'PRICE_HISTORY_1H_RETAIN_DAYS',
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
]

function validateEnv() {
  const missingCritical    = REQUIRED_IN_PROD.filter(k => !process.env[k])
  const missingRecommended = RECOMMENDED.filter(k => !process.env[k])

  const isProd = process.env.NODE_ENV === 'production'

  if (isProd && missingCritical.length > 0) {
    // Hard fail in production — server must not start without these
    console.error('[env] FATAL: Missing required environment variables:', missingCritical.join(', '))
    process.exit(1)
  }

  if (!isProd && missingCritical.length > 0) {
    console.warn('[env] Missing critical vars (server still starts in dev):', missingCritical.join(', '))
  }

  if (missingRecommended.length > 0) {
    console.warn('[env] Missing recommended vars:', missingRecommended.join(', '))
  }
}

module.exports = { validateEnv }
