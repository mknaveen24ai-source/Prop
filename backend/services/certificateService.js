'use strict'

const crypto = require('crypto')

const pool = require('../db')
const logger = require('../utils/logger')
const { signCertificate, verifyCertificateSignature } = require('../utils/certificateSignature')
const { getCertificateVerifyUrl } = require('../utils/publicUrl')
const { createUserNotification } = require('../utils/userNotifications')
const { resolveTemplateForKind } = require('./certificateTemplateService')

/**
 * The one path that mints a certificate. Nothing writes the table directly.
 *
 * issueCertificate() runs INSIDE THE CALLER'S TRANSACTION, matching the
 * convention domain/account.js documents: the aggregate never begins, commits
 * or rolls back. A certificate and the promotion or payout that earned it
 * therefore commit together or not at all — there is no window where a trader
 * has a certificate for a promotion that was rolled back.
 *
 * It emits NO side effects. Notification, socket and email are deliberately
 * split into deliverCertificate(), which callers invoke AFTER COMMIT. That is
 * the same shape routes/admin/payouts.js already uses, and for the same reason:
 * a mail or socket failure must never roll back money that has already moved.
 */

const CERTIFICATE_KINDS = ['phase_passed', 'funded', 'payout', 'custom']

const CERTIFICATE_COLUMNS = `
  id, public_id, user_id, account_id, template_id, kind, title, subtitle,
  recipient_name, amount, currency, metadata, status, revoked_at, revoked_reason,
  signature, issued_by, source_key, issued_at, created_at, updated_at
`

const PHASE_LABELS = {
  phase1: 'Phase 1 Challenge',
  phase2: 'Phase 2 Challenge',
  phase3: 'Phase 3 Challenge',
  funded: 'Funded Trader'
}

function formatAmountLabel(amount, currency = 'USD') {
  const number = Number(amount)
  if (!Number.isFinite(number)) return ''
  // Whole thousands read better unfractioned on a certificate: "$100,000"
  // rather than "$100,000.00". Cents still show when they exist.
  const hasCents = Math.round(number * 100) % 100 !== 0
  const formatted = number.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0
  })
  return currency && currency !== 'USD' ? `${formatted} ${currency}` : `$${formatted}`
}

/**
 * The single place certificate titles are worded. Kept here rather than at the
 * call sites so promotions, payouts, admin re-issues and manual awards cannot
 * drift into three different phrasings of the same award.
 */
function buildCertificateTitle({ kind, accountType, accountSize, amount, currency = 'USD' }) {
  switch (kind) {
    case 'funded':
      return `${formatAmountLabel(accountSize, currency)} Funded Trader`
    case 'phase_passed': {
      const label = PHASE_LABELS[String(accountType || '').toLowerCase()] || 'Challenge'
      const size = formatAmountLabel(accountSize, currency)
      return size ? `${label} — ${size}` : label
    }
    case 'payout':
      return `${formatAmountLabel(amount, currency)} Profit Payout`
    default:
      return 'Certificate of Achievement'
  }
}

/** PF-2026-0A7C-4E19 — the giftVouchers.js prefix + random hex convention. */
function generatePublicId(now = new Date()) {
  const year = now.getUTCFullYear()
  const block = () => crypto.randomBytes(2).toString('hex').toUpperCase()
  return `PF-${year}-${block()}-${block()}`
}

function isUniqueViolationOn(error, fragment) {
  return error
    && error.code === '23505'
    && String(error.constraint || error.detail || '').includes(fragment)
}

/**
 * Issue a certificate inside the caller's transaction.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db  caller's transaction client
 * @returns {Promise<{certificate: object, created: boolean}>}
 *   `created: false` means this sourceKey had already been issued — the normal,
 *   non-error outcome of a retried or double-submitted approval.
 */
