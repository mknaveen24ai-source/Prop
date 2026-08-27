/**
 * The single source of truth for the platform's public base URL.
 *
 * `process.env.FRONTEND_URL || 'http://localhost:3000'` was copy-pasted into
 * five files (mailer.js, routes/auth.js, routes/billing.js,
 * routes/affiliates.js, config/security-config.js). Certificate verification
 * links would have been the sixth. New callers should use this instead; the
 * existing five are left alone deliberately — folding them in is a mechanical
 * change that belongs in its own commit, not smuggled into a feature.
 */

const DEFAULT_BASE_URL = 'http://localhost:3000'

function getPublicBaseUrl(): string {
  const configured = String(process.env.FRONTEND_URL || '').trim()
  // Trailing slashes are stripped so callers can always template `${base}/path`
  // without producing a double slash.
  return (configured || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/** Absolute public URL for the verification page of a given certificate. */
function getCertificateVerifyUrl(publicId: unknown): string {
  return `${getPublicBaseUrl()}/verify/${encodeURIComponent(String(publicId))}`
}

export { getPublicBaseUrl, getCertificateVerifyUrl, DEFAULT_BASE_URL }
