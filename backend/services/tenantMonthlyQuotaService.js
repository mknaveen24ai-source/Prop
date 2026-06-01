const pool = require('../db')
const logger = require('../utils/logger')

let infrastructureReady = false
let infrastructurePromise = null

function getQuotaMonth(input = new Date()) {
  const date = input instanceof Date ? input : new Date(input)
  if (Number.isNaN(date.getTime())) return getQuotaMonth(new Date())
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

function parseNonNegativeLimit(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function normalizeAccountSize(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

async function runEnsureInfrastructure(db = pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_monthly_quotas (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      quota_month DATE NOT NULL,
      account_limit INT,
      is_unlimited BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, quota_month)
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS tenant_monthly_quotas_tenant_month_idx ON tenant_monthly_quotas(tenant_id, quota_month DESC)`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_monthly_size_quotas (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      quota_month DATE NOT NULL,
      account_size INT NOT NULL,
      account_limit INT,
      is_unlimited BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, quota_month, account_size)
    )
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS tenant_monthly_size_quotas_lookup_idx
      ON tenant_monthly_size_quotas(tenant_id, quota_month DESC, account_size)
  `)

  await db.query(`
    CREATE TABLE IF NOT EXISTS account_promotion_reviews (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL DEFAULT 1,
      source_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      from_account_type TEXT NOT NULL,
      target_account_type TEXT NOT NULL,
      account_size NUMERIC,
      status TEXT NOT NULL DEFAULT 'pending',
      triggered_by TEXT,
      reason TEXT,
      requested_by_admin_id TEXT,
      decided_by_admin_id TEXT,
      decision_note TEXT,
      created_account_id TEXT,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS source_account_id TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS user_id TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS from_account_type TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS target_account_type TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS account_size NUMERIC`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS triggered_by TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS reason TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS requested_by_admin_id TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS decided_by_admin_id TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS decision_note TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS created_account_id TEXT`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await db.query(`ALTER TABLE account_promotion_reviews ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await db.query(`CREATE INDEX IF NOT EXISTS account_promotion_reviews_tenant_status_idx ON account_promotion_reviews(tenant_id, status, created_at DESC)`)
  await db.query(`CREATE INDEX IF NOT EXISTS account_promotion_reviews_source_idx ON account_promotion_reviews(source_account_id)`)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS account_promotion_reviews_pending_source_uq ON account_promotion_reviews(source_account_id) WHERE status = 'pending'`)

  infrastructureReady = true
}

async function ensureTenantMonthlyQuotaInfrastructure(db = pool) {
  if (infrastructureReady) return
  if (!infrastructurePromise) {
    infrastructurePromise = runEnsureInfrastructure(db).catch((error) => {
      infrastructurePromise = null
      throw error
    })
  }
  await infrastructurePromise
}

async function lockTenantQuotaMonth(db, tenantId, quotaMonth = getQuotaMonth(), accountSize = null) {
  const normalizedTenantId = parseInt(tenantId, 10) || 1
  const normalizedSize = normalizeAccountSize(accountSize)
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [
    normalizedSize
      ? `tenant_monthly_size_quota:${getQuotaMonth(quotaMonth)}:${normalizedSize}`
      : `tenant_monthly_quota:${getQuotaMonth(quotaMonth)}`,
    normalizedTenantId
  ])
}

async function upsertTenantMonthlyQuota(db, { tenantId, quotaMonth = getQuotaMonth(), accountLimit = null, isUnlimited = true }) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const normalizedTenantId = parseInt(tenantId, 10) || 1
  const normalizedMonth = getQuotaMonth(quotaMonth)
  const unlimited = !!isUnlimited
  const limit = unlimited ? null : parseNonNegativeLimit(accountLimit)
  if (!unlimited && limit === null) {
    const error = new Error('account_limit must be zero or a positive number unless quota is unlimited')
    error.statusCode = 400
    throw error
  }

  const result = await db.query(
    `INSERT INTO tenant_monthly_quotas (tenant_id, quota_month, account_limit, is_unlimited, updated_at)
     VALUES ($1, $2::date, $3, $4, NOW())
     ON CONFLICT (tenant_id, quota_month)
     DO UPDATE SET
       account_limit = EXCLUDED.account_limit,
       is_unlimited = EXCLUDED.is_unlimited,
       updated_at = NOW()
     RETURNING *`,
    [normalizedTenantId, normalizedMonth, limit, unlimited]
  )
  return result.rows[0]
}

async function upsertTenantMonthlySizeQuota(db, { tenantId, quotaMonth = getQuotaMonth(), accountSize, accountLimit = null, isUnlimited = true }) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const normalizedTenantId = parseInt(tenantId, 10) || 1
  const normalizedMonth = getQuotaMonth(quotaMonth)
  const normalizedSize = normalizeAccountSize(accountSize)
  if (!normalizedSize) {
    const error = new Error('account_size must be a positive number')
    error.statusCode = 400
    throw error
  }

  const unlimited = !!isUnlimited
  const limit = unlimited ? null : parseNonNegativeLimit(accountLimit)
  if (!unlimited && limit === null) {
    const error = new Error('account_limit must be zero or a positive number unless quota is unlimited')
    error.statusCode = 400
    throw error
  }

  const result = await db.query(
    `INSERT INTO tenant_monthly_size_quotas (tenant_id, quota_month, account_size, account_limit, is_unlimited, updated_at)
     VALUES ($1, $2::date, $3, $4, $5, NOW())
     ON CONFLICT (tenant_id, quota_month, account_size)
     DO UPDATE SET
       account_limit = EXCLUDED.account_limit,
       is_unlimited = EXCLUDED.is_unlimited,
       updated_at = NOW()
     RETURNING *`,
    [normalizedTenantId, normalizedMonth, normalizedSize, limit, unlimited]
  )
  return result.rows[0]
}

async function getTenantMonthlyQuota(db, tenantId, quotaMonth = getQuotaMonth()) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const normalizedTenantId = parseInt(tenantId, 10) || 1
  const normalizedMonth = getQuotaMonth(quotaMonth)
  const result = await db.query(
    `SELECT *
       FROM tenant_monthly_quotas
      WHERE tenant_id = $1
        AND quota_month = $2::date
      LIMIT 1`,
    [normalizedTenantId, normalizedMonth]
  )
  return result.rows[0] || {
    tenant_id: normalizedTenantId,
    quota_month: normalizedMonth,
    account_limit: null,
    is_unlimited: true
  }
}

async function getTenantMonthlySizeQuota(db, tenantId, accountSize, quotaMonth = getQuotaMonth()) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const normalizedTenantId = parseInt(tenantId, 10) || 1
  const normalizedMonth = getQuotaMonth(quotaMonth)
  const normalizedSize = normalizeAccountSize(accountSize)
  if (!normalizedSize) {
    const error = new Error('account_size must be a positive number')
    error.statusCode = 400
    throw error
  }

  const result = await db.query(
    `SELECT *
       FROM tenant_monthly_size_quotas
      WHERE tenant_id = $1
        AND quota_month = $2::date
        AND account_size = $3
      LIMIT 1`,
    [normalizedTenantId, normalizedMonth, normalizedSize]
  )
  if (result.rows[0]) return result.rows[0]

  return {
    tenant_id: normalizedTenantId,
    quota_month: normalizedMonth,
    account_size: normalizedSize,
    account_limit: null,
    is_unlimited: true
  }
}

async function countTenantMonthlyAccounts(db, tenantId, quotaMonth = getQuotaMonth(), accountSize = null) {
  const normalizedTenantId = parseInt(tenantId, 10) || 1
  const normalizedMonth = getQuotaMonth(quotaMonth)
  const normalizedSize = normalizeAccountSize(accountSize)
  const result = await db.query(
    `SELECT COUNT(*)::int AS used
       FROM accounts
      WHERE COALESCE(tenant_id, $1) = $1
        AND created_at >= $2::date
        AND created_at < ($2::date + INTERVAL '1 month')
        AND ($3::int IS NULL OR account_size::int = $3::int)`,
    [normalizedTenantId, normalizedMonth, normalizedSize]
  )
  return parseInt(result.rows[0]?.used || 0, 10) || 0
}

async function getTenantMonthlyQuotaStatus(db, tenantId, quotaMonth = getQuotaMonth(), accountSize = null) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const normalizedSize = normalizeAccountSize(accountSize)
  const quota = normalizedSize
    ? await getTenantMonthlySizeQuota(db, tenantId, normalizedSize, quotaMonth)
    : await getTenantMonthlyQuota(db, tenantId, quotaMonth)
  const normalizedMonth = getQuotaMonth(quotaMonth)
  const used = await countTenantMonthlyAccounts(db, tenantId, normalizedMonth, normalizedSize)
  const isUnlimited = !!quota.is_unlimited
  const accountLimit = parseNonNegativeLimit(quota.account_limit)
  const remaining = isUnlimited ? null : Math.max(0, (accountLimit || 0) - used)
  const state = isUnlimited
    ? 'unlimited'
    : remaining <= 0
      ? 'full'
      : remaining <= Math.max(1, Math.ceil((accountLimit || 0) * 0.1))
        ? 'near_limit'
        : 'available'

  return {
    tenant_id: parseInt(tenantId, 10) || 1,
    quota_month: normalizedMonth,
    account_size: normalizedSize,
    account_limit: isUnlimited ? null : accountLimit,
    is_unlimited: isUnlimited,
    used,
    remaining,
    state
  }
}

async function assertTenantMonthlyQuotaAvailable(db, tenantId, quotaMonth = getQuotaMonth(), accountSize = null) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  await lockTenantQuotaMonth(db, tenantId, quotaMonth, accountSize)
  const status = await getTenantMonthlyQuotaStatus(db, tenantId, quotaMonth, accountSize)
  if (!status.is_unlimited && status.remaining <= 0) {
    const sizeLabel = status.account_size ? ` $${Number(status.account_size).toLocaleString('en-US')} account` : ''
    const error = new Error(`Monthly quota is full for${sizeLabel} allocations in ${status.quota_month}.`)
    error.statusCode = 403
    error.quota = status
    throw error
  }
  return status
}

function getTargetAccountType(fromAccountType) {
  if (fromAccountType === 'phase1') return 'phase2'
  if (fromAccountType === 'phase2') return 'funded'
  return null
}

async function createPromotionReview(db, acc, { triggeredBy = 'auto_pass', reason = null, requestedByAdminId = null, payload = {} } = {}) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const targetAccountType = getTargetAccountType(String(acc?.account_type || '').toLowerCase())
  if (!targetAccountType) return null

  const result = await db.query(
    `INSERT INTO account_promotion_reviews (
       tenant_id, source_account_id, user_id, from_account_type, target_account_type,
       account_size, status, triggered_by, reason, requested_by_admin_id, payload_json, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (source_account_id) WHERE status = 'pending'
     DO UPDATE SET
       triggered_by = EXCLUDED.triggered_by,
       reason = COALESCE(EXCLUDED.reason, account_promotion_reviews.reason),
       payload_json = account_promotion_reviews.payload_json || EXCLUDED.payload_json,
       updated_at = NOW()
     RETURNING *`,
    [
      acc.tenant_id || 1,
      String(acc.id),
      String(acc.user_id),
      String(acc.account_type),
      targetAccountType,
      acc.account_size,
      triggeredBy,
      reason,
      requestedByAdminId ? String(requestedByAdminId) : null,
      JSON.stringify(payload || {})
    ]
  )
  return result.rows[0]
}

async function listPromotionReviews(db, { tenantId = null, status = 'pending', month = null } = {}) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const params = []
  const where = []
  let index = 1
  if (tenantId) {
    params.push(tenantId)
    where.push(`r.tenant_id = $${index++}`)
  }
  if (status && status !== 'all') {
    params.push(String(status).toLowerCase())
    where.push(`LOWER(r.status) = $${index++}`)
  }
  if (month) {
    params.push(getQuotaMonth(month))
    where.push(`r.created_at >= $${index}::date AND r.created_at < ($${index}::date + INTERVAL '1 month')`)
    index += 1
  }

  const result = await db.query(
    `SELECT
       r.*,
       u.email AS user_email,
       u.full_name AS user_full_name,
       a.account_uid,
       a.current_balance,
       a.starting_balance,
       a.peak_balance,
       a.profit_target,
       a.status AS source_account_status,
       t.name AS tenant_name,
       COALESCE(open_counts.open_trade_count, 0)::int AS open_trade_count,
       COALESCE(pending_counts.pending_trade_count, 0)::int AS pending_trade_count
     FROM account_promotion_reviews r
     JOIN accounts a ON a.id::text = r.source_account_id
     LEFT JOIN users u ON u.id::text = r.user_id
     LEFT JOIN tenants t ON t.id = r.tenant_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS open_trade_count FROM trades tr WHERE tr.account_id::text = r.source_account_id AND tr.status = 'open'
     ) open_counts ON TRUE
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS pending_trade_count FROM trades tr WHERE tr.account_id::text = r.source_account_id AND tr.status = 'pending'
     ) pending_counts ON TRUE
     WHERE ${where.length ? where.join(' AND ') : '1=1'}
     ORDER BY r.created_at DESC, r.id DESC`,
    params
  )
  return result.rows
}

async function getPromotionReviewForUpdate(db, reviewId, tenantId = null) {
  await ensureTenantMonthlyQuotaInfrastructure(db)
  const params = [reviewId]
  const tenantClause = tenantId ? 'AND r.tenant_id = $2' : ''
  if (tenantId) params.push(tenantId)
  const result = await db.query(
    `SELECT r.*, a.status AS source_account_status, a.account_type AS source_account_type,
            a.user_id AS source_user_id, a.tenant_id AS source_tenant_id, a.account_size AS source_account_size
       FROM account_promotion_reviews r
       JOIN accounts a ON a.id::text = r.source_account_id
      WHERE r.id = $1 ${tenantClause}
      FOR UPDATE OF r, a`,
    params
  )
  return result.rows[0] || null
}

async function markPromotionReviewApproved(db, reviewId, { adminId = null, decisionNote = null, createdAccountId = null } = {}) {
  const result = await db.query(
    `UPDATE account_promotion_reviews
        SET status = 'approved',
            decided_by_admin_id = $2,
            decision_note = $3,
            created_account_id = $4,
            decided_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [reviewId, adminId ? String(adminId) : null, decisionNote, createdAccountId ? String(createdAccountId) : null]
  )
  return result.rows[0] || null
}

async function markPromotionReviewRejected(db, reviewId, { adminId = null, decisionNote = null } = {}) {
  const result = await db.query(
    `UPDATE account_promotion_reviews
        SET status = 'rejected',
            decided_by_admin_id = $2,
            decision_note = $3,
            decided_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [reviewId, adminId ? String(adminId) : null, decisionNote]
  )
  return result.rows[0] || null
}

async function logQuotaError(context, error) {
  logger.warn('[tenant-quota] quota gate blocked account allocation', {
    ...context,
    error: error.message,
    quota: error.quota || null
  })
}

module.exports = {
  assertTenantMonthlyQuotaAvailable,
  countTenantMonthlyAccounts,
  createPromotionReview,
  ensureTenantMonthlyQuotaInfrastructure,
  getPromotionReviewForUpdate,
  getQuotaMonth,
  getTargetAccountType,
  getTenantMonthlyQuota,
  getTenantMonthlySizeQuota,
  getTenantMonthlyQuotaStatus,
  listPromotionReviews,
  lockTenantQuotaMonth,
  logQuotaError,
  normalizeAccountSize,
  markPromotionReviewApproved,
  markPromotionReviewRejected,
  upsertTenantMonthlyQuota,
  upsertTenantMonthlySizeQuota
}
