'use strict'
/**
 * Admin Rules & Enforcement Sub-Router
 * Extracted from routes/admin.js for progressive modularization.
 * All shared helpers imported from the monolith via _internals bridge.
 */
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const logger = require('../../utils/logger')
const { DEFAULT_TENANT_SLUG } = require('../../utils/tenants')
const {
  authenticateAdmin,
  requireAdminCapability,
  requireSuperAdmin,
  requireTenantAdminOrSuperAdmin
} = require('../middleware')
const adminMonolith = require('../admin')
const {
  getScopedTenantId, getAdminActorLabel, buildAdminActorPayload, getAdminOwnerId,
  normalizeEntityId, normalizeAdminTag, normalizeEntityType, normalizeAdminEmail,
  parsePositiveInteger, parseBooleanFilter, parseCsvListParam, parseListPaging,
  buildPagination, paginateRows, facetCounts, toIsoOrNull, wantsAdminListContract,
  computeUserLifecycleStage, computeAccountLifecycleStage, computePayoutComplianceStatus,
  buildSavedViewCapabilities, normalizeAccountSnapshot, normalizeUserSnapshot,
  normalizePayoutSnapshot, buildAllowedAccountActions, buildAllowedUserActions,
  buildAllowedPayoutActions, emitCopierEventSafe, emitCopierEventsAfterCommit,
  buildCopierTradePayload, queueAdminCopierEvent, forceCloseOpenTradesForAccount,
  cancelPendingTradesForAccount, forceCloseTradeById, calcTradePnl,
  upsertAdminEntityMeta, computePhaseEndDateForAccountType, appendImmutableAudit,
  buildKycDocumentPresencePredicate, getExposureData, ensureFeatureTables,
  buildUserListResult, buildAccountListResult
} = adminMonolith._internals
const { emitAdminEvent } = require('../../utils/realtime')
const Decimal = require('decimal.js')


// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/rules', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const r = await pool.query(
      `SELECT id, name, scope, condition_json, action_json, enabled, priority,
              trigger_count, last_triggered_at, created_at, updated_at
       FROM admin_rules ORDER BY enabled DESC, priority ASC, created_at DESC LIMIT 500`
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rules' })
  }
})

router.post('/rules', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      name,
      scope = 'global',
      condition_json = {},
      action_json = {},
      enabled = true,
      priority = 100
    } = req.body || {}

    if (!name || String(name).trim().length < 3) {
      return res.status(400).json({ error: 'Rule name is required (min 3 chars)' })
    }

    const r = await pool.query(
      `INSERT INTO admin_rules (name, scope, condition_json, action_json, enabled, priority, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, NOW())
       RETURNING *`,
      [
        String(name).trim(),
        String(scope || 'global').trim(),
        JSON.stringify(condition_json || {}),
        JSON.stringify(action_json || {}),
        !!enabled,
        Number.isFinite(parseInt(priority, 10)) ? parseInt(priority, 10) : 100
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_created',
        entityType: 'rule',
        entityId: String(r.rows[0].id),
        payload: {
          name: String(name).trim(),
          scope: String(scope || 'global').trim()
        }
      })
    } catch (_) {}
    res.status(201).json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create rule' })
  }
})

