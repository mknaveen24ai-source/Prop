'use strict'

const express = require('express')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const pool = require('../db')
const logger = require('../utils/logger')
const {
  authenticateAdmin,
  requireAdminCapability,
  requireTenantAdminOrSuperAdmin
} = require('./middleware')
const {
  ensureCopierRuntimeInfrastructure
} = require('../utils/copierRuntime')
const {
  COPIER_ALLOWED_MASTER_ACCOUNT_TYPES,
  COPIER_COPY_MODES,
  COPIER_JOB_STATES,
  COPIER_RISK_MODES,
  ensureCopierV2Infrastructure,
  normalizeBoolean,
  normalizeCopyMode,
  normalizeEntityId,
  normalizeFollowerStatus,
  normalizeMasterAccountTypes,
  normalizeNewsFilter,
  normalizeNonNegativeNumber,
  normalizePositiveNumber,
  normalizeRiskMode,
  normalizeSessionFilter,
  normalizeStringArray,
  normalizeTenantId,
  resolveScopedTenantId,
  safeJsonParse,
  writeCopierEvent
} = require('../utils/copierV2')

async function ensureCopierInfrastructure() {
  await ensureCopierRuntimeInfrastructure(pool)
  await ensureCopierV2Infrastructure(pool)
}

function isSuperAdmin(req) {
  return String(req?.admin?.role || '') === 'super_admin'
}

function getTenantFilter(req, explicitTenantId = null) {
  const tenantId = resolveScopedTenantId(req, explicitTenantId)
  return {
    tenantId,
    isSuperAdmin: isSuperAdmin(req)
  }
}

function requireScopedTenantId(req, explicitTenantId = null) {
  const tenantId = resolveScopedTenantId(req, explicitTenantId)
  if (!tenantId) {
    const error = new Error('tenant_id is required')
    error.statusCode = 400
    throw error
  }
  return tenantId
}

function buildScopedWhereClause(req, explicitTenantId = null, startIndex = 1, alias = 'tenant_id') {
  const { tenantId, isSuperAdmin: isRoot } = getTenantFilter(req, explicitTenantId)
  if (!isRoot) {
    return {
      clause: `${alias} = $${startIndex}`,
      values: [tenantId]
    }
  }
  if (tenantId) {
    return {
      clause: `${alias} = $${startIndex}`,
      values: [tenantId]
    }
  }
  return {
    clause: '1=1',
    values: []
  }
}

function parseFollowerPayload(body = {}) {
  return {
    display_name: String(body.display_name || '').trim().slice(0, 120),
    bridge_target_key: String(body.bridge_target_key || '').trim().slice(0, 120),
    status: normalizeFollowerStatus(body.status, 'active'),
    copy_mode: normalizeCopyMode(body.copy_mode, 'mirror'),
    risk_mode: normalizeRiskMode(body.risk_mode, 'fixed_lots'),
    fixed_lots: normalizePositiveNumber(body.fixed_lots),
    ratio_multiplier: normalizePositiveNumber(body.ratio_multiplier, 1) || 1,
    risk_percent: normalizePositiveNumber(body.risk_percent),
    symbol_allowlist: normalizeStringArray(body.symbol_allowlist, { upper: true, maxItems: 250, maxLength: 24 }),
    session_filter: normalizeSessionFilter(body.session_filter),
    news_filter: normalizeNewsFilter(body.news_filter),
    max_slippage_points: normalizeNonNegativeNumber(body.max_slippage_points),
    max_spread_points: normalizeNonNegativeNumber(body.max_spread_points),
    max_daily_loss_amount: normalizeNonNegativeNumber(body.max_daily_loss_amount),
    max_daily_loss_pct: normalizeNonNegativeNumber(body.max_daily_loss_pct),
    equity_floor_amount: normalizeNonNegativeNumber(body.equity_floor_amount),
    equity_floor_pct: normalizeNonNegativeNumber(body.equity_floor_pct)
  }
}

function parseMappingPayload(body = {}) {
  return {
    master_id: normalizeTenantId(body.master_id),
    follower_id: normalizeTenantId(body.follower_id),
    is_enabled: normalizeBoolean(body.is_enabled, true),
    copy_mode_override: body.copy_mode_override ? normalizeCopyMode(body.copy_mode_override, 'mirror') : null,
    allowed_master_account_types: normalizeMasterAccountTypes(body.allowed_master_account_types, COPIER_ALLOWED_MASTER_ACCOUNT_TYPES),
    symbol_allowlist: normalizeStringArray(body.symbol_allowlist, { upper: true, maxItems: 250, maxLength: 24 })
  }
}

function parseSymbolMappingPayload(body = {}) {
  return {
    follower_id: normalizeTenantId(body.follower_id),
    master_symbol: String(body.master_symbol || '').trim().toUpperCase().slice(0, 24),
    follower_symbol: String(body.follower_symbol || '').trim().toUpperCase().slice(0, 24),
    is_enabled: normalizeBoolean(body.is_enabled, true)
  }
}

