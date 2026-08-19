'use strict'

const crypto = require('crypto')

/**
 * Certificate integrity signature.
 *
 * The public verification page recomputes this from the stored row and reports
 * a mismatch as tampered. That is what makes verification a real integrity
 * check on the database row rather than a decorative "verified" badge — if
 * someone edits `title` or `amount` directly in the database, the page says so.
 *
 * Key resolution mirrors secureKycStorage.getEncryptionKey(): a dedicated
 * secret, falling back to JWT_SECRET outside production so local development
 * and the test suite work with no extra configuration, and throwing in
 * production rather than silently signing everything with a guessable key.
 */

const SIGNATURE_DISPLAY_LENGTH = 32

function getSigningKey() {
  const secret = process.env.CERTIFICATE_SIGNING_SECRET
    || (process.env.NODE_ENV === 'production' ? '' : process.env.JWT_SECRET)

  if (!secret) {
    const error = new Error('Certificate signing secret is not configured')
    error.code = 'CERTIFICATE_SIGNING_NOT_CONFIGURED'
    throw error
  }
  return crypto.createHash('sha256').update(String(secret)).digest()
}

/**
 * Canonical string signed for a certificate.
 *
 * Every field here is one a forger would want to change. `issued_at` is
 * normalised to an ISO string because pg hands back a Date on read but the
 * caller has a string on write — signing the raw value would make a
 * freshly-issued certificate fail its own verification on the next request.
 * `amount` is normalised through Number for the same reason: NUMERIC comes back
 * as the string '4500.00' but is written as the number 4500.
 */
function buildSignaturePayload(certificate) {
  const issuedAt = certificate.issued_at instanceof Date
    ? certificate.issued_at.toISOString()
    : new Date(certificate.issued_at).toISOString()

  const amount = certificate.amount === null || certificate.amount === undefined || certificate.amount === ''
    ? ''
    : Number(certificate.amount).toFixed(2)

  return [
    String(certificate.public_id || ''),
    String(certificate.user_id || ''),
    String(certificate.kind || ''),
    String(certificate.title || ''),
    amount,
    issuedAt
  ].join('|')
}

function signCertificate(certificate) {
  return crypto
    .createHmac('sha256', getSigningKey())
    .update(buildSignaturePayload(certificate))
    .digest('hex')
    .slice(0, SIGNATURE_DISPLAY_LENGTH)
}

/**
 * Constant-time comparison. A certificate ID is public and an attacker can
 * request verification as often as they like, so a byte-by-byte early return
 * would leak the expected signature a character at a time.
 */
function verifyCertificateSignature(certificate) {
  try {
    const expected = Buffer.from(signCertificate(certificate), 'utf8')
    const actual = Buffer.from(String(certificate.signature || ''), 'utf8')
    if (expected.length !== actual.length) return false
    return crypto.timingSafeEqual(expected, actual)
  } catch {
    // An unconfigured signing key must not read as "this certificate is valid".
    return false
  }
}

/** Human-facing grouping: 4a7c9e1f… -> "4A7C 9E1F …" */
function formatSignatureForDisplay(signature) {
  return String(signature || '').toUpperCase().replace(/(.{4})/g, '$1 ').trim()
}

module.exports = {
  signCertificate,
  verifyCertificateSignature,
  buildSignaturePayload,
  formatSignatureForDisplay,
  SIGNATURE_DISPLAY_LENGTH
}
