const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const logger = require('../utils/logger')
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = require('./admin')._internals

async function auditLog(req, eventType, entityId, payload) {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'gift_voucher',
      entityId: String(entityId),
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (err) {
    logger.warn('[admin-gifts] Non-critical audit log failed:', { error: err.message })
  }
}

// GET /admin/gift-vouchers?status=&search=
// No existing browsable "orders" admin page to extend (challenge_orders is
// only ever touched by ad-hoc revenue-aggregation queries elsewhere in
// admin.js) — a small dedicated page for gifts specifically is less invasive
// than retrofitting one that doesn't exist.
router.get('/gift-vouchers', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const status = String(req.query.status || '').trim().toLowerCase()
    const search = String(req.query.search || '').trim()
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.page_size, 10) || 25))
    const offset = (page - 1) * pageSize

    const conditions = []
    const params = []
    if (status && ['issued', 'claimed', 'expired', 'revoked'].includes(status)) {
      params.push(status)
      conditions.push(`gv.status = $${params.length}`)
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`)
      conditions.push(`(LOWER(gv.recipient_email) LIKE $${params.length} OR LOWER(gv.code) LIKE $${params.length} OR LOWER(pu.email) LIKE $${params.length})`)
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await pool.query(
      `SELECT COUNT(*) AS total
         FROM gift_vouchers gv
         LEFT JOIN users pu ON pu.id = gv.purchaser_user_id
        ${whereClause}`,
      params
    )

    const rowsResult = await pool.query(
      `SELECT gv.id, gv.code, gv.status, gv.account_size, gv.challenge_model_slug,
              gv.amount_paid, gv.gift_message, gv.recipient_email, gv.recipient_user_id,
              gv.issued_at, gv.expires_at, gv.claimed_at,
              pu.email AS purchaser_email, pu.full_name AS purchaser_name
         FROM gift_vouchers gv
         LEFT JOIN users pu ON pu.id = gv.purchaser_user_id
        ${whereClause}
        ORDER BY gv.issued_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    )

    res.json({
      gifts: rowsResult.rows,
      total: parseInt(countResult.rows[0]?.total || '0', 10),
      page,
      page_size: pageSize
    })
  } catch (err) {
    logger.error('[admin-gifts] Failed to list gift vouchers:', { error: err.message })
    res.status(500).json({ error: 'Failed to load gift vouchers' })
  }
})

// POST /admin/gift-vouchers/:id/revoke
router.post('/gift-vouchers/:id/revoke', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `UPDATE gift_vouchers
          SET status = 'revoked', updated_at = NOW()
        WHERE id = $1 AND status = 'issued'
        RETURNING *`,
      [req.params.id]
    )
    if (result.rows.length === 0) {
      return res.status(409).json({ error: 'Only an unclaimed gift can be revoked' })
    }
    await auditLog(req, 'gift_voucher_revoked', req.params.id, { code: result.rows[0].code })
    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin-gifts] Failed to revoke gift voucher:', { error: err.message })
    res.status(500).json({ error: 'Failed to revoke gift voucher' })
  }
})

module.exports = router
