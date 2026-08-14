// Request parsing, pagination, entity snapshots, allowed-action builders and
// admin identity lookups, moved verbatim from routes/admin.js during the admin
// modularization.
const jwt = require('jsonwebtoken')
const pool = require('../../../db')
const { emitAdminEvent } = require('../../../utils/realtime')
const { ensureFeatureTables } = require('./schema')
const { ensureTenantSettingsInfrastructure } = require('../../../utils/tenantSettings')

const ADMIN_VALID_ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000]

function requireReasonText(value, fieldName = 'reason') {
  const reason = String(value || '').trim()
  if (reason.length < 5) {
    throw createHttpError(`A clear ${fieldName} is required`, 400)
  }
  return reason.slice(0, 1000)
}

function createHttpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function normalizeAdminEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function buildKycDocumentPresencePredicate(tableAlias = 'u') {
  const alias = String(tableAlias || 'u').trim() || 'u'
  return `(${alias}.id_document_path IS NOT NULL OR ${alias}.selfie_path IS NOT NULL)`
}

function isBcryptHash(value) {
  const normalized = String(value || '')
  return normalized.startsWith('$2a$') || normalized.startsWith('$2b$') || normalized.startsWith('$2y$')
}

function setAdminCookie(res, token) {
  res.cookie('admin_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000,
    path: '/'
  })
}