function serializeFollower(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    bridge_target_key: row.bridge_target_key,
    status: row.status,
    copy_mode: row.copy_mode,
    risk_mode: row.risk_mode,
    fixed_lots: row.fixed_lots == null ? null : parseFloat(row.fixed_lots),
    ratio_multiplier: row.ratio_multiplier == null ? 1 : parseFloat(row.ratio_multiplier),
    risk_percent: row.risk_percent == null ? null : parseFloat(row.risk_percent),
    symbol_allowlist: safeJsonParse(row.symbol_allowlist_json, []),
    session_filter: safeJsonParse(row.session_filter_json, {}),
    news_filter: safeJsonParse(row.news_filter_json, {}),
    max_slippage_points: row.max_slippage_points == null ? null : parseFloat(row.max_slippage_points),
    max_spread_points: row.max_spread_points == null ? null : parseFloat(row.max_spread_points),
    max_daily_loss_amount: row.max_daily_loss_amount == null ? null : parseFloat(row.max_daily_loss_amount),
    max_daily_loss_pct: row.max_daily_loss_pct == null ? null : parseFloat(row.max_daily_loss_pct),
    equity_floor_amount: row.equity_floor_amount == null ? null : parseFloat(row.equity_floor_amount),
    equity_floor_pct: row.equity_floor_pct == null ? null : parseFloat(row.equity_floor_pct),
    symbol_catalog: safeJsonParse(row.symbol_catalog_json, []),
    symbol_constraints: safeJsonParse(row.symbol_constraints_json, {}),
    last_snapshot: safeJsonParse(row.last_snapshot_json, {}),
    last_balance: row.last_balance == null ? null : parseFloat(row.last_balance),
    last_equity: row.last_equity == null ? null : parseFloat(row.last_equity),
    last_snapshot_at: row.last_snapshot_at,
    last_heartbeat_at: row.last_heartbeat_at,
    stats: safeJsonParse(row.stats_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

router.use(authenticateAdmin, requireTenantAdminOrSuperAdmin)

router.get('/copier/masters', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const { clause, values } = buildScopedWhereClause(req, req.query.tenant_id, 1, 'm.tenant_id')
    const result = await pool.query(
      `SELECT
         m.*,
         a.account_uid,
         a.account_type,
         a.account_size,
         a.status AS account_status,
         u.email AS user_email,
         u.full_name AS user_full_name
       FROM copier_masters m
       JOIN accounts a ON a.id::text = m.account_id
       LEFT JOIN users u ON u.id = a.user_id
       WHERE ${clause}
       ORDER BY m.created_at DESC`,
      values
    )

    res.json(result.rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      account_id: row.account_id,
      label: row.label,
      is_enabled: row.is_enabled,
      account_uid: row.account_uid,
      account_type: row.account_type,
      account_size: row.account_size == null ? null : parseFloat(row.account_size),
      account_status: row.account_status,
      user_email: row.user_email || null,
      user_full_name: row.user_full_name || null,
      created_at: row.created_at,
      updated_at: row.updated_at
    })))
  } catch (error) {
    logger.error('[copier/masters:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier masters' })
  }
})

router.post('/copier/masters', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const tenantId = requireScopedTenantId(req, req.body.tenant_id)
    const accountId = normalizeEntityId(req.body.account_id)
    const label = String(req.body.label || '').trim().slice(0, 120) || null
    if (!accountId) {
      return res.status(400).json({ error: 'account_id is required' })
    }

    const accountResult = await pool.query(
      `SELECT id, tenant_id, account_type, status
         FROM accounts
        WHERE id = $1
          AND tenant_id = $2
        LIMIT 1`,
      [accountId, tenantId]
    )
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found in this tenant' })
    }

    const result = await pool.query(
      `INSERT INTO copier_masters (tenant_id, account_id, label, created_by_admin_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (account_id)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         label = COALESCE(EXCLUDED.label, copier_masters.label),
         is_enabled = TRUE,
         updated_at = NOW()
       RETURNING *`,
      [tenantId, accountId, label, req.admin?.adminId || null]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('[copier/masters:create] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not create copier master' })
  }
})

router.patch('/copier/masters/:id', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const masterId = normalizeTenantId(req.params.id)
    if (!masterId) {
      return res.status(400).json({ error: 'Invalid master id' })
    }

    const tenantId = requireScopedTenantId(req, req.body.tenant_id || req.query.tenant_id)
    const updates = []
    const values = []
    let idx = 1

    if (req.body.label !== undefined) {
      updates.push(`label = $${idx++}`)
      values.push(String(req.body.label || '').trim().slice(0, 120) || null)
    }
    if (req.body.is_enabled !== undefined) {
      updates.push(`is_enabled = $${idx++}`)
      values.push(normalizeBoolean(req.body.is_enabled, true))
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No master fields to update' })
    }

    updates.push(`updated_at = NOW()`)
    values.push(masterId, tenantId)
    const result = await pool.query(
      `UPDATE copier_masters
          SET ${updates.join(', ')}
        WHERE id = $${idx++}
          AND tenant_id = $${idx}
      RETURNING *`,
      values
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copier master not found' })
    }
    res.json(result.rows[0])
  } catch (error) {
    logger.error('[copier/masters:update] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not update copier master' })
  }
})

router.get('/copier/followers', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const { clause, values } = buildScopedWhereClause(req, req.query.tenant_id, 1, 'f.tenant_id')
    const result = await pool.query(
      `SELECT f.*
         FROM copier_followers f
        WHERE ${clause}
        ORDER BY f.created_at DESC`,
      values
    )

    res.json(result.rows.map(serializeFollower))
  } catch (error) {
    logger.error('[copier/followers:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier followers' })
  }
})

router.post('/copier/followers', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const tenantId = requireScopedTenantId(req, req.body.tenant_id)
    const follower = parseFollowerPayload(req.body)

    if (!follower.display_name || !follower.bridge_target_key) {
      return res.status(400).json({ error: 'display_name and bridge_target_key are required' })
    }
    if (follower.risk_mode === 'fixed_lots' && !follower.fixed_lots) {
      return res.status(400).json({ error: 'fixed_lots is required for fixed_lots risk mode' })
    }
    if (follower.risk_mode === 'risk_percent' && !follower.risk_percent) {
      return res.status(400).json({ error: 'risk_percent is required for risk_percent risk mode' })
    }

    const result = await pool.query(
      `INSERT INTO copier_followers (
         tenant_id,
         display_name,
         bridge_target_key,
         status,
         copy_mode,
         risk_mode,
         fixed_lots,
         ratio_multiplier,
         risk_percent,
         symbol_allowlist_json,
         session_filter_json,
         news_filter_json,
         max_slippage_points,
         max_spread_points,
         max_daily_loss_amount,
         max_daily_loss_pct,
         equity_floor_amount,
         equity_floor_pct
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18
       )
       RETURNING *`,
      [
        tenantId,
        follower.display_name,
        follower.bridge_target_key,
        follower.status,
        follower.copy_mode,
        follower.risk_mode,
        follower.fixed_lots,
        follower.ratio_multiplier,
        follower.risk_percent,
        JSON.stringify(follower.symbol_allowlist),
        JSON.stringify(follower.session_filter),
        JSON.stringify(follower.news_filter),
        follower.max_slippage_points,
        follower.max_spread_points,
        follower.max_daily_loss_amount,
        follower.max_daily_loss_pct,
        follower.equity_floor_amount,
        follower.equity_floor_pct
      ]
    )

    res.status(201).json(serializeFollower(result.rows[0]))
  } catch (error) {
    logger.error('[copier/followers:create] error:', { error: error.message })
    res.status(error.code === '23505' ? 409 : 500).json({ error: error.code === '23505' ? 'bridge_target_key already exists for this tenant' : 'Could not create copier follower' })
  }
})

