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

    const where = conditions.length > 0 ? `WHERE v.${conditions.join(' AND v.')}` : ''
    const result = await pool.query(
      `SELECT v.id, v.violation_type, v.severity, v.status, v.account_id, v.user_id, v.trade_id,
              v.instrument, v.source, v.message, v.payload_json, v.hit_count,
              v.first_detected_at, v.last_detected_at, v.resolved_at, v.resolution_note, v.resolution_type,
              a.status AS account_status
         FROM admin_rule_violations v
         LEFT JOIN accounts a ON a.id::text = v.account_id
         ${where}
        ORDER BY v.last_detected_at DESC
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

    const [openCounts, recentCounts] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_open,
          COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical_open,
          COUNT(*) FILTER (WHERE severity = 'high')::int AS high_open
        FROM admin_rule_violations
        WHERE status = 'open'
      `),
      pool.query(`
        SELECT violation_type, COUNT(*)::int AS total
        FROM admin_rule_violations
        WHERE last_detected_at >= NOW() - INTERVAL '24 hours'
        GROUP BY violation_type
        ORDER BY total DESC, violation_type ASC
        LIMIT 10
      `)
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
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid violation id' })
    }

    const note = req.body && req.body.note ? String(req.body.note) : 'Resolved by admin'
    const resolutionType = String(req.body?.resolution_type || 'resolved').trim().toLowerCase()
    if (!['resolved', 'waived', 'false_positive', 'more_info_requested'].includes(resolutionType)) {
      return res.status(400).json({ error: 'resolution_type must be resolved, waived, false_positive, or more_info_requested' })
    }

    // more_info_requested is an intermediate appeal state, not a terminal
    // resolution — it stays in the open queue but logs the admin's note.
    const isTerminal = resolutionType !== 'more_info_requested'

    const result = await pool.query(
      `UPDATE admin_rule_violations
          SET status = CASE WHEN $5::boolean THEN 'resolved' ELSE status END,
              resolved_at = CASE WHEN $5::boolean THEN NOW() ELSE resolved_at END,
              resolution_note = $2::text,
              resolution_type = $3::text,
              payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
                'resolution_type', $3::text,
                'resolved_by_role', $4::text,
                'appeal_notes', COALESCE(payload_json->'appeal_notes', '[]'::jsonb) || jsonb_build_array(
                  jsonb_build_object('note', $2::text, 'resolution_type', $3::text, 'at', NOW())
                )
              )
        WHERE id = $1::int
        RETURNING *`,
      [id, note, resolutionType, req.admin?.role || 'admin', isTerminal]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Violation not found' })
    }

    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to resolve violation' })
  }
})

router.get('/violations/:id/evidence', authenticateAdmin, requireAdminCapability('violation:read:scoped'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid violation id' })
    }

    const violationResult = await pool.query(
      `SELECT id, account_id, trade_id, first_detected_at FROM admin_rule_violations WHERE id = $1`,
      [id]
    )
    if (violationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Violation not found' })
    }
    const violation = violationResult.rows[0]

    if (!violation.account_id) {
      return res.json({ trades: [] })
    }

    // Trades from the same account within a 1-hour window around detection —
    // the violation only stores a single trade_id, so this gives real
    // surrounding context rather than just one row.
    const tradesResult = await pool.query(
      `SELECT id, instrument, direction, lot_size, open_price, close_price, demo_pnl, open_time, close_time
         FROM trades
        WHERE account_id = $1
          AND open_time BETWEEN $2::timestamptz - INTERVAL '1 hour' AND $2::timestamptz + INTERVAL '1 hour'
        ORDER BY open_time ASC
        LIMIT 50`,
      [violation.account_id, violation.first_detected_at]
    )

    res.json({ trades: tradesResult.rows, trigger_trade_id: violation.trade_id })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load violation evidence' })
  }
})

module.exports = router
