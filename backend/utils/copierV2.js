'use strict'

const crypto = require('crypto')

const COPIER_EVENT_TYPES = [
  'OPEN_MARKET',
  'PLACE_PENDING',
  'MODIFY_PENDING',
  'CANCEL_PENDING',
  'MODIFY_POSITION',
  'PARTIAL_CLOSE',
  'CLOSE_POSITION'
]

const COPIER_JOB_STATES = [
  'pending',
  'sent',
  'acknowledged',
  'retry',
  'expired',
  'dead',
  'skipped'
]

const COPIER_COPY_MODES = ['mirror', 'reverse']
const COPIER_RISK_MODES = ['fixed_lots', 'balance_ratio', 'equity_ratio', 'risk_percent']
const COPIER_FOLLOWER_STATUSES = ['active', 'paused', 'stopped', 'breached']
const COPIER_ALLOWED_MASTER_ACCOUNT_TYPES = ['phase1', 'phase2', 'funded']

function safeJsonParse(value, fallback) {
  if (value == null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizePositiveNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeNonNegativeNumber(value, fallback = null) {
  if (value === '' || value == null) return fallback
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function normalizeBoolean(value, fallback = false) {
  if (value == null) return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function normalizeInteger(value, fallback = null) {
  if (value === '' || value == null) return fallback
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeTenantId(value, fallback = null) {
  const parsed = normalizeInteger(value, fallback)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeEntityId(value, fallback = null) {
  if (value === '' || value == null) return fallback
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, 128) : fallback
}

function normalizeStringArray(value, options = {}) {
  const {
    upper = false,
    lower = false,
    allowEmpty = false,
    maxItems = 200,
    maxLength = 64
  } = options

  let items = []
  if (Array.isArray(value)) {
    items = value
  } else if (typeof value === 'string') {
    items = value.split(',')
  } else {
    return []
  }

  const normalized = []
  for (const item of items) {
    let next = String(item || '').trim()
    if (upper) next = next.toUpperCase()
    if (lower) next = next.toLowerCase()
    next = next.slice(0, maxLength)
    if (!next && !allowEmpty) continue
    if (!normalized.includes(next)) {
      normalized.push(next)
    }
    if (normalized.length >= maxItems) break
  }
  return normalized
}

function normalizeCopyMode(value, fallback = 'mirror') {
  const normalized = String(value || fallback).trim().toLowerCase()
  return COPIER_COPY_MODES.includes(normalized) ? normalized : fallback
}

function normalizeRiskMode(value, fallback = 'fixed_lots') {
  const normalized = String(value || fallback).trim().toLowerCase()
  return COPIER_RISK_MODES.includes(normalized) ? normalized : fallback
}

function normalizeFollowerStatus(value, fallback = 'active') {
  const normalized = String(value || fallback).trim().toLowerCase()
  return COPIER_FOLLOWER_STATUSES.includes(normalized) ? normalized : fallback
}

function normalizeMasterAccountTypes(value, fallback = COPIER_ALLOWED_MASTER_ACCOUNT_TYPES) {
  const types = normalizeStringArray(value, { lower: true, maxItems: 3, maxLength: 16 })
    .filter((type) => COPIER_ALLOWED_MASTER_ACCOUNT_TYPES.includes(type))
  return types.length > 0 ? types : [...fallback]
}

function normalizeSessionFilter(value) {
  const parsed = safeJsonParse(value, {})
  const days = normalizeStringArray(parsed.days, { lower: true, maxItems: 7, maxLength: 3 })
    .filter((day) => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(day))

  const startUtc = typeof parsed.start_utc === 'string' ? parsed.start_utc.slice(0, 5) : null
  const endUtc = typeof parsed.end_utc === 'string' ? parsed.end_utc.slice(0, 5) : null

  return {
    enabled: normalizeBoolean(parsed.enabled, false),
    days,
    start_utc: startUtc,
    end_utc: endUtc
  }
}

function normalizeNewsFilter(value) {
  const parsed = safeJsonParse(value, {})
  return {
    enabled: normalizeBoolean(parsed.enabled, false),
    before_minutes: normalizeInteger(parsed.before_minutes, 5) ?? 5,
    after_minutes: normalizeInteger(parsed.after_minutes, 5) ?? 5,
    impact_levels: normalizeStringArray(parsed.impact_levels, { lower: true, maxItems: 5, maxLength: 16 })
  }
}

function buildEventDedupeKey({ tenantId, masterId, masterTradeId, eventType, payload }) {
  const payloadFingerprint = crypto
    .createHash('sha1')
    .update(JSON.stringify(payload || {}))
    .digest('hex')

  return [tenantId || 'default', masterId || 'none', masterTradeId || 'none', eventType, payloadFingerprint].join(':')
}

function resolveScopedTenantId(req, explicitTenantId = null) {
  const requestTenantId = normalizeTenantId(explicitTenantId)
  const adminTenantId = normalizeTenantId(req?.admin?.tenantId)
  const isSuperAdmin = String(req?.admin?.role || '') === 'super_admin'

  if (!isSuperAdmin) {
    return adminTenantId
  }

  return requestTenantId || adminTenantId || null
}

async function ensureCopierV2Infrastructure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_masters (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      account_id TEXT NOT NULL UNIQUE,
      label TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_by_admin_id BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_masters_tenant_idx ON copier_masters(tenant_id, is_enabled)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_followers (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      display_name TEXT NOT NULL,
      bridge_target_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      copy_mode TEXT NOT NULL DEFAULT 'mirror',
      risk_mode TEXT NOT NULL DEFAULT 'fixed_lots',
      fixed_lots NUMERIC(18,6),
      ratio_multiplier NUMERIC(18,6) NOT NULL DEFAULT 1,
      risk_percent NUMERIC(18,6),
      symbol_allowlist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      session_filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      news_filter_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      max_slippage_points NUMERIC(18,6),
      max_spread_points NUMERIC(18,6),
      max_daily_loss_amount NUMERIC(18,6),
      max_daily_loss_pct NUMERIC(18,6),
      equity_floor_amount NUMERIC(18,6),
      equity_floor_pct NUMERIC(18,6),
      symbol_catalog_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      symbol_constraints_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_balance NUMERIC(18,6),
      last_equity NUMERIC(18,6),
      last_snapshot_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      stats_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, bridge_target_key)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_followers_tenant_status_idx ON copier_followers(tenant_id, status)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_master_followers (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      master_id BIGINT NOT NULL REFERENCES copier_masters(id) ON DELETE CASCADE,
      follower_id BIGINT NOT NULL REFERENCES copier_followers(id) ON DELETE CASCADE,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      copy_mode_override TEXT,
      allowed_master_account_types_json JSONB NOT NULL DEFAULT '["phase1","phase2","funded"]'::jsonb,
      symbol_allowlist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (master_id, follower_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_master_followers_tenant_idx ON copier_master_followers(tenant_id, is_enabled)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_symbol_mappings (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      follower_id BIGINT NOT NULL REFERENCES copier_followers(id) ON DELETE CASCADE,
      master_symbol TEXT NOT NULL,
      follower_symbol TEXT NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (follower_id, master_symbol)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_symbol_mappings_tenant_idx ON copier_symbol_mappings(tenant_id, follower_id, is_enabled)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_events (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      master_id BIGINT NOT NULL REFERENCES copier_masters(id) ON DELETE CASCADE,
      master_account_id TEXT NOT NULL,
      master_trade_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT NOT NULL UNIQUE,
      dispatch_state TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      dispatched_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_events_dispatch_idx ON copier_events(dispatch_state, created_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_events_tenant_trade_idx ON copier_events(tenant_id, master_trade_id, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_jobs (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      event_id BIGINT NOT NULL REFERENCES copier_events(id) ON DELETE CASCADE,
      follower_id BIGINT NOT NULL REFERENCES copier_followers(id) ON DELETE CASCADE,
      mapping_id BIGINT NOT NULL REFERENCES copier_master_followers(id) ON DELETE CASCADE,
      correlation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL DEFAULT 'pending',
      scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      attempts_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempt_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      acknowledged_at TIMESTAMPTZ,
      ack_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      command_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      dead_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_jobs_state_schedule_idx ON copier_jobs(state, scheduled_at)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_jobs_follower_state_idx ON copier_jobs(follower_id, state, created_at DESC)`)
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS copier_jobs_event_follower_uq ON copier_jobs(event_id, follower_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_job_attempts (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      job_id BIGINT NOT NULL REFERENCES copier_jobs(id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL,
      stage TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      latency_ms INTEGER,
      bridge_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      response_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_job_attempts_job_idx ON copier_job_attempts(job_id, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_position_links (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      master_id BIGINT NOT NULL REFERENCES copier_masters(id) ON DELETE CASCADE,
      follower_id BIGINT NOT NULL REFERENCES copier_followers(id) ON DELETE CASCADE,
      master_trade_id TEXT NOT NULL,
      follower_external_ticket TEXT,
      follower_external_order_id TEXT,
      mapped_symbol TEXT,
      last_known_lots NUMERIC(18,6),
      current_state TEXT NOT NULL DEFAULT 'pending',
      last_synced_at TIMESTAMPTZ,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (follower_id, master_trade_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_position_links_master_idx ON copier_position_links(master_trade_id, follower_id)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_alert_endpoints (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      endpoint_type TEXT NOT NULL DEFAULT 'webhook',
      display_name TEXT NOT NULL,
      target_url TEXT,
      secret TEXT,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      event_allowlist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_alert_endpoints_tenant_idx ON copier_alert_endpoints(tenant_id, is_enabled)`)

  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS runtime_scope TEXT NOT NULL DEFAULT 'shared_worker'`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS follower_id BIGINT`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS bridge_heartbeat_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS last_snapshot_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS ack_p50_ms INTEGER`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS ack_p95_ms INTEGER`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS throughput_last_minute INTEGER`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS retry_rate_last_hour NUMERIC(18,6)`)
  await pool.query(`ALTER TABLE copier_runtime_status ADD COLUMN IF NOT EXISTS dead_letter_count INTEGER`)
  await pool.query(`CREATE INDEX IF NOT EXISTS copier_runtime_scope_idx ON copier_runtime_status(runtime_scope, tenant_id, follower_id)`)
  await pool.query(`ALTER TABLE copier_masters ALTER COLUMN account_id TYPE TEXT USING account_id::text`)
  await pool.query(`ALTER TABLE copier_events ALTER COLUMN master_account_id TYPE TEXT USING master_account_id::text`)
  await pool.query(`ALTER TABLE copier_events ALTER COLUMN master_trade_id TYPE TEXT USING master_trade_id::text`)
  await pool.query(`ALTER TABLE copier_position_links ALTER COLUMN master_trade_id TYPE TEXT USING master_trade_id::text`)
}

async function writeCopierEvent(db, payload = {}) {
  const tenantId = normalizeTenantId(payload.tenantId)
  const masterAccountId = normalizeEntityId(payload.masterAccountId)
  const masterTradeId = normalizeEntityId(payload.masterTradeId)
  const eventType = String(payload.eventType || '').trim().toUpperCase()

  if (!tenantId || !masterAccountId || !masterTradeId || !COPIER_EVENT_TYPES.includes(eventType)) {
    return null
  }

  const masterResult = await db.query(
    `SELECT id
       FROM copier_masters
      WHERE tenant_id = $1
        AND account_id = $2
        AND is_enabled = TRUE
      LIMIT 1`,
    [tenantId, masterAccountId]
  )

  if (masterResult.rows.length === 0) {
    return null
  }

  const masterId = masterResult.rows[0].id
  const eventPayload = payload.payload || {}
  const dedupeKey = payload.dedupeKey || buildEventDedupeKey({
    tenantId,
    masterId,
    masterTradeId,
    eventType,
    payload: eventPayload
  })

  const result = await db.query(
    `INSERT INTO copier_events (
       tenant_id,
       master_id,
       master_account_id,
       master_trade_id,
       event_type,
       payload_json,
       dedupe_key
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, master_id, tenant_id, master_trade_id, event_type, payload_json, created_at`,
    [tenantId, masterId, masterAccountId, masterTradeId, eventType, JSON.stringify(eventPayload), dedupeKey]
  )

  return result.rows[0] || null
}

module.exports = {
  COPIER_ALLOWED_MASTER_ACCOUNT_TYPES,
  COPIER_COPY_MODES,
  COPIER_EVENT_TYPES,
  COPIER_FOLLOWER_STATUSES,
  COPIER_JOB_STATES,
  COPIER_RISK_MODES,
  buildEventDedupeKey,
  ensureCopierV2Infrastructure,
  normalizeBoolean,
  normalizeCopyMode,
  normalizeEntityId,
  normalizeFollowerStatus,
  normalizeInteger,
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
}