router.patch('/copier/followers/:id', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const followerId = normalizeTenantId(req.params.id)
    if (!followerId) {
      return res.status(400).json({ error: 'Invalid follower id' })
    }
    const tenantId = requireScopedTenantId(req, req.body.tenant_id || req.query.tenant_id)
    const follower = parseFollowerPayload(req.body)
    const updates = []
    const values = []
    let idx = 1

    const assign = (field, value, cast = '') => {
      updates.push(`${field} = $${idx++}${cast}`)
      values.push(value)
    }

    if (req.body.display_name !== undefined) assign('display_name', follower.display_name)
    if (req.body.bridge_target_key !== undefined) assign('bridge_target_key', follower.bridge_target_key)
    if (req.body.status !== undefined) assign('status', follower.status)
    if (req.body.copy_mode !== undefined) assign('copy_mode', follower.copy_mode)
    if (req.body.risk_mode !== undefined) assign('risk_mode', follower.risk_mode)
    if (req.body.fixed_lots !== undefined) assign('fixed_lots', follower.fixed_lots)
    if (req.body.ratio_multiplier !== undefined) assign('ratio_multiplier', follower.ratio_multiplier)
    if (req.body.risk_percent !== undefined) assign('risk_percent', follower.risk_percent)
    if (req.body.symbol_allowlist !== undefined) assign('symbol_allowlist_json', JSON.stringify(follower.symbol_allowlist), '::jsonb')
    if (req.body.session_filter !== undefined) assign('session_filter_json', JSON.stringify(follower.session_filter), '::jsonb')
    if (req.body.news_filter !== undefined) assign('news_filter_json', JSON.stringify(follower.news_filter), '::jsonb')
    if (req.body.max_slippage_points !== undefined) assign('max_slippage_points', follower.max_slippage_points)
    if (req.body.max_spread_points !== undefined) assign('max_spread_points', follower.max_spread_points)
    if (req.body.max_daily_loss_amount !== undefined) assign('max_daily_loss_amount', follower.max_daily_loss_amount)
    if (req.body.max_daily_loss_pct !== undefined) assign('max_daily_loss_pct', follower.max_daily_loss_pct)
    if (req.body.equity_floor_amount !== undefined) assign('equity_floor_amount', follower.equity_floor_amount)
    if (req.body.equity_floor_pct !== undefined) assign('equity_floor_pct', follower.equity_floor_pct)

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No follower fields to update' })
    }

    updates.push('updated_at = NOW()')
    values.push(followerId, tenantId)
    const result = await pool.query(
      `UPDATE copier_followers
          SET ${updates.join(', ')}
        WHERE id = $${idx++}
          AND tenant_id = $${idx}
      RETURNING *`,
      values
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copier follower not found' })
    }
    res.json(serializeFollower(result.rows[0]))
  } catch (error) {
    logger.error('[copier/followers:update] error:', { error: error.message })
    res.status(500).json({ error: 'Could not update copier follower' })
  }
})

router.post('/copier/followers/:id/pause', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const followerId = normalizeTenantId(req.params.id)
    const tenantId = requireScopedTenantId(req, req.body?.tenant_id || req.query.tenant_id)
    const result = await pool.query(
      `UPDATE copier_followers
          SET status = 'paused',
              updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
      RETURNING *`,
      [followerId, tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copier follower not found' })
    }
    res.json(serializeFollower(result.rows[0]))
  } catch (error) {
    logger.error('[copier/followers:pause] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not pause copier follower' })
  }
})

router.post('/copier/followers/:id/resume', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const followerId = normalizeTenantId(req.params.id)
    const tenantId = requireScopedTenantId(req, req.body?.tenant_id || req.query.tenant_id)
    const result = await pool.query(
      `UPDATE copier_followers
          SET status = 'active',
              updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
      RETURNING *`,
      [followerId, tenantId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copier follower not found' })
    }
    res.json(serializeFollower(result.rows[0]))
  } catch (error) {
    logger.error('[copier/followers:resume] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not resume copier follower' })
  }
})

router.get('/copier/mappings', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const { clause, values } = buildScopedWhereClause(req, req.query.tenant_id, 1, 'mf.tenant_id')
    const result = await pool.query(
      `SELECT
         mf.*,
         m.account_id AS master_account_id,
         m.label AS master_label,
         f.display_name AS follower_display_name,
         f.bridge_target_key
       FROM copier_master_followers mf
       JOIN copier_masters m ON m.id = mf.master_id
       JOIN copier_followers f ON f.id = mf.follower_id
       WHERE ${clause}
       ORDER BY mf.created_at DESC`,
      values
    )

    res.json(result.rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      master_id: row.master_id,
      follower_id: row.follower_id,
      master_account_id: row.master_account_id,
      master_label: row.master_label,
      follower_display_name: row.follower_display_name,
      bridge_target_key: row.bridge_target_key,
      is_enabled: row.is_enabled,
      copy_mode_override: row.copy_mode_override,
      allowed_master_account_types: safeJsonParse(row.allowed_master_account_types_json, []),
      symbol_allowlist: safeJsonParse(row.symbol_allowlist_json, []),
      created_at: row.created_at,
      updated_at: row.updated_at
    })))
  } catch (error) {
    logger.error('[copier/mappings:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier mappings' })
  }
})

