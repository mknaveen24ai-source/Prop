// Admin immutable audit, four-eyes approvals, feature flags, notifications, cases.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
require('../../loadEnv')

const { ensureFeatureTables, toBool } = require('./shared/schema')
const {
  normalizeAuditPayload,
  buildAuditHash, appendImmutableAudit
} = require('./shared/audit')

router.get('/immutable-audit', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const countResult = await pool.query(`SELECT COUNT(*)::int AS c FROM admin_immutable_audit`)
    if ((countResult.rows[0]?.c || 0) === 0) {
      try {
        await appendImmutableAudit(pool, {
          eventType: 'audit_chain_initialized',
          entityType: 'system',
          entityId: 'bootstrap',
          payload: { initialized_at: new Date().toISOString() }
        })
      } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    }

    const result = await pool.query(
      `SELECT
         id,
         event_type,
         entity_type,
         entity_id,
         actor,
         payload_json,
         payload_text,
         prev_hash,
         entry_hash,
         created_at
       FROM admin_immutable_audit
       ORDER BY id DESC
       LIMIT 500`
    )

    const descRows = result.rows
    const ascRows = [...descRows].reverse()
    let expectedPrev = 'GENESIS'
    let brokenLinks = 0
    const validatedAsc = ascRows.map(r => {
      const payloadText = String(r.payload_text || normalizeAuditPayload(r.payload_json || {}))
      const createdAt = r.created_at ? new Date(r.created_at).toISOString() : ''
      const expectedHash = buildAuditHash({
        prevHash: r.prev_hash,
        eventType: r.event_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payloadText,
        createdAt
      })
      const isValid = r.prev_hash === expectedPrev && r.entry_hash === expectedHash
      if (!isValid) brokenLinks += 1
      expectedPrev = r.entry_hash
      return { ...r, is_valid: isValid }
    })

    const entries = validatedAsc.reverse()
    res.json({
      generated_at: new Date(),
      integrity: {
        valid: brokenLinks === 0,
        broken_links: brokenLinks,
        checked_entries: validatedAsc.length,
        chain_head: entries[0]?.entry_hash || null
      },
      entries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load immutable audit log' })
  }
})

router.get('/four-eyes/queue', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT
         id, action_type, target_type, target_id, payload_json, requested_by,
         approvals_json, required_approvals, status, created_at, updated_at, decided_at,
         COALESCE(jsonb_array_length(approvals_json), 0)::int AS approvals_count
       FROM admin_four_eyes_requests
       ORDER BY created_at DESC
       LIMIT 300`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load 4-eyes queue' })
  }
})

router.post('/four-eyes/request', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      action_type,
      target_type = 'generic',
      target_id = '',
      payload = {},
      required_approvals = 2,
      requested_by = 'admin'
    } = req.body || {}

    if (!action_type || String(action_type).trim().length < 3) {
      return res.status(400).json({ error: 'action_type is required (min 3 chars)' })
    }
    const requiredApprovals = Math.max(2, Math.min(5, parseInt(required_approvals, 10) || 2))
    const ins = await pool.query(
      `INSERT INTO admin_four_eyes_requests
        (action_type, target_type, target_id, payload_json, requested_by, required_approvals, status, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', NOW())
       RETURNING *`,
      [
        String(action_type).trim(),
        String(target_type || 'generic').trim(),
        String(target_id || '').trim(),
        JSON.stringify(payload || {}),
        String(requested_by || 'admin').trim(),
        requiredApprovals
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'four_eyes_request_created',
        entityType: 'four_eyes_request',
        entityId: String(ins.rows[0].id),
        payload: {
          action_type: String(action_type).trim(),
          required_approvals: requiredApprovals
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create 4-eyes request' })
  }
})

router.post('/four-eyes/:id/decision', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const decision = String(req.body?.decision || '').trim().toLowerCase()
    const approver = String(req.body?.approver || 'admin').trim()
    const comment = String(req.body?.comment || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' })

    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT id, action_type, target_type, target_id, payload_json, requested_by,
              approvals_json, required_approvals, status, created_at, updated_at, decided_at
       FROM admin_four_eyes_requests WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }

    const current = currentResult.rows[0]
    if (current.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Request already ${current.status}` })
    }

    const approvals = Array.isArray(current.approvals_json) ? [...current.approvals_json] : []
    if (approvals.some(a => String(a.approver || '') === approver)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Approver has already submitted a decision' })
    }
    approvals.push({
      approver,
      decision,
      comment,
      at: new Date().toISOString()
    })

    const approvedCount = approvals.filter(a => a.decision === 'approve').length
    const rejectedCount = approvals.filter(a => a.decision === 'reject').length
    const needed = Math.max(2, parseInt(current.required_approvals || 2, 10))
    const nextStatus = rejectedCount > 0 ? 'rejected' : approvedCount >= needed ? 'approved' : 'pending'
    const decidedAt = nextStatus === 'pending' ? null : new Date().toISOString()

    const update = await client.query(
      `UPDATE admin_four_eyes_requests
          SET approvals_json = $2::jsonb,
              status = $3,
              decided_at = $4::timestamptz,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *,
                  COALESCE(jsonb_array_length(approvals_json), 0)::int AS approvals_count`,
      [id, JSON.stringify(approvals), nextStatus, decidedAt]
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'four_eyes_decision_submitted',
        entityType: 'four_eyes_request',
        entityId: String(id),
        payload: {
          decision,
          approver,
          resulting_status: nextStatus,
          approvals_count: approvals.length
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json(update.rows[0])
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to submit 4-eyes decision' })
  } finally {
    client.release()
  }
})

