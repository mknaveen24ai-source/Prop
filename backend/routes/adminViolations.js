const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, requireAdminCapability } = require('./middleware')
const { ensureViolationTables } = require('../services/violationEngine')

router.get('/violations', authenticateAdmin, requireAdminCapability('violation:read:scoped'), async (req, res) => {
  try {
    await ensureViolationTables()

    const conditions = []
    const values = []
    const scopedTenantId = req.admin?.tenantId || null

    if (scopedTenantId) {
      values.push(scopedTenantId)
      conditions.push(`COALESCE(tenant_id, $${values.length}) = $${values.length}`)
    }

    if (req.query.status) {
      values.push(String(req.query.status))
      conditions.push(`status = $${values.length}`)
    }
    if (req.query.type) {
      values.push(String(req.query.type))
      conditions.push(`violation_type = $${values.length}`)
    }
    if (req.query.account_id) {
      values.push(String(req.query.account_id))
      conditions.push(`account_id = $${values.length}`)
    }
    if (req.query.user_id) {
      values.push(String(req.query.user_id))
      conditions.push(`user_id = $${values.length}`)
    }

    const limitRaw = parseInt(req.query.limit, 10)
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200
    values.push(limit)

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const result = await pool.query(
      `SELECT id, violation_type, severity, status, account_id, user_id, trade_id,
              instrument, source, message, payload_json, hit_count,
              first_detected_at, last_detected_at, resolved_at, resolution_note, resolution_type
         FROM admin_rule_violations
         ${where}
        ORDER BY last_detected_at DESC
        LIMIT $${values.length}`,
      values
    )

    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load violations' })
  }
})

router.get('/violations/summary', authenticateAdmin, requireAdminCapability('violation:read:scoped'), async (req, res) => {
  try {
    await ensureViolationTables()
    const scopedTenantId = req.admin?.tenantId || null

    const [openCounts, recentCounts] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_open,
          COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical_open,
          COUNT(*) FILTER (WHERE severity = 'high')::int AS high_open
        FROM admin_rule_violations
        WHERE status = 'open'
          AND ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)
      `, [scopedTenantId]),
      pool.query(`
        SELECT violation_type, COUNT(*)::int AS total
        FROM admin_rule_violations
        WHERE last_detected_at >= NOW() - INTERVAL '24 hours'
          AND ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)
        GROUP BY violation_type
        ORDER BY total DESC, violation_type ASC
        LIMIT 10
      `, [scopedTenantId])
    ])

    res.json({
      totals: openCounts.rows[0] || { total_open: 0, critical_open: 0, high_open: 0 },
      top_types_last_24h: recentCounts.rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load violation summary' })
  }
})

router.post('/violations/:id/resolve', authenticateAdmin, requireAdminCapability('violation:resolve:scoped'), async (req, res) => {
  try {
    await ensureViolationTables()
    const scopedTenantId = req.admin?.tenantId || null
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid violation id' })
    }

    const note = req.body && req.body.note ? String(req.body.note) : 'Resolved by admin'
    const resolutionType = String(req.body?.resolution_type || 'resolved').trim().toLowerCase()
    if (!['resolved', 'waived', 'false_positive'].includes(resolutionType)) {
      return res.status(400).json({ error: 'resolution_type must be resolved, waived, or false_positive' })
    }
    const result = await pool.query(
      `UPDATE admin_rule_violations
          SET status = 'resolved',
              resolved_at = NOW(),
              resolution_note = $2,
              resolution_type = $3,
              payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
                'resolution_type', $3,
                'resolved_by_role', $4,
                'resolved_tenant_scope', $5
              )
        WHERE id = $1
          AND ($6::bigint IS NULL OR COALESCE(tenant_id, $6) = $6)
        RETURNING *`,
      [id, note, resolutionType, req.admin?.role || 'admin', scopedTenantId, scopedTenantId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Violation not found' })
    }

    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve violation' })
  }
})

module.exports = router