async function issueCertificate(db, {
  userId,
  accountId = null,
  kind,
  title,
  subtitle = null,
  recipientName,
  amount = null,
  currency = 'USD',
  metadata = {},
  sourceKey = null,
  issuedBy = null
}) {
  const executor = db || pool

  if (!userId) throw new Error('issueCertificate requires a userId')
  if (!CERTIFICATE_KINDS.includes(kind)) throw new Error(`Unknown certificate kind: ${kind}`)
  if (!title) throw new Error('issueCertificate requires a title')

  const template = await resolveTemplateForKind(executor, kind)

  // issued_at is set here rather than left to the column default: the signature
  // covers it, so it has to be the exact value that lands in the row. A DEFAULT
  // NOW() would sign one timestamp and store another, and every certificate
  // would fail its own verification.
  const issuedAt = new Date()

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const draft = {
      public_id: generatePublicId(issuedAt),
      user_id: userId,
      kind,
      title,
      amount,
      issued_at: issuedAt
    }

    try {
      const result = await executor.query(
        `INSERT INTO certificates
           (public_id, user_id, account_id, template_id, kind, title, subtitle,
            recipient_name, amount, currency, metadata, signature, issued_by,
            source_key, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15)
         ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING
         RETURNING ${CERTIFICATE_COLUMNS}`,
        [
          draft.public_id,
          userId,
          accountId,
          template ? template.id : null,
          kind,
          title,
          subtitle,
          String(recipientName || 'Trader'),
          amount,
          currency,
          JSON.stringify(metadata || {}),
          signCertificate(draft),
          issuedBy,
          sourceKey,
          issuedAt
        ]
      )

      if (result.rows[0]) return { certificate: result.rows[0], created: true }

      // DO NOTHING fired: this sourceKey is already issued. Return the original
      // rather than erroring — a replayed engine event or a double-clicked
      // approve button is expected, not exceptional.
      const existing = await executor.query(
        `SELECT ${CERTIFICATE_COLUMNS} FROM certificates WHERE source_key = $1`,
        [sourceKey]
      )
      if (existing.rows[0]) return { certificate: existing.rows[0], created: false }

      throw new Error('Certificate insert conflicted but no existing row was found')
    } catch (error) {
      // A public_id collision is astronomically unlikely but cheap to retry;
      // anything else is a real failure and must surface.
      if (isUniqueViolationOn(error, 'public_id')) continue
      throw error
    }
  }

  throw new Error('Could not allocate a unique certificate ID after 5 attempts')
}

/**
 * Post-commit side effects: in-app notification, live socket push, and the
 * congratulation email.
 *
 * Never throws. The certificate is already committed by the time this runs, so
 * a socket hiccup or a full mail queue must not turn a successful promotion or
 * payout into a 500 for the admin who approved it.
 */
async function deliverCertificate(io, certificate, { email = null } = {}) {
  if (!certificate) return

  try {
    await createUserNotification(io, certificate.user_id, {
      type: 'success',
      title: 'Certificate Awarded',
      message: `Your "${certificate.title}" certificate is ready to view, download and share.`
    })

    if (io) {
      io.to(String(certificate.user_id)).emit('certificate_awarded', {
        public_id: certificate.public_id,
        kind: certificate.kind,
        title: certificate.title,
        recipient_name: certificate.recipient_name,
        amount: certificate.amount,
        currency: certificate.currency,
        issued_at: certificate.issued_at,
        verify_url: getCertificateVerifyUrl(certificate.public_id)
      })
    }

    if (email) {
      // Required lazily: utils/emailQueue.js pulls in the mailer, which reads
      // SMTP config at require time. Importing it at module scope would drag
      // that into every path that merely issues a certificate.
      const { enqueueCertificateAwardedEmail } = require('../utils/emailQueue')
      await enqueueCertificateAwardedEmail(email, certificate, { userId: certificate.user_id })
    }
  } catch (error) {
    logger.error('[certificates] Delivery failed after issue', {
      public_id: certificate.public_id,
      error: error.message
    })
  }
}

async function getByPublicId(db, publicId) {
  const executor = db || pool
  const result = await executor.query(
    `SELECT ${CERTIFICATE_COLUMNS} FROM certificates WHERE public_id = $1`,
    [String(publicId || '')]
  )
  return result.rows[0] || null
}

async function getById(db, id) {
  const executor = db || pool
  const result = await executor.query(
    `SELECT ${CERTIFICATE_COLUMNS} FROM certificates WHERE id = $1`,
    [id]
  )
  return result.rows[0] || null
}

async function listForUser(db, userId) {
  const executor = db || pool
  const result = await executor.query(
    `SELECT ${CERTIFICATE_COLUMNS}
       FROM certificates
      WHERE user_id = $1
      ORDER BY issued_at DESC`,
    [userId]
  )
  return result.rows
}

/**
 * Admin registry search. `q` matches the certificate ID, the snapshotted
 * recipient name, or the trader's current name/email — an admin looking someone
 * up will use whichever they have to hand.
 */
