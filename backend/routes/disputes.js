const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const logger = require('../utils/logger')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const { sanitizeString } = require('../utils/validation')
const { runWithSystemDbContext } = require('../utils/dbContext')

let disputesInfrastructurePromise = null

async function ensureDisputesInfrastructure() {
  if (disputesInfrastructurePromise) return disputesInfrastructurePromise

  disputesInfrastructurePromise = runWithSystemDbContext(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disputes (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL DEFAULT 1,
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
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS admin_response TEXT`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    await pool.query(`CREATE INDEX IF NOT EXISTS disputes_tenant_created_idx ON disputes(tenant_id, created_at DESC)`)
    await pool.query(`
      UPDATE disputes d
         SET tenant_id = COALESCE(d.tenant_id, u.tenant_id, 1)
        FROM users u
       WHERE d.user_id::text = u.id::text
         AND (d.tenant_id IS NULL OR d.tenant_id = 1)
    `).catch(() => {})
  }).catch((error) => {
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
    const { userId } = req.user
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const { account_id, reason, description } = req.body

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
          AND user_id = $2
          AND COALESCE(tenant_id, $3) = $3`,
      [account_id, userId, tenantId]
    )
    if (accountCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found or belongs to another user.' })
    }
    const accStatus = accountCheck.rows[0].status
    if (!['failed', 'expired'].includes(accStatus)) {
      return res.status(400).json({ error: 'Only failed or expired accounts can be disputed.' })
    }

    const result = await pool.query(
      `INSERT INTO disputes (tenant_id, user_id, account_id, reason, description, status)
       VALUES ($1, $2, $3, $4, $5, 'open')
       RETURNING id, status, created_at`,
      [tenantId, userId, account_id, reason, sanitizedDescription]
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
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const result = await pool.query(
      `SELECT d.*, a.account_size, a.status as account_status
       FROM disputes d
       JOIN accounts a ON d.account_id::text = a.id::text
       WHERE d.user_id::text = $1::text
         AND COALESCE(d.tenant_id, $2) = $2
       ORDER BY d.created_at DESC`,
      [String(userId), tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Fetch my-disputes error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch disputes' })
  }
})

module.exports = router
module.exports.ensureDisputesInfrastructure = ensureDisputesInfrastructure