router.post('/rules/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid rule id' })
    const r = await pool.query(
      `UPDATE admin_rules
          SET enabled = NOT enabled,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Rule not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_toggled',
        entityType: 'rule',
        entityId: String(id),
        payload: { enabled: !!r.rows[0].enabled }
      })
    } catch (_) {}
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle rule' })
  }
})

router.delete('/rules/:id', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid rule id' })
    const r = await pool.query(`DELETE FROM admin_rules WHERE id = $1 RETURNING id`, [id])
    if (r.rows.length === 0) return res.status(404).json({ error: 'Rule not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_deleted',
        entityType: 'rule',
        entityId: String(id),
        payload: {}
      })
    } catch (_) {}
    res.json({ message: 'Rule deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete rule' })
  }
})

router.post('/rules/reorder', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const orderedIdsRaw = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids : []
    const orderedIds = [...new Set(
      orderedIdsRaw
        .map(v => parseInt(v, 10))
        .filter(v => Number.isFinite(v))
    )]

    if (orderedIds.length === 0) {
      return res.status(400).json({ error: 'ordered_ids must be a non-empty array of rule ids' })
    }

    await client.query('BEGIN')
    await client.query(
      `UPDATE admin_rules r
          SET priority = src.ord * 10,
              updated_at = NOW()
         FROM (
           SELECT id::bigint AS id, ord::int AS ord
           FROM unnest($1::bigint[]) WITH ORDINALITY AS t(id, ord)
         ) src
        WHERE r.id = src.id`,
      [orderedIds]
    )
    const result = await client.query(
      `SELECT id, name, scope, condition_json, action_json, enabled, priority,
              trigger_count, last_triggered_at, created_at, updated_at
       FROM admin_rules ORDER BY enabled DESC, priority ASC, created_at DESC LIMIT 500`
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'rules_reordered',
        entityType: 'rule',
        entityId: 'bulk',
        payload: { ordered_ids: orderedIds.slice(0, 200) }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json(result.rows)
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reorder rules' })
  } finally {
    client.release()
  }
})

router.get('/enforcement/events', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const r = await pool.query(
      `SELECT id, rule_id, account_id, user_id, action, payload_json, status,
              message, created_at
       FROM admin_enforcement_events ORDER BY created_at DESC LIMIT 300`
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load enforcement events' })
  }
})

router.post('/enforcement/apply', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const { account_id, action, reason = '', rule_id = null, payload = {} } = req.body || {}
    if (!account_id) return res.status(400).json({ error: 'account_id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })

    await client.query('BEGIN')

    const accResult = await client.query(
      `SELECT id, user_id, status FROM accounts WHERE id = $1 FOR UPDATE`,
      [String(account_id)]
    )
    if (accResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const acc = accResult.rows[0]
    let message = ''
    let eventStatus = 'applied'
    const copierEvents = []

    if (action === 'lock_account') {
      await client.query(`UPDATE accounts SET status = 'locked', updated_at = NOW() WHERE id = $1`, [acc.id])
      message = 'Account locked'
    } else if (action === 'force_close_open_trades') {
      const closeResult = await forceCloseOpenTradesForAccount(client, acc.id, { copierEvents, source: 'admin_enforcement_force_close_open_trades' })
      message = `Force-closed ${closeResult.closedCount} open trades; total P&L ${closeResult.totalPnl >= 0 ? '+' : ''}$${closeResult.totalPnl.toFixed(2)}`
    } else if (action === 'flag_for_review') {
      await client.query(
        `UPDATE accounts
            SET review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [acc.id, String(reason || 'Flagged by auto enforcement')]
      )
      message = 'Account flagged for manual review'
    } else {
      eventStatus = 'failed'
      message = `Unsupported action: ${action}`
    }

    const eventResult = await client.query(
      `INSERT INTO admin_enforcement_events (rule_id, account_id, user_id, action, payload_json, status, message)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        Number.isFinite(parseInt(rule_id, 10)) ? parseInt(rule_id, 10) : null,
        String(acc.id),
        String(acc.user_id),
        String(action),
        JSON.stringify(payload || {}),
        eventStatus,
        message
      ]
    )

    if (rule_id && eventStatus === 'applied') {
      await client.query(
        `UPDATE admin_rules
            SET trigger_count = trigger_count + 1,
                last_triggered_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [parseInt(rule_id, 10)]
      )
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'enforcement_applied',
        entityType: 'account',
        entityId: String(acc.id),
        payload: {
          action: String(action),
          status: eventStatus,
          rule_id: Number.isFinite(parseInt(rule_id, 10)) ? parseInt(rule_id, 10) : null
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    await emitCopierEventsAfterCommit(copierEvents)
    res.json({ message, event: eventResult.rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to apply enforcement action' })
  } finally {
    client.release()
  }
})


module.exports = router