async function listCertificates(db, { q = '', kind = '', status = '', page = 1, pageSize = 25 } = {}) {
  const executor = db || pool
  const limit = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25))
  const offset = (Math.max(1, parseInt(page, 10) || 1) - 1) * limit

  const conditions = []
  const values = []

  const search = String(q || '').trim()
  if (search) {
    values.push(`%${search}%`)
    const p = `$${values.length}`
    conditions.push(`(c.public_id ILIKE ${p} OR c.recipient_name ILIKE ${p} OR u.full_name ILIKE ${p} OR u.email ILIKE ${p})`)
  }
  if (kind && CERTIFICATE_KINDS.includes(kind)) {
    values.push(kind)
    conditions.push(`c.kind = $${values.length}`)
  }
  if (status === 'active' || status === 'revoked') {
    values.push(status)
    conditions.push(`c.status = $${values.length}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const rows = await executor.query(
    `SELECT c.id, c.public_id, c.user_id, c.account_id, c.template_id, c.kind, c.title,
            c.subtitle, c.recipient_name, c.amount, c.currency, c.status, c.revoked_at,
            c.revoked_reason, c.signature, c.issued_by, c.issued_at,
            u.full_name AS user_full_name, u.email AS user_email
       FROM certificates c
       JOIN users u ON u.id = c.user_id
       ${where}
      ORDER BY c.issued_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    values
  )
  const total = await executor.query(
    `SELECT COUNT(*)::int AS count FROM certificates c JOIN users u ON u.id = c.user_id ${where}`,
    values
  )

  return {
    certificates: rows.rows,
    total: total.rows[0].count,
    page: Math.max(1, parseInt(page, 10) || 1),
    pageSize: limit
  }
}

async function revokeCertificate(db, id, { reason = null, actor = null } = {}) {
  const executor = db || pool
  const result = await executor.query(
    `UPDATE certificates
        SET status = 'revoked',
            revoked_at = NOW(),
            revoked_reason = $2,
            issued_by = COALESCE($3, issued_by),
            updated_at = NOW()
      WHERE id = $1
        AND status <> 'revoked'
      RETURNING ${CERTIFICATE_COLUMNS}`,
    [id, reason, actor]
  )
  return result.rows[0] || null
}

/**
 * Re-issue: a fresh certificate against the CURRENT template, superseding an
 * existing one. This is the sanctioned way to move a certificate onto a
 * redesigned template, since template_id is otherwise pinned forever.
 *
 * The original is revoked rather than deleted, so a QR already printed or
 * shared resolves to an explicit "superseded" answer instead of "not found".
 */
async function reissueCertificate(db, id, { actor = null } = {}) {
  const executor = db || pool
  const original = await getById(executor, id)
  if (!original) return null

  const issued = await issueCertificate(executor, {
    userId: original.user_id,
    accountId: original.account_id,
    kind: original.kind,
    title: original.title,
    subtitle: original.subtitle,
    recipientName: original.recipient_name,
    amount: original.amount,
    currency: original.currency,
    metadata: { ...(original.metadata || {}), reissued_from: original.public_id },
    sourceKey: null,
    issuedBy: actor
  })

  await executor.query(
    `UPDATE certificates
        SET status = 'revoked',
            revoked_at = NOW(),
            revoked_reason = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [original.id, `Superseded by ${issued.certificate.public_id}`]
  )

  return issued.certificate
}

/**
 * The public verification answer. Separated from the row read so the route,
 * the trader viewer and any future consumer all report the same verdict.
 */
function describeVerification(certificate) {
  if (!certificate) return { valid: false, status: 'not_found', signatureValid: false }
  const signatureValid = verifyCertificateSignature(certificate)
  return {
    valid: signatureValid && certificate.status === 'active',
    status: certificate.status === 'revoked' ? 'revoked' : (signatureValid ? 'active' : 'tampered'),
    signatureValid
  }
}

module.exports = {
  CERTIFICATE_KINDS,
  CERTIFICATE_COLUMNS,
  buildCertificateTitle,
  formatAmountLabel,
  generatePublicId,
  issueCertificate,
  deliverCertificate,
  getByPublicId,
  getById,
  listForUser,
  listCertificates,
  revokeCertificate,
  reissueCertificate,
  describeVerification
}
