'use strict'
/**
 * Admin Analytics Sub-Router
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
const Decimal = require('decimal.js')


// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/announcement', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const settings = await getSettingsMap([
      'announcement_message',
      'announcement_type',
      'announcement_enabled',
      'announcement_updated_at'
    ])

    const message = sanitizeString(String(settings.announcement_message || ''), 500)
    const rawType = String(settings.announcement_type || 'info').toLowerCase()
    const type = ['info', 'success', 'warning', 'error'].includes(rawType) ? rawType : 'info'
    const enabled = message.length > 0 && toBool(settings.announcement_enabled, true)

    res.json({
      message,
      type,
      enabled,
      updated_at: settings.announcement_updated_at || null
    })
  } catch (error) {
    logger.error('Announcement load error:', { error: error.message })
    res.status(500).json({ error: 'Could not load announcement' })
  }
})

router.post('/announcement', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    const message = sanitizeString(String(req.body?.message || ''), 500)
    const rawType = String(req.body?.type || 'info').toLowerCase()
    const type = ['info', 'success', 'warning', 'error'].includes(rawType) ? rawType : 'info'
    const enabled = message.length > 0 && toBool(req.body?.enabled, true)
    const updatedAt = new Date().toISOString()

    await client.query('BEGIN')
    await upsertSetting(client, 'announcement_message', message)
    await upsertSetting(client, 'announcement_type', type)
    await upsertSetting(client, 'announcement_enabled', enabled ? 'true' : 'false')
    await upsertSetting(client, 'announcement_updated_at', updatedAt)

    try {
      await appendImmutableAudit(client, {
        eventType: 'announcement_saved',
        entityType: 'system',
        entityId: 'announcement',
        payload: { enabled, type, message_length: message.length }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json({ message, type, enabled, updated_at: updatedAt })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Announcement save error:', { error: error.message })
    res.status(500).json({ error: 'Could not save announcement' })
  } finally {
    client.release()
  }
})

router.get('/leaderboard', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const tenantId = getScopedTenantId(req)
    const result = await pool.query(
      `
        WITH ranked_accounts AS (
          SELECT
            u.id AS user_id,
            u.email,
            u.full_name,
            u.country,
            u.trader_uid,
            COALESCE(u.leaderboard_visible, TRUE) AS visible,
            a.account_uid,
            a.account_size,
            ROUND((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0))::numeric, 2) AS profit_usd,
            ROUND(
              CASE
                WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                ELSE ((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance) * 100
              END::numeric,
              2
            ) AS profit_pct,
            ROW_NUMBER() OVER (
              PARTITION BY u.id
              ORDER BY
                CASE
                  WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                  ELSE (COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance
                END DESC,
                a.current_balance DESC,
                a.id DESC
            ) AS rn
          FROM users u
          JOIN accounts a ON a.user_id = u.id
          WHERE a.account_type = 'funded'
            AND a.status = 'active'
            AND COALESCE(u.is_banned, FALSE) = FALSE
            AND ($1::bigint IS NULL OR COALESCE(u.tenant_id, a.tenant_id, $1) = $1)
        ),
        closed_trade_stats AS (
          SELECT
            a.user_id,
            COUNT(t.id)::int AS total_trades,
            COALESCE(
              ROUND(
                CASE
                  WHEN COUNT(t.id) = 0 THEN 0
                  ELSE (100.0 * COUNT(t.id) FILTER (WHERE t.demo_pnl > 0) / COUNT(t.id))
                END::numeric,
                1
              ),
              0
            ) AS win_rate
          FROM accounts a
          LEFT JOIN trades t ON t.account_id = a.id AND t.status = 'closed'
          WHERE ($1::bigint IS NULL OR COALESCE(a.tenant_id, $1) = $1)
          GROUP BY a.user_id
        )
        SELECT
          r.user_id,
          r.email,
          r.full_name,
          r.country,
          r.trader_uid,
          r.visible,
          r.account_uid,
          r.account_size,
          r.profit_usd,
          r.profit_pct,
          COALESCE(s.total_trades, 0) AS total_trades,
          COALESCE(s.win_rate, 0) AS win_rate
        FROM ranked_accounts r
        LEFT JOIN closed_trade_stats s ON s.user_id = r.user_id
        WHERE r.rn = 1
        ORDER BY r.profit_pct DESC, r.profit_usd DESC, r.user_id ASC
        LIMIT 100
      `,
      [tenantId]
    )

    res.json(result.rows.map((row, index) => ({
      ...row,
      rank: index + 1,
      username: row.full_name,
      display_name: row.full_name,
      profit_pct: parseFloat(row.profit_pct || 0),
      profit_usd: parseFloat(row.profit_usd || 0),
      account_size: parseFloat(row.account_size || 0),
      total_trades: parseInt(row.total_trades || 0, 10),
      win_rate: parseFloat(row.win_rate || 0),
      visible: row.visible !== false
    })))
  } catch (error) {
    logger.error('Admin leaderboard error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch leaderboard' })
  }
})

router.post('/leaderboard/visibility', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const tenantId = getScopedTenantId(req)
    const userId = normalizeEntityId(req.body?.userId)
    if (!userId) {
      return res.status(400).json({ error: 'Valid userId is required' })
    }

    const visible = toBool(req.body?.visible, true)
    const result = await pool.query(
      `UPDATE users
          SET leaderboard_visible = $1
        WHERE id = $2
          AND ($3::bigint IS NULL OR COALESCE(tenant_id, $3) = $3)
        RETURNING id, leaderboard_visible`,
      [visible, userId, tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trader not found' })
    }

    try {
      await appendImmutableAudit(pool, {
        eventType: 'leaderboard_visibility_updated',
        entityType: 'user',
        entityId: String(userId),
        payload: { visible }
      })
    } catch (_) {}

    res.json({
      userId,
      visible: result.rows[0].leaderboard_visible !== false
    })
  } catch (error) {
    logger.error('Leaderboard visibility error:', { error: error.message })
    res.status(500).json({ error: 'Could not update leaderboard visibility' })
  }
})

router.get('/signup-trends', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90)
    const tenantId = getScopedTenantId(req)

    const signupResult = await pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int AS signups
       FROM users
       WHERE created_at >= NOW() - ($1 || ' days')::interval
         AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
       GROUP BY day
       ORDER BY day ASC`,
      [days, tenantId]
    )

    const challengeResult = await pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int AS challenges
       FROM accounts
       WHERE account_type = 'phase1'
         AND created_at >= NOW() - ($1 || ' days')::interval
         AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
       GROUP BY day
       ORDER BY day ASC`,
      [days, tenantId]
    )

    const signupMap = {}
    signupResult.rows.forEach(r => { signupMap[String(r.day)] = r.signups })

    const challengeMap = {}
    challengeResult.rows.forEach(r => { challengeMap[String(r.day)] = r.challenges })

    // Build full date range so every day appears (zero-filling missing days)
    const result = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() - i)
      d.setUTCHours(0, 0, 0, 0)
      const dayStr = d.toISOString().slice(0, 10)
      const label  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      result.push({
        date:       dayStr,
        label,
        signups:    signupMap[dayStr]    || 0,
        challenges: challengeMap[dayStr] || 0
      })
    }

    res.json(result)
  } catch (error) {
    logger.error('Signup trends error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch signup trends' })
  }
})

router.get('/saved-views', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const resource = String(req.query?.resource || '').trim().toLowerCase()
    if (!resource) {
      return res.status(400).json({ error: 'resource is required' })
    }

    const tenantId = getScopedTenantId(req)
    const adminId = getAdminOwnerId(req.admin)
    const result = await pool.query(
      `SELECT id, tenant_id, resource, name, config_json, is_default, created_at, updated_at
       FROM admin_saved_views
       WHERE admin_id = $1
         AND resource = $2
         AND tenant_id IS NOT DISTINCT FROM $3
       ORDER BY is_default DESC, updated_at DESC, id DESC`,
      [adminId, resource, tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Saved views fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not load saved views' })
  }
})

router.post('/saved-views', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const resource = String(req.body?.resource || '').trim().toLowerCase()
    const name = String(req.body?.name || '').trim()
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {}
    const isDefault = !!req.body?.is_default
    const tenantId = getScopedTenantId(req)
    const adminId = getAdminOwnerId(req.admin)

    if (!resource) return res.status(400).json({ error: 'resource is required' })
    if (name.length < 2) return res.status(400).json({ error: 'name is required' })

    await client.query('BEGIN')
    if (isDefault) {
      await client.query(
        `UPDATE admin_saved_views
            SET is_default = FALSE, updated_at = NOW()
          WHERE admin_id = $1
            AND resource = $2
            AND tenant_id IS NOT DISTINCT FROM $3`,
        [adminId, resource, tenantId]
      )
    }

    const result = await client.query(
      `INSERT INTO admin_saved_views
        (tenant_id, admin_id, admin_role, resource, name, config_json, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW(), NOW())
       RETURNING id, tenant_id, resource, name, config_json, is_default, created_at, updated_at`,
      [tenantId, adminId, req.admin?.role || 'admin', resource, name.slice(0, 120), JSON.stringify(config), isDefault]
    )
    await client.query('COMMIT')
    res.status(201).json(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Saved view create error:', { error: error.message })
    res.status(500).json({ error: 'Could not save view' })
  } finally {
    client.release()
  }
})

router.patch('/saved-views/:id', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const tenantId = getScopedTenantId(req)
    const adminId = getAdminOwnerId(req.admin)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid saved view id is required' })

    const existing = await client.query(
      `SELECT id, resource
       FROM admin_saved_views
       WHERE id = $1
         AND admin_id = $2
         AND tenant_id IS NOT DISTINCT FROM $3`,
      [id, adminId, tenantId]
    )
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' })

    const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 120) : null
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : null
    const isDefault = req.body?.is_default === undefined ? null : !!req.body.is_default

    await client.query('BEGIN')
    if (isDefault) {
      await client.query(
        `UPDATE admin_saved_views
            SET is_default = FALSE, updated_at = NOW()
          WHERE admin_id = $1
            AND resource = $2
            AND tenant_id IS NOT DISTINCT FROM $3`,
        [adminId, existing.rows[0].resource, tenantId]
      )
    }

    const result = await client.query(
      `UPDATE admin_saved_views
          SET name = COALESCE($1, name),
              config_json = COALESCE($2::jsonb, config_json),
              is_default = COALESCE($3, is_default),
              updated_at = NOW()
        WHERE id = $4
          AND admin_id = $5
          AND tenant_id IS NOT DISTINCT FROM $6
        RETURNING id, tenant_id, resource, name, config_json, is_default, created_at, updated_at`,
      [name || null, config ? JSON.stringify(config) : null, isDefault, id, adminId, tenantId]
    )
    await client.query('COMMIT')
    res.json(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Saved view update error:', { error: error.message })
    res.status(500).json({ error: 'Could not update saved view' })
  } finally {
    client.release()
  }
})

router.delete('/saved-views/:id', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const tenantId = getScopedTenantId(req)
    const adminId = getAdminOwnerId(req.admin)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid saved view id is required' })

    const result = await pool.query(
      `DELETE FROM admin_saved_views
        WHERE id = $1
          AND admin_id = $2
          AND tenant_id IS NOT DISTINCT FROM $3
      RETURNING id`,
      [id, adminId, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' })
    res.json({ message: 'Saved view deleted' })
  } catch (error) {
    logger.error('Saved view delete error:', { error: error.message })
    res.status(500).json({ error: 'Could not delete saved view' })
  }
})

router.post('/tags/assign', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(normalizeEntityId).filter(Boolean).slice(0, 100) : []
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(normalizeAdminTag).filter(Boolean).slice(0, 20) : []
    const mode = String(req.body?.mode || 'add').trim().toLowerCase()
    const tenantId = getScopedTenantId(req)
    const adminActor = getAdminActorLabel(req.admin)

    if (!entityType) return res.status(400).json({ error: 'Valid entity_type is required' })
    if (ids.length === 0) return res.status(400).json({ error: 'At least one entity id is required' })
    if (tags.length === 0 && mode !== 'clear') return res.status(400).json({ error: 'At least one tag is required' })
    if (!['add', 'remove', 'set', 'clear'].includes(mode)) return res.status(400).json({ error: 'mode must be add, remove, set, or clear' })

    await client.query('BEGIN')
    for (const entityId of ids) {
      if (mode === 'clear') {
        await client.query(
          `DELETE FROM admin_entity_tags
            WHERE entity_type = $1
              AND entity_id = $2`,
          [entityType, entityId]
        )
        continue
      }

      if (mode === 'set') {
        await client.query(
          `DELETE FROM admin_entity_tags
            WHERE entity_type = $1
              AND entity_id = $2
              AND tag <> ALL($3::text[])`,
          [entityType, entityId, tags]
        )
      }

      if (mode === 'remove') {
        await client.query(
          `DELETE FROM admin_entity_tags
            WHERE entity_type = $1
              AND entity_id = $2
              AND tag = ANY($3::text[])`,
          [entityType, entityId, tags]
        )
      } else {
        for (const tag of tags) {
          await client.query(
            `INSERT INTO admin_entity_tags (tenant_id, entity_type, entity_id, tag, created_by, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (entity_type, entity_id, tag) DO NOTHING`,
            [tenantId, entityType, entityId, tag, adminActor]
          )
        }
      }
    }
    await client.query('COMMIT')
    res.json({ message: 'Tags updated', entity_type: entityType, ids, tags, mode })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Tag assignment error:', { error: error.message })
    res.status(500).json({ error: 'Could not update tags' })
  } finally {
    client.release()
  }
})

router.get('/notes', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.query?.entity_type)
    const entityId = normalizeEntityId(req.query?.entity_id)
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entity_type and entity_id are required' })
    }

    const result = await pool.query(
      `SELECT id, tenant_id, entity_type, entity_id, note_text, created_by, created_at
       FROM admin_entity_notes
       WHERE entity_type = $1
         AND entity_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [entityType, entityId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Notes fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not load notes' })
  }
})

router.post('/notes', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const noteText = String(req.body?.note || '').trim()
    const tenantId = getScopedTenantId(req)
    const createdBy = getAdminActorLabel(req.admin)

    if (!entityType || !entityId) return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    if (noteText.length < 2) return res.status(400).json({ error: 'A note is required' })

    const result = await client.query(
      `INSERT INTO admin_entity_notes
        (tenant_id, entity_type, entity_id, note_text, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING id, tenant_id, entity_type, entity_id, note_text, created_by, created_at`,
      [tenantId, entityType, entityId, noteText.slice(0, 4000), createdBy]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('Note create error:', { error: error.message })
    res.status(500).json({ error: 'Could not add note' })
  } finally {
    client.release()
  }
})

router.post('/cases/link', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const caseId = req.body?.case_id == null || req.body?.case_id === '' ? null : parseInt(req.body.case_id, 10)
    const tenantId = getScopedTenantId(req)

    if (!entityType || !entityId) return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    if (caseId !== null) {
      const caseLookup = await client.query(`SELECT id FROM admin_cases WHERE id = $1`, [caseId])
      if (caseLookup.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    }

    const meta = await upsertAdminEntityMeta(client, {
      tenantId,
      entityType,
      entityId,
      patch: { linked_case_id: caseId }
    })
    res.json({ message: caseId ? 'Case linked' : 'Case unlinked', meta })
  } catch (error) {
    logger.error('Case link error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not link case' })
  } finally {
    client.release()
  }
})

router.post('/entity-meta', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const tenantId = getScopedTenantId(req)
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    }

    const patch = {
      owner_admin_id: req.body?.owner_admin_id ? String(req.body.owner_admin_id).trim().slice(0, 120) : null,
      priority: req.body?.priority ? String(req.body.priority).trim().toLowerCase() : null,
      workflow_status: req.body?.workflow_status ? String(req.body.workflow_status).trim().toLowerCase() : null,
      classification: req.body?.classification ? String(req.body.classification).trim().toLowerCase().slice(0, 120) : null,
      risk_tier: req.body?.risk_tier ? String(req.body.risk_tier).trim().toLowerCase() : null,
      status_reason: req.body?.status_reason ? String(req.body.status_reason).trim().slice(0, 1000) : null,
      sla_state: req.body?.sla_state ? String(req.body.sla_state).trim().toLowerCase().slice(0, 120) : null,
      linked_case_id: req.body?.linked_case_id ? parseInt(req.body.linked_case_id, 10) : null
    }

    const meta = await upsertAdminEntityMeta(client, { tenantId, entityType, entityId, patch })
    res.json({ message: 'Entity metadata updated', meta })
  } catch (error) {
    logger.error('Entity meta update error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not update entity metadata' })
  } finally {
    client.release()
  }
})

function buildAllowedEmailJobActions(job) {
  const status = String(job?.status || '').toLowerCase()
  const actions = ['preview_email_job']
  if (['retry', 'dead', 'failed'].includes(status)) {
    actions.push('retry_email_job')
  }
  if (job?.preview_url) {
    actions.push('copy_preview_path')
  }
  return actions
}

async function buildEmailJobListResult({ tenantId = null, query = {} } = {}) {
  await ensureEmailQueueInfrastructure()

  const search = String(query.search || '').trim().toLowerCase()
  const page = Number.isFinite(query.page) ? query.page : 1
  const pageSize = Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = query.filters || {}
  const sortKey = String(query.sort || 'created_at').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const where = []
  const params = []
  let index = 1

  if (tenantId !== null && tenantId !== undefined) {
    params.push(tenantId)
    where.push(`ej.tenant_id = $${index}`)
    index += 1
  }

  if (search) {
    params.push(`%${search}%`)
    where.push(`(
      LOWER(COALESCE(ej.to_email, '')) LIKE $${index}
      OR LOWER(COALESCE(ej.template_key, '')) LIKE $${index}
      OR LOWER(COALESCE(ej.provider_message_id, '')) LIKE $${index}
      OR LOWER(COALESCE(ej.unique_key, '')) LIKE $${index}
      OR LOWER(COALESCE(ej.id::text, '')) LIKE $${index}
    )`)
    index += 1
  }

  if (filters.status) {
    params.push(String(filters.status).trim().toLowerCase())
    where.push(`LOWER(COALESCE(ej.status, 'pending')) = $${index}`)
    index += 1
  }

  if (filters.template_key) {
    params.push(String(filters.template_key).trim().toLowerCase())
    where.push(`LOWER(COALESCE(ej.template_key, '')) = $${index}`)
    index += 1
  }

  if (filters.delivery_type === 'automation') {
    where.push(`ej.unique_key IS NOT NULL`)
  } else if (filters.delivery_type === 'transactional') {
    where.push(`ej.unique_key IS NULL`)
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const orderByMap = {
    id: 'ej.id',
    created_at: 'ej.created_at',
    scheduled_for: 'ej.scheduled_for',
    sent_at: 'ej.sent_at',
    status: 'ej.status',
    template_key: 'ej.template_key',
    to_email: 'ej.to_email',
    attempt_count: 'ej.attempt_count'
  }
  const orderBy = orderByMap[sortKey] || orderByMap.created_at
  const offset = Math.max(0, (page - 1) * pageSize)

  const listValues = [...params, pageSize, offset]
  const rowsResult = await pool.query(
    `SELECT
        ej.id,
        ej.tenant_id,
        ej.user_id,
        ej.to_email,
        ej.template_key,
        ej.payload_json,
        ej.status,
        ej.attempt_count,
        ej.last_error,
        ej.provider_message_id,
        ej.preview_url,
        ej.unique_key,
        ej.scheduled_for,
        ej.last_attempt_at,
        ej.sent_at,
        ej.created_at,
        ej.updated_at,
        COALESCE(ej.payload_json->>'fullName', '') AS full_name_hint,
        CASE WHEN ej.unique_key IS NULL THEN 'transactional' ELSE 'automation' END AS delivery_type
      FROM email_jobs ej
      ${whereClause}
      ORDER BY ${orderBy} ${sortDirection}, ej.id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  )

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM email_jobs ej
      ${whereClause}`,
    params
  )

  const summaryResult = await pool.query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ej.status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE ej.status = 'sending')::int AS sending,
        COUNT(*) FILTER (WHERE ej.status = 'retry')::int AS retry,
        COUNT(*) FILTER (WHERE ej.status = 'sent')::int AS sent,
        COUNT(*) FILTER (WHERE ej.status = 'dead')::int AS dead
      FROM email_jobs ej
      ${whereClause}`,
    params
  )

  const statusFacetResult = await pool.query(
    `SELECT COALESCE(ej.status, 'pending') AS key, COUNT(*)::int AS count
       FROM email_jobs ej
      ${whereClause}
      GROUP BY COALESCE(ej.status, 'pending')
      ORDER BY count DESC, key ASC`,
    params
  )

  const templateFacetResult = await pool.query(
    `SELECT COALESCE(ej.template_key, 'unknown') AS key, COUNT(*)::int AS count
       FROM email_jobs ej
      ${whereClause}
      GROUP BY COALESCE(ej.template_key, 'unknown')
      ORDER BY count DESC, key ASC`,
    params
  )

  const rows = rowsResult.rows.map((row) => ({
    ...row,
    attempt_count: parseInt(row.attempt_count || 0, 10) || 0,
    delivery_type: row.delivery_type || 'transactional',
    allowed_actions: buildAllowedEmailJobActions(row)
  }))

  const statusFacets = {}
  for (const row of statusFacetResult.rows) {
    statusFacets[row.key] = parseInt(row.count || 0, 10) || 0
  }
  const templateFacets = {}
  for (const row of templateFacetResult.rows) {
    templateFacets[row.key] = parseInt(row.count || 0, 10) || 0
  }

  return {
    summary: {
      ...(summaryResult.rows[0] || {}),
      total: parseInt(summaryResult.rows[0]?.total || 0, 10) || 0,
      pending: parseInt(summaryResult.rows[0]?.pending || 0, 10) || 0,
      sending: parseInt(summaryResult.rows[0]?.sending || 0, 10) || 0,
      retry: parseInt(summaryResult.rows[0]?.retry || 0, 10) || 0,
      sent: parseInt(summaryResult.rows[0]?.sent || 0, 10) || 0,
      dead: parseInt(summaryResult.rows[0]?.dead || 0, 10) || 0
    },
    rows,
    pagination: buildPagination({
      page,
      pageSize,
      total: parseInt(totalResult.rows[0]?.count || 0, 10) || 0
    }),
    facets: {
      status: statusFacets,
      template_key: templateFacets,
      delivery_type: facetCounts(rows, (row) => row.delivery_type || 'transactional')
    },
    default_sort: { key: 'created_at', direction: 'desc' },
    saved_view_capabilities: buildSavedViewCapabilities('email_jobs'),
    allRows: rows
  }
}

router.post('/export', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const resource = String(req.body?.resource || '').trim().toLowerCase()
    const query = {
      search: req.body?.search || '',
      page: 1,
      pageSize: 5000,
      sort: req.body?.sort || undefined,
      order: req.body?.order || undefined,
      filters: req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {}
    }

    let result
    let columns
    if (resource === 'traders') {
      result = await buildTraderListResult({ tenantId, query })
      columns = [
        { header: 'Trader ID', key: 'id' },
        { header: 'Email', key: 'email' },
        { header: 'Full Name', key: 'full_name' },
        { header: 'Country', key: 'country' },
        { header: 'KYC Status', key: 'kyc_status' },
        { header: 'Is Banned', value: (row) => row.is_banned ? 'Yes' : 'No' },
        { header: 'Risk Tier', key: 'risk_tier' },
        { header: 'Classification', key: 'classification' },
        { header: 'Tags', value: (row) => (row.tags || []).join('|') },
        { header: 'Created At', key: 'created_at' }
      ]
    } else if (resource === 'accounts') {
      result = await buildAccountListResult({ tenantId, query })
      columns = [
        { header: 'Account ID', key: 'id' },
        { header: 'Trader Email', key: 'user_email' },
        { header: 'Account Type', key: 'account_type' },
        { header: 'Status', key: 'status' },
        { header: 'Account Size', key: 'account_size' },
        { header: 'Current Balance', key: 'current_balance' },
        { header: 'Risk Tier', key: 'risk_tier' },
        { header: 'Classification', key: 'classification' },
        { header: 'Tags', value: (row) => (row.tags || []).join('|') },
        { header: 'Created At', key: 'created_at' }
      ]
    } else if (resource === 'payouts') {
      result = await buildPayoutListResult({ tenantId, query })
      columns = [
        { header: 'Payout ID', key: 'id' },
        { header: 'Trader Email', key: 'email' },
        { header: 'Account ID', key: 'account_id' },
        { header: 'Status', key: 'status' },
        { header: 'Flagged', value: (row) => row.is_flagged ? 'Yes' : 'No' },
        { header: 'Amount Requested', key: 'amount_requested' },
        { header: 'Amount Payable', key: 'amount_payable' },
        { header: 'Risk Tier', key: 'risk_tier' },
        { header: 'Tags', value: (row) => (row.tags || []).join('|') },
        { header: 'Requested At', key: 'requested_at' }
      ]
    } else if (resource === 'email_jobs') {
      result = await buildEmailJobListResult({ tenantId, query })
      columns = [
        { header: 'Job ID', key: 'id' },
        { header: 'Tenant ID', key: 'tenant_id' },
        { header: 'Recipient', key: 'to_email' },
        { header: 'Template', key: 'template_key' },
        { header: 'Delivery Type', key: 'delivery_type' },
        { header: 'Status', key: 'status' },
        { header: 'Attempts', key: 'attempt_count' },
        { header: 'Scheduled For', key: 'scheduled_for' },
        { header: 'Last Attempt', key: 'last_attempt_at' },
        { header: 'Sent At', key: 'sent_at' },
        { header: 'Provider Message ID', key: 'provider_message_id' },
        { header: 'Preview Path', key: 'preview_url' },
        { header: 'Unique Key', key: 'unique_key' },
        { header: 'Last Error', key: 'last_error' }
      ]
    } else if (resource === 'trades') {
      const filters = query.filters || {}
      const where = []
      const params = []

      if (tenantId !== null && tenantId !== undefined) {
        params.push(tenantId)
        where.push(`COALESCE(u.tenant_id, $${params.length}) = $${params.length}`)
      }
      if (query.search) {
        params.push(`%${String(query.search).trim().toLowerCase()}%`)
        where.push(`(
          LOWER(COALESCE(t.instrument, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.email, '')) LIKE $${params.length}
          OR LOWER(COALESCE(t.id::text, '')) LIKE $${params.length}
          OR LOWER(COALESCE(t.account_id::text, '')) LIKE $${params.length}
          OR LOWER(COALESCE(a.user_id::text, '')) LIKE $${params.length}
        )`)
      }
      if (filters.status) {
        params.push(String(filters.status).trim().toLowerCase())
        where.push(`LOWER(COALESCE(t.status, '')) = $${params.length}`)
      }
      if (filters.direction) {
        params.push(String(filters.direction).trim().toLowerCase())
        where.push(`LOWER(COALESCE(t.direction, '')) = $${params.length}`)
      }
      if (filters.instrument) {
        params.push(String(filters.instrument).trim().toUpperCase())
        where.push(`UPPER(COALESCE(t.instrument, '')) = $${params.length}`)
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      const tradesResult = await pool.query(
        `SELECT t.id,
                t.account_id,
                a.user_id,
                u.email,
                t.instrument AS symbol,
                UPPER(t.direction) AS type,
                t.lot_size AS lots,
                t.open_price,
                t.close_price,
                t.stop_loss AS sl,
                t.take_profit AS tp,
                t.status,
                t.demo_pnl AS pnl,
                t.open_time,
                t.close_time
           FROM trades t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN users u ON u.id = a.user_id
           ${whereClause}
          ORDER BY COALESCE(t.close_time, t.open_time) DESC
          LIMIT 5000`,
        params
      )
      result = { allRows: tradesResult.rows }
      columns = [
        { header: 'Trade ID', key: 'id' },
        { header: 'Account ID', key: 'account_id' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Trader Email', key: 'email' },
        { header: 'Symbol', key: 'symbol' },
        { header: 'Direction', key: 'type' },
        { header: 'Lots', key: 'lots' },
        { header: 'Open Price', key: 'open_price' },
        { header: 'Close Price', key: 'close_price' },
        { header: 'Status', key: 'status' },
        { header: 'PnL', key: 'pnl' },
        { header: 'Open Time', key: 'open_time' },
        { header: 'Close Time', key: 'close_time' }
      ]
    } else if (resource === 'leaderboard') {
      const filters = query.filters || {}
      const params = [tenantId]
      const conditions = [
        `a.account_type = 'funded'`,
        `a.status = 'active'`,
        `COALESCE(u.is_banned, FALSE) = FALSE`,
        `($1::bigint IS NULL OR COALESCE(u.tenant_id, a.tenant_id, $1) = $1)`
      ]

      if (query.search) {
        params.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(u.email, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.full_name, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.country, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.trader_uid, '')) LIKE $${params.length}
        )`)
      }
      if (filters.visible === 'visible') {
        conditions.push(`COALESCE(u.leaderboard_visible, TRUE) = TRUE`)
      } else if (filters.visible === 'hidden') {
        conditions.push(`COALESCE(u.leaderboard_visible, TRUE) = FALSE`)
      }

      const leaderboardResult = await pool.query(
        `
          WITH ranked_accounts AS (
            SELECT
              u.id AS user_id,
              u.email,
              u.full_name,
              u.country,
              u.trader_uid,
              COALESCE(u.leaderboard_visible, TRUE) AS visible,
              a.account_uid,
              a.account_size,
              ROUND((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0))::numeric, 2) AS profit_usd,
              ROUND(
                CASE
                  WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                  ELSE ((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance) * 100
                END::numeric,
                2
              ) AS profit_pct,
              ROW_NUMBER() OVER (
                PARTITION BY u.id
                ORDER BY
                  CASE
                    WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                    ELSE (COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance
                  END DESC,
                  a.current_balance DESC,
                  a.id DESC
              ) AS rn
            FROM users u
            JOIN accounts a ON a.user_id = u.id
            WHERE ${conditions.join(' AND ')}
          ),
          closed_trade_stats AS (
            SELECT
              a.user_id,
              COUNT(t.id)::int AS total_trades,
              COALESCE(
                ROUND(
                  CASE
                    WHEN COUNT(t.id) = 0 THEN 0
                    ELSE (100.0 * COUNT(t.id) FILTER (WHERE t.demo_pnl > 0) / COUNT(t.id))
                  END::numeric,
                  1
                ),
                0
              ) AS win_rate
            FROM accounts a
            LEFT JOIN trades t ON t.account_id = a.id AND t.status = 'closed'
            WHERE ($1::bigint IS NULL OR COALESCE(a.tenant_id, $1) = $1)
            GROUP BY a.user_id
          )
          SELECT
            r.user_id,
            r.email,
            r.full_name,
            r.country,
            r.trader_uid,
            r.visible,
            r.account_uid,
            r.account_size,
            r.profit_usd,
            r.profit_pct,
            COALESCE(s.total_trades, 0) AS total_trades,
            COALESCE(s.win_rate, 0) AS win_rate
          FROM ranked_accounts r
          LEFT JOIN closed_trade_stats s ON s.user_id = r.user_id
          WHERE r.rn = 1
          ORDER BY r.profit_pct DESC, r.profit_usd DESC, r.user_id ASC
          LIMIT 5000
        `,
        params
      )
      result = {
        allRows: leaderboardResult.rows.map((row, index) => ({
          ...row,
          rank: index + 1,
          username: row.full_name,
          display_name: row.full_name,
          profit_pct: parseFloat(row.profit_pct || 0),
          profit_usd: parseFloat(row.profit_usd || 0),
          account_size: parseFloat(row.account_size || 0),
          total_trades: parseInt(row.total_trades || 0, 10),
          win_rate: parseFloat(row.win_rate || 0),
          visible: row.visible !== false
        }))
      }
      columns = [
        { header: 'Rank', key: 'rank' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Email', key: 'email' },
        { header: 'Full Name', key: 'full_name' },
        { header: 'Country', key: 'country' },
        { header: 'Trader UID', key: 'trader_uid' },
        { header: 'Visible', value: (row) => row.visible ? 'Yes' : 'No' },
        { header: 'Account UID', key: 'account_uid' },
        { header: 'Account Size', key: 'account_size' },
        { header: 'Profit USD', key: 'profit_usd' },
        { header: 'Profit %', key: 'profit_pct' },
        { header: 'Total Trades', key: 'total_trades' },
        { header: 'Win Rate', key: 'win_rate' }
      ]
    } else if (resource === 'bbook') {
      const filters = query.filters || {}
      const where = [
        `t.status = 'closed'`,
        `a.account_type = 'funded'`
      ]
      const params = []

      if (tenantId !== null && tenantId !== undefined) {
        params.push(tenantId)
        where.push(`COALESCE(a.tenant_id, $${params.length}) = $${params.length}`)
      }
      if (query.search) {
        params.push(`%${String(query.search).trim().toLowerCase()}%`)
        where.push(`(
          LOWER(COALESCE(t.instrument, '')) LIKE $${params.length}
          OR LOWER(COALESCE(t.id::text, '')) LIKE $${params.length}
        )`)
      }
      if (filters.direction) {
        params.push(String(filters.direction).trim().toLowerCase())
        where.push(`LOWER(COALESCE(t.direction, '')) = $${params.length}`)
      }
      if (filters.symbol) {
        params.push(String(filters.symbol).trim().toUpperCase())
        where.push(`UPPER(COALESCE(t.instrument, '')) = $${params.length}`)
      }
      if (filters.edge_side === 'positive') {
        where.push(`(COALESCE(t.commission, 0) - COALESCE(t.demo_pnl, 0)) >= 0`)
      } else if (filters.edge_side === 'negative') {
        where.push(`(COALESCE(t.commission, 0) - COALESCE(t.demo_pnl, 0)) < 0`)
      }

      const bbookResult = await pool.query(
        `
          SELECT
            t.id,
            t.instrument AS symbol,
            UPPER(t.direction) AS type,
            t.lot_size AS lots,
            COALESCE(t.demo_pnl, 0) AS trader_pnl,
            (COALESCE(t.commission, 0) - COALESCE(t.demo_pnl, 0)) AS platform_pnl,
            COALESCE(t.commission, 0) AS fee_revenue,
            t.close_time AS closed_at
          FROM trades t
          JOIN accounts a ON a.id = t.account_id
          WHERE ${where.join(' AND ')}
          ORDER BY t.close_time DESC NULLS LAST, t.id DESC
          LIMIT 5000
        `,
        params
      )
      result = { allRows: bbookResult.rows }
      columns = [
        { header: 'Trade ID', key: 'id' },
        { header: 'Symbol', key: 'symbol' },
        { header: 'Direction', key: 'type' },
        { header: 'Lots', key: 'lots' },
        { header: 'Trader PnL', key: 'trader_pnl' },
        { header: 'Platform Edge', key: 'platform_pnl' },
        { header: 'Fee Revenue', key: 'fee_revenue' },
        { header: 'Closed At', key: 'closed_at' }
      ]
    } else if (resource === 'chat_conversations') {
      await ensureChatTables()
      const filters = query.filters || {}
      const conditions = []
      const values = []

      if (tenantId !== null && tenantId !== undefined) {
        values.push(tenantId)
        conditions.push(`c.tenant_id = $${values.length}`)
      }
      if (query.search) {
        values.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(c.subject, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.email, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(c.id::text, '')) LIKE $${values.length}
          OR LOWER(COALESCE(last_message.message, '')) LIKE $${values.length}
        )`)
      }
      if (filters.status) {
        values.push(String(filters.status).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(c.status, '')) = $${values.length}`)
      }
      if (toBool(filters.unread_only, false)) {
        conditions.push(`COALESCE(c.unread_admin_count, 0) > 0`)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const chatResult = await pool.query(
        `
          SELECT
            c.id,
            c.user_id,
            c.subject,
            c.status,
            c.assigned_to,
            c.created_at,
            c.updated_at,
            c.last_message_at,
            c.unread_user_count,
            c.unread_admin_count,
            u.email AS user_email,
            u.full_name AS user_name,
            message_count.count AS message_count,
            last_message.message AS last_message
          FROM chat_conversations c
          LEFT JOIN users u ON u.id::text = c.user_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS count
            FROM chat_messages
            WHERE conversation_id = c.id
          ) AS message_count ON TRUE
          LEFT JOIN LATERAL (
            SELECT message
            FROM chat_messages
            WHERE conversation_id = c.id
            ORDER BY created_at DESC
            LIMIT 1
          ) AS last_message ON TRUE
          ${whereClause}
          ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
          LIMIT 5000
        `,
        values
      )
      result = { allRows: chatResult.rows }
      columns = [
        { header: 'Conversation ID', key: 'id' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Status', key: 'status' },
        { header: 'Subject', key: 'subject' },
        { header: 'User Email', key: 'user_email' },
        { header: 'User Name', key: 'user_name' },
        { header: 'Assigned To', key: 'assigned_to' },
        { header: 'Message Count', key: 'message_count' },
        { header: 'Unread Admin', key: 'unread_admin_count' },
        { header: 'Last Message', key: 'last_message' },
        { header: 'Last Message At', key: 'last_message_at' },
        { header: 'Created At', key: 'created_at' }
      ]
    } else if (resource === 'violations') {
      const filters = query.filters || {}
      const conditions = []
      const values = []

      if (tenantId !== null && tenantId !== undefined) {
        values.push(tenantId)
        conditions.push(`COALESCE(tenant_id, $${values.length}) = $${values.length}`)
      }
      if (query.search) {
        values.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(violation_type, '')) LIKE $${values.length}
          OR LOWER(COALESCE(message, '')) LIKE $${values.length}
          OR LOWER(COALESCE(instrument, '')) LIKE $${values.length}
          OR LOWER(COALESCE(account_id::text, '')) LIKE $${values.length}
          OR LOWER(COALESCE(user_id::text, '')) LIKE $${values.length}
          OR LOWER(COALESCE(id::text, '')) LIKE $${values.length}
        )`)
      }
      if (filters.status) {
        values.push(String(filters.status).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(status, '')) = $${values.length}`)
      }
      if (filters.severity) {
        values.push(String(filters.severity).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(severity, '')) = $${values.length}`)
      }
      if (filters.type) {
        values.push(String(filters.type).trim())
        conditions.push(`violation_type = $${values.length}`)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const violationsResult = await pool.query(
        `SELECT id, violation_type, severity, status, account_id, user_id, trade_id,
                instrument, source, message, hit_count, first_detected_at, last_detected_at,
                resolved_at, resolution_note, resolution_type
           FROM admin_rule_violations
           ${whereClause}
          ORDER BY last_detected_at DESC
          LIMIT 5000`,
        values
      )
      result = { allRows: violationsResult.rows }
      columns = [
        { header: 'Violation ID', key: 'id' },
        { header: 'Type', key: 'violation_type' },
        { header: 'Severity', key: 'severity' },
        { header: 'Status', key: 'status' },
        { header: 'Account ID', key: 'account_id' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Trade ID', key: 'trade_id' },
        { header: 'Instrument', key: 'instrument' },
        { header: 'Source', key: 'source' },
        { header: 'Message', key: 'message' },
        { header: 'Hit Count', key: 'hit_count' },
        { header: 'First Detected', key: 'first_detected_at' },
        { header: 'Last Detected', key: 'last_detected_at' },
        { header: 'Resolved At', key: 'resolved_at' },
        { header: 'Resolution Type', key: 'resolution_type' }
      ]
    } else if (resource === 'disputes') {
      const filters = query.filters || {}
      const conditions = []
      const values = []

      if (tenantId !== null && tenantId !== undefined) {
        values.push(tenantId)
        conditions.push(`COALESCE(d.tenant_id, $${values.length}) = $${values.length}`)
      }
      if (query.search) {
        values.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(d.reason, '')) LIKE $${values.length}
          OR LOWER(COALESCE(d.description, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.email, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(d.id::text, '')) LIKE $${values.length}
        )`)
      }
      if (filters.status) {
        values.push(String(filters.status).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(d.status, '')) = $${values.length}`)
      }
      if (filters.priority) {
        values.push(String(filters.priority).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(m.priority, 'normal')) = $${values.length}`)
      }
      if (filters.owner) {
        values.push(String(filters.owner).trim())
        conditions.push(`COALESCE(m.owner, 'unassigned') = $${values.length}`)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const disputesResult = await pool.query(
        `SELECT d.id::text AS dispute_id,
                d.status,
                d.reason,
                d.description,
                d.admin_response,
                d.created_at,
                d.updated_at,
                u.full_name,
                u.email,
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
           ${whereClause}
          ORDER BY d.created_at DESC
          LIMIT 5000`,
        values
      )
      result = { allRows: disputesResult.rows }
      columns = [
        { header: 'Dispute ID', key: 'dispute_id' },
        { header: 'Status', key: 'status' },
        { header: 'Reason', key: 'reason' },
        { header: 'Description', key: 'description' },
        { header: 'Admin Response', key: 'admin_response' },
        { header: 'Trader Name', key: 'full_name' },
        { header: 'Trader Email', key: 'email' },
        { header: 'Account UID', key: 'account_uid' },
        { header: 'Account Type', key: 'account_type' },
        { header: 'Account Status', key: 'account_status' },
        { header: 'Owner', key: 'owner' },
        { header: 'Priority', key: 'priority' },
        { header: 'SLA Hours', key: 'sla_hours' },
        { header: 'Notes', key: 'notes' },
        { header: 'Created At', key: 'created_at' },
        { header: 'Updated At', key: 'updated_at' }
      ]
    } else {
      return res.status(400).json({ error: 'resource must be traders, accounts, payouts, email_jobs, trades, leaderboard, bbook, chat_conversations, violations, or disputes' })
    }

    const csv = serializeCsv(result.allRows || [], columns)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${resource}-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(csv)
  } catch (error) {
    logger.error('Admin export error:', { error: error.message })
    res.status(500).json({ error: 'Could not export data' })
  }
})

router.get('/email-jobs', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureEmailQueueInfrastructure()
    const tenantId = getScopedTenantId(req)
    const paging = parseListPaging(req)
    const listResult = await buildEmailJobListResult({
      tenantId,
      query: {
        page: paging.page,
        pageSize: paging.pageSize,
        search: req.query.search || '',
        sort: req.query.sort || 'created_at',
        order: req.query.order || 'desc',
        filters: {
          status: req.query.status || null,
          template_key: req.query.template_key || null,
          delivery_type: req.query.delivery_type || null
        }
      }
    })
    res.json(wantsAdminListContract(req) ? listResult : {
      summary: listResult.summary,
      rows: listResult.rows
    })
  } catch (error) {
    logger.error('Admin email jobs fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch email jobs' })
  }
})

router.post('/email-jobs/:jobId/retry', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureEmailQueueInfrastructure()
    const tenantId = getScopedTenantId(req)
    const jobId = parseInt(req.params.jobId, 10)
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Valid email job id is required' })
    }

    const lookup = await pool.query(
      `SELECT id, status
         FROM email_jobs
        WHERE id = $1
          AND ($2::bigint IS NULL OR tenant_id = $2)
        LIMIT 1`,
      [jobId, tenantId]
    )
    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: 'Email job not found' })
    }

    const status = String(lookup.rows[0].status || '').toLowerCase()
    if (!['retry', 'dead', 'failed'].includes(status)) {
      return res.status(409).json({ error: 'Only retryable email jobs can be re-queued' })
    }

    await pool.query(
      `UPDATE email_jobs
          SET status = 'pending',
              scheduled_for = NOW(),
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [jobId]
    )

    res.json({ message: 'Email job re-queued', job_id: jobId })
  } catch (error) {
    logger.error('Admin email job retry error:', { error: error.message })
    res.status(500).json({ error: 'Could not re-queue email job' })
  }
})


module.exports = router