router.post('/copier/mappings', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const tenantId = requireScopedTenantId(req, req.body.tenant_id)
    const mapping = parseMappingPayload(req.body)
    if (!mapping.master_id || !mapping.follower_id) {
      return res.status(400).json({ error: 'master_id and follower_id are required' })
    }

    const ownershipResult = await pool.query(
      `SELECT
         (SELECT tenant_id FROM copier_masters WHERE id = $1) AS master_tenant_id,
         (SELECT tenant_id FROM copier_followers WHERE id = $2) AS follower_tenant_id`,
      [mapping.master_id, mapping.follower_id]
    )
    const ownership = ownershipResult.rows[0] || {}
    if (Number(ownership.master_tenant_id || 0) !== tenantId || Number(ownership.follower_tenant_id || 0) !== tenantId) {
      return res.status(400).json({ error: 'master_id and follower_id must belong to this tenant' })
    }

    const result = await pool.query(
      `INSERT INTO copier_master_followers (
         tenant_id,
         master_id,
         follower_id,
         is_enabled,
         copy_mode_override,
         allowed_master_account_types_json,
         symbol_allowlist_json
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       ON CONFLICT (master_id, follower_id)
       DO UPDATE SET
         is_enabled = EXCLUDED.is_enabled,
         copy_mode_override = EXCLUDED.copy_mode_override,
         allowed_master_account_types_json = EXCLUDED.allowed_master_account_types_json,
         symbol_allowlist_json = EXCLUDED.symbol_allowlist_json,
         updated_at = NOW()
       RETURNING *`,
      [
        tenantId,
        mapping.master_id,
        mapping.follower_id,
        mapping.is_enabled,
        mapping.copy_mode_override,
        JSON.stringify(mapping.allowed_master_account_types),
        JSON.stringify(mapping.symbol_allowlist)
      ]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('[copier/mappings:create] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not save copier mapping' })
  }
})

router.patch('/copier/mappings/:id', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const mappingId = normalizeTenantId(req.params.id)
    if (!mappingId) {
      return res.status(400).json({ error: 'Invalid mapping id' })
    }
    const tenantId = requireScopedTenantId(req, req.body.tenant_id || req.query.tenant_id)
    const mapping = parseMappingPayload(req.body)
    const updates = []
    const values = []
    let idx = 1

    const assign = (field, value, cast = '') => {
      updates.push(`${field} = $${idx++}${cast}`)
      values.push(value)
    }

    if (req.body.is_enabled !== undefined) assign('is_enabled', mapping.is_enabled)
    if (req.body.copy_mode_override !== undefined) assign('copy_mode_override', mapping.copy_mode_override)
    if (req.body.allowed_master_account_types !== undefined) assign('allowed_master_account_types_json', JSON.stringify(mapping.allowed_master_account_types), '::jsonb')
    if (req.body.symbol_allowlist !== undefined) assign('symbol_allowlist_json', JSON.stringify(mapping.symbol_allowlist), '::jsonb')
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No mapping fields to update' })
    }

    updates.push('updated_at = NOW()')
    values.push(mappingId, tenantId)
    const result = await pool.query(
      `UPDATE copier_master_followers
          SET ${updates.join(', ')}
        WHERE id = $${idx++}
          AND tenant_id = $${idx}
      RETURNING *`,
      values
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copier mapping not found' })
    }
    res.json(result.rows[0])
  } catch (error) {
    logger.error('[copier/mappings:update] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not update copier mapping' })
  }
})

router.get('/copier/symbol-mappings', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const { clause, values } = buildScopedWhereClause(req, req.query.tenant_id, 1, 'sm.tenant_id')
    const result = await pool.query(
      `SELECT
         sm.*,
         f.display_name AS follower_display_name
       FROM copier_symbol_mappings sm
       JOIN copier_followers f ON f.id = sm.follower_id
       WHERE ${clause}
       ORDER BY sm.created_at DESC`,
      values
    )

    res.json(result.rows.map((row) => ({
      id: row.id,
      tenant_id: row.tenant_id,
      follower_id: row.follower_id,
      follower_display_name: row.follower_display_name,
      master_symbol: row.master_symbol,
      follower_symbol: row.follower_symbol,
      is_enabled: row.is_enabled,
      created_at: row.created_at,
      updated_at: row.updated_at
    })))
  } catch (error) {
    logger.error('[copier/symbol-mappings:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier symbol mappings' })
  }
})

