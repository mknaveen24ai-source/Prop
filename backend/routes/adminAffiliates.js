const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const logger = require('../utils/logger')
const { sanitizeString } = require('../utils/validation')
const {
  fetchAllAffiliatesForAdmin,
  fetchAffiliateSummary,
  fetchAffiliateReferrals,
  fetchAffiliateCommissions,
  fetchAffiliatePayouts,
  markCommissionsPaidForPayout,
  insertBalanceAdjustment,
  fetchAffiliateTiers,
  createAffiliateTier,
  updateAffiliateTier
} = require('../utils/affiliates')
const {
  enqueueAffiliatePayoutApprovedEmail,
  enqueueAffiliatePayoutRejectedEmail
} = require('../utils/emailQueue')
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = require('./admin')._internals

async function auditLog(req, eventType, entityId, payload) {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'affiliate',
      entityId: String(entityId),
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (err) {
    logger.warn('[admin-affiliates] Non-critical audit log failed:', { error: err.message })
  }
}

// GET /admin/affiliates — list of users who have at least one referral.
router.get('/affiliates', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20))
    const result = await fetchAllAffiliatesForAdmin({ search: req.query.search, page, pageSize })
    res.json(result)
  } catch (err) {
    logger.error('[admin-affiliates] Failed to list affiliates:', { error: err.message })
    res.status(500).json({ error: 'Failed to load affiliates' })
  }
})

