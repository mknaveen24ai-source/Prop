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
  'KYC_FILE_ENCRYPTION_KEY',
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

// ── Production safety checks ───────────────────────────────────────────────
// Used by scripts/deploy-preflight.js (and covered by test/env.test.js) to
// catch env vars that are *present* but hold a default/placeholder/weak value
// that would be unsafe to run in production.

function getMissingProductionEnvVars() {
  return REQUIRED_IN_PROD.filter(k => !process.env[k])
}

const MIN_SECRET_LENGTH = 32
const PLACEHOLDER_PATTERN = /your-|changeme|change-me|example|placeholder|password|default/i

function isUnsafeSecret(value) {
  return value.length < MIN_SECRET_LENGTH || PLACEHOLDER_PATTERN.test(value)
}

function isUnsafeHexKey(value) {
  return !/^[0-9a-f]{32,}$/i.test(value)
}

function isUnsafeDatabaseUrl(value) {
  return /:\/\/postgres:postgres@/i.test(value) || /@(localhost|127\.0\.0\.1)[:/]/i.test(value)
}

const ESP_TECHNICAL_DOMAIN_PATTERN = /@[^@]*(smtp-brevo\.com|sendgrid\.net|mailgun\.org|amazonses\.com|resend\.dev|mailtrap\.io)$/i

function isUnsafeSmtpFrom(smtpFrom, smtpUser) {
  if (smtpFrom === smtpUser) return true
  return ESP_TECHNICAL_DOMAIN_PATTERN.test(smtpFrom)
}

function getUnsafeProductionEnvVars() {
  const unsafe = []

  for (const key of ['JWT_SECRET', 'ADMIN_JWT_SECRET', 'KYC_FILE_ENCRYPTION_KEY']) {
    if (process.env[key] && isUnsafeSecret(process.env[key])) unsafe.push(key)
  }

  if (process.env.TOTP_ENCRYPTION_KEY && isUnsafeHexKey(process.env.TOTP_ENCRYPTION_KEY)) {
    unsafe.push('TOTP_ENCRYPTION_KEY')
  }

  if (process.env.DATABASE_URL && isUnsafeDatabaseUrl(process.env.DATABASE_URL)) {
    unsafe.push('DATABASE_URL')
  }

  if (process.env.SMTP_FROM && isUnsafeSmtpFrom(process.env.SMTP_FROM, process.env.SMTP_USER)) {
    unsafe.push('SMTP_FROM')
  }

  if (process.env.TRUST_PROXY && process.env.TRUST_PROXY.toLowerCase() !== 'true') {
    unsafe.push('TRUST_PROXY')
  }

  if (process.env.ADMIN_PASSWORD && isUnsafeSecret(process.env.ADMIN_PASSWORD)) {
    unsafe.push('ADMIN_PASSWORD')
  }

  return unsafe
}

module.exports = { validateEnv, getMissingProductionEnvVars, getUnsafeProductionEnvVars }
