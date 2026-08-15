const express = require('express')
const router = express.Router()
const fs = require('fs')
const path = require('path')
const pool = require('../db')
const { authenticateToken, authenticateAdmin } = require('./middleware')
const logger = require('../utils/logger')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const { sanitizeString } = require('../utils/validation')
const { ensureViolationTables } = require('../services/violationEngine')

const EVIDENCE_UPLOAD_ROOT = path.join(__dirname, '../uploads/dispute-evidence')

// Mirrors trades.js's persistTradeScreenshot pattern (data-URL in, relative
// path out) — evidence is a broker statement / platform screenshot, so PDF
// is allowed alongside images, unlike trade screenshots.
async function persistDisputeEvidence({ userId, dataUrl }) {
  if (typeof dataUrl !== 'string') return null
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg)|application\/pdf);base64,(.+)$/i)
  if (!match) return null

  const mime = match[1].toLowerCase()
  const ext = mime === 'application/pdf' ? 'pdf' : (mime.includes('png') ? 'png' : 'jpg')
  const buffer = Buffer.from(match[2], 'base64')
  // Capped well under the app's global express.json() body limit (1MB,
  // server.js) — this arrives as JSON (data URL in the request body, same
  // as trades.js's screenshot uploads), not multipart, so the whole request
  // has to fit inside that ceiling alongside the rest of the form fields.
  if (!buffer.length || buffer.length > 600_000) return null

  const userPart = sanitizeString(String(userId || 'user'), 64) || 'user'
  const absoluteDir = path.join(EVIDENCE_UPLOAD_ROOT, userPart)
  await fs.promises.mkdir(absoluteDir, { recursive: true })

  const filename = `evidence-${Date.now()}.${ext}`
  const absolutePath = path.join(absoluteDir, filename)
  await fs.promises.writeFile(absolutePath, buffer)

  return path.join(userPart, filename).replace(/\\/g, '/')
}

let disputesInfrastructurePromise = null