router.get('/feature-flags', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, flag_key, description, enabled, rollout_pct, segment, updated_by,
              created_at, updated_at
       FROM admin_feature_flags ORDER BY flag_key ASC`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feature flags' })
  }
})

router.post('/feature-flags', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      flag_key,
      description = '',
      enabled = false,
      rollout_pct = 100,
      segment = 'all',
      updated_by = 'admin'
    } = req.body || {}
    if (!flag_key || String(flag_key).trim().length < 2) {
      return res.status(400).json({ error: 'flag_key is required (min 2 chars)' })
    }
    const rollout = Math.max(0, Math.min(100, parseInt(rollout_pct, 10) || 0))
    const upsert = await pool.query(
      `INSERT INTO admin_feature_flags
        (flag_key, description, enabled, rollout_pct, segment, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (flag_key)
       DO UPDATE SET
         description = EXCLUDED.description,
         enabled = EXCLUDED.enabled,
         rollout_pct = EXCLUDED.rollout_pct,
         segment = EXCLUDED.segment,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        String(flag_key).trim(),
        String(description || ''),
        toBool(enabled, false),
        rollout,
        String(segment || 'all'),
        String(updated_by || 'admin')
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'feature_flag_upserted',
        entityType: 'feature_flag',
        entityId: String(upsert.rows[0].id),
        payload: {
          flag_key: String(flag_key).trim(),
          enabled: toBool(enabled, false),
          rollout_pct: rollout
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(upsert.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to save feature flag' })
  }
})

router.post('/feature-flags/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid flag id' })
    const result = await pool.query(
      `UPDATE admin_feature_flags
          SET enabled = NOT enabled,
              updated_at = NOW(),
              updated_by = $2
        WHERE id = $1
        RETURNING *`,
      [id, String(req.body?.updated_by || 'admin')]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Feature flag not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'feature_flag_toggled',
        entityType: 'feature_flag',
        entityId: String(id),
        payload: {
          flag_key: result.rows[0].flag_key,
          enabled: !!result.rows[0].enabled
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle feature flag' })
  }
})

router.get('/notifications', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const status = req.query.status ? String(req.query.status) : null
    const params = []
    let where = ''
    if (status && status !== 'all') {
      params.push(status)
      where = `WHERE status = $1`
    }
    const result = await pool.query(
      `SELECT id, type, channel, title, message, audience, status, scheduled_for,
              sent_at, created_by, created_at
       FROM admin_notifications ${where} ORDER BY created_at DESC LIMIT 400`,
      params
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' })
  }
})