async function getActivePlatformAdminCount() {
  await ensureFeatureTables()
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM platform_admins
      WHERE status = 'active'`
  )
  return parseInt(result.rows[0]?.count || 0, 10) || 0
}

async function getPlatformAdminByEmail(email) {
  await ensureFeatureTables()
  const normalizedEmail = normalizeAdminEmail(email)
  if (!normalizedEmail) return null
  const result = await pool.query(
    `SELECT id, email, full_name, password_hash, role, status, token_version,
            totp_enabled, totp_secret, totp_temp_secret, totp_backup_codes,
            last_login_at, created_at, updated_at
       FROM platform_admins
      WHERE LOWER(email) = $1
      LIMIT 1`,
    [normalizedEmail]
  )
  return result.rows[0] || null
}

async function getPlatformAdminById(adminId) {
  await ensureFeatureTables()
  const result = await pool.query(
    `SELECT id, email, full_name, password_hash, role, status, token_version,
            totp_enabled, totp_secret, totp_temp_secret, totp_backup_codes,
            last_login_at, created_at, updated_at
       FROM platform_admins
      WHERE id = $1
      LIMIT 1`,
    [adminId]
  )
  return result.rows[0] || null
}

function buildAdminJwtPayload(admin, overrides = {}) {
  return {
    role: admin?.role || 'super_admin',
    adminId: admin?.id || admin?.adminId || null,
    atv: admin?.token_version || admin?.atv || 1,
    email: admin?.email || null,
    full_name: admin?.full_name || null,
    src: admin?.auth_source || 'platform_admin',
    ...overrides
  }
}

function signAdminToken(admin, overrides = {}, expiresIn = '24h') {
  return jwt.sign(
    buildAdminJwtPayload(admin, overrides),
    process.env.ADMIN_JWT_SECRET,
    { expiresIn }
  )
}

function looksLikeDefaultSecret(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return true
  return normalized.includes('your-secret') ||
    normalized.includes('generate-random') ||
    normalized.startsWith('propfirm_') ||
    normalized.includes('secret_key') ||
    normalized.length < 32
}

function parsePositiveInteger(value, { fallback = null, min = 1, max = 365 } = {}) {
  const parsed = parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  if (parsed < min || parsed > max) return fallback
  return parsed
}

function parseBooleanFilter(value) {
  if (typeof value === 'boolean') return value
  const normalized = String(value || '').trim().toLowerCase()
  if (['true', '1', 'yes'].includes(normalized)) return true
  if (['false', '0', 'no'].includes(normalized)) return false
  return null
}

function getAdminOwnerId(admin) {
  return String(admin?.adminId || admin?.email || admin?.role || 'admin')
}

function wantsAdminListContract(req) {
  const format = String(req.query?.format || '').trim().toLowerCase()
  return format === 'list' || format === 'v2'
}

function parseCsvListParam(value, { normalize = true } = {}) {
  if (value == null || value === '') return []
  const parts = Array.isArray(value) ? value : String(value).split(',')
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .map((part) => normalize ? part.toLowerCase() : part)
}

function normalizeAdminTag(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return normalized || null
}

function normalizeEntityType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['user', 'account', 'payout', 'trade', 'case', 'violation', 'dispute'].includes(normalized) ? normalized : null
}

function parseListPaging(req, { defaultPageSize = 25, maxPageSize = 100 } = {}) {
  const page = parsePositiveInteger(req.query?.page, { fallback: 1, min: 1, max: 100000 }) || 1
  const pageSize = parsePositiveInteger(req.query?.page_size, { fallback: defaultPageSize, min: 1, max: maxPageSize }) || defaultPageSize
  return { page, pageSize }
}

function buildPagination({ page, pageSize, total }) {
  const totalItems = Math.max(0, parseInt(total || 0, 10) || 0)
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  return {
    current: Math.min(page, totalPages),
    total: totalPages,
    total_items: totalItems,
    page_size: pageSize
  }
}

function paginateRows(rows, { page, pageSize }) {
  const offset = Math.max(0, (page - 1) * pageSize)
  return rows.slice(offset, offset + pageSize)
}

function facetCounts(rows, selector) {
  const counts = {}
  for (const row of rows) {
    const value = selector(row)
    if (Array.isArray(value)) {
      value.forEach((item) => {
        const key = String(item || '').trim()
        if (!key) return
        counts[key] = (counts[key] || 0) + 1
      })
      continue
    }
    const key = String(value ?? '').trim() || 'unknown'
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

function toIsoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function computeUserLifecycleStage(row) {
  if (row?.funded_only) return 'funded'
  if ((row?.account_count || 0) > 0 && (row?.has_active_accounts || row?.active_account_count > 0)) return 'evaluating'
  if (row?.is_banned) return 'inactive'
  return 'new'
}

function computeAccountLifecycleStage(row) {
  const status = String(row?.status || '').toLowerCase()
  if (row?.account_type === 'funded') return status === 'active' ? 'funded' : status
  if (status === 'active') return 'evaluating'
  if (['failed', 'locked', 'expired'].includes(status)) return 'failed'
  if (status === 'passed') return 'funded'
  return status || 'inactive'
}

function computePayoutComplianceStatus(row) {
  if (row?.is_flagged) return 'blocked'
  if (String(row?.status || '').toLowerCase() === 'pending') return 'pending'
  return 'clean'
}

function buildSavedViewCapabilities(resource) {
  return {
    resource,
    can_save: true,
    can_update: true,
    can_delete: true
  }
}

async function upsertAdminEntityMeta(client, { entityType, entityId, patch = {} }) {
  const normalizedEntityType = normalizeEntityType(entityType)
  const normalizedEntityId = normalizeEntityId(entityId)
  const hasLinkedCaseId = Object.prototype.hasOwnProperty.call(patch, 'linked_case_id')
  if (!normalizedEntityType || !normalizedEntityId) {
    throw createHttpError('Valid entity metadata target is required', 400)
  }

  const result = await client.query(
    `INSERT INTO admin_entity_meta
      (entity_type, entity_id, owner_admin_id, priority, workflow_status, classification,
       risk_tier, status_reason, sla_state, linked_case_id, created_at, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, 'normal'), COALESCE($5, 'open'), $6,
       COALESCE($7, 'low'), $8, $9, $10, NOW(), NOW())
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET
       owner_admin_id = COALESCE(EXCLUDED.owner_admin_id, admin_entity_meta.owner_admin_id),
       priority = COALESCE(EXCLUDED.priority, admin_entity_meta.priority),
       workflow_status = COALESCE(EXCLUDED.workflow_status, admin_entity_meta.workflow_status),
       classification = COALESCE(EXCLUDED.classification, admin_entity_meta.classification),
       risk_tier = COALESCE(EXCLUDED.risk_tier, admin_entity_meta.risk_tier),
       status_reason = COALESCE(EXCLUDED.status_reason, admin_entity_meta.status_reason),
       sla_state = COALESCE(EXCLUDED.sla_state, admin_entity_meta.sla_state),
       linked_case_id = CASE WHEN $11 THEN EXCLUDED.linked_case_id ELSE admin_entity_meta.linked_case_id END,
       updated_at = NOW()
     RETURNING *`,
    [
      normalizedEntityType,
      normalizedEntityId,
      patch.owner_admin_id || null,
      patch.priority || null,
      patch.workflow_status || null,
      patch.classification || null,
      patch.risk_tier || null,
      patch.status_reason || null,
      patch.sla_state || null,
      patch.linked_case_id || null,
      hasLinkedCaseId
    ]
  )
  return result.rows[0] || null
}

function computePhaseEndDateForAccountType(accountType, settings = {}, baseDate = new Date()) {
  if (String(accountType || '').toLowerCase() === 'funded') {
    return null
  }

  const normalizedType = String(accountType || '').toLowerCase()
  const days = (normalizedType === 'phase2' || normalizedType === 'phase3')
    ? parsePositiveInteger(settings.phase2_day_limit, { fallback: 30, min: 1, max: 3650 })
    : parsePositiveInteger(settings.phase1_day_limit, { fallback: 30, min: 1, max: 3650 })

  const phaseEndDate = new Date(baseDate)
  phaseEndDate.setUTCDate(phaseEndDate.getUTCDate() + days)
  phaseEndDate.setUTCHours(23, 59, 59, 999)
  return phaseEndDate
}

function normalizeAccountSnapshot(account) {
  if (!account) return null
  return {
    id: account.id,
    user_id: account.user_id,
    account_type: account.account_type,
    account_size: account.account_size,
    status: account.status,
    current_balance: parseFloat(account.current_balance || 0),
    starting_balance: parseFloat(account.starting_balance || 0),
    peak_balance: parseFloat(account.peak_balance || 0),
    profit_target: parseFloat(account.profit_target || 0),
    max_drawdown_pct: parseFloat(account.max_drawdown_pct || 0),
    phase_start_date: account.phase_start_date || null,
    phase_end_date: account.phase_end_date || null,
    review_flagged: !!account.review_flagged,
    review_flag_reason: account.review_flag_reason || null,
    account_uid: account.account_uid || null
  }
}

function normalizeUserSnapshot(user) {
  if (!user) return null
  return {
    id: user.id,
    email: user.email || null,
    full_name: user.full_name || null,
    is_banned: !!user.is_banned,
    kyc_status: user.kyc_status || null,
    token_version: parseInt(user.token_version || 1, 10)
  }
}

function normalizePayoutSnapshot(payout) {
  if (!payout) return null
  return {
    id: payout.id,
    user_id: payout.user_id || null,
    account_id: payout.account_id || null,
    status: payout.status || null,
    is_flagged: !!payout.is_flagged,
    flag_reason: payout.flag_reason || null,
    admin_notes: payout.admin_notes || null,
    amount_requested: parseFloat(payout.amount_requested || 0),
    amount_payable: parseFloat(payout.amount_payable || 0)
  }
}

function normalizeViolationSnapshot(violation) {
  if (!violation) return null
  return {
    id: violation.id,
    account_id: violation.account_id || null,
    user_id: violation.user_id || null,
    violation_type: violation.violation_type || null,
    severity: violation.severity || null,
    status: violation.status || null,
    resolution_note: violation.resolution_note || null,
    resolution_type: violation.resolution_type || null
  }
}

function buildAllowedAccountActions(account) {
  if (!account) return []

  const actions = ['open_account_detail', 'force_close_open_trades']
  const status = String(account.status || '').toLowerCase()
  const accountType = String(account.account_type || '').toLowerCase()

  if (['phase1', 'phase2'].includes(accountType) && status === 'active') {
    actions.push('pass', 'fail', 'extend_days')
  }
  if (accountType === 'funded' && status === 'active') {
    actions.push('revoke_funded')
  }
  if (['failed', 'locked'].includes(status)) {
    actions.push('restore_active')
  }
  if (['phase1', 'phase2'].includes(accountType) && ['failed', 'locked', 'expired'].includes(status)) {
    actions.push('restore_with_reset', 'replace_account')
  } else if (!['active', 'passed'].includes(status)) {
    actions.push('replace_account')
  }
  if (status !== 'locked') {
    actions.push('lock_account')
  }
  if (['phase1', 'phase2'].includes(accountType) && status !== 'passed') {
    actions.push('extend_days')
  }
  if (account.review_flagged) {
    actions.push('clear_review_flag')
  }

  return [...new Set(actions)]
}

function buildAllowedUserActions(user) {
  if (!user) return []
  const actions = ['open_user_detail', 'manual_account', 'revoke_sessions']
  if (user.is_banned) actions.push('unban')
  else actions.push('ban')
  if (String(user.kyc_status || '').toLowerCase() !== 'approved') actions.push('approve_kyc')
  if (String(user.kyc_status || '').toLowerCase() !== 'rejected') actions.push('reject_kyc')
  return [...new Set(actions)]
}

function buildAllowedPayoutActions(payout) {
  if (!payout) return []
  const actions = ['open_account_detail']
  const status = String(payout.status || '').toLowerCase()
  if (payout.dispute_id) actions.push('open_dispute')
  if (status === 'pending') actions.push('approve_payout', 'reject_payout')
  if (payout.is_flagged) actions.push('unflag_payout')
  else actions.push('flag_payout')
  return [...new Set(actions)]
}

function buildAllowedViolationActions(violation) {
  if (!violation) return []
  const actions = []
  if (violation.account_id) actions.push('open_account_detail')
  if (String(violation.status || '').toLowerCase() !== 'resolved') {
    actions.push('waive_violation', 'resolve_violation', 'false_positive')
  }
  return actions
}

async function fetchAccountForAdmin(client, accountId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT a.id, a.user_id, a.account_type, a.account_size,
            a.current_balance, a.starting_balance, a.peak_balance, a.status,
            a.max_drawdown_pct, a.profit_target, a.phase_start_date, a.phase_end_date,
            a.account_uid, a.review_flagged, a.review_flag_reason,
            u.email AS user_email, u.full_name
       FROM accounts a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = $1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [String(accountId)]
  )
  return result.rows[0] || null
}

function normalizeEntityId(value) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, 128) : null
}

async function fetchUserForAdmin(client, userId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT id, email, full_name, kyc_status, is_banned, token_version
       FROM users
       WHERE id = $1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [normalizeEntityId(userId)]
  )
  return result.rows[0] || null
}

async function fetchPayoutForAdmin(client, payoutId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.amount_payable,
            p.status, p.is_flagged, p.flag_reason, p.admin_notes, p.requested_at,
            u.email, u.full_name
       FROM payouts p
       JOIN users u ON u.id = p.user_id
      WHERE p.id = $1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [parseInt(payoutId, 10)]
  )
  return result.rows[0] || null
}

async function emitSuperAdminPowerEvent(req, payload = {}) {
  emitAdminEvent('admin_command_center_updated', {
    ...payload
  })
}

function serializeCsv(rows, columns) {
  const escapeValue = (value) => {
    const normalized = value == null ? '' : String(value)
    if (/[",\n]/.test(normalized)) {
      return `"${normalized.replace(/"/g, '""')}"`
    }
    return normalized
  }

  const header = columns.map((column) => escapeValue(column.header)).join(',')
  const body = rows.map((row) => (
    columns.map((column) => escapeValue(typeof column.value === 'function' ? column.value(row) : row[column.key])).join(',')
  ))
  return [header, ...body].join('\n')
}