// GET /admin/affiliates/payouts — approval queue. Placed before /affiliates/:userId
// so the literal path "payouts" never gets swallowed by the :userId param route.
router.get('/affiliates/payouts', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const status = ['pending', 'paid', 'rejected'].includes(req.query.status) ? req.query.status : null
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20))
    const offset = (page - 1) * pageSize

    const [result, countResult] = await Promise.all([
      pool.query(
        `SELECT pr.*, u.full_name, u.email
           FROM affiliate_payout_requests pr
           JOIN users u ON u.id = pr.affiliate_user_id
          WHERE ($1::text IS NULL OR pr.status = $1)
          ORDER BY pr.requested_at DESC
          LIMIT $2 OFFSET $3`,
        [status, pageSize, offset]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM affiliate_payout_requests WHERE ($1::text IS NULL OR status = $1)`,
        [status]
      )
    ])

    res.json({
      rows: result.rows.map(r => ({ ...r, amount_requested: parseFloat(r.amount_requested) })),
      total: countResult.rows[0]?.total || 0,
      page,
      pageSize
    })
  } catch (err) {
    logger.error('[admin-affiliates] Failed to list payout requests:', { error: err.message })
    res.status(500).json({ error: 'Failed to load affiliate payout requests' })
  }
})

// POST /admin/affiliates/payouts/approve
router.post('/affiliates/payouts/approve', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  let client
  try {
    const { payout_id, transaction_id } = req.body
    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    client = await pool.connect()
    await client.query('BEGIN')

    const payoutResult = await client.query(
      `SELECT pr.*, u.email, u.full_name
         FROM affiliate_payout_requests pr
         JOIN users u ON u.id = pr.affiliate_user_id
        WHERE pr.id = $1
        FOR UPDATE`,
      [payout_id]
    )
    const payout = payoutResult.rows[0]
    if (!payout) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout request not found' })
    }
    if (payout.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Payout request is not pending' })
    }

    const settledAmount = await markCommissionsPaidForPayout(client, payout.affiliate_user_id, payout.id)

    await client.query(
      `UPDATE affiliate_payout_requests
          SET status = 'paid', paid_at = NOW(), transaction_id = $2, updated_at = NOW()
        WHERE id = $1`,
      [payout.id, transaction_id || null]
    )

    await client.query('COMMIT')

    await auditLog(req, 'affiliate_payout_approved', payout.id, {
      affiliate_user_id: payout.affiliate_user_id,
      settled_amount: settledAmount
    })

    try {
      await enqueueAffiliatePayoutApprovedEmail(payout.email, payout.full_name, settledAmount, payout.payment_method, {
        userId: payout.affiliate_user_id
      })
    } catch (emailErr) {
      logger.warn('[admin-affiliates] Failed to enqueue payout approved email:', { error: emailErr.message })
    }

    res.json({ message: 'Affiliate payout marked as paid', settled_amount: settledAmount })
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    logger.error('[admin-affiliates] Failed to approve payout:', { error: err.message })
    res.status(500).json({ error: 'Failed to approve payout' })
  } finally {
    if (client) client.release()
  }
})

// POST /admin/affiliates/payouts/reject
router.post('/affiliates/payouts/reject', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const { payout_id, reason } = req.body
    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    const payoutResult = await pool.query(
      `SELECT pr.*, u.email, u.full_name
         FROM affiliate_payout_requests pr
         JOIN users u ON u.id = pr.affiliate_user_id
        WHERE pr.id = $1`,
      [payout_id]
    )
    const payout = payoutResult.rows[0]
    if (!payout) return res.status(404).json({ error: 'Payout request not found' })
    if (payout.status !== 'pending') return res.status(400).json({ error: 'Payout request is not pending' })

    const reasonText = sanitizeString(String(reason || ''), 500) || null
    await pool.query(
      `UPDATE affiliate_payout_requests
          SET status = 'rejected', admin_notes = $2, updated_at = NOW()
        WHERE id = $1`,
      [payout.id, reasonText]
    )

    await auditLog(req, 'affiliate_payout_rejected', payout.id, {
      affiliate_user_id: payout.affiliate_user_id,
      reason: reasonText
    })

    try {
      await enqueueAffiliatePayoutRejectedEmail(payout.email, payout.full_name, parseFloat(payout.amount_requested), reasonText, {
        userId: payout.affiliate_user_id
      })
    } catch (emailErr) {
      logger.warn('[admin-affiliates] Failed to enqueue payout rejected email:', { error: emailErr.message })
    }

    res.json({ message: 'Affiliate payout rejected' })
  } catch (err) {
    logger.error('[admin-affiliates] Failed to reject payout:', { error: err.message })
    res.status(500).json({ error: 'Failed to reject payout' })
  }
})

// GET /admin/affiliates/tiers
router.get('/affiliates/tiers', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const tiers = await fetchAffiliateTiers({ includeInactive: true })
    res.json({ tiers })
  } catch (err) {
    logger.error('[admin-affiliates] Failed to list tiers:', { error: err.message })
    res.status(500).json({ error: 'Failed to load commission tiers' })
  }
})

// POST /admin/affiliates/tiers
router.post('/affiliates/tiers', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const tierRank = parseInt(req.body?.tier_rank, 10)
    const minReferrals = parseInt(req.body?.min_referrals, 10)
    const commissionPct = parseFloat(req.body?.commission_pct)
    const label = sanitizeString(String(req.body?.label || '').trim(), 100) || null

    if (!Number.isFinite(tierRank) || tierRank < 1) return res.status(400).json({ error: 'A valid tier_rank is required' })
    if (!Number.isFinite(minReferrals) || minReferrals < 0) return res.status(400).json({ error: 'A valid min_referrals is required' })
    if (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100) {
      return res.status(400).json({ error: 'commission_pct must be between 0 and 100' })
    }

    const tier = await createAffiliateTier({ tier_rank: tierRank, label, min_referrals: minReferrals, commission_pct: commissionPct })
    await auditLog(req, 'affiliate_tier_created', tier.id, { tier_rank: tierRank, min_referrals: minReferrals, commission_pct: commissionPct })
    res.status(201).json(tier)
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A tier with this rank already exists' })
    logger.error('[admin-affiliates] Failed to create tier:', { error: err.message })
    res.status(500).json({ error: 'Failed to create commission tier' })
  }
})

// PATCH /admin/affiliates/tiers/:id
router.patch('/affiliates/tiers/:id', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const body = req.body || {}
    const patch = {}
    if (body.label !== undefined) patch.label = sanitizeString(String(body.label || '').trim(), 100) || null
    if (body.min_referrals !== undefined) {
      const v = parseInt(body.min_referrals, 10)
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: 'Invalid min_referrals' })
      patch.min_referrals = v
    }
    if (body.commission_pct !== undefined) {
      const v = parseFloat(body.commission_pct)
      if (!Number.isFinite(v) || v < 0 || v > 100) return res.status(400).json({ error: 'Invalid commission_pct' })
      patch.commission_pct = v
    }
    if (body.is_active !== undefined) patch.is_active = !!body.is_active

    const tier = await updateAffiliateTier(req.params.id, patch)
    if (!tier) return res.status(404).json({ error: 'Tier not found' })

    await auditLog(req, 'affiliate_tier_updated', tier.id, { changes: patch })
    res.json(tier)
  } catch (err) {
    logger.error('[admin-affiliates] Failed to update tier:', { error: err.message })
    res.status(500).json({ error: 'Failed to update commission tier' })
  }
})

// GET /admin/affiliates/:userId — per-affiliate drill-down
router.get('/affiliates/:userId', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const userResult = await pool.query(
      `SELECT id, full_name, email, affiliate_code, created_at FROM users WHERE id = $1`,
      [req.params.userId]
    )
    const user = userResult.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })

    const [summary, referrals, commissions, payouts] = await Promise.all([
      fetchAffiliateSummary(user.id),
      fetchAffiliateReferrals(user.id, { page: 1, pageSize: 50 }),
      fetchAffiliateCommissions(user.id, { page: 1, pageSize: 50 }),
      fetchAffiliatePayouts(user.id, { page: 1, pageSize: 50 })
    ])

    res.json({ user, summary, referrals, commissions, payouts })
  } catch (err) {
    logger.error('[admin-affiliates] Failed to load affiliate detail:', { error: err.message })
    res.status(500).json({ error: 'Failed to load affiliate detail' })
  }
})

// POST /admin/affiliates/:userId/adjust-balance — manual correction (no automatic
// refund/chargeback clawback exists; this is the only way a balance changes
// outside of normal commission-earning).
router.post('/affiliates/:userId/adjust-balance', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const amount = parseFloat(req.body?.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'A non-zero numeric amount is required' })
    }
    const reason = sanitizeString(String(req.body?.reason || '').trim(), 500)
    if (!reason || reason.length < 5) {
      return res.status(400).json({ error: 'A reason (5+ characters) is required' })
    }

    const userResult = await pool.query(`SELECT id FROM users WHERE id = $1`, [req.params.userId])
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    const adjustment = await insertBalanceAdjustment(pool, {
      referrerUserId: req.params.userId,
      amount,
      note: reason,
      adjustedBy: getAdminActorLabel(req.admin)
    })

    await auditLog(req, 'affiliate_balance_adjusted', req.params.userId, { amount, reason })

    res.json({ adjustment: { ...adjustment, commission_amount: parseFloat(adjustment.commission_amount) } })
  } catch (err) {
    logger.error('[admin-affiliates] Failed to adjust balance:', { error: err.message })
    res.status(500).json({ error: 'Failed to adjust balance' })
  }
})

module.exports = router