router.post('/copier/symbol-mappings', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const tenantId = requireScopedTenantId(req, req.body.tenant_id)
    const mapping = parseSymbolMappingPayload(req.body)
    if (!mapping.follower_id || !mapping.master_symbol || !mapping.follower_symbol) {
      return res.status(400).json({ error: 'follower_id, master_symbol, and follower_symbol are required' })
    }

    const followerResult = await pool.query(
      `SELECT id FROM copier_followers WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [mapping.follower_id, tenantId]
    )
    if (followerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Follower not found in this tenant' })
    }

    const result = await pool.query(
      `INSERT INTO copier_symbol_mappings (tenant_id, follower_id, master_symbol, follower_symbol, is_enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (follower_id, master_symbol)
       DO UPDATE SET
         follower_symbol = EXCLUDED.follower_symbol,
         is_enabled = EXCLUDED.is_enabled,
         updated_at = NOW()
       RETURNING *`,
      [tenantId, mapping.follower_id, mapping.master_symbol, mapping.follower_symbol, mapping.is_enabled]
    )

    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('[copier/symbol-mappings:create] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not save symbol mapping' })
  }
})

router.patch('/copier/symbol-mappings/:id', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const symbolMappingId = normalizeTenantId(req.params.id)
    if (!symbolMappingId) {
      return res.status(400).json({ error: 'Invalid symbol mapping id' })
    }
    const tenantId = requireScopedTenantId(req, req.body.tenant_id || req.query.tenant_id)
    const mapping = parseSymbolMappingPayload(req.body)
    const updates = []
    const values = []
    let idx = 1

    if (req.body.master_symbol !== undefined) {
      updates.push(`master_symbol = $${idx++}`)
      values.push(mapping.master_symbol)
    }
    if (req.body.follower_symbol !== undefined) {
      updates.push(`follower_symbol = $${idx++}`)
      values.push(mapping.follower_symbol)
    }
    if (req.body.is_enabled !== undefined) {
      updates.push(`is_enabled = $${idx++}`)
      values.push(mapping.is_enabled)
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No symbol mapping fields to update' })
    }

    updates.push(`updated_at = NOW()`)
    values.push(symbolMappingId, tenantId)
    const result = await pool.query(
      `UPDATE copier_symbol_mappings
          SET ${updates.join(', ')}
        WHERE id = $${idx++}
          AND tenant_id = $${idx}
      RETURNING *`,
      values
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Symbol mapping not found' })
    }
    res.json(result.rows[0])
  } catch (error) {
    logger.error('[copier/symbol-mappings:update] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not update symbol mapping' })
  }
})

router.get('/copier/alerts', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const { clause, values } = buildScopedWhereClause(req, req.query.tenant_id, 1)
    const result = await pool.query(
      `SELECT * FROM copier_alert_endpoints WHERE ${clause} ORDER BY created_at DESC`,
      values
    )
    res.json(result.rows.map((row) => ({
      ...row,
      event_allowlist: safeJsonParse(row.event_allowlist_json, [])
    })))
  } catch (error) {
    logger.error('[copier/alerts:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier alerts' })
  }
})

router.post('/copier/alerts', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const tenantId = requireScopedTenantId(req, req.body.tenant_id)
    const displayName = String(req.body.display_name || '').trim().slice(0, 120)
    const endpointType = String(req.body.endpoint_type || 'webhook').trim().toLowerCase()
    if (!displayName) {
      return res.status(400).json({ error: 'display_name is required' })
    }
    const result = await pool.query(
      `INSERT INTO copier_alert_endpoints (
         tenant_id, endpoint_type, display_name, target_url, secret, is_enabled, event_allowlist_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING *`,
      [
        tenantId,
        endpointType,
        displayName,
        req.body.target_url ? String(req.body.target_url).trim().slice(0, 500) : null,
        req.body.secret ? String(req.body.secret).trim().slice(0, 255) : null,
        normalizeBoolean(req.body.is_enabled, true),
        JSON.stringify(normalizeStringArray(req.body.event_allowlist, { lower: true, maxItems: 50, maxLength: 60 }))
      ]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('[copier/alerts:create] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not save copier alert endpoint' })
  }
})

router.patch('/copier/alerts/:id', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const alertId = normalizeTenantId(req.params.id)
    const tenantId = requireScopedTenantId(req, req.body.tenant_id || req.query.tenant_id)
    const updates = []
    const values = []
    let idx = 1
    const assign = (field, value, cast = '') => {
      updates.push(`${field} = $${idx++}${cast}`)
      values.push(value)
    }
    if (req.body.display_name !== undefined) assign('display_name', String(req.body.display_name || '').trim().slice(0, 120))
    if (req.body.target_url !== undefined) assign('target_url', req.body.target_url ? String(req.body.target_url).trim().slice(0, 500) : null)
    if (req.body.secret !== undefined) assign('secret', req.body.secret ? String(req.body.secret).trim().slice(0, 255) : null)
    if (req.body.is_enabled !== undefined) assign('is_enabled', normalizeBoolean(req.body.is_enabled, true))
    if (req.body.event_allowlist !== undefined) assign('event_allowlist_json', JSON.stringify(normalizeStringArray(req.body.event_allowlist, { lower: true, maxItems: 50, maxLength: 60 })), '::jsonb')
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No alert fields to update' })
    }
    updates.push('updated_at = NOW()')
    values.push(alertId, tenantId)
    const result = await pool.query(
      `UPDATE copier_alert_endpoints
          SET ${updates.join(', ')}
        WHERE id = $${idx++}
          AND tenant_id = $${idx}
      RETURNING *`,
      values
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Alert endpoint not found' })
    }
    res.json(result.rows[0])
  } catch (error) {
    logger.error('[copier/alerts:update] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not update copier alert endpoint' })
  }
})

router.get('/copier/health', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const tenantId = resolveScopedTenantId(req, req.query.tenant_id)
    const filters = []
    const values = []
    let idx = 1
    if (tenantId) {
      filters.push(`j.tenant_id = $${idx++}`)
      values.push(tenantId)
    }
    const jobWhere = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const followerWhere = tenantId ? 'WHERE tenant_id = $1' : ''
    const runtimeWhere = tenantId ? 'WHERE tenant_id = $1 OR tenant_id IS NULL' : ''

    const [runtimeResult, jobsResult, followerResult] = await Promise.all([
      pool.query(`SELECT * FROM copier_runtime_status ${runtimeWhere} ORDER BY updated_at DESC LIMIT 5`, tenantId ? [tenantId] : []),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE j.state IN ('pending','retry','sent'))::INT AS queue_depth,
           COUNT(*) FILTER (WHERE j.state = 'dead')::INT AS dead_letter_count,
           COUNT(*) FILTER (WHERE j.state = 'acknowledged' AND j.acknowledged_at >= NOW() - INTERVAL '1 hour')::INT AS acknowledged_last_hour,
           COUNT(*) FILTER (WHERE j.state = 'retry' AND j.updated_at >= NOW() - INTERVAL '1 hour')::INT AS retry_last_hour,
           COUNT(*) FILTER (WHERE j.state = 'skipped' AND j.updated_at >= NOW() - INTERVAL '1 hour')::INT AS skipped_last_hour,
           PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.latency_ms) AS ack_p50_ms,
           PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY a.latency_ms) AS ack_p95_ms
         FROM copier_jobs j
         LEFT JOIN copier_job_attempts a
           ON a.job_id = j.id
          AND a.delivery_status = 'acknowledged'
          AND a.latency_ms IS NOT NULL
         ${jobWhere}`,
        values
      ),
      pool.query(
        `SELECT
           COUNT(*)::INT AS follower_count,
           COUNT(*) FILTER (WHERE status = 'active')::INT AS active_followers,
           COUNT(*) FILTER (WHERE status = 'paused')::INT AS paused_followers,
           COUNT(*) FILTER (WHERE status = 'breached')::INT AS breached_followers
         FROM copier_followers
         ${followerWhere}`,
        tenantId ? [tenantId] : []
      )
    ])

    const runtimeRows = runtimeResult.rows || []
    const runtime = runtimeRows[0] || {}
    const jobs = jobsResult.rows[0] || {}
    const followers = followerResult.rows[0] || {}

    const perFollowerRates = await pool.query(
      `SELECT
         f.id AS follower_id,
         f.display_name,
         COUNT(*) FILTER (WHERE j.state = 'acknowledged')::INT AS success_count,
         COUNT(*) FILTER (WHERE j.state = 'dead')::INT AS failure_count
       FROM copier_followers f
       LEFT JOIN copier_jobs j
         ON j.follower_id = f.id
       ${tenantId ? 'WHERE f.tenant_id = $1' : ''}
       GROUP BY f.id, f.display_name
       ORDER BY f.display_name ASC`,
      tenantId ? [tenantId] : []
    )

    const perTenantStatus = await pool.query(
      `SELECT
         tenant_id,
         COUNT(*)::INT AS follower_count,
         COUNT(*) FILTER (WHERE status = 'active')::INT AS active_followers,
         MAX(last_heartbeat_at) AS latest_follower_heartbeat
       FROM copier_followers
       ${tenantId ? 'WHERE tenant_id = $1' : ''}
       GROUP BY tenant_id
       ORDER BY tenant_id ASC`,
      tenantId ? [tenantId] : []
    )

    res.json({
      runtime: {
        status_key: runtime.status_key || 'primary',
        running: Boolean(runtime.running),
        socket_ready: Boolean(runtime.socket_ready),
        ws_connected: Boolean(runtime.ws_connected),
        queue_depth: Number(jobs.queue_depth || runtime.queue_depth || 0),
        last_heartbeat_at: runtime.last_heartbeat_at || null,
        bridge_heartbeat_at: runtime.bridge_heartbeat_at || null,
        last_snapshot_at: runtime.last_snapshot_at || null,
        last_signal_sent_at: runtime.last_signal_sent_at || null,
        last_error: runtime.last_error || null,
        ack_p50_ms: jobs.ack_p50_ms == null ? null : Math.round(Number(jobs.ack_p50_ms)),
        ack_p95_ms: jobs.ack_p95_ms == null ? null : Math.round(Number(jobs.ack_p95_ms))
      },
      totals: {
        follower_count: Number(followers.follower_count || 0),
        active_followers: Number(followers.active_followers || 0),
        paused_followers: Number(followers.paused_followers || 0),
        breached_followers: Number(followers.breached_followers || 0),
        dead_letter_count: Number(jobs.dead_letter_count || 0),
        acknowledged_last_hour: Number(jobs.acknowledged_last_hour || 0),
        retry_last_hour: Number(jobs.retry_last_hour || 0),
        skipped_last_hour: Number(jobs.skipped_last_hour || 0)
      },
      per_follower: perFollowerRates.rows,
      per_tenant: perTenantStatus.rows
    })
  } catch (error) {
    logger.error('[copier/health] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier health dashboard' })
  }
})