async function ensureDisputesInfrastructure() {
  if (disputesInfrastructurePromise) return disputesInfrastructurePromise

  disputesInfrastructurePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disputes (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_id TEXT,
        reason TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        admin_response TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS admin_response TEXT`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    // Soft link to the system-flagged breach being appealed (nullable — best-effort,
    // populated at submission time from the account's most recent violation row).
    // No hard FK: admin_rule_violations lives behind a separate lazy-init guard
    // (ensureViolationTables), same soft-reference convention used elsewhere here.
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS violation_id BIGINT`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS evidence_path TEXT`)
    await pool.query(`CREATE INDEX IF NOT EXISTS disputes_created_idx ON disputes(created_at DESC)`)
  })().catch((error) => {
    disputesInfrastructurePromise = null
    throw error
  })

  return disputesInfrastructurePromise
}

// FIX: Rate limit dispute submissions — max 3 per 24 hours per user.
// Without this a banned/failed user could spam thousands of dispute records.
const disputeLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: { error: 'You can only submit 3 disputes per day. Please contact support directly if you need further assistance.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId ? `user:${String(req.user.userId)}` : ipKeyGenerator(req)
})

// Allowed dispute reasons (allowlist — prevents freeform injection into admin queues)
const VALID_REASONS = [
  'Incorrect drawdown calculation',
  'Technical issue during challenge',
  'Price feed error',
  'Incorrect trade closure',
  'Account expired incorrectly',
  'Other'
]

// POST /api/disputes/submit
router.post('/submit', authenticateToken, disputeLimiter, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    await ensureViolationTables()
    const { userId } = req.user
    const { account_id, reason, description, evidence_data_url } = req.body

    if (!account_id || !reason || !description) {
      return res.status(400).json({ error: 'All fields are required.' })
    }

    // FIX: Validate reason against allowlist — prevents freeform injection
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({ error: 'Invalid dispute reason. Please select from the provided options.' })
    }

    // FIX: Sanitize and length-limit description
    const sanitizedDescription = sanitizeString(String(description), 2000)
    if (!sanitizedDescription || sanitizedDescription.length < 20) {
      return res.status(400).json({ error: 'Description must be at least 20 characters.' })
    }

    // Verify account belongs to user and is failed/expired
    const accountCheck = await pool.query(
      `SELECT status
         FROM accounts
        WHERE id = $1
          AND user_id = $2`,
      [account_id, userId]
    )
    if (accountCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found or belongs to another user.' })
    }
    const accStatus = accountCheck.rows[0].status
    if (!['failed', 'expired'].includes(accStatus)) {
      return res.status(400).json({ error: 'Only failed or expired accounts can be disputed.' })
    }

    // Best-effort link to the breach being appealed — the most recent
    // system-flagged violation on this account, if any.
    const violationLookup = await pool.query(
      `SELECT id FROM admin_rule_violations
        WHERE account_id = $1
        ORDER BY last_detected_at DESC
        LIMIT 1`,
      [String(account_id)]
    )
    const violationId = violationLookup.rows[0]?.id || null

    let evidencePath = null
    if (evidence_data_url) {
      evidencePath = await persistDisputeEvidence({ userId, dataUrl: evidence_data_url })
      if (!evidencePath) {
        return res.status(400).json({ error: 'Evidence file must be a JPG, PNG or PDF under 600KB.' })
      }
    }

    const result = await pool.query(
      `INSERT INTO disputes (user_id, account_id, reason, description, status, violation_id, evidence_path)
       VALUES ($1, $2, $3, $4, 'open', $5, $6)
       RETURNING id, status, created_at, violation_id, evidence_path`,
      [userId, account_id, reason, sanitizedDescription, violationId, evidencePath]
    )

    res.json({ message: 'Dispute submitted successfully', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Submit dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit dispute' })
  }
})

// GET /api/disputes/my-disputes
router.get('/my-disputes', authenticateToken, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    const { userId } = req.user
    const result = await pool.query(
      `SELECT d.*, a.account_size, a.status as account_status, a.account_uid,
              v.violation_type, v.message AS violation_message, v.first_detected_at AS violation_detected_at
       FROM disputes d
       JOIN accounts a ON d.account_id::text = a.id::text
       LEFT JOIN admin_rule_violations v ON v.id = d.violation_id
       WHERE d.user_id::text = $1::text
       ORDER BY d.created_at DESC`,
      [String(userId)]
    )
    res.json(result.rows.map((row) => ({ ...row, has_evidence: Boolean(row.evidence_path) })))
  } catch (error) {
    logger.error('Fetch my-disputes error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch disputes' })
  }
})

// GET /api/disputes/violation-context/:account_id — the most recent system-
// flagged breach on this account, shown alongside the appeal form as context
// before submission (the prototype's "Violation under appeal" card).
router.get('/violation-context/:account_id', authenticateToken, async (req, res) => {
  try {
    await ensureViolationTables()
    const { userId } = req.user
    const { account_id } = req.params

    const accountCheck = await pool.query(
      `SELECT id, account_uid FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const violation = await pool.query(
      `SELECT id, violation_type, message, first_detected_at, severity
         FROM admin_rule_violations
        WHERE account_id = $1
        ORDER BY last_detected_at DESC
        LIMIT 1`,
      [String(account_id)]
    )

    res.json({
      account_uid: accountCheck.rows[0].account_uid,
      violation: violation.rows[0] || null
    })
  } catch (error) {
    logger.error('Fetch violation context error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch violation context' })
  }
})

