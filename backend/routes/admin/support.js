// Admin support inbox and dispute workflow.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const { ensureDisputesInfrastructure } = require('../disputes')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')

// GET /api/admin/support-inbox — unified queue combining live chat
// conversations and trader appeals (Modern Gazette handoff spec, isAdminChat
// block's `t.queue` tag: one inbox, two real queues). Per the plan's Phase
// 3c decision: kept as two source tables (chat is real-time/Socket.IO-first,
// disputes is async/single-response) rather than a forced schema merge —
// this endpoint just normalizes both into one sorted, taggable list.
router.get('/support-inbox', authenticateAdmin, async (req, res) => {
  try {
    await ensureDisputesInfrastructure()
    const [chatResult, disputeResult] = await Promise.all([
      pool.query(
        `SELECT c.id, c.subject, c.status, c.assigned_to, c.updated_at, c.unread_admin_count,
                u.full_name, u.email
           FROM chat_conversations c
           JOIN users u ON u.id::text = c.user_id
          WHERE c.status IN ('open', 'pending')
          ORDER BY c.updated_at DESC
          LIMIT 100`
      ),
      pool.query(
        `SELECT d.id, d.reason, d.status, d.created_at AS updated_at,
                u.full_name, u.email
           FROM disputes d
           JOIN users u ON u.id::text = d.user_id::text
          WHERE d.status IN ('open', 'under_review')
          ORDER BY d.created_at DESC
          LIMIT 100`
      )
    ])

    const chatRows = chatResult.rows.map((r) => ({
      id: r.id,
      channel: 'chat',
      queue: 'Chat',
      name: r.full_name || r.email,
      subject: r.subject,
      status: r.status,
      assigned_to: r.assigned_to,
      unread: r.unread_admin_count || 0,
      updated_at: r.updated_at
    }))
    const disputeRows = disputeResult.rows.map((r) => ({
      id: r.id,
      channel: 'dispute',
      queue: 'Appeal',
      name: r.full_name || r.email,
      subject: r.reason,
      status: r.status,
      assigned_to: null,
      unread: 0,
      updated_at: r.updated_at
    }))

    const combined = [...chatRows, ...disputeRows].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    res.json({
      rows: combined,
      summary: {
        chat_open: chatRows.length,
        appeals_open: disputeRows.length,
        total: combined.length
      }
    })
  } catch (error) {
    logger.error('Support inbox error:', { error: error.message })
    res.status(500).json({ error: 'Could not load support inbox' })
  }
})

router.get('/dispute-workflow', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    await ensureDisputesInfrastructure()
    let rows = []
    try {
      const result = await pool.query(
        `SELECT
           d.id::text AS dispute_id,
           d.status,
           d.reason,
           d.description,
           d.admin_response,
           d.created_at,
           d.updated_at,
           -- Presence only. The stored path is an internal filename and the
           -- client never needs it: the file is fetched by dispute id through
           -- GET /api/disputes/admin/:id/evidence, which re-reads the path
           -- server-side and applies its own containment guard.
           (d.evidence_path IS NOT NULL AND d.evidence_path <> '') AS has_evidence,
           u.full_name,
           u.email,
           u.trader_uid,
           a.account_uid,
           a.account_type,
           a.status AS account_status,
           COALESCE(m.owner, 'unassigned') AS owner,
           COALESCE(m.priority, 'normal') AS priority,
           COALESCE(m.sla_hours, 48)::int AS sla_hours,
           COALESCE(m.notes, '') AS notes
         FROM disputes d
         LEFT JOIN users u ON u.id::text = d.user_id::text
         LEFT JOIN accounts a ON a.id::text = d.account_id::text
         LEFT JOIN admin_dispute_meta m ON m.dispute_id = d.id::text
         ORDER BY d.created_at DESC
         LIMIT 500`
      )
      rows = result.rows.map(r => {
        const ageHours = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) / 3600000 : 0
        const slaHours = Math.max(1, parseInt(r.sla_hours || 48, 10))
        const sla_status =
          ageHours >= slaHours * 1.75 ? 'breach'
            : ageHours >= slaHours ? 'overdue'
              : 'within_sla'
        return {
          ...r,
          age_hours: parseFloat(ageHours.toFixed(2)),
          sla_hours: slaHours,
          sla_status
        }
      })
    } catch (err) {
      if (err?.code !== '42P01') throw err
      rows = []
    }

    res.json({
      generated_at: new Date(),
      summary: {
        total: rows.length,
        open: rows.filter(r => r.status === 'open').length,
        under_review: rows.filter(r => r.status === 'under_review').length,
        resolved: rows.filter(r => r.status === 'resolved').length,
        rejected: rows.filter(r => r.status === 'rejected').length,
        overdue: rows.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length,
        breach: rows.filter(r => r.sla_status === 'breach').length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dispute workflow' })
  }
})

router.post('/dispute-workflow/:id/meta', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    await ensureDisputesInfrastructure()
    const disputeId = String(req.params.id || '').trim()
    if (!disputeId) return res.status(400).json({ error: 'Invalid dispute id' })

    const owner = req.body?.owner ? String(req.body.owner).trim() : null
    const priorityRaw = req.body?.priority ? String(req.body.priority).trim().toLowerCase() : 'normal'
    const priority = ['low', 'normal', 'high', 'urgent'].includes(priorityRaw) ? priorityRaw : 'normal'
    const slaHours = Math.max(1, Math.min(336, parseInt(req.body?.sla_hours || 48, 10) || 48))
    const notes = String(req.body?.notes || '')

    const disputeResult = await pool.query(
      `SELECT id
         FROM disputes
        WHERE id::text = $1
        LIMIT 1`,
      [disputeId]
    )
    if (disputeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dispute not found' })
    }

    const upsert = await pool.query(
      `INSERT INTO admin_dispute_meta (dispute_id, owner, priority, sla_hours, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (dispute_id)
       DO UPDATE SET
         owner = EXCLUDED.owner,
         priority = EXCLUDED.priority,
         sla_hours = EXCLUDED.sla_hours,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [disputeId, owner, priority, slaHours, notes]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'dispute_meta_updated',
        entityType: 'dispute',
        entityId: disputeId,
        payload: { owner, priority, sla_hours: slaHours }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(upsert.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update dispute metadata' })
  }
})

router.post('/dispute-workflow/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    await ensureDisputesInfrastructure()
    const disputeId = String(req.params.id || '').trim()
    if (!disputeId) return res.status(400).json({ error: 'Invalid dispute id' })
    const status = String(req.body?.status || '').trim()
    const adminResponse = String(req.body?.admin_response || '')
    const allowed = ['open', 'under_review', 'resolved', 'rejected']
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    }

    const result = await pool.query(
      `UPDATE disputes
          SET status = $2,
              admin_response = CASE WHEN $3 <> '' THEN $3 ELSE admin_response END,
              updated_at = NOW()
        WHERE id::text = $1
        RETURNING *`,
      [disputeId, status, adminResponse]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'dispute_status_updated',
        entityType: 'dispute',
        entityId: disputeId,
        payload: { status }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(result.rows[0])
  } catch (err) {
    if (err?.code === '42P01') return res.status(404).json({ error: 'Disputes table not found' })
    res.status(500).json({ error: 'Failed to update dispute status' })
  }
})

module.exports = router