router.get('/copier/jobs', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const tenantId = resolveScopedTenantId(req, req.query.tenant_id)
    const conditions = []
    const values = []
    let idx = 1
    if (tenantId) {
      conditions.push(`j.tenant_id = $${idx++}`)
      values.push(tenantId)
    }
    if (req.query.state) {
      conditions.push(`j.state = $${idx++}`)
      values.push(String(req.query.state).trim().toLowerCase())
    }
    if (req.query.follower_id) {
      conditions.push(`j.follower_id = $${idx++}`)
      values.push(normalizeTenantId(req.query.follower_id))
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.min(500, Math.max(1, normalizeTenantId(req.query.limit, 100) || 100))

    const result = await pool.query(
      `SELECT
         j.*,
         e.event_type,
         e.master_trade_id,
         f.display_name AS follower_display_name,
         m.master_id,
         cm.account_id AS master_account_id
       FROM copier_jobs j
       JOIN copier_events e ON e.id = j.event_id
       JOIN copier_followers f ON f.id = j.follower_id
       JOIN copier_master_followers m ON m.id = j.mapping_id
       JOIN copier_masters cm ON cm.id = e.master_id
       ${whereClause}
       ORDER BY j.updated_at DESC
       LIMIT ${limit}`,
      values
    )

    res.json(result.rows.map((row) => ({
      ...row,
      ack_payload: safeJsonParse(row.ack_payload_json, {}),
      command: safeJsonParse(row.command_json, {})
    })))
  } catch (error) {
    logger.error('[copier/jobs:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier jobs' })
  }
})

router.get('/copier/dead-letters', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const tenantId = resolveScopedTenantId(req, req.query.tenant_id)
    const conditions = [`j.state = 'dead'`]
    const values = []
    let idx = 1

    if (tenantId) {
      conditions.push(`j.tenant_id = $${idx++}`)
      values.push(tenantId)
    }
    if (req.query.follower_id) {
      conditions.push(`j.follower_id = $${idx++}`)
      values.push(normalizeTenantId(req.query.follower_id))
    }

    const limit = Math.min(500, Math.max(1, normalizeTenantId(req.query.limit, 100) || 100))
    const result = await pool.query(
      `SELECT
         j.*,
         e.event_type,
         e.master_trade_id,
         f.display_name AS follower_display_name
       FROM copier_jobs j
       JOIN copier_events e ON e.id = j.event_id
       JOIN copier_followers f ON f.id = j.follower_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY j.updated_at DESC
       LIMIT ${limit}`,
      values
    )

    res.json(result.rows.map((row) => ({
      ...row,
      ack_payload: safeJsonParse(row.ack_payload_json, {}),
      command: safeJsonParse(row.command_json, {})
    })))
  } catch (error) {
    logger.error('[copier/dead-letters:list] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier dead letters' })
  }
})

router.post('/copier/jobs/:id/retry', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const jobId = normalizeTenantId(req.params.id)
    if (!jobId) {
      return res.status(400).json({ error: 'Invalid job id' })
    }
    const tenantId = resolveScopedTenantId(req, req.body?.tenant_id || req.query.tenant_id)
    const result = await pool.query(
      `UPDATE copier_jobs
          SET state = 'retry',
              scheduled_at = NOW(),
              dead_reason = NULL,
              last_error = NULL,
              updated_at = NOW()
        WHERE id = $1
          ${tenantId ? 'AND tenant_id = $2' : ''}
      RETURNING *`,
      tenantId ? [jobId, tenantId] : [jobId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Copier job not found' })
    }
    res.json(result.rows[0])
  } catch (error) {
    logger.error('[copier/jobs:retry] error:', { error: error.message })
    res.status(500).json({ error: 'Could not retry copier job' })
  }
})