router.post('/notifications', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      type = 'info',
      channel = 'web',
      title = '',
      message,
      audience = 'all',
      scheduled_for = null,
      created_by = 'admin'
    } = req.body || {}
    if (!message || String(message).trim().length < 3) {
      return res.status(400).json({ error: 'message is required (min 3 chars)' })
    }
    const t = ['info', 'warning', 'success', 'error'].includes(String(type)) ? String(type) : 'info'
    const c = ['web', 'email', 'webhook'].includes(String(channel)) ? String(channel) : 'web'
    let scheduled = null
    if (scheduled_for) {
      const dt = new Date(scheduled_for)
      if (!Number.isNaN(dt.getTime())) scheduled = dt.toISOString()
    }
    const status = scheduled ? 'scheduled' : 'queued'
    const ins = await pool.query(
      `INSERT INTO admin_notifications
        (type, channel, title, message, audience, status, scheduled_for, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       RETURNING *`,
      [t, c, String(title || ''), String(message).trim(), String(audience || 'all'), status, scheduled, String(created_by || 'admin')]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'notification_created',
        entityType: 'notification',
        entityId: String(ins.rows[0].id),
        payload: { type: t, channel: c, status }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create notification' })
  }
})

router.post('/notifications/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid notification id' })
    if (!['queued', 'scheduled', 'sent', 'cancelled', 'read'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const update = await pool.query(
      `UPDATE admin_notifications
          SET status = $2,
              sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
        WHERE id = $1
        RETURNING *`,
      [id, status]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Notification not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'notification_status_updated',
        entityType: 'notification',
        entityId: String(id),
        payload: { status }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification status' })
  }
})

router.get('/cases', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const status = req.query.status ? String(req.query.status) : null
    const owner = req.query.owner ? String(req.query.owner) : null
    const params = []
    const filters = []
    if (status && status !== 'all') {
      params.push(status)
      filters.push(`status = $${params.length}`)
    }
    if (owner && owner !== 'all') {
      params.push(owner)
      filters.push(`owner = $${params.length}`)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const result = await pool.query(
      `SELECT id, source_type, source_id, title, severity, priority, status,
              owner, notes, created_by, created_at, updated_at, closed_at
       FROM admin_cases ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cases' })
  }
})

router.post('/cases', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      source_type = 'manual',
      source_id = '',
      title,
      severity = 'medium',
      priority = 'normal',
      owner = null,
      notes = '',
      created_by = 'admin'
    } = req.body || {}
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 chars)' })
    }
    const sev = ['low', 'medium', 'high', 'critical'].includes(String(severity)) ? String(severity) : 'medium'
    const prio = ['low', 'normal', 'high', 'urgent'].includes(String(priority)) ? String(priority) : 'normal'
    const ins = await pool.query(
      `INSERT INTO admin_cases
        (source_type, source_id, title, severity, priority, owner, notes, created_by, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', NOW())
       RETURNING *`,
      [
        String(source_type || 'manual'),
        String(source_id || ''),
        String(title).trim(),
        sev,
        prio,
        owner ? String(owner) : null,
        String(notes || ''),
        String(created_by || 'admin')
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_created',
        entityType: 'case',
        entityId: String(ins.rows[0].id),
        payload: { source_type: String(source_type || 'manual'), severity: sev, priority: prio }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create case' })
  }
})

router.post('/cases/:id/assign', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const owner = String(req.body?.owner || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid case id' })
    if (!owner) return res.status(400).json({ error: 'owner is required' })
    const update = await pool.query(
      `UPDATE admin_cases
          SET owner = $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, owner]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_assigned',
        entityType: 'case',
        entityId: String(id),
        payload: { owner }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign case owner' })
  }
})

router.post('/cases/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid case id' })
    const allowed = ['open', 'in_progress', 'pending_external', 'resolved', 'closed']
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    const update = await pool.query(
      `UPDATE admin_cases
          SET status = $2,
              closed_at = CASE WHEN $2 IN ('resolved', 'closed') THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, status]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_status_updated',
        entityType: 'case',
        entityId: String(id),
        payload: { status }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update case status' })
  }
})

module.exports = router