function buildAdminAuditActor(admin) {
  return String(admin?.email || admin?.full_name || admin?.role || 'admin')
}

function sanitizePlatformAdminRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role || 'super_admin',
    status: row.status || 'active',
    token_version: row.token_version || 1,
    totp_enabled: !!row.totp_enabled,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  }
}

async function buildAdminSecurityStatus(currentAdmin) {
  await ensureFeatureTables()
  await ensureTenantSettingsInfrastructure()

  const platformResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'active' AND totp_enabled = TRUE)::int AS totp_enabled
     FROM platform_admins`
  )

  const platformCounts = platformResult.rows[0] || {}
  const activePlatformAdmins = parseInt(platformCounts.active || 0, 10) || 0

  const base = {
    checked_at: new Date().toISOString(),
    current_admin: {
      admin_id: currentAdmin?.adminId || null,
      role: currentAdmin?.role || null,
      email: currentAdmin?.email || null,
      auth_source: currentAdmin?.auth_source || null,
      totp_enabled: currentAdmin?.totp_enabled === true
    },
    session_revocation: {
      supported: true,
      token_versioned: true
    }
  }

  if (String(currentAdmin?.role || '') !== 'super_admin') {
    return {
      ...base,
      totp: {
        current_admin_totp_enabled: currentAdmin?.totp_enabled === true
      }
    }
  }

  return {
    ...base,
    migration: {
      platform_admin_bootstrap_complete: activePlatformAdmins > 0,
      env_fallback_enabled: activePlatformAdmins === 0,
      platform_admin_count: parseInt(platformCounts.total || 0, 10) || 0,
      active_platform_admin_count: activePlatformAdmins
    },
    totp: {
      platform_admins_enabled: parseInt(platformCounts.totp_enabled || 0, 10) || 0,
      platform_admins_total: activePlatformAdmins,
      current_admin_totp_enabled: currentAdmin?.totp_enabled === true
    },
    secrets: {
      admin_password_needs_rotation: !isBcryptHash(process.env.ADMIN_PASSWORD) || looksLikeDefaultSecret(process.env.ADMIN_PASSWORD),
      jwt_secret_needs_rotation: looksLikeDefaultSecret(process.env.JWT_SECRET),
      admin_jwt_secret_needs_rotation: looksLikeDefaultSecret(process.env.ADMIN_JWT_SECRET),
      totp_encryption_configured: !!String(process.env.TOTP_ENCRYPTION_KEY || '').trim() && String(process.env.TOTP_ENCRYPTION_KEY || '').trim().length >= 64,
      node_env: String(process.env.NODE_ENV || 'development')
    }
  }
}

module.exports = {
  ADMIN_VALID_ACCOUNT_SIZES,
  requireReasonText,
  createHttpError,
  normalizeAdminEmail,
  buildKycDocumentPresencePredicate,
  isBcryptHash,
  setAdminCookie,
  getActivePlatformAdminCount,
  getPlatformAdminByEmail,
  getPlatformAdminById,
  buildAdminJwtPayload,
  signAdminToken,
  looksLikeDefaultSecret,
  parsePositiveInteger,
  parseBooleanFilter,
  getAdminOwnerId,
  wantsAdminListContract,
  parseCsvListParam,
  normalizeAdminTag,
  normalizeEntityType,
  parseListPaging,
  buildPagination,
  paginateRows,
  facetCounts,
  toIsoOrNull,
  computeUserLifecycleStage,
  computeAccountLifecycleStage,
  computePayoutComplianceStatus,
  buildSavedViewCapabilities,
  upsertAdminEntityMeta,
  computePhaseEndDateForAccountType,
  normalizeAccountSnapshot,
  normalizeUserSnapshot,
  normalizePayoutSnapshot,
  normalizeViolationSnapshot,
  buildAllowedAccountActions,
  buildAllowedUserActions,
  buildAllowedPayoutActions,
  buildAllowedViolationActions,
  fetchAccountForAdmin,
  normalizeEntityId,
  fetchUserForAdmin,
  fetchPayoutForAdmin,
  emitSuperAdminPowerEvent,
  serializeCsv,
  buildAdminAuditActor,
  sanitizePlatformAdminRecord,
  buildAdminSecurityStatus
}