router.get('/copier/reconciliation', requireAdminCapability('copier:read:scoped'), async (req, res) => {
  try {
    const tenantId = resolveScopedTenantId(req, req.query.tenant_id)
    const values = []
    const conditions = []
    let idx = 1
    if (tenantId) {
      conditions.push(`m.tenant_id = $${idx++}`)
      values.push(tenantId)
    }
    if (req.query.follower_id) {
      conditions.push(`mf.follower_id = $${idx++}`)
      values.push(normalizeTenantId(req.query.follower_id))
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const mappingResult = await pool.query(
      `SELECT
         mf.id AS mapping_id,
         mf.follower_id,
         f.display_name AS follower_display_name,
         f.last_snapshot_json,
         m.id AS master_id,
         cm.account_id AS master_account_id
       FROM copier_master_followers mf
       JOIN copier_followers f ON f.id = mf.follower_id
       JOIN copier_masters cm ON cm.id = mf.master_id
       JOIN copier_masters m ON m.id = mf.master_id
       ${whereClause}`,
      values
    )

    const diffs = []
    for (const row of mappingResult.rows) {
      const snapshot = safeJsonParse(row.last_snapshot_json, {})
      const positions = Array.isArray(snapshot.positions) ? snapshot.positions : []
      const pendingOrders = Array.isArray(snapshot.pending_orders) ? snapshot.pending_orders : []

      const masterOpenTrades = await pool.query(
        `SELECT id, instrument, stop_loss, take_profit, lot_size, status, order_type
           FROM trades
          WHERE account_id = $1
            AND status IN ('open', 'pending')`,
        [row.master_account_id]
      )

      const linkRows = await pool.query(
        `SELECT master_trade_id, follower_external_ticket, follower_external_order_id, mapped_symbol, last_known_lots, current_state
           FROM copier_position_links
          WHERE follower_id = $1`,
        [row.follower_id]
      )
      const linksByMasterTrade = new Map(linkRows.rows.map((link) => [String(link.master_trade_id), link]))

      for (const trade of masterOpenTrades.rows) {
        const link = linksByMasterTrade.get(String(trade.id))
        if (!link) {
          diffs.push({
            type: trade.status === 'pending' ? 'pending_state_mismatch' : 'missing_follower_position',
            master_trade_id: trade.id,
            follower_id: row.follower_id,
            follower_display_name: row.follower_display_name,
            master_id: row.master_id,
            detail: 'No follower link exists for master trade'
          })
          continue
        }

        const targetCollection = trade.status === 'pending' ? pendingOrders : positions
        const externalId = trade.status === 'pending' ? link.follower_external_order_id : link.follower_external_ticket
        const followerPosition = targetCollection.find((item) => String(item.ticket || item.order_id || '') === String(externalId || ''))
        if (!followerPosition) {
          diffs.push({
            type: trade.status === 'pending' ? 'pending_state_mismatch' : 'missing_follower_position',
            master_trade_id: trade.id,
            follower_id: row.follower_id,
            follower_display_name: row.follower_display_name,
            master_id: row.master_id,
            detail: 'Follower snapshot does not include linked position/order'
          })
          continue
        }

        const followerLots = parseFloat(followerPosition.lots || followerPosition.volume || 0)
        const linkLots = parseFloat(link.last_known_lots || 0)
        if (Number.isFinite(followerLots) && Number.isFinite(linkLots) && Math.abs(followerLots - linkLots) > 0.0001) {
          diffs.push({
            type: 'size_mismatch',
            master_trade_id: trade.id,
            follower_id: row.follower_id,
            follower_display_name: row.follower_display_name,
            master_id: row.master_id,
            detail: `Follower lots ${followerLots} differ from last known ${linkLots}`
          })
        }

        const followerSl = parseFloat(followerPosition.stop_loss ?? followerPosition.sl ?? 0)
        const masterSl = parseFloat(trade.stop_loss ?? 0)
        if (Number.isFinite(followerSl) && Number.isFinite(masterSl) && Math.abs(followerSl - masterSl) > 0.0001) {
          diffs.push({
            type: 'sl_mismatch',
            master_trade_id: trade.id,
            follower_id: row.follower_id,
            follower_display_name: row.follower_display_name,
            master_id: row.master_id,
            detail: `Follower SL ${followerSl} differs from master SL ${masterSl}`
          })
        }

        const followerTp = parseFloat(followerPosition.take_profit ?? followerPosition.tp ?? 0)
        const masterTp = parseFloat(trade.take_profit ?? 0)
        if (Number.isFinite(followerTp) && Number.isFinite(masterTp) && Math.abs(followerTp - masterTp) > 0.0001) {
          diffs.push({
            type: 'tp_mismatch',
            master_trade_id: trade.id,
            follower_id: row.follower_id,
            follower_display_name: row.follower_display_name,
            master_id: row.master_id,
            detail: `Follower TP ${followerTp} differs from master TP ${masterTp}`
          })
        }
      }

      const linkedExternalTickets = new Set(linkRows.rows.map((link) => String(link.follower_external_ticket || link.follower_external_order_id || '')).filter(Boolean))
      for (const position of positions) {
        const ticket = String(position.ticket || '')
        if (ticket && !linkedExternalTickets.has(ticket)) {
          diffs.push({
            type: 'orphan_follower_position',
            master_trade_id: null,
            follower_id: row.follower_id,
            follower_display_name: row.follower_display_name,
            master_id: row.master_id,
            detail: `Follower position ${ticket} is not linked to any master trade`
          })
        }
      }
    }

    res.json({ rows: diffs, total: diffs.length })
  } catch (error) {
    logger.error('[copier/reconciliation] error:', { error: error.message })
    res.status(500).json({ error: 'Could not load copier reconciliation' })
  }
})

router.post('/copier/reconciliation/resync', requireAdminCapability('copier:write:scoped'), async (req, res) => {
  try {
    const tenantId = requireScopedTenantId(req, req.body.tenant_id || req.query.tenant_id)
    const action = String(req.body.action || '').trim().toLowerCase()
    const followerId = normalizeTenantId(req.body.follower_id)
    const masterTradeId = normalizeEntityId(req.body.master_trade_id)

    if (!['resync position', 'resync pending', 'sync sl/tp', 'requeue last actionable event', 'flatten orphan follower position'].includes(action)) {
      return res.status(400).json({ error: 'Unsupported resync action' })
    }
    if (!followerId) {
      return res.status(400).json({ error: 'follower_id is required' })
    }

    const followerResult = await pool.query(
      `SELECT * FROM copier_followers WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [followerId, tenantId]
    )
    if (followerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Follower not found' })
    }

    if (action === 'requeue last actionable event') {
      if (!masterTradeId) {
        return res.status(400).json({ error: 'master_trade_id is required' })
      }
      const jobResult = await pool.query(
        `UPDATE copier_jobs
            SET state = 'retry',
                scheduled_at = NOW(),
                dead_reason = NULL,
                last_error = NULL,
                updated_at = NOW()
          WHERE id = (
            SELECT j.id
              FROM copier_jobs j
              JOIN copier_events e ON e.id = j.event_id
             WHERE j.tenant_id = $1
               AND j.follower_id = $2
               AND e.master_trade_id = $3
             ORDER BY j.created_at DESC
             LIMIT 1
          )
        RETURNING *`,
        [tenantId, followerId, masterTradeId]
      )
      if (jobResult.rows.length === 0) {
        return res.status(404).json({ error: 'No actionable copier job found for that follower/master trade' })
      }
      return res.json({ message: 'Copier job requeued', job: jobResult.rows[0] })
    }

    const tradeResult = masterTradeId
      ? await pool.query(
          `SELECT t.id, t.account_id, t.instrument, t.direction, t.status, t.order_type, t.pending_price,
                  t.open_price, t.stop_loss, t.take_profit, t.lot_size, a.tenant_id
             FROM trades t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.id = $1
              AND a.tenant_id = $2
            LIMIT 1`,
          [masterTradeId, tenantId]
        )
      : { rows: [] }

    const trade = tradeResult.rows[0] || null
    if (action !== 'flatten orphan follower position' && !trade) {
      return res.status(404).json({ error: 'Master trade not found for resync action' })
    }

    let eventType = null
    let eventPayload = null
    if (action === 'resync position') {
      eventType = trade.status === 'pending' ? 'PLACE_PENDING' : 'OPEN_MARKET'
      eventPayload = {
        instrument: trade.instrument,
        direction: trade.direction,
        status: trade.status,
        order_type: trade.order_type,
        pending_price: trade.pending_price,
        open_price: trade.open_price,
        stop_loss: trade.stop_loss,
        take_profit: trade.take_profit,
        lot_size: trade.lot_size,
        source: 'manual_resync'
      }
    } else if (action === 'resync pending') {
      eventType = trade.status === 'pending' ? 'PLACE_PENDING' : 'CANCEL_PENDING'
      eventPayload = {
        instrument: trade.instrument,
        direction: trade.direction,
        order_type: trade.order_type,
        pending_price: trade.pending_price,
        stop_loss: trade.stop_loss,
        take_profit: trade.take_profit,
        lot_size: trade.lot_size,
        source: 'manual_resync'
      }
    } else if (action === 'sync sl/tp') {
      eventType = 'MODIFY_POSITION'
      eventPayload = {
        instrument: trade.instrument,
        stop_loss: trade.stop_loss,
        take_profit: trade.take_profit,
        lot_size: trade.lot_size,
        source: 'manual_resync'
      }
    } else if (action === 'flatten orphan follower position') {
      const externalTicket = String(req.body.external_ticket || '').trim()
      if (!externalTicket) {
        return res.status(400).json({ error: 'external_ticket is required to flatten an orphan follower position' })
      }
      const orphanEventResult = await pool.query(
        `SELECT e.master_id
           FROM copier_events e
          WHERE e.tenant_id = $1
          ORDER BY e.created_at DESC
          LIMIT 1`,
        [tenantId]
      )
      if (orphanEventResult.rows.length === 0) {
        return res.status(400).json({ error: 'No copier master context exists yet for this tenant' })
      }
      eventType = 'CLOSE_POSITION'
      eventPayload = {
        instrument: String(req.body.instrument || '').trim().toUpperCase() || null,
        external_ticket: externalTicket,
        force_orphan_close: true,
        source: 'manual_resync'
      }
      const syntheticEvent = await pool.query(
        `INSERT INTO copier_events (
           tenant_id,
           master_id,
           master_account_id,
           master_trade_id,
           event_type,
           payload_json,
           dedupe_key
         ) VALUES ($1, $2, 0, 0, $3, $4::jsonb, $5)
         RETURNING *`,
        [tenantId, orphanEventResult.rows[0].master_id, eventType, JSON.stringify(eventPayload), uuidv4()]
      )

      const latestMapping = await pool.query(
        `SELECT id
           FROM copier_master_followers
          WHERE tenant_id = $1
            AND follower_id = $2
            AND is_enabled = TRUE
          ORDER BY updated_at DESC
          LIMIT 1`,
        [tenantId, followerId]
      )
      if (latestMapping.rows.length === 0) {
        return res.status(400).json({ error: 'No active copier mapping exists for this follower' })
      }
      const jobResult = await pool.query(
        `INSERT INTO copier_jobs (
           tenant_id,
           event_id,
           follower_id,
           mapping_id,
           correlation_id,
           state,
           scheduled_at,
           expires_at,
           command_json
         ) VALUES ($1, $2, $3, $4, $5, 'pending', NOW(), NOW() + INTERVAL '10 seconds', $6::jsonb)
         RETURNING *`,
        [
          tenantId,
          syntheticEvent.rows[0].id,
          followerId,
          latestMapping.rows[0].id,
          uuidv4(),
          JSON.stringify({ event_type: eventType, payload: eventPayload })
        ]
      )
      return res.json({ message: 'Orphan flatten job queued', job: jobResult.rows[0] })
    }

    const createdEvent = await writeCopierEvent(pool, {
      tenantId,
      masterAccountId: trade.account_id,
      masterTradeId: trade.id,
      eventType,
      payload: eventPayload
    })

    if (!createdEvent) {
      return res.status(400).json({ error: 'Trade is not enabled as a copier master or identical resync event already exists' })
    }

    const jobsResult = await pool.query(
      `UPDATE copier_events
          SET dispatch_state = 'pending',
              dispatched_at = NULL
        WHERE id = $1
      RETURNING id, event_type, master_trade_id`,
      [createdEvent.id]
    )

    res.json({ message: 'Copier resync event queued', event: jobsResult.rows[0] })
  } catch (error) {
    logger.error('[copier/reconciliation:resync] error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not queue copier resync action' })
  }
})

module.exports = {
  router,
  ensureCopierInfrastructure,
  ensureCopierSettings: ensureCopierInfrastructure
}