// GET /api/disputes/overturn-rates — platform-wide, by dispute reason: what
// share of *decided* appeals (resolved or rejected — still-open ones don't
// count yet) came back in the trader's favor. Omits reasons with no decided
// appeals yet rather than showing a fabricated 0%/blank bar.
router.get('/overturn-rates', authenticateToken, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    const result = await pool.query(
      `SELECT reason,
              COUNT(*) FILTER (WHERE status = 'resolved')::int AS resolved_count,
              COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count
         FROM disputes
        WHERE status IN ('resolved', 'rejected')
        GROUP BY reason
        ORDER BY (COUNT(*) FILTER (WHERE status = 'resolved') + COUNT(*) FILTER (WHERE status = 'rejected')) DESC
        LIMIT 3`
    )
    const rates = result.rows
      .map((row) => {
        const decided = row.resolved_count + row.rejected_count
        if (decided === 0) return null
        return {
          label: row.reason,
          pct: Math.round((row.resolved_count / decided) * 100),
          decided_count: decided
        }
      })
      .filter(Boolean)
    res.json(rates)
  } catch (error) {
    logger.error('Fetch overturn rates error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch overturn rates' })
  }
})

// ─── Admin ───────────────────────────────────────────────────────────────────
// These two moved here from server.js, where they sat inline below the
// `app.use('/api/disputes', ...)` mount. The user-facing handlers that sat
// beside them were dead (shadowed by this router); these were still reachable
// because the router defines no matching GET /all or PATCH /:id, so Express
// fell through to them. Registered ahead of the `/:id/*` routes below so the
// literal `/all` path can never be captured as an `:id`.
//
// The joins cast both sides to text: `disputes.user_id`/`account_id` are TEXT
// (see ensureDisputesInfrastructure above) while `users.id`/`accounts.id` may
// not be, and the same casting convention is already used by /my-disputes.

// GET /api/disputes/all
router.get('/all', authenticateAdmin, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    const result = await pool.query(
      `SELECT d.*, u.email, u.full_name, u.trader_uid,
              a.account_uid, a.account_type, a.account_size, a.status AS account_status
         FROM disputes d
         JOIN users u ON d.user_id::text = u.id::text
         LEFT JOIN accounts a ON d.account_id::text = a.id::text
        ORDER BY d.created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Fetch all disputes error:', { error: error.message })
    res.status(500).json({ error: 'Could not load disputes.' })
  }
})

// PATCH /api/disputes/:id
router.patch('/:id', authenticateAdmin, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    const { id } = req.params
    const { status, admin_response } = req.body
    const valid = ['open', 'under_review', 'resolved', 'rejected']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
    }
    const result = await pool.query(
      `UPDATE disputes SET status = $1, admin_response = $2, updated_at = NOW()
        WHERE id = $3 RETURNING *`,
      [status, admin_response || null, id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' })
    res.json({ message: 'Dispute updated', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Update dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not update dispute' })
  }
})

// GET /api/disputes/:id/evidence — serves the uploaded evidence file back to
// the dispute's owner. Path-traversal guarded the same way trades.js's
// screenshot route and admin.js's KYC document route are.
router.get('/:id/evidence', authenticateToken, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    const { userId } = req.user
    const { id } = req.params

    const result = await pool.query(
      `SELECT evidence_path FROM disputes WHERE id = $1 AND user_id::text = $2::text`,
      [id, String(userId)]
    )
    if (result.rows.length === 0 || !result.rows[0].evidence_path) {
      return res.status(404).json({ error: 'Evidence not found' })
    }

    const relPath = result.rows[0].evidence_path
    const absoluteFilePath = path.resolve(EVIDENCE_UPLOAD_ROOT, relPath)
    if (!absoluteFilePath.startsWith(path.resolve(EVIDENCE_UPLOAD_ROOT) + path.sep)) {
      return res.status(400).json({ error: 'Invalid evidence path' })
    }
    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'Evidence file missing' })
    }

    res.sendFile(absoluteFilePath)
  } catch (error) {
    logger.error('Fetch dispute evidence error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch evidence' })
  }
})

module.exports = router
module.exports.ensureDisputesInfrastructure = ensureDisputesInfrastructure
