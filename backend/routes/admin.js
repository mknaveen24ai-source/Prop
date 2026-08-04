const express = require('express')
const router = express.Router()
const pool = require('../db')
const {
  authenticateAdmin,
  authenticateAdminPre2FA,
  buildAdminSessionPayload,
  requireAdminCapability,
  requireSuperAdmin
} = require('./middleware')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const rateLimit = require('express-rate-limit')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const qrcode = require('qrcode')
const Decimal = require('decimal.js')
const logger = require('../utils/logger')
const totp   = require('../utils/totp')
const { invalidateAllUserTokens } = require('../utils/tokenCache')
const { emitAdminEvent } = require('../utils/realtime')
const {
  CONTRACT_SIZES,
  getPipSize,
  getSpreadPoints,
  getWideSpreadThreshold,
  getQuickMoveThreshold,
  roundPrice
} = require('../constants')
const { buildAccountAvailability } = require('../utils/accountAvailability')
const {
  ensureEmailQueueInfrastructure,
  enqueueKycApprovedEmail,
  enqueueKycRejectedEmail,
  enqueuePayoutApprovedEmail,
  enqueuePayoutRejectedEmail
} = require('../utils/emailQueue')
const { sanitizeString, isValidEmail } = require('../utils/validation')
const { fetchProgressionSettings, promotePassedAccount } = require('../services/progressionService')
const { fetchStepModels, fetchStepModelBySlug, toggleStepModel } = require('../utils/stepModels')
const { CURRENT_TOS_VERSION } = require('../utils/tosVersion')
const { readKycFileBuffer, getKycContentType, getOriginalKycExtension } = require('../utils/secureKycStorage')
const { ensureViolationTables } = require('../services/violationEngine')
const { sendEmailMessage, htmlWrap, resolveMailContext } = require('../mailer')
const { computeRMultiple } = require('./trades')
const { getTenantSettings } = require('../services/tenantPolicyService')
const { getPriceForTenant } = require('../priceFeed')
const { ensureDisputesInfrastructure } = require('./disputes')
const { ensureChatTables } = require('./chat')
const {
  ensureTenantSettingsInfrastructure,
  getTenantSettingsMap
} = require('../utils/tenantSettings')
require('../loadEnv')


// FIX (BUG-C3): Added strict rate limiter to admin login. The user-facing login
// already had an authLimiter (10 req/min), but the admin login was completely
// unprotected, allowing unlimited brute-force password attempts.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts total per IP
  message: { error: 'Too many admin login attempts. Please wait 15 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // don't count successful logins against the limit
})

const ADMIN_VALID_ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000]

let _featureTablesReady = false
let _featureTablesPromise = null

function getAdminActorLabel(admin) {
  const role = String(admin?.role || 'admin')
  const identity = admin?.email || admin?.full_name || admin?.adminId || 'unknown'
  return `${role}:${identity}`
}

function buildAdminActorPayload(admin) {
  return {
    admin_id: admin?.adminId || null,
    role: admin?.role || null,
    email: admin?.email || null,
    full_name: admin?.full_name || null
  }
}

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

async function buildTraderListResult({ query = {} } = {}) {
  const search = String(query.search || '').trim().toLowerCase()
  const page = Number.isFinite(query.page) ? query.page : 1
  const pageSize = Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = query.filters || {}
  const sortKey = String(query.sort || 'created_at').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const params = []
  const where = []
  let index = 1

  if (search) {
    params.push(`%${search}%`)
    where.push(`(
      LOWER(COALESCE(u.email, '')) LIKE $${index}
      OR LOWER(COALESCE(u.full_name, '')) LIKE $${index}
      OR LOWER(COALESCE(u.country, '')) LIKE $${index}
      OR LOWER(COALESCE(u.affiliate_code, '')) LIKE $${index}
      OR CAST(u.id AS TEXT) LIKE $${index}
    )`)
    index += 1
  }

  if (filters.kyc_status) {
    params.push(String(filters.kyc_status).trim().toLowerCase())
    where.push(`LOWER(COALESCE(u.kyc_status, 'pending')) = $${index}`)
    index += 1
  }

  if (filters.is_banned !== null && filters.is_banned !== undefined) {
    params.push(!!filters.is_banned)
    where.push(`COALESCE(u.is_banned, FALSE) = $${index}`)
    index += 1
  }

  if (filters.country) {
    params.push(String(filters.country).trim().toLowerCase())
    where.push(`LOWER(COALESCE(u.country, '')) = $${index}`)
    index += 1
  }

  if (filters.has_active_accounts !== null && filters.has_active_accounts !== undefined) {
    params.push(!!filters.has_active_accounts)
    where.push(`(
      EXISTS (
        SELECT 1
        FROM accounts a_active
        WHERE a_active.user_id = u.id
          AND a_active.status = 'active'
      )
    ) = $${index}`)
    index += 1
  }

  if (filters.funded_only !== null && filters.funded_only !== undefined) {
    params.push(!!filters.funded_only)
    where.push(`(
      EXISTS (
        SELECT 1
        FROM accounts a_funded
        WHERE a_funded.user_id = u.id
          AND a_funded.account_type = 'funded'
      )
    ) = $${index}`)
    index += 1
  }

  const tagFilters = Array.isArray(filters.tags) ? filters.tags : parseCsvListParam(filters.tags || [])
  if (tagFilters.length > 0) {
    params.push(tagFilters)
    where.push(`EXISTS (
      SELECT 1
      FROM admin_entity_tags aet
      WHERE aet.entity_type = 'user'
        AND aet.entity_id = CAST(u.id AS TEXT)
        AND aet.tag = ANY($${index}::text[])
    )`)
    index += 1
  }

  const riskTierFilter = Array.isArray(filters.risk_tier) ? filters.risk_tier : parseCsvListParam(filters.risk_tier || [])
  if (riskTierFilter.length > 0) {
    params.push(riskTierFilter)
    where.push(`COALESCE(meta.risk_tier,
      CASE
        WHEN COALESCE(u.is_banned, FALSE) THEN 'critical'
        WHEN LOWER(COALESCE(u.kyc_status, 'pending')) = 'rejected' THEN 'high'
        WHEN COALESCE(active_accounts.active_account_count, 0) > 0 THEN 'medium'
        ELSE 'low'
      END
    ) = ANY($${index}::text[])`)
    index += 1
  }

  const orderByMap = {
    created_at: 'u.created_at',
    email: 'u.email',
    full_name: 'u.full_name',
    country: 'u.country',
    kyc_status: 'u.kyc_status',
    account_count: 'account_stats.account_count',
    active_account_count: 'account_stats.active_account_count',
    risk_tier: 'risk_tier',
    internal_notes_count: 'internal_notes_count',
    last_action_at: 'last_action_at'
  }
  const orderBy = orderByMap[sortKey] || orderByMap.created_at

  const result = await pool.query(
    `SELECT
        u.id,
        u.id::text AS entity_id,
        'user'::text AS entity_type,
        u.email,
        u.full_name,
        u.country,
        u.phone,
        u.kyc_status,
        COALESCE(u.is_banned, FALSE) AS is_banned,
        u.affiliate_code,
        u.created_at,
        u.token_version,
        COALESCE(account_stats.account_count, 0)::int AS account_count,
        COALESCE(account_stats.active_account_count, 0)::int AS active_account_count,
        COALESCE(account_stats.funded_account_count, 0)::int AS funded_account_count,
        COALESCE(payout_stats.total_paid, 0) AS total_paid,
        COALESCE(meta.owner_admin_id, '') AS owner_admin_id,
        COALESCE(meta.priority, 'normal') AS priority,
        COALESCE(meta.workflow_status,
          CASE
            WHEN COALESCE(u.is_banned, FALSE) THEN 'blocked'
            WHEN LOWER(COALESCE(u.kyc_status, 'pending')) = 'pending' THEN 'needs_review'
            ELSE 'active'
          END
        ) AS workflow_status,
        COALESCE(meta.classification,
          CASE
            WHEN COALESCE(u.is_banned, FALSE) THEN 'fraud-watch'
            WHEN COALESCE(NULLIF(u.affiliate_code, ''), '') <> '' THEN 'affiliate'
            ELSE 'self-serve'
          END
        ) AS classification,
        COALESCE(meta.risk_tier,
          CASE
            WHEN COALESCE(u.is_banned, FALSE) THEN 'critical'
            WHEN LOWER(COALESCE(u.kyc_status, 'pending')) = 'rejected' THEN 'high'
            WHEN COALESCE(account_stats.active_account_count, 0) > 0 THEN 'medium'
            ELSE 'low'
          END
        ) AS risk_tier,
        meta.status_reason,
        COALESCE(meta.sla_state,
          CASE
            WHEN LOWER(COALESCE(u.kyc_status, 'pending')) = 'pending' THEN 'needs-review'
            ELSE 'clear'
          END
        ) AS sla_state,
        meta.linked_case_id,
        COALESCE(tag_summary.tags, ARRAY[]::text[]) AS tags,
        COALESCE(note_summary.internal_notes_count, 0)::int AS internal_notes_count,
        note_summary.last_action_at,
        (COALESCE(account_stats.active_account_count, 0) > 0) AS has_active_accounts,
        (COALESCE(account_stats.funded_account_count, 0) > 0) AS funded_only
      FROM users u
      LEFT JOIN admin_entity_meta meta
        ON meta.entity_type = 'user'
       AND meta.entity_id = CAST(u.id AS TEXT)
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE a.status IN ('active', 'passed', 'funded', 'locked')) AS account_count,
          COUNT(*) FILTER (WHERE a.status = 'active') AS active_account_count,
          COUNT(*) FILTER (WHERE a.account_type = 'funded') AS funded_account_count
        FROM accounts a
        WHERE a.user_id = u.id
      ) account_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.amount_payable), 0) AS total_paid
        FROM payouts p
        WHERE p.user_id = u.id
          AND p.status = 'paid'
      ) payout_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT array_agg(tag ORDER BY tag) AS tags
        FROM admin_entity_tags aet
        WHERE aet.entity_type = 'user'
          AND aet.entity_id = CAST(u.id AS TEXT)
      ) tag_summary ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS internal_notes_count, MAX(created_at) AS last_action_at
        FROM admin_entity_notes aen
        WHERE aen.entity_type = 'user'
          AND aen.entity_id = CAST(u.id AS TEXT)
      ) note_summary ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS active_account_count
        FROM accounts a_active
        WHERE a_active.user_id = u.id
          AND a_active.status = 'active'
      ) active_accounts ON TRUE
      WHERE ${where.length > 0 ? where.join(' AND ') : '1=1'}
      ORDER BY ${orderBy} ${sortDirection}, u.id DESC`,
    params
  )

  const rows = result.rows.map((row) => ({
    ...row,
    tags: Array.isArray(row.tags) ? row.tags : [],
    total_paid: parseFloat(row.total_paid || 0),
    last_action_at: toIsoOrNull(row.last_action_at),
    lifecycle_stage: computeUserLifecycleStage(row),
    allowed_actions: buildAllowedUserActions(row)
  }))

  const summary = {
    total: rows.length,
    approved_kyc: rows.filter((row) => String(row.kyc_status || '').toLowerCase() === 'approved').length,
    pending_kyc: rows.filter((row) => String(row.kyc_status || '').toLowerCase() === 'pending').length,
    rejected_kyc: rows.filter((row) => String(row.kyc_status || '').toLowerCase() === 'rejected').length,
    banned: rows.filter((row) => row.is_banned).length,
    funded_traders: rows.filter((row) => row.funded_only).length,
    active_accounts: rows.reduce((sum, row) => sum + (parseInt(row.active_account_count || 0, 10) || 0), 0),
    needs_attention: rows.filter((row) => row.risk_tier === 'high' || row.risk_tier === 'critical' || String(row.kyc_status || '').toLowerCase() === 'pending').length
  }

  const facets = {
    kyc_status: facetCounts(rows, (row) => String(row.kyc_status || 'pending').toLowerCase()),
    risk_tier: facetCounts(rows, (row) => row.risk_tier || 'low'),
    lifecycle_stage: facetCounts(rows, (row) => row.lifecycle_stage || 'new'),
    country: facetCounts(rows, (row) => row.country || 'unknown'),
    tags: facetCounts(rows, (row) => row.tags || [])
  }

  return {
    summary,
    rows: paginateRows(rows, { page, pageSize }),
    pagination: buildPagination({ page, pageSize, total: rows.length }),
    facets,
    default_sort: { key: 'created_at', direction: 'desc' },
    saved_view_capabilities: buildSavedViewCapabilities('traders'),
    allRows: rows
  }
}

async function buildAccountListResult({ query = {} } = {}) {
  const search = String(query.search || '').trim().toLowerCase()
  const page = Number.isFinite(query.page) ? query.page : 1
  const pageSize = Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = query.filters || {}
  const sortKey = String(query.sort || 'created_at').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const params = []
  const where = []
  let index = 1

  if (search) {
    params.push(`%${search}%`)
    where.push(`(
      LOWER(COALESCE(u.email, '')) LIKE $${index}
      OR LOWER(COALESCE(u.full_name, '')) LIKE $${index}
      OR CAST(a.id AS TEXT) LIKE $${index}
      OR LOWER(COALESCE(a.account_uid, '')) LIKE $${index}
    )`)
    index += 1
  }

  if (filters.account_type) {
    const accountTypes = Array.isArray(filters.account_type) ? filters.account_type : parseCsvListParam(filters.account_type || [])
    if (accountTypes.length > 0) {
      params.push(accountTypes)
      where.push(`LOWER(COALESCE(a.account_type, '')) = ANY($${index}::text[])`)
      index += 1
    }
  }

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : parseCsvListParam(filters.status || [])
    if (statuses.length > 0) {
      params.push(statuses)
      where.push(`LOWER(COALESCE(a.status, '')) = ANY($${index}::text[])`)
      index += 1
    }
  }

  if (filters.review_flagged !== null && filters.review_flagged !== undefined) {
    params.push(!!filters.review_flagged)
    where.push(`COALESCE(a.review_flagged, FALSE) = $${index}`)
    index += 1
  }

  const tagFilters = Array.isArray(filters.tags) ? filters.tags : parseCsvListParam(filters.tags || [])
  if (tagFilters.length > 0) {
    params.push(tagFilters)
    where.push(`EXISTS (
      SELECT 1
      FROM admin_entity_tags aet
      WHERE aet.entity_type = 'account'
        AND aet.entity_id = CAST(a.id AS TEXT)
        AND aet.tag = ANY($${index}::text[])
    )`)
    index += 1
  }

  const orderByMap = {
    created_at: 'a.created_at',
    updated_at: 'a.updated_at',
    current_balance: 'a.current_balance',
    account_size: 'a.account_size',
    status: 'a.status',
    account_type: 'a.account_type',
    risk_tier: 'risk_tier',
    last_action_at: 'last_action_at'
  }
  const orderBy = orderByMap[sortKey] || orderByMap.created_at

  const result = await pool.query(
    `SELECT
        a.id,
        a.id::text AS entity_id,
        'account'::text AS entity_type,
        a.user_id,
        a.account_type,
        a.account_size,
        a.current_balance,
        a.starting_balance,
        a.peak_balance,
        a.status,
        a.profit_target,
        a.max_drawdown_pct,
        a.created_at,
        a.updated_at,
        a.account_uid,
        a.phase_start_date,
        a.phase_end_date,
        COALESCE(a.review_flagged, FALSE) AS review_flagged,
        a.review_flag_reason,
        u.email,
        u.full_name,
        u.kyc_status,
        u.is_banned,
        a.account_size AS size,
        a.current_balance AS balance,
        a.current_balance AS equity,
        a.peak_balance AS high_water_mark,
        u.email AS user_email,
        COALESCE(open_trades.open_trade_count, 0)::int AS open_trade_count,
        COALESCE(payout_stats.total_payouts, 0) AS total_payouts,
        COALESCE(split_stats.profit_split, 80) AS profit_split,
        COALESCE(meta.owner_admin_id, '') AS owner_admin_id,
        COALESCE(meta.priority, 'normal') AS priority,
        COALESCE(meta.workflow_status,
          CASE
            WHEN COALESCE(a.review_flagged, FALSE) THEN 'needs_review'
            WHEN LOWER(COALESCE(a.status, '')) = 'active' THEN 'active'
            ELSE LOWER(COALESCE(a.status, 'inactive'))
          END
        ) AS workflow_status,
        COALESCE(meta.classification,
          CASE
            WHEN COALESCE(a.review_flagged, FALSE) THEN 'manual-review'
            WHEN LOWER(COALESCE(a.account_type, '')) = 'funded' THEN 'funded'
            ELSE 'evaluating'
          END
        ) AS classification,
        COALESCE(meta.risk_tier,
          CASE
            WHEN COALESCE(a.review_flagged, FALSE) THEN 'high'
            WHEN LOWER(COALESCE(a.status, '')) IN ('failed', 'locked') THEN 'critical'
            WHEN LOWER(COALESCE(a.status, '')) = 'active' THEN 'medium'
            ELSE 'low'
          END
        ) AS risk_tier,
        meta.status_reason,
        COALESCE(meta.sla_state,
          CASE
            WHEN COALESCE(a.review_flagged, FALSE) THEN 'needs-review'
            ELSE 'clear'
          END
        ) AS sla_state,
        meta.linked_case_id,
        COALESCE(tag_summary.tags, ARRAY[]::text[]) AS tags,
        COALESCE(note_summary.internal_notes_count, 0)::int AS internal_notes_count,
        note_summary.last_action_at
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      LEFT JOIN admin_entity_meta meta
        ON meta.entity_type = 'account'
       AND meta.entity_id = CAST(a.id AS TEXT)
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS open_trade_count
        FROM trades t
        WHERE t.account_id = a.id
          AND t.status = 'open'
      ) open_trades ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(p.amount_payable), 0) AS total_payouts
        FROM payouts p
        WHERE p.account_id = a.id
          AND p.status = 'paid'
      ) payout_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(value::numeric), 80) AS profit_split
        FROM platform_settings
        WHERE key = 'profit_share_pct'
      ) split_stats ON TRUE
      LEFT JOIN LATERAL (
        SELECT array_agg(tag ORDER BY tag) AS tags
        FROM admin_entity_tags aet
        WHERE aet.entity_type = 'account'
          AND aet.entity_id = CAST(a.id AS TEXT)
      ) tag_summary ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS internal_notes_count, MAX(created_at) AS last_action_at
        FROM admin_entity_notes aen
        WHERE aen.entity_type = 'account'
          AND aen.entity_id = CAST(a.id AS TEXT)
      ) note_summary ON TRUE
      WHERE ${where.length > 0 ? where.join(' AND ') : '1=1'}
      ORDER BY ${orderBy} ${sortDirection}, a.id DESC`,
    params
  )

  const rows = result.rows.map((row) => ({
    ...row,
    tags: Array.isArray(row.tags) ? row.tags : [],
    total_payouts: parseFloat(row.total_payouts || 0),
    profit_split: parseFloat(row.profit_split || 80),
    last_action_at: toIsoOrNull(row.last_action_at),
    lifecycle_stage: computeAccountLifecycleStage(row),
    allowed_actions: buildAllowedAccountActions(row)
  }))

  const summary = {
    total: rows.length,
    active: rows.filter((row) => String(row.status || '').toLowerCase() === 'active').length,
    funded: rows.filter((row) => String(row.account_type || '').toLowerCase() === 'funded').length,
    breached: rows.filter((row) => ['failed', 'locked'].includes(String(row.status || '').toLowerCase())).length,
    review_flagged: rows.filter((row) => row.review_flagged).length,
    open_trades: rows.reduce((sum, row) => sum + (parseInt(row.open_trade_count || 0, 10) || 0), 0)
  }

  const facets = {
    account_type: facetCounts(rows, (row) => String(row.account_type || '').toLowerCase()),
    status: facetCounts(rows, (row) => String(row.status || '').toLowerCase()),
    risk_tier: facetCounts(rows, (row) => row.risk_tier || 'low'),
    lifecycle_stage: facetCounts(rows, (row) => row.lifecycle_stage || 'inactive'),
    tags: facetCounts(rows, (row) => row.tags || [])
  }

  return {
    summary,
    rows: paginateRows(rows, { page, pageSize }),
    pagination: buildPagination({ page, pageSize, total: rows.length }),
    facets,
    default_sort: { key: 'created_at', direction: 'desc' },
    saved_view_capabilities: buildSavedViewCapabilities('accounts'),
    allRows: rows
  }
}

async function buildPayoutListResult({ query = {} } = {}) {
  await ensureDisputesInfrastructure()
  const search = String(query.search || '').trim().toLowerCase()
  const page = Number.isFinite(query.page) ? query.page : 1
  const pageSize = Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = query.filters || {}
  const sortKey = String(query.sort || 'requested_at').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const params = []
  const where = []
  let index = 1

  if (search) {
    params.push(`%${search}%`)
    where.push(`(
      LOWER(COALESCE(u.email, '')) LIKE $${index}
      OR LOWER(COALESCE(u.full_name, '')) LIKE $${index}
      OR CAST(p.id AS TEXT) LIKE $${index}
      OR CAST(p.account_id AS TEXT) LIKE $${index}
    )`)
    index += 1
  }

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : parseCsvListParam(filters.status || [])
    if (statuses.length > 0) {
      params.push(statuses)
      where.push(`LOWER(COALESCE(p.status, 'pending')) = ANY($${index}::text[])`)
      index += 1
    }
  }

  if (filters.is_flagged !== null && filters.is_flagged !== undefined) {
    params.push(!!filters.is_flagged)
    where.push(`COALESCE(p.is_flagged, FALSE) = $${index}`)
    index += 1
  }

  if (filters.dispute_linked !== null && filters.dispute_linked !== undefined) {
    params.push(!!filters.dispute_linked)
    where.push(`(dispute_link.dispute_id IS NOT NULL) = $${index}`)
    index += 1
  }

  const tagFilters = Array.isArray(filters.tags) ? filters.tags : parseCsvListParam(filters.tags || [])
  if (tagFilters.length > 0) {
    params.push(tagFilters)
    where.push(`EXISTS (
      SELECT 1
      FROM admin_entity_tags aet
      WHERE aet.entity_type = 'payout'
        AND aet.entity_id = CAST(p.id AS TEXT)
        AND aet.tag = ANY($${index}::text[])
    )`)
    index += 1
  }

  const orderByMap = {
    requested_at: 'p.requested_at',
    amount_requested: 'p.amount_requested',
    amount_payable: 'p.amount_payable',
    status: 'p.status',
    risk_tier: 'risk_tier',
    last_action_at: 'last_action_at'
  }
  const orderBy = orderByMap[sortKey] || orderByMap.requested_at

  const result = await pool.query(
    `SELECT
        p.id,
        p.id::text AS entity_id,
        'payout'::text AS entity_type,
        p.user_id,
        p.account_id,
        p.amount_requested,
        p.amount_payable,
        p.payment_method,
        p.payment_details,
        p.status,
        COALESCE(p.is_flagged, FALSE) AS is_flagged,
        p.flag_reason,
        p.admin_notes,
        p.requested_at,
        p.paid_at,
        p.transaction_id,
        u.email,
        u.full_name,
        u.kyc_status,
        dispute_link.dispute_id,
        COALESCE(meta.owner_admin_id, '') AS owner_admin_id,
        COALESCE(meta.priority, 'normal') AS priority,
        COALESCE(meta.workflow_status,
          CASE
            WHEN COALESCE(p.is_flagged, FALSE) THEN 'needs_review'
            ELSE LOWER(COALESCE(p.status, 'pending'))
          END
        ) AS workflow_status,
        COALESCE(meta.classification,
          CASE
            WHEN COALESCE(p.is_flagged, FALSE) THEN 'payout-hold'
            ELSE 'finance-review'
          END
        ) AS classification,
        COALESCE(meta.risk_tier,
          CASE
            WHEN COALESCE(p.is_flagged, FALSE) THEN 'high'
            WHEN dispute_link.dispute_id IS NOT NULL THEN 'medium'
            ELSE 'low'
          END
        ) AS risk_tier,
        meta.status_reason,
        COALESCE(meta.sla_state,
          CASE
            WHEN LOWER(COALESCE(p.status, 'pending')) = 'pending' THEN 'pending'
            ELSE 'clear'
          END
        ) AS sla_state,
        meta.linked_case_id,
        COALESCE(tag_summary.tags, ARRAY[]::text[]) AS tags,
        COALESCE(note_summary.internal_notes_count, 0)::int AS internal_notes_count,
        note_summary.last_action_at
      FROM payouts p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN admin_entity_meta meta
        ON meta.entity_type = 'payout'
       AND meta.entity_id = CAST(p.id AS TEXT)
      LEFT JOIN LATERAL (
        SELECT d.id AS dispute_id
        FROM disputes d
        WHERE (
          (p.account_id IS NOT NULL AND CAST(d.account_id AS TEXT) = CAST(p.account_id AS TEXT))
          OR
          (p.account_id IS NULL AND CAST(d.user_id AS TEXT) = CAST(p.user_id AS TEXT))
        )
        ORDER BY d.created_at DESC
        LIMIT 1
      ) dispute_link ON TRUE
      LEFT JOIN LATERAL (
        SELECT array_agg(tag ORDER BY tag) AS tags
        FROM admin_entity_tags aet
        WHERE aet.entity_type = 'payout'
          AND aet.entity_id = CAST(p.id AS TEXT)
      ) tag_summary ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS internal_notes_count, MAX(created_at) AS last_action_at
        FROM admin_entity_notes aen
        WHERE aen.entity_type = 'payout'
          AND aen.entity_id = CAST(p.id AS TEXT)
      ) note_summary ON TRUE
      WHERE ${where.length > 0 ? where.join(' AND ') : '1=1'}
      ORDER BY ${orderBy} ${sortDirection}, p.id DESC`,
    params
  )

  const rows = result.rows.map((row) => ({
    ...row,
    tags: Array.isArray(row.tags) ? row.tags : [],
    amount_requested: parseFloat(row.amount_requested || 0),
    amount_payable: parseFloat(row.amount_payable || 0),
    last_action_at: toIsoOrNull(row.last_action_at),
    compliance_status: computePayoutComplianceStatus(row),
    allowed_actions: buildAllowedPayoutActions(row)
  }))

  const summary = {
    total: rows.length,
    pending: rows.filter((row) => String(row.status || '').toLowerCase() === 'pending').length,
    paid: rows.filter((row) => String(row.status || '').toLowerCase() === 'paid').length,
    rejected: rows.filter((row) => String(row.status || '').toLowerCase() === 'rejected').length,
    flagged: rows.filter((row) => row.is_flagged).length,
    requested_value: rows.reduce((sum, row) => sum + (parseFloat(row.amount_requested || 0) || 0), 0)
  }

  const facets = {
    status: facetCounts(rows, (row) => String(row.status || 'pending').toLowerCase()),
    risk_tier: facetCounts(rows, (row) => row.risk_tier || 'low'),
    compliance_status: facetCounts(rows, (row) => row.compliance_status || 'clean'),
    tags: facetCounts(rows, (row) => row.tags || [])
  }

  return {
    summary,
    rows: paginateRows(rows, { page, pageSize }),
    pagination: buildPagination({ page, pageSize, total: rows.length }),
    facets,
    default_sort: { key: 'requested_at', direction: 'desc' },
    saved_view_capabilities: buildSavedViewCapabilities('payouts'),
    allRows: rows
  }
}

async function createAdminIssuedAccount(client, { userId, accountType, accountSize, settings, overrides = {} }) {
  const normalizedType = String(accountType || 'phase1').toLowerCase()
  const size = parseInt(accountSize, 10)
  const startingBalance = size
  const currentBalance = overrides.current_balance != null ? parseFloat(overrides.current_balance) : startingBalance
  const peakBalance = overrides.peak_balance != null ? parseFloat(overrides.peak_balance) : startingBalance

  let profitTarget = 0
  let maxDrawdownPct = 5

  if (normalizedType === 'phase1') {
    const pct = parseFloat(overrides.profit_target_pct || settings.phase1_profit_target_pct || '10')
    profitTarget = overrides.profit_target != null ? parseFloat(overrides.profit_target) : parseFloat((size * (pct / 100)).toFixed(2))
    maxDrawdownPct = overrides.max_drawdown_pct != null ? parseFloat(overrides.max_drawdown_pct) : parseFloat(settings.phase1_max_drawdown_pct || '10')
  } else if (normalizedType === 'phase2' || normalizedType === 'phase3') {
    const pct = parseFloat(overrides.profit_target_pct || settings.phase2_profit_target_pct || '5')
    profitTarget = overrides.profit_target != null ? parseFloat(overrides.profit_target) : parseFloat((size * (pct / 100)).toFixed(2))
    maxDrawdownPct = overrides.max_drawdown_pct != null ? parseFloat(overrides.max_drawdown_pct) : parseFloat(settings.phase2_max_drawdown_pct || '5')
  } else {
    profitTarget = overrides.profit_target != null ? parseFloat(overrides.profit_target) : 0
    maxDrawdownPct = overrides.max_drawdown_pct != null ? parseFloat(overrides.max_drawdown_pct) : parseFloat(settings.funded_max_drawdown_pct || '5')
  }

  const phaseEndDate = overrides.phase_end_date !== undefined
    ? overrides.phase_end_date
    : computePhaseEndDateForAccountType(normalizedType, settings)

  const result = await client.query(
    `INSERT INTO accounts (
       user_id, account_type, account_size, current_balance, starting_balance,
       peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, phase_end_date, account_uid
     ) VALUES (
       $1, $2, $3, $4, $3, $5, $6, $7, 'active', NOW(), $8, $9
     )
     RETURNING id, user_id, account_type, account_size, current_balance, starting_balance,
               peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, phase_end_date,
               account_uid`,
    [
      userId,
      normalizedType,
      size,
      currentBalance,
      peakBalance,
      profitTarget,
      maxDrawdownPct,
      phaseEndDate,
      uuidv4()
    ]
  )

  return result.rows[0]
}

async function runEnsureFeatureTables() {
  if (_featureTablesReady) return

  await ensureTenantSettingsInfrastructure()

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_incidents (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      acknowledged_by TEXT
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_incidents_status_created ON admin_incidents(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_rules (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 100,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_rules_enabled_priority ON admin_rules(enabled, priority ASC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_enforcement_events (
      id BIGSERIAL PRIMARY KEY,
      rule_id BIGINT REFERENCES admin_rules(id) ON DELETE SET NULL,
      account_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'applied',
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_enforcement_events_created ON admin_enforcement_events(created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_balance_adjustments (
      id BIGSERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount NUMERIC(15,2) NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      adjustment_type TEXT NOT NULL DEFAULT 'manual',
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_balance_adjustments_account_created ON admin_balance_adjustments(account_id, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_immutable_audit (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'admin',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload_text TEXT NOT NULL DEFAULT '{}',
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_immutable_audit_created ON admin_immutable_audit(created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_four_eyes_requests (
      id BIGSERIAL PRIMARY KEY,
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'generic',
      target_id TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      requested_by TEXT NOT NULL DEFAULT 'admin',
      approvals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      required_approvals INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_four_eyes_status_created ON admin_four_eyes_requests(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_feature_flags (
      id BIGSERIAL PRIMARY KEY,
      flag_key TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rollout_pct INTEGER NOT NULL DEFAULT 100,
      segment TEXT NOT NULL DEFAULT 'all',
      updated_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_feature_flags_updated ON admin_feature_flags(updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'info',
      channel TEXT NOT NULL DEFAULT 'web',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'all',
      status TEXT NOT NULL DEFAULT 'queued',
      scheduled_for TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_notifications_status_created ON admin_notifications(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_cases (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      owner TEXT,
      notes TEXT,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_cases_status_priority ON admin_cases(status, priority, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_saved_views (
      id BIGSERIAL PRIMARY KEY,
      admin_id TEXT NOT NULL DEFAULT '',
      admin_role TEXT NOT NULL DEFAULT 'admin',
      resource TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_saved_views_owner_resource ON admin_saved_views(admin_id, resource, updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_entity_meta (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owner_admin_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      workflow_status TEXT NOT NULL DEFAULT 'open',
      classification TEXT,
      risk_tier TEXT NOT NULL DEFAULT 'low',
      status_reason TEXT,
      sla_state TEXT,
      linked_case_id BIGINT REFERENCES admin_cases(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, entity_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_entity_meta_type_updated ON admin_entity_meta(entity_type, updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_entity_tags (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, entity_id, tag)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_entity_tags_lookup ON admin_entity_tags(entity_type, entity_id, tag)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_entity_notes (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      note_text TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_entity_notes_lookup ON admin_entity_notes(entity_type, entity_id, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_dispute_meta (
      id BIGSERIAL PRIMARY KEY,
      dispute_id TEXT NOT NULL UNIQUE,
      owner TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      sla_hours INTEGER NOT NULL DEFAULT 48,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_dispute_meta_updated ON admin_dispute_meta(updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_scheduled_reports (
      id BIGSERIAL PRIMARY KEY,
      report_key TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      recipients TEXT NOT NULL DEFAULT '',
      schedule_cron TEXT NOT NULL DEFAULT '0 9 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_scheduled_reports_enabled ON admin_scheduled_reports(enabled, updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'super_admin',
      status TEXT NOT NULL DEFAULT 'active',
      token_version INTEGER NOT NULL DEFAULT 1,
      totp_secret TEXT,
      totp_temp_secret TEXT,
      totp_backup_codes TEXT,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_admins_status_email ON platform_admins(status, email)`)

  // Backfill-safe columns used by auto-enforcement actions.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flag_reason TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT`)
  await pool.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS flag_reason TEXT`)
  await pool.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS admin_notes TEXT`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_status_created ON accounts(status, created_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payouts_status_requested ON payouts(status, requested_at DESC)`)

  _featureTablesReady = true
}

async function ensureFeatureTables() {
  if (_featureTablesReady) return
  if (!_featureTablesPromise) {
    _featureTablesPromise = runEnsureFeatureTables().catch((error) => {
      _featureTablesPromise = null
      throw error
    })
  }
  await _featureTablesPromise
}

async function getSettingsMap(keys) {
  if (!keys || keys.length === 0) return {}
  const result = await pool.query(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [keys]
  )
  const out = {}
  for (const row of result.rows) out[row.key] = row.value
  return out
}

async function upsertSetting(client, key, value) {
  await client.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  )
}

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v || '').toLowerCase().trim()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

function normalizeAuditPayload(payload) {
  try {
    return JSON.stringify(payload || {})
  } catch {
    return '{}'
  }
}

function buildAuditHash({ prevHash, eventType, entityType, entityId, payloadText, createdAt }) {
  const base = [
    String(prevHash || 'GENESIS'),
    String(eventType || ''),
    String(entityType || ''),
    String(entityId || ''),
    String(payloadText || '{}'),
    String(createdAt || '')
  ].join('|')
  return crypto.createHash('sha256').update(base).digest('hex')
}

async function appendImmutableAudit(db, { eventType, entityType = '', entityId = '', actor = 'admin', payload = {} }) {
  await ensureFeatureTables()
  const payloadText = normalizeAuditPayload(payload)
  const prevResult = await db.query(`SELECT entry_hash FROM admin_immutable_audit ORDER BY id DESC LIMIT 1`)
  const prevHash = prevResult.rows[0]?.entry_hash || 'GENESIS'
  const createdAt = new Date().toISOString()
  const entryHash = buildAuditHash({ prevHash, eventType, entityType, entityId, payloadText, createdAt })
  const ins = await db.query(
    `INSERT INTO admin_immutable_audit
      (event_type, entity_type, entity_id, actor, payload_json, payload_text, prev_hash, entry_hash, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz)
     RETURNING *`,
    [
      String(eventType || 'event'),
      String(entityType || ''),
      String(entityId || ''),
      String(actor || 'admin'),
      payloadText,
      payloadText,
      prevHash,
      entryHash,
      createdAt
    ]
  )
  return ins.rows[0]
}

function calcTradePnl(direction, openPrice, currentPrice, lots, instrument) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(currentPrice).minus(openPrice)
    : new Decimal(openPrice).minus(currentPrice)
  return priceDiff.times(lots).times(contractSize).toDecimalPlaces(2).toNumber()
}

// -- Force-close helpers ------------------------------------------------------
async function forceCloseOpenTradesForAccount(client, accountId, options) {
  if (!options) options = {}
  const openTrades = await client.query(
    `SELECT t.*, a.user_id
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [accountId]
  )

  if (openTrades.rows.length === 0) {
    return { closedCount: 0, totalPnl: 0 }
  }

  let totalPnl = 0
  for (const t of openTrades.rows) {
    const openPrice = parseFloat(t.open_price || 0)
    const lots = parseFloat(t.lot_size || 0)
    const fallbackPrice = openPrice
    const livePrice = await getPriceForTenant(t.instrument).catch(function() { return null })
    const currentPrice = t.direction === 'buy'
      ? parseFloat((livePrice && livePrice.bid) || fallbackPrice)
      : parseFloat((livePrice && livePrice.ask) || fallbackPrice)
    const pnl = parseFloat((
      calcTradePnl(t.direction, openPrice, currentPrice, lots, t.instrument) -
      parseFloat(t.commission || 0)
    ).toFixed(2))
    totalPnl += pnl

    const closeResult = await client.query(
      `UPDATE trades
          SET status = 'closed',
              close_price = $1,
              close_time = NOW(),
              demo_pnl = $2,
              close_reason = 'Admin Auto Enforcement'
        WHERE id = $3`,
      [currentPrice, pnl, t.id]
    )
    if (closeResult.rowCount !== 1) {
      throw new Error('Failed to force-close trade ' + t.id)
    }
  }

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [totalPnl, accountId]
  )

  return {
    closedCount: openTrades.rows.length,
    totalPnl: parseFloat(totalPnl.toFixed(2))
  }
}

async function cancelPendingTradesForAccount(client, accountId, closeReason, options) {
  if (!options) options = {}
  const pendingTrades = await client.query(
    `SELECT t.*
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1 AND t.status = 'pending'
      FOR UPDATE`,
    [accountId]
  )
  if (pendingTrades.rows.length === 0) return 0

  const cancelled = await client.query(
    `UPDATE trades
        SET status = 'cancelled',
            close_time = NOW(),
            close_reason = $2
      WHERE account_id = $1 AND status = 'pending'
      RETURNING id`,
    [accountId, String(closeReason || 'Cancelled by admin')]
  )
  if (cancelled.rows.length !== pendingTrades.rows.length) {
    throw new Error('Failed to cancel all pending trades for account ' + accountId)
  }
  return cancelled.rows.length
}

async function forceCloseTradeById(client, tradeId, closeReason, options) {
  if (!closeReason) closeReason = 'Admin Force Close'
  if (!options) options = {}
  const result = await client.query(
    `SELECT t.id, t.account_id, t.instrument, t.direction, t.open_price, t.lot_size, t.commission,
            a.user_id
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [tradeId]
  )

  if (result.rows.length === 0) return null

  const trade = result.rows[0]
  const openPrice = parseFloat(trade.open_price || 0)
  const fallbackPrice = openPrice
  const livePrice = await getPriceForTenant(trade.instrument).catch(function() { return null })
  const closePrice = trade.direction === 'buy'
    ? parseFloat((livePrice && livePrice.bid) || fallbackPrice)
    : parseFloat((livePrice && livePrice.ask) || fallbackPrice)
  const pnl = parseFloat((
    calcTradePnl(
      trade.direction,
      openPrice,
      closePrice,
      parseFloat(trade.lot_size || 0),
      trade.instrument
    ) - parseFloat(trade.commission || 0)
  ).toFixed(2))

  const closeResult = await client.query(
    `UPDATE trades
        SET status = 'closed',
            close_price = $1,
            close_time = NOW(),
            demo_pnl = $2,
            close_reason = $3
      WHERE id = $4`,
    [closePrice, pnl, String(closeReason || 'Admin Force Close'), trade.id]
  )
  if (closeResult.rowCount !== 1) {
    throw new Error('Failed to force-close trade ' + trade.id)
  }

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [pnl, trade.account_id]
  )

  return {
    trade_id: trade.id,
    account_id: trade.account_id,
    user_id: trade.user_id,
    instrument: trade.instrument,
    pnl,
    close_price: closePrice
  }
}
async function getExposureData(pool) {
  const pricesResult = await pool.query('SELECT instrument, bid, ask FROM price_feed');
  const priceMap = {};
  pricesResult.rows.forEach(p => priceMap[p.instrument] = p);

  const exposureQ = await pool.query(`
    SELECT t.instrument, t.direction, t.lot_size, t.open_price
    FROM trades t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 'open'
  `);

  const exposureGroups = {};
  let total_open_trades = 0;
  let total_floating_pnl = 0;

  for (const t of exposureQ.rows) {
    if (!exposureGroups[t.instrument]) {
      exposureGroups[t.instrument] = { buy_lots: 0, sell_lots: 0, trade_count: 0, floating_pnl: 0 };
    }
    const group = exposureGroups[t.instrument];
    const lot = parseFloat(t.lot_size);
    group.trade_count++;
    total_open_trades++;
    
    if (t.direction === 'buy') group.buy_lots += lot;
    else group.sell_lots += lot;
    
    const priceData = priceMap[t.instrument];
    if (priceData) {
      const currentPrice = t.direction === 'buy' ? parseFloat(priceData.bid) : parseFloat(priceData.ask);
      const openPrice = parseFloat(t.open_price);
      const pnl = calcTradePnl(t.direction, openPrice, currentPrice, lot, t.instrument);
      group.floating_pnl += pnl;
      total_floating_pnl += pnl;
    }
  }

  const exposureData = Object.keys(exposureGroups).map(inst => {
    const g = exposureGroups[inst];
    const net = g.buy_lots - g.sell_lots;
    return {
      instrument: inst,
      buy_lots: g.buy_lots,
      long_lots: g.buy_lots,
      sell_lots: g.sell_lots,
      short_lots: g.sell_lots,
      net_lots: net,
      trade_count: g.trade_count,
      floating_pnl: g.floating_pnl,
      net_direction: net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'FLAT',
      reverse_direction: net > 0 ? 'sell' : net < 0 ? 'buy' : 'flat',
      reverse_lots: Math.abs(net)
    };
  });

  return { exposureData, total_open_trades, total_floating_pnl };
}

// FIX (BUG-C3): adminLoginLimiter applied before the handler (defined above)
router.post('/login', adminLoginLimiter, async function(req, res) {
  try {
    await ensureFeatureTables()

    const { email, password } = req.body
    const normalizedEmail = normalizeAdminEmail(email)

    const activePlatformAdminCount = await getActivePlatformAdminCount()
    const platformAdmin = normalizedEmail ? await getPlatformAdminByEmail(normalizedEmail) : null

    if (platformAdmin) {
      if (platformAdmin.status !== 'active') {
        return res.status(403).json({ error: 'Platform admin account is inactive' })
      }

      const passwordOk = await bcrypt.compare(String(password || ''), platformAdmin.password_hash)
      if (!passwordOk) {
        return res.status(401).json({ error: 'Invalid admin credentials' })
      }

      if (platformAdmin.totp_enabled && platformAdmin.totp_secret) {
        const pre2faToken = signAdminToken(
          {
            id: platformAdmin.id,
            token_version: platformAdmin.token_version || 1,
            email: platformAdmin.email,
            full_name: platformAdmin.full_name,
            role: platformAdmin.role || 'super_admin',
            auth_source: 'platform_admin'
          },
          { type: 'pre_2fa_admin' },
          '5m'
        )
        return res.json({ requires2FA: true, pre2faToken, role: platformAdmin.role || 'super_admin' })
      }

      const token = signAdminToken({
        id: platformAdmin.id,
        token_version: platformAdmin.token_version || 1,
        email: platformAdmin.email,
        full_name: platformAdmin.full_name,
        role: platformAdmin.role || 'super_admin',
        auth_source: 'platform_admin'
      })

      await pool.query(
        `UPDATE platform_admins
            SET last_login_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [platformAdmin.id]
      )

      setAdminCookie(res, token)

      return res.json({
        message: 'Admin login successful',
        token,
        admin: {
          id: platformAdmin.id,
          email: platformAdmin.email,
          full_name: platformAdmin.full_name,
          role: platformAdmin.role || 'super_admin',
          auth_source: 'platform_admin',
          totp_enabled: !!platformAdmin.totp_enabled
        }
      })
    }

    if (activePlatformAdminCount > 0) {
      if (!normalizedEmail) {
        return res.status(400).json({ error: 'Admin email is required' })
      }
      return res.status(401).json({ error: 'Invalid admin credentials' })
    }

    const adminPassword = process.env.ADMIN_PASSWORD

    if (!adminPassword) {
      return res.status(500).json({ error: 'Admin password not configured' })
    }

    // FIX (CRITICAL #3): Enforce bcrypt hashing in production.
    // Plain-text admin passwords are a security risk. In production, we reject
    // plain-text passwords outright to prevent accidental misconfiguration.
    const envPasswordIsHash = isBcryptHash(adminPassword)

    const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production'

    if (!envPasswordIsHash && isProduction) {
      return res.status(500).json({
        error: 'Admin password must be a bcrypt hash. Run: node -e "require(\'bcrypt\').hash(\'YourPass\',12).then(console.log)"'
      })
    }

    const isValidPassword = envPasswordIsHash
      ? await bcrypt.compare(String(password || ''), adminPassword)
      : String(password || '') === String(adminPassword)

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid admin password' })
    }

    const adminTokenVersion = await getLegacyAdminTokenVersion()

    const token = signAdminToken({
      token_version: adminTokenVersion,
      email: normalizedEmail || process.env.ADMIN_EMAIL || null,
      full_name: 'Platform Owner',
      role: 'super_admin',
      auth_source: 'env_fallback'
    })

    setAdminCookie(res, token)

    return res.json({
      message: 'Admin login successful',
      token,
      admin: {
        role: 'super_admin',
        email: normalizedEmail || process.env.ADMIN_EMAIL || null,
        full_name: 'Platform Owner',
        auth_source: 'env_fallback',
        requires_platform_admin_bootstrap: true,
        totp_enabled: false
      }
    })

    // Check if admin 2FA is set up
    let admin2faEnabled = false
    let admin2faSecret  = null
    try {
      const s2fa = await pool.query(
        `SELECT value FROM platform_settings WHERE key = 'admin_totp_secret'`
      )
      if (s2fa.rows.length > 0 && s2fa.rows[0].value) {
        admin2faEnabled = true
        admin2faSecret  = s2fa.rows[0].value
      }
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    if (admin2faEnabled) {
      // Step 1 of 2 — password OK, but issue a short-lived pre_2fa_admin token
      const pre2faToken = jwt.sign(
        { role: 'super_admin', type: 'pre_2fa_admin', atv: adminTokenVersion },
        process.env.ADMIN_JWT_SECRET,
        { expiresIn: '5m' }
      )
      return res.json({ requires2FA: true, pre2faToken })
    }

    // No 2FA configured — issue full admin token (unchanged original flow)
    const legacyToken = jwt.sign(
      { role: 'super_admin', atv: adminTokenVersion },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    )

    // FIX (BUG-L5): Hardened admin cookie with sameSite: 'strict' (was 'lax').
    res.cookie('admin_token', legacyToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    })

    res.json({ message: 'Admin login successful', token: legacyToken, admin: { role: 'super_admin' } })

  } catch (error) {
    logger.error('[admin/login] error:', { error: error.message })
    res.status(500).json({ error: 'Admin login error' })
  }
})


router.post('/logout', function(req, res) {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict', // FIX AUDIT: match set cookie flags
    path: '/'
  })
  res.json({ message: 'Admin logout successful' })
})

// ─────────────────────────────────────────────────────────────────────────────
// Admin 2FA routes
// ─────────────────────────────────────────────────────────────────────────────

async function getAuthenticatedAdminRecord(admin) {
  if (!admin) return null
  if (String(admin.auth_source || '') === 'env_fallback' || !admin.adminId) {
    return null
  }
  const platformAdmin = await getPlatformAdminById(admin.adminId)
  return platformAdmin ? { ...platformAdmin, auth_source: 'platform_admin' } : null
}

async function getAdminRecordForPre2faSession(adminPre2fa) {
  if (!adminPre2fa?.adminId) return null
  const platformAdmin = await getPlatformAdminById(adminPre2fa.adminId)
  return platformAdmin ? { ...platformAdmin, auth_source: 'platform_admin' } : null
}

function getAdmin2faStatusPayload(admin, record) {
  return {
    role: admin?.role || record?.role || null,
    auth_source: admin?.auth_source || record?.auth_source || null,
    totp_enabled: !!record?.totp_enabled,
    totp_setup_available: !!record,
    legacy_env_fallback: String(admin?.auth_source || '') === 'env_fallback',
    backup_codes_configured: !!record?.totp_backup_codes
  }
}

function parseStoredBackupCodes(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (_) {
    return []
  }
}

function buildAdminAuditActor(admin) {
  return String(admin?.email || admin?.full_name || admin?.role || 'admin')
}

function buildAdminSessionAdmin(record) {
  if (!record) return null
  return {
    adminId: record.id || record.adminId || null,
    role: record.role || null,
    email: record.email || null,
    full_name: record.full_name || null,
    auth_source: record.auth_source || null,
    totp_enabled: !!record.totp_enabled
  }
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

async function persistAdminSecurityFields(record, patch = {}) {
  if (!record?.id) return

  const {
    totp_secret = null,
    totp_temp_secret = null,
    totp_backup_codes = null,
    totp_enabled = false,
    token_version = null,
    status = null,
    password_hash = null,
    full_name = null,
    last_login_at = null
  } = patch

  const params = [
    record.id,
    totp_secret,
    totp_temp_secret,
    totp_backup_codes,
    !!totp_enabled,
    token_version,
    status,
    password_hash,
    full_name,
    last_login_at
  ]

  await pool.query(
    `UPDATE platform_admins
        SET totp_secret = $2,
            totp_temp_secret = $3,
            totp_backup_codes = $4,
            totp_enabled = $5,
            token_version = COALESCE($6, token_version),
            status = COALESCE($7, status),
            password_hash = COALESCE($8, password_hash),
            full_name = COALESCE($9, full_name),
            last_login_at = COALESCE($10, last_login_at),
            updated_at = NOW()
      WHERE id = $1`,
    params
  )
}

async function verifyAdmin2faTokenOrBackup(record, token) {
  if (!record?.totp_secret) {
    return { ok: false, used_backup_code: false, backup_codes: null }
  }

  const plainSecret = totp.decryptSecret(record.totp_secret)
  if (totp.verifyToken(plainSecret, token)) {
    return { ok: true, used_backup_code: false, backup_codes: null }
  }

  const backupCodes = parseStoredBackupCodes(record.totp_backup_codes)
  if (backupCodes.length === 0) {
    return { ok: false, used_backup_code: false, backup_codes }
  }

  const consumed = await totp.consumeBackupCode(token, backupCodes)
  if (!consumed.matched) {
    return { ok: false, used_backup_code: false, backup_codes }
  }

  return {
    ok: true,
    used_backup_code: true,
    backup_codes: consumed.updated
  }
}

async function getLegacyAdminTokenVersion() {
  let adminTokenVersion = 1
  try {
    const tv = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
    )
    if (tv.rows.length > 0) {
      const parsed = parseInt(tv.rows[0].value, 10)
      if (!Number.isNaN(parsed)) adminTokenVersion = parsed
    } else {
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ('admin_token_version', '1', NOW())
         ON CONFLICT (key) DO NOTHING`
      )
    }
  } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
  return adminTokenVersion
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

const adminTwoFaValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many admin 2FA attempts. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
})

router.get('/2fa/status', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    res.json({
      ...getAdmin2faStatusPayload(req.admin, record),
      email: req.admin?.email || null
    })
  } catch (err) {
    logger.error('[admin/2fa/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not load admin 2FA status' })
  }
})

router.post('/2fa/setup', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    if (!record) {
      return res.status(403).json({ error: '2FA setup is only available for DB-backed admin accounts' })
    }

    const label = `${record.email || record.full_name || 'admin'}`
    const { base32, otpauthUrl } = totp.generateSecret(label)
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl)
    const encTemp = totp.encryptSecret(base32)
    await persistAdminSecurityFields(record, {
      totp_secret: record.totp_secret || null,
      totp_temp_secret: encTemp,
      totp_backup_codes: record.totp_backup_codes || null,
      totp_enabled: !!record.totp_enabled,
      token_version: record.token_version || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: record.last_login_at || null
    })

    res.json({ qr: qrDataUrl, secret: base32 })
  } catch (err) {
    logger.error('[admin/2fa/setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not set up admin 2FA' })
  }
})

// POST /api/admin/2fa/verify-setup — confirm first code, activate admin 2FA
router.post('/2fa/verify-setup', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    if (!record) {
      return res.status(403).json({ error: '2FA setup is only available for DB-backed admin accounts' })
    }

    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    if (!record.totp_temp_secret) {
      return res.status(400).json({ error: 'Run /api/admin/2fa/setup first' })
    }

    const plainTemp = totp.decryptSecret(record.totp_temp_secret)
    const valid = totp.verifyToken(plainTemp, token)
    if (!valid) return res.status(401).json({ error: 'Invalid code. Please try again.' })

    const backup = await totp.generateBackupCodes()
    const encLive = totp.encryptSecret(plainTemp)
    const storedBackupCodes = backup.hashes.map((hash) => ({ hash, used: false }))

    await persistAdminSecurityFields(record, {
      totp_secret: encLive,
      totp_temp_secret: null,
      totp_backup_codes: JSON.stringify(storedBackupCodes),
      totp_enabled: true,
      token_version: record.token_version || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: record.last_login_at || null
    })

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'admin_2fa_enabled',
        entityType: String(req.admin?.role || 'admin'),
        entityId: String(record.id),
        payload: { auth_source: record.auth_source || null }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    logger.info('[admin/2fa] Admin 2FA enabled', { adminId: record.id, role: req.admin?.role })
    res.json({
      message: 'Admin 2FA enabled successfully.',
      backup_codes: backup.plain
    })
  } catch (err) {
    logger.error('[admin/2fa/verify-setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not activate admin 2FA' })
  }
})

router.post('/2fa/validate', adminTwoFaValidateLimiter, authenticateAdminPre2FA, async function(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'admin_ip'
  const rl = totp.checkRateLimit(`admin:${ip}`)
  if (rl.blocked) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${rl.remaining} minute(s).` })
  }

  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const record = await getAdminRecordForPre2faSession(req.adminPre2fa)
    if (!record || record.status !== 'active') {
      return res.status(403).json({ error: 'Admin account is unavailable' })
    }

    if (!record.totp_enabled || !record.totp_secret) {
      return res.status(400).json({ error: 'Admin 2FA is not configured' })
    }

    const validation = await verifyAdmin2faTokenOrBackup(record, token)
    if (!validation.ok) {
      totp.recordFailure(`admin:${ip}`)
      return res.status(401).json({ error: 'Invalid code. Please try again.' })
    }

    if (validation.used_backup_code) {
      await persistAdminSecurityFields(record, {
        totp_secret: record.totp_secret,
        totp_temp_secret: record.totp_temp_secret || null,
        totp_backup_codes: JSON.stringify(validation.backup_codes || []),
        totp_enabled: !!record.totp_enabled,
        token_version: record.token_version || 1,
        status: record.status || 'active',
        password_hash: record.password_hash || null,
        full_name: record.full_name || null,
        last_login_at: record.last_login_at || null
      })
    }

    totp.clearAttempts(`admin:${ip}`)

    const fullToken = signAdminToken({
      id: record.id,
      token_version: record.token_version || req.adminPre2fa.atv || 1,
      email: record.email,
      full_name: record.full_name,
      role: record.role || 'super_admin',
      auth_source: record.auth_source || 'platform_admin'
    })

    await persistAdminSecurityFields(record, {
      totp_secret: record.totp_secret,
      totp_temp_secret: record.totp_temp_secret || null,
      totp_backup_codes: validation.used_backup_code ? JSON.stringify(validation.backup_codes || []) : (record.totp_backup_codes || null),
      totp_enabled: !!record.totp_enabled,
      token_version: record.token_version || req.adminPre2fa.atv || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: new Date().toISOString()
    })

    setAdminCookie(res, fullToken)

    res.json({
      message: 'Admin login successful',
      token: fullToken,
      admin: buildAdminSessionPayload(buildAdminSessionAdmin(record))
    })
  } catch (err) {
    logger.error('[admin/2fa/validate] error:', { error: err.message })
    res.status(500).json({ error: 'Could not verify admin 2FA token' })
  }
})

router.post('/2fa/disable', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    if (!record) {
      return res.status(403).json({ error: '2FA management is only available for DB-backed admin accounts' })
    }

    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    if (!record.totp_enabled || !record.totp_secret) {
      return res.status(400).json({ error: 'Admin 2FA is not configured' })
    }

    const validation = await verifyAdmin2faTokenOrBackup(record, token)
    if (!validation.ok) return res.status(401).json({ error: 'Invalid 2FA code' })

    await persistAdminSecurityFields(record, {
      totp_secret: null,
      totp_temp_secret: null,
      totp_backup_codes: null,
      totp_enabled: false,
      token_version: record.token_version || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: record.last_login_at || null
    })

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'admin_2fa_disabled',
        entityType: String(req.admin?.role || 'admin'),
        entityId: String(record.id),
        payload: { auth_source: record.auth_source || null }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    logger.info('[admin/2fa] Admin 2FA disabled')
    res.json({ message: 'Admin 2FA disabled' })
  } catch (err) {
    logger.error('[admin/2fa/disable] error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable admin 2FA' })
  }
})

router.get('/session', authenticateAdmin, async function(req, res) {
  res.json(buildAdminSessionPayload(req.admin))
})

router.get('/security/status', authenticateAdmin, async function(req, res) {
  try {
    res.json(await buildAdminSecurityStatus(req.admin))
  } catch (err) {
    logger.error('[admin/security/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not load admin security status' })
  }
})

router.get('/admin-users', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureTenantSettingsInfrastructure()

    const [platformResult, securityStatus] = await Promise.all([
      pool.query(
        `SELECT id, email, full_name, role, status, token_version, totp_enabled,
                last_login_at, created_at, updated_at
           FROM platform_admins
          ORDER BY created_at ASC`
      ),
      buildAdminSecurityStatus(req.admin)
    ])

    res.json({
      summary: securityStatus,
      platform_admins: platformResult.rows.map(sanitizePlatformAdminRecord).filter(Boolean)
    })
  } catch (err) {
    logger.error('[admin/admin-users] list error:', { error: err.message })
    res.status(500).json({ error: 'Could not load admin access data' })
  }
})

router.post('/admin-users', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const email = normalizeAdminEmail(req.body?.email)
    const password = String(req.body?.password || '')
    const fullName = String(req.body?.full_name || '').trim() || null
    const role = 'super_admin'

    if (!email) return res.status(400).json({ error: 'Admin email is required' })
    if (password.length < 10) {
      return res.status(400).json({ error: 'Admin password must be at least 10 characters' })
    }

    const existing = await getPlatformAdminByEmail(email)
    if (existing) {
      return res.status(409).json({ error: 'A platform admin with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const insert = await pool.query(
      `INSERT INTO platform_admins
        (email, full_name, password_hash, role, status, token_version, totp_enabled, created_at, updated_at)
       VALUES (LOWER($1), $2, $3, $4, 'active', 1, FALSE, NOW(), NOW())
       RETURNING id, email, full_name, role, status, token_version, totp_enabled, last_login_at, created_at, updated_at`,
      [email, fullName, passwordHash, role]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_created',
        entityType: 'platform_admin',
        entityId: String(insert.rows[0].id),
        payload: { email, role }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.status(201).json({
      message: 'Platform admin created',
      admin_user: sanitizePlatformAdminRecord(insert.rows[0])
    })
  } catch (err) {
    logger.error('[admin/admin-users] create error:', { error: err.message })
    res.status(500).json({ error: 'Could not create platform admin' })
  }
})

router.patch('/admin-users/:id', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    const nextFullName = Object.prototype.hasOwnProperty.call(req.body || {}, 'full_name')
      ? (String(req.body?.full_name || '').trim() || null)
      : current.full_name
    const nextStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status')
      ? String(req.body?.status || '').trim().toLowerCase()
      : current.status

    if (!['active', 'disabled'].includes(nextStatus)) {
      return res.status(400).json({ error: 'status must be active or disabled' })
    }

    if (current.status === 'active' && nextStatus !== 'active') {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM platform_admins
          WHERE status = 'active'`
      )
      const activeCount = parseInt(countResult.rows[0]?.count || 0, 10) || 0
      if (activeCount <= 1) {
        return res.status(400).json({ error: 'You must keep at least one active platform admin' })
      }
    }

    const update = await pool.query(
      `UPDATE platform_admins
          SET full_name = $2,
              status = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, full_name, role, status, token_version, totp_enabled, last_login_at, created_at, updated_at`,
      [adminId, nextFullName, nextStatus]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_updated',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { status: nextStatus, full_name: nextFullName }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({
      message: 'Platform admin updated',
      admin_user: sanitizePlatformAdminRecord(update.rows[0])
    })
  } catch (err) {
    logger.error('[admin/admin-users] update error:', { error: err.message })
    res.status(500).json({ error: 'Could not update platform admin' })
  }
})

router.post('/admin-users/:id/reset-password', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    const password = String(req.body?.password || '')
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })
    if (password.length < 10) {
      return res.status(400).json({ error: 'New password must be at least 10 characters' })
    }

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    const passwordHash = await bcrypt.hash(password, 12)
    await pool.query(
      `UPDATE platform_admins
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId, passwordHash]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_password_reset',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { email: current.email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Platform admin password reset successfully' })
  } catch (err) {
    logger.error('[admin/admin-users] reset-password error:', { error: err.message })
    res.status(500).json({ error: 'Could not reset platform admin password' })
  }
})

router.post('/admin-users/:id/revoke-sessions', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    await pool.query(
      `UPDATE platform_admins
          SET token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_sessions_revoked',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { email: current.email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Platform admin sessions revoked' })
  } catch (err) {
    logger.error('[admin/admin-users] revoke-sessions error:', { error: err.message })
    res.status(500).json({ error: 'Could not revoke platform admin sessions' })
  }
})

router.post('/admin-users/:id/disable', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    if (current.status === 'active') {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM platform_admins
          WHERE status = 'active'`
      )
      const activeCount = parseInt(countResult.rows[0]?.count || 0, 10) || 0
      if (activeCount <= 1) {
        return res.status(400).json({ error: 'You must keep at least one active platform admin' })
      }
    }

    await pool.query(
      `UPDATE platform_admins
          SET status = 'disabled',
              token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_disabled',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { email: current.email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Platform admin disabled' })
  } catch (err) {
    logger.error('[admin/admin-users] disable error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable platform admin' })
  }
})

router.get('/overview', authenticateAdmin, async function(req, res) {

  try {
    await ensureViolationTables()
    await ensureDisputesInfrastructure()

    const accounts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase1') AS phase1_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase2') AS phase2_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded') AS funded_active,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE status = 'passed') AS total_passed,
        COUNT(*) FILTER (WHERE status = 'expired') AS total_expired
       FROM accounts`
    )

    const users = await pool.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE kyc_status = 'pending') AS kyc_pending,
        COUNT(*) FILTER (WHERE kyc_status = 'approved') AS kyc_approved
       FROM users`
    )

    const pnl = await pool.query(
      `SELECT
        COALESCE(SUM(t.demo_pnl), 0) AS total_demo_pnl,
        COALESCE(SUM(t.broker_pnl), 0) AS total_broker_pnl,
        COUNT(*) FILTER (WHERE t.status = 'closed') AS total_closed_trades,
        COUNT(*) FILTER (WHERE t.status = 'open') AS total_open_trades
       FROM trades t
       JOIN accounts a ON a.id = t.account_id`
    )

    const payouts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_payouts,
        COALESCE(SUM(amount_payable) FILTER (WHERE status = 'paid'), 0) AS total_paid_out
       FROM payouts p
       JOIN users u ON u.id = p.user_id`
    )

    const bannedUsers = await pool.query(
      `SELECT COUNT(*) as banned
       FROM users
       WHERE is_banned = true`
    );
    const flaggedPayouts = await pool.query(
      `SELECT COUNT(*) as flagged
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'flagged'`
    );

    const { exposureData } = await getExposureData(pool);

    // ── Command Center additions (Modern Gazette handoff spec) ──────────
    // Gross revenue by month — challenge_orders is the only real revenue
    // source in this app; there's no separate "reset fee" product, so this
    // is a single "Challenge Fees" series (the prototype's copy mentions
    // resets, but that's not a real feature here — omitted rather than
    // fabricated).
    const revenueByMonth = await pool.query(
      `SELECT to_char(date_trunc('month', paid_at), 'Mon') AS month,
              date_trunc('month', paid_at) AS month_start,
              COALESCE(SUM(amount), 0) AS revenue
         FROM challenge_orders
        WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '6 months'
        GROUP BY date_trunc('month', paid_at)
        ORDER BY month_start ASC`
    )

    // Daily event counts for KPI sparklines/deltas — only for metrics with
    // a real timestamped event stream (point-in-time counts like "active
    // challenges" or "pending KYC" have no historical series to draw from,
    // so those KPI cards render without a sparkline/delta rather than a
    // fabricated one).
    const [dailySignups, dailyFunded, dailyPayouts, dailyPnl] = await Promise.all([
      pool.query(`SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS n
                    FROM users WHERE created_at >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT date_trunc('day', phase_start_date) AS day, COUNT(*)::int AS n
                    FROM accounts WHERE account_type = 'funded' AND phase_start_date >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT date_trunc('day', paid_at) AS day, COALESCE(SUM(amount_payable), 0) AS n
                    FROM payouts WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT date_trunc('day', close_time) AS day, COALESCE(SUM(demo_pnl), 0) AS n
                    FROM trades WHERE status = 'closed' AND close_time >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
    ])

    function buildDailySeries(rows, days = 14) {
      const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), parseFloat(r.n) || 0]))
      const series = []
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
        series.push({ value: byDay.get(d) || 0 })
      }
      return series
    }
    function trendDelta(series) {
      const last7 = series.slice(-7).reduce((a, b) => a + b.value, 0)
      const prev7 = series.slice(-14, -7).reduce((a, b) => a + b.value, 0)
      if (prev7 === 0) return last7 > 0 ? { pct: null, label: `+${last7} (7d)` } : { pct: 0, label: '0 (7d)' }
      const pct = Math.round(((last7 - prev7) / prev7) * 100)
      return { pct, label: `${pct >= 0 ? '+' : ''}${pct}% (7d)` }
    }

    const signupsSeries = buildDailySeries(dailySignups.rows)
    const fundedSeries = buildDailySeries(dailyFunded.rows)
    const payoutsSeries = buildDailySeries(dailyPayouts.rows)
    const pnlSeries = buildDailySeries(dailyPnl.rows)

    // Needs Attention — a real, sorted queue (not just a stat grid): pending
    // KYC, pending/flagged payouts, open critical violations, open disputes.
    const [violationCounts, disputeCounts] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS critical_open,
                         COUNT(*) FILTER (WHERE status = 'open')::int AS all_open
                    FROM admin_rule_violations`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('open', 'under_review'))::int AS open_count
                    FROM disputes`)
    ])

    const attentionQueue = [
      { key: 'kyc', label: 'Pending KYC reviews', meta: 'Identity verification', n: parseInt(users.rows[0].kyc_pending || 0) },
      { key: 'payouts', label: 'Pending payout requests', meta: 'Awaiting review', n: parseInt(payouts.rows[0].pending_payouts || 0) },
      { key: 'flagged', label: 'Flagged payouts', meta: 'Risk-flagged, needs decision', n: parseInt(flaggedPayouts.rows[0].flagged || 0) },
      { key: 'violations', label: 'Critical violations', meta: 'System-flagged breaches', n: violationCounts.rows[0].critical_open },
      { key: 'disputes', label: 'Open appeals', meta: 'Trader-filed disputes', n: disputeCounts.rows[0].open_count },
      { key: 'banned', label: 'Banned users', meta: 'Under enforcement', n: parseInt(bannedUsers.rows[0].banned || 0) },
    ].filter((item) => item.n > 0).sort((a, b) => b.n - a.n)

    const totalAttention = attentionQueue.reduce((sum, item) => sum + item.n, 0)

    // Alerts — the top 1-3 most urgent conditions only (never fabricated
    // filler if fewer than 3 exist).
    const alerts = []
    if (violationCounts.rows[0].critical_open > 0) {
      alerts.push({ tone: 'loss', kicker: 'Critical', text: `${violationCounts.rows[0].critical_open} critical violation${violationCounts.rows[0].critical_open === 1 ? '' : 's'} awaiting review`, cta: 'Review', go: 'violations' })
    }
    if (parseInt(flaggedPayouts.rows[0].flagged || 0) > 0) {
      alerts.push({ tone: 'warn', kicker: 'Flagged', text: `${flaggedPayouts.rows[0].flagged} payout${parseInt(flaggedPayouts.rows[0].flagged) === 1 ? '' : 's'} flagged for risk review`, cta: 'Review', go: 'payouts' })
    }
    if (disputeCounts.rows[0].open_count > 0) {
      alerts.push({ tone: 'accent', kicker: 'Open', text: `${disputeCounts.rows[0].open_count} trader appeal${disputeCounts.rows[0].open_count === 1 ? '' : 's'} awaiting a decision`, cta: 'Review', go: 'disputes' })
    }

    res.json({
      accounts: {
        phase1: parseInt(accounts.rows[0].phase1_active || 0),
        phase2: parseInt(accounts.rows[0].phase2_active || 0),
        funded: parseInt(accounts.rows[0].funded_active || 0),
        failed: parseInt(accounts.rows[0].total_failed || 0),
        passed: parseInt(accounts.rows[0].total_passed || 0),
        expired: parseInt(accounts.rows[0].total_expired || 0)
      },
      users: {
        total: parseInt(users.rows[0].total_users || 0),
        pending_kyc: parseInt(users.rows[0].kyc_pending || 0),
        approved_kyc: parseInt(users.rows[0].kyc_approved || 0),
        banned: parseInt(bannedUsers.rows[0].banned || 0)
      },
      trades: {
        open: parseInt(pnl.rows[0].total_open_trades || 0),
        total_pnl: parseFloat(pnl.rows[0].total_demo_pnl || 0)
      },
      payouts: {
        pending: parseInt(payouts.rows[0].pending_payouts || 0),
        total_paid: parseFloat(payouts.rows[0].total_paid_out || 0),
        flagged_count: parseInt(flaggedPayouts.rows[0].flagged || 0)
      },
      exposure: exposureData,
      settings: {},
      revenue_by_month: revenueByMonth.rows.map((r) => ({ month: r.month, revenue: parseFloat(r.revenue) })),
      kpi_trends: {
        users: { spark: signupsSeries, delta: trendDelta(signupsSeries) },
        funded: { spark: fundedSeries, delta: trendDelta(fundedSeries) },
        payouts_paid: { spark: payoutsSeries, delta: trendDelta(payoutsSeries) },
        pnl: { spark: pnlSeries, delta: trendDelta(pnlSeries) },
      },
      attention_queue: attentionQueue,
      attention_total: totalAttention,
      alerts
    })

  } catch (error) {
    logger.error('Admin overview error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch overview' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/signup-trends
// Real 30-day signup + challenge data for AdminDashboard charts.
// FIX (BUG-2): Added so dashboard charts show real data, not mock constants.
// ─────────────────────────────────────────────────────────────────────────────
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

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
      `
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
    const userId = normalizeEntityId(req.body?.userId)
    if (!userId) {
      return res.status(400).json({ error: 'Valid userId is required' })
    }

    const visible = toBool(req.body?.visible, true)
    const result = await pool.query(
      `UPDATE users
          SET leaderboard_visible = $1
        WHERE id = $2
        RETURNING id, leaderboard_visible`,
      [visible, userId]
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({
      userId,
      visible: result.rows[0].leaderboard_visible !== false
    })
  } catch (error) {
    logger.error('Leaderboard visibility error:', { error: error.message })
    res.status(500).json({ error: 'Could not update leaderboard visibility' })
  }
})

router.get('/signup-trends', authenticateAdmin, async function(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90)

    const signupResult = await pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int AS signups
       FROM users
       WHERE created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY day
       ORDER BY day ASC`,
      [days]
    )

    const challengeResult = await pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int AS challenges
       FROM accounts
       WHERE account_type = 'phase1'
         AND created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY day
       ORDER BY day ASC`,
      [days]
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

router.get('/saved-views', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const resource = String(req.query?.resource || '').trim().toLowerCase()
    if (!resource) {
      return res.status(400).json({ error: 'resource is required' })
    }

    const adminId = getAdminOwnerId(req.admin)
    const result = await pool.query(
      `SELECT id, resource, name, config_json, is_default, created_at, updated_at
       FROM admin_saved_views
       WHERE admin_id = $1
         AND resource = $2
       ORDER BY is_default DESC, updated_at DESC, id DESC`,
      [adminId, resource]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Saved views fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not load saved views' })
  }
})

router.post('/saved-views', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const resource = String(req.body?.resource || '').trim().toLowerCase()
    const name = String(req.body?.name || '').trim()
    const config = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {}
    const isDefault = !!req.body?.is_default
    const adminId = getAdminOwnerId(req.admin)

    if (!resource) return res.status(400).json({ error: 'resource is required' })
    if (name.length < 2) return res.status(400).json({ error: 'name is required' })

    await client.query('BEGIN')
    if (isDefault) {
      await client.query(
        `UPDATE admin_saved_views
            SET is_default = FALSE, updated_at = NOW()
          WHERE admin_id = $1
            AND resource = $2`,
        [adminId, resource]
      )
    }

    const result = await client.query(
      `INSERT INTO admin_saved_views
        (admin_id, admin_role, resource, name, config_json, is_default, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW(), NOW())
       RETURNING id, resource, name, config_json, is_default, created_at, updated_at`,
      [adminId, req.admin?.role || 'admin', resource, name.slice(0, 120), JSON.stringify(config), isDefault]
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

router.patch('/saved-views/:id', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const adminId = getAdminOwnerId(req.admin)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid saved view id is required' })

    const existing = await client.query(
      `SELECT id, resource
       FROM admin_saved_views
       WHERE id = $1
         AND admin_id = $2`,
      [id, adminId]
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
            AND resource = $2`,
        [adminId, existing.rows[0].resource]
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
        RETURNING id, resource, name, config_json, is_default, created_at, updated_at`,
      [name || null, config ? JSON.stringify(config) : null, isDefault, id, adminId]
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

router.delete('/saved-views/:id', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const adminId = getAdminOwnerId(req.admin)
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Valid saved view id is required' })

    const result = await pool.query(
      `DELETE FROM admin_saved_views
        WHERE id = $1
          AND admin_id = $2
      RETURNING id`,
      [id, adminId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Saved view not found' })
    res.json({ message: 'Saved view deleted' })
  } catch (error) {
    logger.error('Saved view delete error:', { error: error.message })
    res.status(500).json({ error: 'Could not delete saved view' })
  }
})

router.post('/tags/assign', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(normalizeEntityId).filter(Boolean).slice(0, 100) : []
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(normalizeAdminTag).filter(Boolean).slice(0, 20) : []
    const mode = String(req.body?.mode || 'add').trim().toLowerCase()
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
            `INSERT INTO admin_entity_tags (entity_type, entity_id, tag, created_by, created_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (entity_type, entity_id, tag) DO NOTHING`,
            [entityType, entityId, tag, adminActor]
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

router.get('/notes', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.query?.entity_type)
    const entityId = normalizeEntityId(req.query?.entity_id)
    if (!entityType || !entityId) {
      return res.status(400).json({ error: 'entity_type and entity_id are required' })
    }

    const result = await pool.query(
      `SELECT id, entity_type, entity_id, note_text, created_by, created_at
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

router.post('/notes', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const noteText = String(req.body?.note || '').trim()
    const createdBy = getAdminActorLabel(req.admin)

    if (!entityType || !entityId) return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    if (noteText.length < 2) return res.status(400).json({ error: 'A note is required' })

    const result = await client.query(
      `INSERT INTO admin_entity_notes
        (entity_type, entity_id, note_text, created_by, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, entity_type, entity_id, note_text, created_by, created_at`,
      [entityType, entityId, noteText.slice(0, 4000), createdBy]
    )
    res.status(201).json(result.rows[0])
  } catch (error) {
    logger.error('Note create error:', { error: error.message })
    res.status(500).json({ error: 'Could not add note' })
  } finally {
    client.release()
  }
})

router.post('/cases/link', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
    const caseId = req.body?.case_id == null || req.body?.case_id === '' ? null : parseInt(req.body.case_id, 10)

    if (!entityType || !entityId) return res.status(400).json({ error: 'Valid entity_type and entity_id are required' })
    if (caseId !== null) {
      const caseLookup = await client.query(`SELECT id FROM admin_cases WHERE id = $1`, [caseId])
      if (caseLookup.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    }

    const meta = await upsertAdminEntityMeta(client, {
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

router.post('/entity-meta', authenticateAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const entityType = normalizeEntityType(req.body?.entity_type)
    const entityId = normalizeEntityId(req.body?.entity_id)
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

    const meta = await upsertAdminEntityMeta(client, { entityType, entityId, patch })
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

async function buildEmailJobListResult({ query = {} } = {}) {
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

router.post('/export', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
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
      result = await buildTraderListResult({ query })
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
      result = await buildAccountListResult({ query })
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
      result = await buildPayoutListResult({ query })
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
      result = await buildEmailJobListResult({ query })
      columns = [
        { header: 'Job ID', key: 'id' },
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
      const params = []
      const conditions = [
        `a.account_type = 'funded'`,
        `a.status = 'active'`,
        `COALESCE(u.is_banned, FALSE) = FALSE`
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
      await ensureDisputesInfrastructure()
      const filters = query.filters || {}
      const conditions = []
      const values = []

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

router.get('/email-jobs', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureEmailQueueInfrastructure()
    const paging = parseListPaging(req)
    const listResult = await buildEmailJobListResult({
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

router.post('/email-jobs/:jobId/retry', authenticateAdmin, async function(req, res) {
  try {
    await ensureEmailQueueInfrastructure()
    const jobId = parseInt(req.params.jobId, 10)
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Valid email job id is required' })
    }

    const lookup = await pool.query(
      `SELECT id, status
         FROM email_jobs
        WHERE id = $1
        LIMIT 1`,
      [jobId]
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

router.get('/traders', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const paging = parseListPaging(req)
    const listResult = await buildTraderListResult({
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          kyc_status: req.query?.kyc_status || null,
          is_banned: parseBooleanFilter(req.query?.is_banned),
          has_active_accounts: parseBooleanFilter(req.query?.has_active_accounts),
          funded_only: parseBooleanFilter(req.query?.funded_only),
          country: req.query?.country || null,
          risk_tier: req.query?.risk_tier || null,
          tags: parseCsvListParam(req.query?.tags || [])
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin traders fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch traders' })
  }
})

// GET /api/admin/traders/:userId/activity-spark — 30-day cumulative realized
// P&L across all of a trader's accounts, for the isAdminUsers drawer's
// `row.spark` (Modern Gazette handoff spec). Computed on read, no new table.
router.get('/traders/:userId/activity-spark', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    const { userId } = req.params
    const result = await pool.query(
      `SELECT DATE(t.close_time) AS day, COALESCE(SUM(t.demo_pnl), 0) AS pnl
         FROM trades t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.user_id = $1 AND t.status = 'closed' AND t.close_time >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day ASC`,
      [userId]
    )
    const byDay = new Map(result.rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), parseFloat(r.pnl) || 0]))
    let running = 0
    const spark = []
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      running += byDay.get(d) || 0
      spark.push({ value: parseFloat(running.toFixed(2)) })
    }
    res.json({ spark })
  } catch (error) {
    logger.error('Admin trader activity-spark error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trader activity' })
  }
})

// "Request more" — the prototype's isAdminKyc review actions are Reject /
// Request more / Approve. Reject and Approve already existed for real;
// Request more didn't (no status change makes sense — the trader stays
// pending — so it's a real trader-facing email + an internal note, reusing
// the same admin_entity_notes table AdminEntityDrawer already writes to).
router.post('/kyc/request-info', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const userId = normalizeEntityId(req.body?.user_id)
    const message = sanitizeString(String(req.body?.message || ''), 1000)
    if (!userId) return res.status(400).json({ error: 'user_id is required' })
    if (message.length < 5) return res.status(400).json({ error: 'Please describe what additional information is needed' })

    const userResult = await pool.query('SELECT id, email, full_name FROM users WHERE id = $1', [userId])
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' })
    const user = userResult.rows[0]

    const context = resolveMailContext()
    const result = await sendEmailMessage({
      to: user.email,
      subject: `Action needed on your ${context.firmName} identity verification`,
      html: htmlWrap('More information needed', `
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">Hi ${user.full_name || 'there'},</p>
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">
          Our team reviewed your identity verification submission and needs a bit more before we can approve it:
        </p>
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;background:#132436;padding:14px;border-radius:4px;">${message}</p>
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">
          Sign in and resubmit your documents from the Identity Verification page whenever you're ready.
        </p>
      `),
      text: `Hi ${user.full_name || 'there'}, our team needs more information on your identity verification: ${message}`
    })
    if (!result.ok) return res.status(502).json({ error: 'Could not send the request email' })

    await pool.query(
      `INSERT INTO admin_entity_notes (entity_type, entity_id, note_text, created_by, created_at)
       VALUES ('user', $1, $2, $3, NOW())`,
      [String(userId), `Requested more KYC info: ${message}`, getAdminActorLabel(req.admin)]
    )

    res.json({ message: 'Request sent' })
  } catch (error) {
    logger.error('KYC request-info error:', { error: error.message })
    res.status(500).json({ error: 'Could not send request' })
  }
})

router.post('/kyc/approve', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET kyc_status = 'approved'
       WHERE id = $1
       RETURNING id, email, full_name`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_approved',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    // Send automated email to the user
    await enqueueKycApprovedEmail(result.rows[0].email, result.rows[0].full_name, {
      userId: result.rows[0].id
    })

    res.json({ message: 'KYC approved successfully' })
  } catch (error) {
    logger.error('KYC approve error:', { error: error.message })
    res.status(500).json({ error: 'Could not approve KYC' })
  }
})

router.post('/kyc/reject', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    const { reason } = req.body
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET kyc_status = 'rejected'
       ${ reason ? `, kyc_rejection_reason = $2` : '' }
       WHERE id = $1
       RETURNING id, email, full_name`,
      reason ? [user_id, String(reason).slice(0, 500)] : [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_rejected',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email, reason: reason || '' }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    // Send automated email to the user
    await enqueueKycRejectedEmail(result.rows[0].email, result.rows[0].full_name, reason, {
      userId: result.rows[0].id
    })

    res.json({ message: 'KYC rejected' })
  } catch (error) {
    logger.error('KYC reject error:', { error: error.message })
    res.status(500).json({ error: 'Could not reject KYC' })
  }
})

// Trader invites — the prototype's isAdminUsers block has a "+ Invite"
// button with no real backend capability behind it anywhere in this app
// (registration is already open/public, so an "invite" is a nudge email +
// an audit trail, not an access-gated flow). Built for real rather than
// left as a dead button: sends a real email, tracked in a lightweight table.
let traderInvitesTablePromise = null
async function ensureTraderInvitesTable() {
  if (traderInvitesTablePromise) return traderInvitesTablePromise
  traderInvitesTablePromise = pool.query(`
    CREATE TABLE IF NOT EXISTS admin_trader_invites (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((err) => { traderInvitesTablePromise = null; throw err })
  return traderInvitesTablePromise
}

router.post('/traders/invite', authenticateAdmin, requireAdminCapability('trader:write:scoped'), async function(req, res) {
  try {
    await ensureTraderInvitesTable()
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email address is required' })

    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email])
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'This email already has an account' })
    }

    const context = resolveMailContext()
    const signupUrl = `${context.baseUrl}/register`
    const result = await sendEmailMessage({
      to: email,
      subject: `You're invited to trade with ${context.firmName}`,
      html: htmlWrap('You have been invited', `
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">
          An admin at ${context.firmName} invited you to start a funded trading challenge.
        </p>
        <p style="margin:24px 0;">
          <a href="${signupUrl}" style="background:#c9a84c;color:#0d1b2a;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:700;">Create your account</a>
        </p>
      `),
      text: `You've been invited to trade with ${context.firmName}. Create your account: ${signupUrl}`
    })
    if (!result.ok) return res.status(502).json({ error: 'Could not send the invite email' })

    await pool.query(
      `INSERT INTO admin_trader_invites (email, invited_by) VALUES ($1, $2)`,
      [email, getAdminActorLabel(req.admin)]
    )

    res.json({ message: 'Invite sent', email })
  } catch (error) {
    logger.error('Trader invite error:', { error: error.message })
    res.status(500).json({ error: 'Could not send invite' })
  }
})

router.post('/ban', authenticateAdmin, requireAdminCapability('trader:moderate:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = true
       WHERE id = $1
       RETURNING id, email`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_banned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Trader banned successfully' })
  } catch (error) {
    logger.error('Ban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not ban trader' })
  }
})

router.post('/unban', authenticateAdmin, requireAdminCapability('trader:moderate:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = false
       WHERE id = $1
       RETURNING id, email`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_unbanned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Trader unbanned successfully' })
  } catch (error) {
    logger.error('Unban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not unban trader' })
  }
})

router.post('/users/:userId/revoke-sessions', authenticateAdmin, requireAdminCapability('trader:revoke_sessions'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const userId = normalizeEntityId(req.params.userId)
    const reason = requireReasonText(req.body?.reason)

    if (!userId) {
      return res.status(400).json({ error: 'Valid user id is required' })
    }

    await client.query('BEGIN')
    const user = await fetchUserForAdmin(client, userId, { forUpdate: true })
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }

    const beforeSnapshot = normalizeUserSnapshot(user)
    const result = await client.query(
      `UPDATE users
          SET token_version = COALESCE(token_version, 1) + 1
        WHERE id = $1
        RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
      [userId]
    )
    const updatedUser = result.rows[0]

    await appendImmutableAudit(client, {
      eventType: 'admin_user_sessions_revoked',
      entityType: 'user',
      entityId: String(userId),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizeUserSnapshot(updatedUser)
      }
    })

    await client.query('COMMIT')
    await invalidateAllUserTokens(userId)

    if (req.app.get('io')) {
      req.app.get('io').to(String(userId)).emit('force_logout', {
        message: 'Your session was revoked by platform support. Please log in again.'
      })
    }

    await emitSuperAdminPowerEvent(req, {
      entity: 'user',
      entity_id: userId,
      action: 'revoke_sessions'
    })

    res.json({
      message: 'Trader sessions revoked successfully',
      user: updatedUser,
      allowed_actions: buildAllowedUserActions(updatedUser)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin revoke sessions error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not revoke trader sessions' })
  } finally {
    client.release()
  }
})

router.post('/users/:userId/manual-account', authenticateAdmin, requireAdminCapability('account:create_manual'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const userId = normalizeEntityId(req.params.userId)
    const reason = requireReasonText(req.body?.reason)
    const accountType = String(req.body?.account_type || 'phase1').trim().toLowerCase()
    const accountSize = parseInt(req.body?.account_size, 10)

    if (!userId) {
      return res.status(400).json({ error: 'Valid user id is required' })
    }
    if (!['phase1', 'phase2', 'phase3', 'funded'].includes(accountType)) {
      return res.status(400).json({ error: 'account_type must be phase1, phase2, phase3, or funded' })
    }
    if (!Number.isFinite(accountSize) || !ADMIN_VALID_ACCOUNT_SIZES.includes(accountSize)) {
      return res.status(400).json({ error: `account_size must be one of: ${ADMIN_VALID_ACCOUNT_SIZES.join(', ')}` })
    }

    await client.query('BEGIN')
    const user = await fetchUserForAdmin(client, userId, { forUpdate: true })
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }

    const settings = await getTenantSettings([
      'phase1_day_limit',
      'phase2_day_limit',
      'phase1_profit_target_pct',
      'phase2_profit_target_pct',
      'phase1_max_drawdown_pct',
      'phase2_max_drawdown_pct',
      'funded_max_drawdown_pct'
    ])

    const account = await createAdminIssuedAccount(client, {
      userId,
      accountType,
      accountSize,
      settings
    })

    await appendImmutableAudit(client, {
      eventType: 'admin_manual_account_issued',
      entityType: 'account',
      entityId: String(account.id),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        issued_for_user: normalizeUserSnapshot(user),
        after_snapshot: normalizeAccountSnapshot(account),
        bypassed_account_limits: true
      }
    })

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(userId)).emit('account_update', {
        message: `Support issued a new ${accountType.toUpperCase()} account for you.`,
        account_id: account.id,
        event: 'admin_manual_account_issued'
      })
    }

    await emitSuperAdminPowerEvent(req, {
      entity: 'account',
      entity_id: account.id,
      action: 'manual_account'
    })

    res.json({
      message: 'Manual account issued successfully',
      account,
      bypassed_account_limits: true,
      allowed_actions: buildAllowedAccountActions(account)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin manual account error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not issue manual account' })
  } finally {
    client.release()
  }
})

router.get('/accounts', authenticateAdmin, requireAdminCapability('account:read:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const paging = parseListPaging(req)
    const listResult = await buildAccountListResult({
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          account_type: req.query?.account_type || null,
          status: req.query?.status || null,
          review_flagged: parseBooleanFilter(req.query?.review_flagged),
          tags: parseCsvListParam(req.query?.tags || [])
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin accounts fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch accounts' })
  }
})

router.post('/accounts/:accountId/adjust-balance', authenticateAdmin, requireAdminCapability('account:adjust_balance'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const accountId = String(req.params.accountId || '').trim()
    const amount = parseFloat(req.body?.amount)
    const reason = requireReasonText(req.body?.reason)

    if (!accountId) return res.status(400).json({ error: 'Valid account id is required' })
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'A non-zero amount is required' })
    }

    await client.query('BEGIN')
    const account = await fetchAccountForAdmin(client, accountId, { forUpdate: true })
    if (!account) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const beforeSnapshot = normalizeAccountSnapshot(account)
    const updated = await client.query(
      `UPDATE accounts
          SET current_balance = current_balance + $1,
              peak_balance = GREATEST(peak_balance, current_balance + $1),
              updated_at = NOW()
        WHERE id = $2
        RETURNING id, user_id, account_type, current_balance, starting_balance,
                  peak_balance, status, profit_target, max_drawdown_pct, phase_start_date,
                  phase_end_date, account_uid, review_flagged, review_flag_reason`,
      [amount, account.id]
    )

    await client.query(
      `INSERT INTO admin_balance_adjustments
        (account_id, user_id, amount, reason, adjustment_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(account.id),
        String(account.user_id),
        amount,
        reason,
        amount > 0 ? 'credit' : 'debit',
        String(req.admin?.role || 'admin')
      ]
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'account_balance_adjusted',
        entityType: 'account',
        entityId: String(account.id),
        actor: getAdminActorLabel(req.admin),
        payload: {
          amount,
          reason,
          actor: buildAdminActorPayload(req.admin),
          before_snapshot: beforeSnapshot,
          after_snapshot: normalizeAccountSnapshot(updated.rows[0])
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(account.user_id)).emit('account_update', {
        message: `Admin balance adjustment applied: ${amount >= 0 ? '+' : ''}$${amount.toFixed(2)}`,
        pnl: amount,
        account_id: account.id,
        event: 'admin_balance_adjustment'
      })
    }

    await emitSuperAdminPowerEvent(req, {
      entity: 'account',
      entity_id: account.id,
      action: 'adjust_balance'
    })

    res.json({
      message: `Balance adjusted by ${amount >= 0 ? '+' : ''}$${amount.toFixed(2)}`,
      account: updated.rows[0]
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin balance adjustment error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not adjust balance' })
  } finally {
    client.release()
  }
})

router.post('/accounts/:accountId/override', authenticateAdmin, requireAdminCapability('account:override'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const accountId = String(req.params.accountId || '').trim()
    const action = String(req.body?.action || '').trim()
    const reason = requireReasonText(req.body?.reason)
    const extensionDays = parsePositiveInteger(req.body?.days, {
      fallback: action === 'extend_14_days' ? 14 : null,
      min: 1,
      max: 365
    })

    if (!accountId) return res.status(400).json({ error: 'Valid account id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })

    await client.query('BEGIN')
    const account = await fetchAccountForAdmin(client, accountId, { forUpdate: true })
    if (!account) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const beforeSnapshot = normalizeAccountSnapshot(account)
    const platformSettings = await getTenantSettings([
      'phase1_day_limit',
      'phase2_day_limit',
      'phase1_profit_target_pct',
      'phase2_profit_target_pct',
      'phase1_max_drawdown_pct',
      'phase2_max_drawdown_pct',
      'funded_max_drawdown_pct'
    ])
    let message = ''
    let promoted = null
    let replacementAccount = null
    let updatedAccount = null
    let closeResult = { closedCount: 0, totalPnl: 0 }
    let cancelledCount = 0

    if (action === 'pass' || action === 'promote') {
      if (!['phase1', 'phase2'].includes(account.account_type)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only challenge accounts can be promoted' })
      }
      if (account.status === 'passed') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'This account is already marked as passed' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Manual Promotion')

      await client.query(
        `UPDATE accounts
            SET status = 'passed',
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )

      const settings = await fetchProgressionSettings(client)
      promoted = await promotePassedAccount(client, account, settings)
      if (!promoted) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'No promotion path exists for this account' })
      }

      message = `Account passed manually. Closed ${closeResult.closedCount} open trades, cancelled ${cancelledCount} pending orders, and created the next account.`
    } else if (action === 'fail') {
      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Manual Breach')
      await client.query(
        `UPDATE accounts
            SET status = 'failed',
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )
      message = `Account breached manually. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
    } else if (action === 'extend_14_days' || action === 'extend_days') {
      if (!['phase1', 'phase2'].includes(account.account_type)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only challenge accounts can be extended' })
      }
      if (!extensionDays) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'A valid extension day count is required' })
      }
      await client.query(
        `UPDATE accounts
            SET phase_end_date = (
              CASE
                WHEN phase_end_date IS NULL OR phase_end_date < NOW() THEN NOW()
                ELSE phase_end_date
              END
            ) + ($2 * INTERVAL '1 day'),
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, extensionDays]
      )
      message = `Extended account by ${extensionDays} days.`
    } else if (action === 'revoke_funded') {
      if (account.account_type !== 'funded') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only funded accounts can be revoked' })
      }
      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Funding Revoked by Admin')
      await client.query(
        `UPDATE accounts
            SET status = 'locked',
                review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, reason || 'Funding revoked by admin']
      )
      message = `Funded account revoked. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
    } else if (action === 'force_close_open_trades') {
      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { source: 'admin_enforcement_force_close_open_trades' })
      message = `Force-closed ${closeResult.closedCount} open trades; total P&L ${closeResult.totalPnl >= 0 ? '+' : ''}$${closeResult.totalPnl.toFixed(2)}`
    } else if (action === 'restore_active') {
      if (!['failed', 'locked'].includes(String(account.status || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only failed or locked accounts can be restored to active' })
      }
      await client.query(
        `UPDATE accounts
            SET status = 'active',
                review_flagged = FALSE,
                review_flag_reason = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )
      message = 'Account restored to active status without resetting performance history.'
    } else if (action === 'restore_with_reset') {
      if (!['phase1', 'phase2'].includes(String(account.account_type || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only phase1 and phase2 accounts can be reset and restored' })
      }
      if (!['failed', 'locked', 'expired'].includes(String(account.status || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only failed, locked, or expired accounts can be reset and restored' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Restore With Reset')
      const phaseEndDate = computePhaseEndDateForAccountType(account.account_type, platformSettings)

      await client.query(
        `UPDATE accounts
            SET status = 'active',
                current_balance = starting_balance,
                peak_balance = starting_balance,
                phase_start_date = NOW(),
                phase_end_date = $2,
                review_flagged = FALSE,
                review_flag_reason = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, phaseEndDate]
      )
      message = `Account restored with reset. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
    } else if (action === 'replace_account') {
      if (['active', 'passed'].includes(String(account.status || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only closed, breached, expired, or locked accounts can be replaced' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Replace Account')
      replacementAccount = await createAdminIssuedAccount(client, {
        userId: account.user_id,
        accountType: account.account_type,
        accountSize: account.account_size,
        settings: platformSettings,
        overrides: {
          profit_target: account.profit_target,
          max_drawdown_pct: account.max_drawdown_pct
        }
      })
      message = `Replacement account created successfully as account #${replacementAccount.id}.`
    } else if (action === 'lock_account') {
      await client.query(
        `UPDATE accounts
            SET status = 'locked',
                review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, reason]
      )
      message = 'Account locked successfully.'
    } else if (action === 'clear_review_flag') {
      await client.query(
        `UPDATE accounts
            SET review_flagged = FALSE,
                review_flag_reason = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )
      message = 'Review flag cleared.'
    } else {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Unsupported action: ${action}` })
    }

    updatedAccount = await fetchAccountForAdmin(client, account.id, { forUpdate: false })

    try {
      await appendImmutableAudit(client, {
        eventType: 'admin_account_override',
        entityType: 'account',
        entityId: String(account.id),
        actor: getAdminActorLabel(req.admin),
        payload: {
          action,
          reason,
          actor: buildAdminActorPayload(req.admin),
          before_snapshot: beforeSnapshot,
          after_snapshot: normalizeAccountSnapshot(updatedAccount),
          closed_trades: closeResult.closedCount,
          cancelled_pending: cancelledCount,
          total_pnl: closeResult.totalPnl,
          promoted_to_account_id: promoted?.new_account_id || null,
          replacement_account_id: replacementAccount?.id || null,
          extension_days: extensionDays || null
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(account.user_id)).emit('account_update', {
        message,
        pnl: closeResult.totalPnl,
        account_id: account.id,
        new_account_id: replacementAccount?.id || promoted?.new_account_id || null,
        event: action === 'pass' || action === 'promote'
          ? (promoted?.event || 'admin_manual_promotion')
          : `admin_${action}`
      })
    }

    emitAdminEvent('admin_enforcement_event', {
      account_id: account.id,
      user_id: account.user_id,
      action,
      status: 'applied',
      message,
      payload_json: {
        closed_trades: closeResult.closedCount,
        cancelled_pending: cancelledCount,
        total_pnl: closeResult.totalPnl,
        replacement_account_id: replacementAccount?.id || null,
        promoted_to_account_id: promoted?.new_account_id || null
      }
    })

    await emitSuperAdminPowerEvent(req, {
      entity: 'account',
      entity_id: account.id,
      action,
      replacement_account_id: replacementAccount?.id || null,
      promoted_to_account_id: promoted?.new_account_id || null
    })

    res.json({
      message,
      closed_trades: closeResult.closedCount,
      cancelled_pending: cancelledCount,
      total_pnl: closeResult.totalPnl,
      new_account_id: replacementAccount?.id || promoted?.new_account_id || null,
      account: updatedAccount,
      allowed_actions: buildAllowedAccountActions(updatedAccount)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin account override error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not apply admin override' })
  } finally {
    client.release()
  }
})

router.get('/trades', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    const paging = parseListPaging(req)
    const direction = String(req.query?.direction || 'all').toLowerCase()
    const status = String(req.query?.status || 'all').toLowerCase()
    const search = String(req.query?.search || req.query?.q || '').trim()

    // Built separately from `statusCondition` so the Open/Pending/Closed stat-card
    // breakdown (below) can reflect the full picture under the active search+
    // direction filter, independent of which status tab happens to be selected.
    const searchDirectionConditions = []
    const searchDirectionValues = []
    let sdParamIndex = 1

    if (['buy', 'sell'].includes(direction)) {
      searchDirectionConditions.push(`t.direction = $${sdParamIndex}`)
      searchDirectionValues.push(direction)
      sdParamIndex++
    }
    if (search) {
      searchDirectionConditions.push(`(
        t.id::text ILIKE $${sdParamIndex} OR
        t.account_id::text ILIKE $${sdParamIndex} OR
        a.user_id::text ILIKE $${sdParamIndex} OR
        t.instrument ILIKE $${sdParamIndex}
      )`)
      searchDirectionValues.push(`%${search}%`)
      sdParamIndex++
    }

    const conditions = [...searchDirectionConditions]
    const values = [...searchDirectionValues]
    let paramIndex = sdParamIndex

    if (['open', 'pending', 'closed'].includes(status)) {
      conditions.push(`t.status = $${paramIndex}`)
      values.push(status)
      paramIndex++
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const searchDirectionWhereClause = searchDirectionConditions.length > 0 ? `WHERE ${searchDirectionConditions.join(' AND ')}` : ''

    const [countResult, breakdownResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id ${whereClause}`,
        values
      ),
      pool.query(
        `SELECT t.status, COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id ${searchDirectionWhereClause} GROUP BY t.status`,
        searchDirectionValues
      )
    ])
    const totalItems = parseInt(countResult.rows[0]?.count || 0, 10)
    const summary = { total: totalItems, open: 0, pending: 0, closed: 0 }
    for (const row of breakdownResult.rows) {
      if (row.status === 'open') summary.open = parseInt(row.count, 10)
      else if (row.status === 'pending') summary.pending = parseInt(row.count, 10)
      else summary.closed += parseInt(row.count, 10)
    }

    const limitParam = paramIndex
    const offsetParam = paramIndex + 1
    const result = await pool.query(
      `SELECT t.id,
              t.account_id,
              a.user_id,
              t.instrument AS symbol,
              UPPER(t.direction) AS type,
              t.lot_size AS lots,
              t.open_price,
              t.close_price,
              t.stop_loss AS sl,
              t.take_profit AS tp,
              t.status,
              t.demo_pnl,
              t.commission,
              p.bid,
              p.ask,
              t.open_time,
              t.close_time
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       ${whereClause}
       ORDER BY
         CASE WHEN t.status = 'open' THEN 0 WHEN t.status = 'pending' THEN 1 ELSE 2 END,
         COALESCE(t.close_time, t.open_time) DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...values, paging.pageSize, (paging.page - 1) * paging.pageSize]
    )

    const rows = result.rows.map(row => {
      let pnl = parseFloat(row.demo_pnl || 0)
      if (row.status === 'open') {
        const livePrice = row.type === 'BUY'
          ? parseFloat(row.bid || row.open_price || 0)
          : parseFloat(row.ask || row.open_price || 0)
        pnl = parseFloat((
          calcTradePnl(
            String(row.type || '').toLowerCase(),
            parseFloat(row.open_price || 0),
            livePrice,
            parseFloat(row.lots || 0),
            row.symbol
          ) - parseFloat(row.commission || 0)
        ).toFixed(2))
      }
      const r_multiple = ['closed', 'cancelled'].includes(row.status)
        ? computeRMultiple({ stop_loss: row.sl, open_price: row.open_price, lot_size: row.lots, demo_pnl: pnl, instrument: row.symbol })
        : null

      return {
        ...row,
        pnl,
        r_multiple
      }
    })

    res.json({
      rows,
      summary,
      pagination: buildPagination({ page: paging.page, pageSize: paging.pageSize, total: totalItems })
    })
  } catch (error) {
    logger.error('Admin trades fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trades' })
  }
})

router.post('/trades/:tradeId/close', authenticateAdmin, requireAdminCapability('trader:write:scoped'), async function(req, res) {
  const client = await pool.connect()
  try {
    const tradeId = String(req.params.tradeId || '').trim()
    if (!tradeId) return res.status(400).json({ error: 'Valid trade id is required' })

    await client.query('BEGIN')
    const closed = await forceCloseTradeById(client, tradeId, 'Admin Force Close')
    if (!closed) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    try {
      await appendImmutableAudit(client, {
        eventType: 'admin_trade_force_closed',
        entityType: 'trade',
        entityId: String(closed.trade_id),
        payload: {
          account_id: String(closed.account_id),
          instrument: closed.instrument,
          pnl: closed.pnl
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(closed.user_id)).emit('account_update', {
        message: `Admin force-closed ${closed.instrument}: ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`,
        pnl: closed.pnl,
        account_id: closed.account_id,
        event: 'admin_trade_force_closed'
      })
    }

    res.json({
      message: 'Trade force-closed successfully',
      pnl: closed.pnl,
      close_price: closed.close_price
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin trade force-close error:', { error: error.message })
    res.status(500).json({ error: 'Could not force close trade' })
  } finally {
    client.release()
  }
})

router.get('/payouts', authenticateAdmin, requireAdminCapability('payout:read:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureDisputesInfrastructure()
    const paging = parseListPaging(req)
    const listResult = await buildPayoutListResult({
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          status: req.query?.status || null,
          is_flagged: parseBooleanFilter(req.query?.is_flagged),
          dispute_linked: parseBooleanFilter(req.query?.dispute_linked),
          tags: parseCsvListParam(req.query?.tags || [])
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin payouts fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch payouts' })
  }
})

router.post('/payouts/approve', authenticateAdmin, requireAdminCapability('payout:review:scoped'), async function(req, res) {
  let client
  try {
    const { payout_id, transaction_id } = req.body

    client = await pool.connect()
    await client.query('BEGIN')

    // Fetch payout details and user email/name first
    const payoutData = await client.query(
      `SELECT p.amount_requested, p.amount_payable, p.payment_method, p.account_id, p.status,
              u.id::text AS user_id, u.email, u.full_name
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1
       FOR UPDATE`,
      [payout_id]
    )

    if (payoutData.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, amount_payable, payment_method, account_id, status, user_id, email, full_name } = payoutData.rows[0]
    if (status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Payout is not pending' })
    }

    const accountData = await client.query(
      `SELECT current_balance, starting_balance FROM accounts WHERE id = $1 FOR UPDATE`,
      [account_id]
    )
    if (accountData.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const availableProfit = new Decimal(accountData.rows[0].current_balance).minus(accountData.rows[0].starting_balance)
    if (availableProfit.lt(amount_requested)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Insufficient realized profit for payout' })
    }

    await client.query(
      `UPDATE accounts SET current_balance = current_balance - $1 WHERE id = $2`,
      [amount_requested, account_id]
    )

    await client.query(
      `UPDATE payouts SET
       status = 'paid',
       paid_at = NOW(),
       transaction_id = $1
       WHERE id = $2`,
      [transaction_id, payout_id]
    )

    await client.query('COMMIT')

    // Send automated email to the user
    await enqueuePayoutApprovedEmail(email, full_name, amount_payable, payment_method, {
      userId: user_id || null
    })

    res.json({ message: 'Payout marked as paid and user notified' })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not mark payout as paid:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
  } finally {
    if (client) client.release()
  }
})

router.post('/payouts/reject', authenticateAdmin, requireAdminCapability('payout:review:scoped'), async function(req, res) {
  try {
    const { payout_id, reason } = req.body

    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    // Fetch payout details and user email/name
    const payoutData = await pool.query(
      `SELECT p.amount_requested, u.id::text AS user_id, u.email, u.full_name
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`,
      [payout_id]
    )

    if (payoutData.rows.length === 0) {
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, user_id, email, full_name } = payoutData.rows[0]

    await pool.query(
      `UPDATE payouts SET
       status = 'rejected',
       updated_at = NOW(),
       admin_notes = $1
       WHERE id = $2`,
      [reason || 'Rejected by admin', payout_id]
    )

    // Send automated email to the user
    await enqueuePayoutRejectedEmail(email, full_name, amount_requested, reason, {
      userId: user_id || null
    })

    res.json({ message: 'Payout rejected and user notified' })
  } catch (error) {
    logger.error('Could not reject payout:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
  }
})

router.post('/payouts/:payoutId/flag', authenticateAdmin, requireAdminCapability('payout:flag'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const payoutId = parseInt(req.params.payoutId, 10)
    const reason = requireReasonText(req.body?.reason, 'flag reason')

    if (!Number.isFinite(payoutId) || payoutId <= 0) {
      return res.status(400).json({ error: 'Valid payout id is required' })
    }

    await client.query('BEGIN')
    const payout = await fetchPayoutForAdmin(client, payoutId, { forUpdate: true })
    if (!payout) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const beforeSnapshot = normalizePayoutSnapshot(payout)
    const updatedResult = await client.query(
      `UPDATE payouts
          SET is_flagged = TRUE,
              flag_reason = $2,
              admin_notes = COALESCE(NULLIF(admin_notes, ''), '') ||
                CASE WHEN COALESCE(NULLIF(admin_notes, ''), '') = '' THEN '' ELSE E'\n' END ||
                $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, user_id, account_id, amount_requested, amount_payable,
                  status, is_flagged, flag_reason, admin_notes`,
      [payoutId, reason, `[FLAGGED ${new Date().toISOString()}] ${reason}`]
    )
    const updatedPayout = updatedResult.rows[0]

    await appendImmutableAudit(client, {
      eventType: 'admin_payout_flagged',
      entityType: 'payout',
      entityId: String(payoutId),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizePayoutSnapshot(updatedPayout)
      }
    })

    await client.query('COMMIT')
    await emitSuperAdminPowerEvent(req, {
      entity: 'payout',
      entity_id: payoutId,
      action: 'flag_payout'
    })

    res.json({
      message: 'Payout flagged for review',
      payout: updatedPayout,
      allowed_actions: buildAllowedPayoutActions(updatedPayout)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not flag payout:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not flag payout' })
  } finally {
    client.release()
  }
})

router.post('/payouts/:payoutId/unflag', authenticateAdmin, requireAdminCapability('payout:flag'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const payoutId = parseInt(req.params.payoutId, 10)
    const reason = requireReasonText(req.body?.reason, 'unflag reason')

    if (!Number.isFinite(payoutId) || payoutId <= 0) {
      return res.status(400).json({ error: 'Valid payout id is required' })
    }

    await client.query('BEGIN')
    const payout = await fetchPayoutForAdmin(client, payoutId, { forUpdate: true })
    if (!payout) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const beforeSnapshot = normalizePayoutSnapshot(payout)
    const updatedResult = await client.query(
      `UPDATE payouts
          SET is_flagged = FALSE,
              flag_reason = NULL,
              admin_notes = COALESCE(NULLIF(admin_notes, ''), '') ||
                CASE WHEN COALESCE(NULLIF(admin_notes, ''), '') = '' THEN '' ELSE E'\n' END ||
                $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, user_id, account_id, amount_requested, amount_payable,
                  status, is_flagged, flag_reason, admin_notes`,
      [payoutId, `[UNFLAGGED ${new Date().toISOString()}] ${reason}`]
    )
    const updatedPayout = updatedResult.rows[0]

    await appendImmutableAudit(client, {
      eventType: 'admin_payout_unflagged',
      entityType: 'payout',
      entityId: String(payoutId),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizePayoutSnapshot(updatedPayout)
      }
    })

    await client.query('COMMIT')
    await emitSuperAdminPowerEvent(req, {
      entity: 'payout',
      entity_id: payoutId,
      action: 'unflag_payout'
    })

    res.json({
      message: 'Payout unflagged successfully',
      payout: updatedPayout,
      allowed_actions: buildAllowedPayoutActions(updatedPayout)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not unflag payout:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not unflag payout' })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/risk-scores', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H2): Replaced RANDOM() with real calculations:
    //   - win_rate_pct: actual wins / closed trades
    //   - avg_hold_seconds: real avg from open_time/close_time
    //   - total_trades: real count, flagged_payouts: real count
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.full_name,
        u.email,
        a.id AS account_id,
        a.account_type,
        a.status AS account_status,
        a.review_flagged,
        COUNT(t.id) FILTER (WHERE t.status = 'closed')                             AS total_trades,
        COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)          AS winning_trades,
        CASE
          WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') = 0 THEN 0
          ELSE ROUND(
            COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
            / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
          )
        END AS win_rate_pct,
        COALESCE(ROUND(
          AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
          FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
        , 0), 0) AS avg_hold_seconds,
        COUNT(p.id) FILTER (WHERE p.is_flagged = true)                              AS flagged_payouts,
        COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)             AS total_pnl,
        -- Computed risk_score 0-100: higher score = more suspicious trader
        LEAST(100, (
          20
          + CASE
              WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
               AND ROUND(
                    COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
                    / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
                  ) > 70
              THEN 40 ELSE 0
            END
          + CASE
              WHEN COALESCE(ROUND(
                  AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
                  FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
              , 0), 9999) < 300
               AND COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
              THEN 20 ELSE 0
            END
          + CASE WHEN COUNT(p.id) FILTER (WHERE p.is_flagged = true) > 0 THEN 20 ELSE 0 END
          + CASE WHEN a.review_flagged THEN 20 ELSE 0 END
        )) AS risk_score
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      LEFT JOIN trades t ON t.account_id = a.id
      LEFT JOIN payouts p ON p.user_id = u.id
      WHERE a.status IN ('active', 'funded')
      GROUP BY u.id, u.full_name, u.email, a.id, a.account_type, a.status, a.review_flagged
      ORDER BY risk_score DESC, total_trades DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error('Risk scores error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

router.get('/account-health', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.id::text AS account_id,
        COALESCE(a.account_uid::text, a.id::text) AS account_uid,
        a.account_type,
        a.status AS account_status,
        COALESCE(a.account_size, 0)::numeric AS account_size,
        COALESCE(a.current_balance, 0)::numeric AS current_balance,
        COALESCE(a.peak_balance, 0)::numeric AS peak_balance,
        COALESCE(a.review_flagged, false) AS review_flagged,
        a.created_at,
        u.id::text AS user_id,
        u.full_name,
        u.email,
        COALESCE(u.kyc_status, 'pending') AS kyc_status,
        COALESCE(u.is_banned, false) AS is_banned,
        COALESCE(ts.closed_trades, 0)::int AS closed_trades,
        COALESCE(ts.winning_trades, 0)::int AS winning_trades,
        COALESCE(ts.win_rate_pct, 0)::numeric AS win_rate_pct,
        COALESCE(ts.avg_hold_seconds, 0)::numeric AS avg_hold_seconds,
        COALESCE(ts.total_pnl, 0)::numeric AS total_pnl,
        COALESCE(ps.flagged_payouts, 0)::int AS flagged_payouts,
        COALESCE(ds.open_disputes, 0)::int AS open_disputes
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN (
        SELECT
          t.account_id,
          COUNT(*) FILTER (WHERE t.status = 'closed')::int AS closed_trades,
          COUNT(*) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::int AS winning_trades,
          CASE
            WHEN COUNT(*) FILTER (WHERE t.status = 'closed') = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric)
              / NULLIF(COUNT(*) FILTER (WHERE t.status = 'closed'), 0) * 100, 2
            )
          END AS win_rate_pct,
          COALESCE(ROUND(
            AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
            FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL), 0
          ), 0) AS avg_hold_seconds,
          COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0) AS total_pnl
        FROM trades t
        GROUP BY t.account_id
      ) ts ON ts.account_id = a.id
      LEFT JOIN (
        SELECT p.account_id, COUNT(*) FILTER (WHERE p.is_flagged = true)::int AS flagged_payouts
        FROM payouts p
        GROUP BY p.account_id
      ) ps ON ps.account_id = a.id
      LEFT JOIN (
        SELECT d.account_id::text AS account_id, COUNT(*) FILTER (WHERE d.status IN ('open', 'under_review'))::int AS open_disputes
        FROM disputes d
        GROUP BY d.account_id::text
      ) ds ON ds.account_id = a.id::text
      WHERE a.status IN ('active', 'funded', 'locked')
      ORDER BY a.created_at DESC
      LIMIT 500
    `)

    const rows = result.rows.map(r => {
      const accountSize = parseFloat(r.account_size || 0)
      const currentBalance = parseFloat(r.current_balance || 0)
      const totalPnl = parseFloat(r.total_pnl || 0)
      const closedTrades = parseInt(r.closed_trades || 0, 10)
      const winRate = parseFloat(r.win_rate_pct || 0)
      const avgHoldSec = parseFloat(r.avg_hold_seconds || 0)
      const flaggedPayouts = parseInt(r.flagged_payouts || 0, 10)
      const openDisputes = parseInt(r.open_disputes || 0, 10)
      const accountAgeDays = r.created_at
        ? Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000))
        : 0

      let penalties = 0
      const reasons = []
      if (r.is_banned) { penalties += 70; reasons.push('User is banned') }
      if (r.account_status === 'locked') { penalties += 40; reasons.push('Account is locked') }
      if (r.review_flagged) { penalties += 25; reasons.push('Account flagged for manual review') }
      if (String(r.kyc_status) !== 'approved') { penalties += 15; reasons.push('KYC not approved') }
      if (flaggedPayouts > 0) { penalties += Math.min(30, flaggedPayouts * 10); reasons.push(`Flagged payouts: ${flaggedPayouts}`) }
      if (openDisputes > 0) { penalties += Math.min(25, openDisputes * 8); reasons.push(`Open disputes: ${openDisputes}`) }
      if (closedTrades >= 20 && winRate >= 75 && avgHoldSec > 0 && avgHoldSec < 180) {
        penalties += 15
        reasons.push('Unusually high win rate with very short holds')
      }
      if (accountSize > 0 && totalPnl <= -(accountSize * 0.12)) {
        penalties += 12
        reasons.push('Deep realized loss vs account size')
      }
      if (accountAgeDays <= 7 && closedTrades >= 40) {
        penalties += 10
        reasons.push('High activity on very new account')
      }

      const healthScore = Math.max(0, Math.min(100, 100 - penalties))
      const healthBand = healthScore >= 75 ? 'healthy' : healthScore >= 45 ? 'watch' : 'critical'
      return {
        ...r,
        account_size: accountSize,
        current_balance: currentBalance,
        total_pnl: parseFloat(totalPnl.toFixed(2)),
        closed_trades: closedTrades,
        win_rate_pct: parseFloat(winRate.toFixed(2)),
        avg_hold_seconds: parseFloat(avgHoldSec.toFixed(0)),
        flagged_payouts: flaggedPayouts,
        open_disputes: openDisputes,
        account_age_days: accountAgeDays,
        health_score: healthScore,
        health_band: healthBand,
        reasons
      }
    })

    const summary = {
      total: rows.length,
      healthy: rows.filter(r => r.health_band === 'healthy').length,
      watch: rows.filter(r => r.health_band === 'watch').length,
      critical: rows.filter(r => r.health_band === 'critical').length,
      avg_health_score: rows.length > 0
        ? parseFloat((rows.reduce((sum, r) => sum + r.health_score, 0) / rows.length).toFixed(2))
        : 0
    }

    rows.sort((a, b) => a.health_score - b.health_score)
    res.json({ generated_at: new Date(), summary, rows })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account health scores' })
  }
})

router.get('/command-center/accounts', authenticateAdmin, requireAdminCapability('command_center:read'), async (req, res) => {
  try {
    await ensureFeatureTables()
    const conditions = []
    const values = []

    if (req.query.status) {
      values.push(String(req.query.status).trim().toLowerCase())
      conditions.push(`LOWER(a.status) = $${values.length}`)
    }
    if (req.query.account_type) {
      values.push(String(req.query.account_type).trim().toLowerCase())
      conditions.push(`LOWER(a.account_type) = $${values.length}`)
    }
    const reviewFlagged = parseBooleanFilter(req.query.review_flagged)
    if (reviewFlagged !== null) {
      values.push(reviewFlagged)
      conditions.push(`COALESCE(a.review_flagged, FALSE) = $${values.length}`)
    }
    if (req.query.created_from) {
      values.push(String(req.query.created_from))
      conditions.push(`a.created_at >= $${values.length}::timestamptz`)
    }
    if (req.query.created_to) {
      values.push(String(req.query.created_to))
      conditions.push(`a.created_at < ($${values.length}::timestamptz + INTERVAL '1 day')`)
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`)
      conditions.push(`(
        LOWER(COALESCE(u.email, '')) LIKE $${values.length}
        OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
        OR LOWER(COALESCE(a.account_uid, '')) LIKE $${values.length}
        OR CAST(a.id AS TEXT) LIKE $${values.length}
      )`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = parsePositiveInteger(req.query.limit, { fallback: 200, min: 1, max: 500 })
    values.push(limit)

    const result = await pool.query(
      `SELECT a.id, a.user_id, a.account_type, a.account_size, a.status,
              a.current_balance, a.starting_balance, a.peak_balance, a.profit_target,
              a.max_drawdown_pct, a.phase_start_date, a.phase_end_date, a.account_uid,
              COALESCE(a.review_flagged, FALSE) AS review_flagged,
              a.review_flag_reason, a.created_at,
              u.email, u.full_name, COALESCE(u.is_banned, FALSE) AS is_banned,
              COALESCE((
                SELECT COUNT(*) FROM trades t WHERE t.account_id = a.id AND t.status = 'open'
              ), 0)::int AS open_trade_count
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY
         CASE
           WHEN a.status = 'locked' THEN 0
           WHEN a.status = 'failed' THEN 1
           WHEN a.status = 'expired' THEN 2
           WHEN COALESCE(a.review_flagged, FALSE) = TRUE THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $${values.length}`,
      values
    )

    const rows = result.rows.map((row) => ({
      ...row,
      allowed_actions: buildAllowedAccountActions(row)
    }))

    res.json({
      summary: {
        total: rows.length,
        failed: rows.filter((row) => row.status === 'failed').length,
        locked: rows.filter((row) => row.status === 'locked').length,
        review_flagged: rows.filter((row) => row.review_flagged).length
      },
      rows
    })
  } catch (error) {
    logger.error('Command center accounts error:', { error: error.message })
    res.status(500).json({ error: 'Failed to load account recovery queue' })
  }
})

router.get('/command-center/users', authenticateAdmin, requireAdminCapability('command_center:read'), async (req, res) => {
  try {
    await ensureFeatureTables()
    const conditions = []
    const values = []

    const bannedFilter = parseBooleanFilter(req.query.is_banned)
    if (bannedFilter !== null) {
      values.push(bannedFilter)
      conditions.push(`COALESCE(u.is_banned, FALSE) = $${values.length}`)
    }
    if (req.query.kyc_status) {
      values.push(String(req.query.kyc_status).trim().toLowerCase())
      conditions.push(`LOWER(COALESCE(u.kyc_status, 'pending')) = $${values.length}`)
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`)
      conditions.push(`(
        LOWER(COALESCE(u.email, '')) LIKE $${values.length}
        OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
        OR CAST(u.id AS TEXT) LIKE $${values.length}
      )`)
    }

    const hasActiveAccounts = parseBooleanFilter(req.query.has_active_accounts)
    if (hasActiveAccounts !== null) {
      conditions.push(hasActiveAccounts
        ? `EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'active')`
        : `NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'active')`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = parsePositiveInteger(req.query.limit, { fallback: 200, min: 1, max: 500 })
    values.push(limit)

    const result = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.country, u.phone,
              COALESCE(u.kyc_status, 'pending') AS kyc_status,
              COALESCE(u.is_banned, FALSE) AS is_banned,
              u.created_at, COALESCE(u.token_version, 1) AS token_version,
              COALESCE((
                SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id
              ), 0)::int AS account_count,
              COALESCE((
                SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id AND a.status = 'active'
              ), 0)::int AS active_account_count
       FROM users u
       ${where}
       ORDER BY
         CASE WHEN COALESCE(u.is_banned, FALSE) = TRUE THEN 0 ELSE 1 END,
         u.created_at DESC
       LIMIT $${values.length}`,
      values
    )

    const rows = result.rows.map((row) => ({
      ...row,
      allowed_actions: buildAllowedUserActions(row)
    }))

    res.json({
      summary: {
        total: rows.length,
        banned: rows.filter((row) => row.is_banned).length,
        pending_kyc: rows.filter((row) => row.kyc_status === 'pending').length,
        with_active_accounts: rows.filter((row) => row.active_account_count > 0).length
      },
      rows
    })
  } catch (error) {
    logger.error('Command center users error:', { error: error.message })
    res.status(500).json({ error: 'Failed to load trader control queue' })
  }
})

router.get('/command-center/money-risk', authenticateAdmin, requireAdminCapability('command_center:read'), async (req, res) => {
  try {
    await ensureFeatureTables()
    await ensureViolationTables()
    await ensureDisputesInfrastructure()

    const conditions = []
    const values = []

    if (req.query.payout_status) {
      values.push(String(req.query.payout_status).trim().toLowerCase())
      conditions.push(`LOWER(p.status) = $${values.length}`)
    }
    const flaggedFilter = parseBooleanFilter(req.query.is_flagged)
    if (flaggedFilter !== null) {
      values.push(flaggedFilter)
      conditions.push(`COALESCE(p.is_flagged, FALSE) = $${values.length}`)
    }
    const openDisputesFilter = parseBooleanFilter(req.query.open_disputes)
    if (openDisputesFilter !== null) {
      conditions.push(openDisputesFilter
        ? `COALESCE(ds.open_disputes_count, 0) > 0`
        : `COALESCE(ds.open_disputes_count, 0) = 0`)
    }
    const criticalViolationsFilter = parseBooleanFilter(req.query.critical_violations)
    if (criticalViolationsFilter !== null) {
      conditions.push(criticalViolationsFilter
        ? `COALESCE(vs.critical_violations_count, 0) > 0`
        : `COALESCE(vs.critical_violations_count, 0) = 0`)
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`)
      conditions.push(`(
        LOWER(COALESCE(u.email, '')) LIKE $${values.length}
        OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
        OR CAST(p.id AS TEXT) LIKE $${values.length}
        OR CAST(p.account_id AS TEXT) LIKE $${values.length}
      )`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = parsePositiveInteger(req.query.limit, { fallback: 200, min: 1, max: 500 })
    values.push(limit)

    const result = await pool.query(
      `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.amount_payable,
              p.status, COALESCE(p.is_flagged, FALSE) AS is_flagged, p.flag_reason, p.admin_notes,
              p.requested_at, u.email, u.full_name,
              COALESCE(ds.open_disputes_count, 0)::int AS open_disputes_count,
              ds.latest_dispute_id AS dispute_id,
              COALESCE(vs.critical_violations_count, 0)::int AS critical_violations_count,
              vs.latest_violation_id
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN (
         SELECT d.account_id::text AS account_id,
                COUNT(*) FILTER (WHERE d.status IN ('open', 'under_review'))::int AS open_disputes_count,
                MAX(d.id) FILTER (WHERE d.status IN ('open', 'under_review')) AS latest_dispute_id
         FROM disputes d
         GROUP BY d.account_id::text
       ) ds ON ds.account_id = p.account_id::text
       LEFT JOIN (
         SELECT v.account_id::text AS account_id,
                COUNT(*) FILTER (WHERE v.status = 'open' AND v.severity = 'critical')::int AS critical_violations_count,
                MAX(v.id) FILTER (WHERE v.status = 'open') AS latest_violation_id
         FROM admin_rule_violations v
         GROUP BY v.account_id::text
       ) vs ON vs.account_id = p.account_id::text
       ${where}
       ORDER BY
         CASE
           WHEN COALESCE(p.is_flagged, FALSE) = TRUE THEN 0
           WHEN COALESCE(vs.critical_violations_count, 0) > 0 THEN 1
           WHEN COALESCE(ds.open_disputes_count, 0) > 0 THEN 2
           ELSE 3
         END,
         p.requested_at DESC
       LIMIT $${values.length}`,
      values
    )

    const rows = result.rows.map((row) => {
      const allowedActions = buildAllowedPayoutActions(row)
      if (row.latest_violation_id && row.critical_violations_count > 0) {
        allowedActions.push('waive_violation')
      }
      return {
        ...row,
        allowed_actions: [...new Set(allowedActions)]
      }
    })

    res.json({
      summary: {
        total: rows.length,
        pending: rows.filter((row) => row.status === 'pending').length,
        flagged: rows.filter((row) => row.is_flagged).length,
        with_open_disputes: rows.filter((row) => row.open_disputes_count > 0).length,
        with_critical_violations: rows.filter((row) => row.critical_violations_count > 0).length
      },
      rows
    })
  } catch (error) {
    logger.error('Command center money-risk error:', { error: error.message })
    res.status(500).json({ error: 'Failed to load money and risk queue' })
  }
})

router.post('/command-center/bulk-action', authenticateAdmin, requireAdminCapability('command_center:bulk'), async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    await ensureViolationTables()
    await ensureDisputesInfrastructure()

    const entity = String(req.body?.entity || '').trim().toLowerCase()
    const action = String(req.body?.action || '').trim().toLowerCase()
    const reason = requireReasonText(req.body?.reason)
    const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {}
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map((value) => String(value || '').trim()).filter(Boolean))]
      : []

    if (!['account', 'user', 'payout', 'violation'].includes(entity)) {
      return res.status(400).json({ error: 'entity must be account, user, payout, or violation' })
    }
    if (!action) {
      return res.status(400).json({ error: 'action is required' })
    }
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ error: 'ids must contain between 1 and 100 items' })
    }

    const results = []

    for (const rawId of ids) {
      let postCommitInvalidateUserId = null

      try {
        await client.query('BEGIN')

        if (entity === 'account') {
          const account = await fetchAccountForAdmin(client, rawId, { forUpdate: true })
          if (!account) throw createHttpError('Account not found', 404)

          const beforeSnapshot = normalizeAccountSnapshot(account)
          const platformSettings = await getTenantSettings([
            'phase1_day_limit',
            'phase2_day_limit',
            'phase1_profit_target_pct',
            'phase2_profit_target_pct',
            'phase1_max_drawdown_pct',
            'phase2_max_drawdown_pct',
            'funded_max_drawdown_pct'
          ])
          let closeResult = { closedCount: 0, totalPnl: 0 }
          let cancelledCount = 0
          let linkedAccountId = null
          let message = ''

          if (action === 'restore_active') {
            if (!['failed', 'locked'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only failed or locked accounts can be restored to active', 400)
            }
            await client.query(
              `UPDATE accounts
                  SET status = 'active',
                      review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id]
            )
            message = 'Account restored to active'
          } else if (action === 'restore_with_reset') {
            if (!['phase1', 'phase2'].includes(String(account.account_type || '').toLowerCase())) {
              throw createHttpError('Only phase1 and phase2 accounts can be reset and restored', 400)
            }
            if (!['failed', 'locked', 'expired'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only failed, locked, or expired accounts can be reset and restored', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Bulk Restore With Reset')
            await client.query(
              `UPDATE accounts
                  SET status = 'active',
                      current_balance = starting_balance,
                      peak_balance = starting_balance,
                      phase_start_date = NOW(),
                      phase_end_date = $2,
                      review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, computePhaseEndDateForAccountType(account.account_type, platformSettings)]
            )
            message = 'Account restored with reset'
          } else if (action === 'replace_account') {
            if (['active', 'passed'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only non-active accounts can be replaced', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Bulk Replace Account')
            const replacement = await createAdminIssuedAccount(client, {
              userId: account.user_id,
              accountType: account.account_type,
              accountSize: account.account_size,
              settings: platformSettings,
              overrides: {
                profit_target: account.profit_target,
                max_drawdown_pct: account.max_drawdown_pct
              }
            })
            linkedAccountId = replacement.id
            message = `Replacement account created (#${replacement.id})`
          } else if (action === 'lock_account') {
            await client.query(
              `UPDATE accounts
                  SET status = 'locked',
                      review_flagged = TRUE,
                      review_flag_reason = $2,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, reason]
            )
            message = 'Account locked'
          } else if (action === 'clear_review_flag') {
            await client.query(
              `UPDATE accounts
                  SET review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id]
            )
            message = 'Review flag cleared'
          } else if (action === 'extend_days') {
            const extensionDays = parsePositiveInteger(options?.days, { fallback: null, min: 1, max: 365 })
            if (!extensionDays) throw createHttpError('options.days must be provided for extend_days', 400)
            await client.query(
              `UPDATE accounts
                  SET phase_end_date = (
                    CASE
                      WHEN phase_end_date IS NULL OR phase_end_date < NOW() THEN NOW()
                      ELSE phase_end_date
                    END
                  ) + ($2 * INTERVAL '1 day'),
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, extensionDays]
            )
            message = `Extended account by ${extensionDays} days`
          } else if (action === 'force_close_open_trades') {
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            message = `Force-closed ${closeResult.closedCount} open trades`
          } else if (action === 'revoke_funded') {
            if (account.account_type !== 'funded') {
              throw createHttpError('Only funded accounts can be revoked', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Funding Revoked by Admin (Bulk)')
            await client.query(
              `UPDATE accounts
                  SET status = 'locked',
                      review_flagged = TRUE,
                      review_flag_reason = $2,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, reason || 'Funding revoked by admin']
            )
            message = `Funded account revoked. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
          } else {
            throw createHttpError(`Unsupported bulk account action: ${action}`, 400)
          }

          const afterAccount = await fetchAccountForAdmin(client, rawId)
          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'account',
            entityId: String(rawId),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeAccountSnapshot(afterAccount),
              closed_trades: closeResult.closedCount,
              cancelled_pending: cancelledCount,
              total_pnl: closeResult.totalPnl,
              linked_account_id: linkedAccountId
            }
          })

          await client.query('COMMIT')
          emitAdminEvent('admin_enforcement_event', {
            account_id: account.id,
            user_id: account.user_id,
            action,
            status: 'applied',
            message
          })
          await emitSuperAdminPowerEvent(req, {
            entity,
            entity_id: account.id,
            action,
            linked_account_id: linkedAccountId
          })

          results.push({
            id: rawId,
            success: true,
            message,
            new_account_id: linkedAccountId || null
          })
        } else if (entity === 'user') {
          const user = await fetchUserForAdmin(client, rawId, { forUpdate: true })
          if (!user) throw createHttpError('User not found', 404)

          const beforeSnapshot = normalizeUserSnapshot(user)
          let message = ''
          let createdAccount = null
          let updatedUser = user

          if (action === 'ban') {
            const result = await client.query(
              `UPDATE users SET is_banned = TRUE WHERE id = $1
               RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'Trader banned'
          } else if (action === 'unban') {
            const result = await client.query(
              `UPDATE users SET is_banned = FALSE WHERE id = $1
               RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'Trader unbanned'
          } else if (action === 'revoke_sessions') {
            const result = await client.query(
              `UPDATE users
                  SET token_version = COALESCE(token_version, 1) + 1
                WHERE id = $1
                RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            postCommitInvalidateUserId = user.id
            message = 'Trader sessions revoked'
          } else if (action === 'approve_kyc') {
            const result = await client.query(
              `UPDATE users
                  SET kyc_status = 'approved',
                      kyc_rejection_reason = NULL
                WHERE id = $1
                RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'KYC approved'
          } else if (action === 'reject_kyc') {
            const result = await client.query(
              `UPDATE users
                  SET kyc_status = 'rejected',
                      kyc_rejection_reason = $2
                WHERE id = $1
                RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id, reason]
            )
            updatedUser = result.rows[0]
            message = 'KYC rejected'
          } else if (action === 'manual_account') {
            const accountType = String(options?.account_type || 'phase1').trim().toLowerCase()
            const accountSize = parseInt(options?.account_size, 10)
            if (!['phase1', 'phase2', 'phase3', 'funded'].includes(accountType)) {
              throw createHttpError('options.account_type must be phase1, phase2, phase3, or funded', 400)
            }
            if (!Number.isFinite(accountSize) || !ADMIN_VALID_ACCOUNT_SIZES.includes(accountSize)) {
              throw createHttpError(`options.account_size must be one of: ${ADMIN_VALID_ACCOUNT_SIZES.join(', ')}`, 400)
            }
            const settings = await getTenantSettings([
              'phase1_day_limit',
              'phase2_day_limit',
              'phase1_profit_target_pct',
              'phase2_profit_target_pct',
              'phase1_max_drawdown_pct',
              'phase2_max_drawdown_pct',
              'funded_max_drawdown_pct'
            ])
            createdAccount = await createAdminIssuedAccount(client, {
              userId: user.id,
              accountType,
              accountSize,
              settings
            })
            message = `Manual ${accountType} account issued`
          } else {
            throw createHttpError(`Unsupported bulk user action: ${action}`, 400)
          }

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'user',
            entityId: String(user.id),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeUserSnapshot(updatedUser),
              linked_account_id: createdAccount?.id || null
            }
          })

          await client.query('COMMIT')

          if (postCommitInvalidateUserId) {
            await invalidateAllUserTokens(postCommitInvalidateUserId)
          }
          await emitSuperAdminPowerEvent(req, {
            entity,
            entity_id: user.id,
            action,
            linked_account_id: createdAccount?.id || null
          })

          results.push({
            id: rawId,
            success: true,
            message,
            new_account_id: createdAccount?.id || null
          })
        } else if (entity === 'payout') {
          const payout = await fetchPayoutForAdmin(client, rawId, { forUpdate: true })
          if (!payout) throw createHttpError('Payout not found', 404)

          const beforeSnapshot = normalizePayoutSnapshot(payout)
          let updatedPayout = payout
          let message = ''

          if (action === 'flag_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET is_flagged = TRUE,
                      flag_reason = $2,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, reason]
            )
            updatedPayout = result.rows[0]
            message = 'Payout flagged'
          } else if (action === 'unflag_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET is_flagged = FALSE,
                      flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id]
            )
            updatedPayout = result.rows[0]
            message = 'Payout unflagged'
          } else if (action === 'approve_payout') {
            if (String(payout.status || '').toLowerCase() !== 'pending') {
              throw createHttpError('Only pending payouts can be approved', 400)
            }
            const accountBalance = await client.query(
              `SELECT current_balance, starting_balance FROM accounts WHERE id = $1 FOR UPDATE`,
              [payout.account_id]
            )
            if (accountBalance.rows.length === 0) throw createHttpError('Account not found for payout', 404)
            const availableProfit = new Decimal(accountBalance.rows[0].current_balance).minus(accountBalance.rows[0].starting_balance)
            if (availableProfit.lt(payout.amount_requested)) {
              throw createHttpError('Insufficient realized profit for payout', 400)
            }
            await client.query(
              `UPDATE accounts SET current_balance = current_balance - $1 WHERE id = $2`,
              [payout.amount_requested, payout.account_id]
            )
            const result = await client.query(
              `UPDATE payouts
                  SET status = 'paid',
                      paid_at = NOW(),
                      transaction_id = COALESCE($2, transaction_id),
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, options?.transaction_id ? String(options.transaction_id) : null]
            )
            updatedPayout = result.rows[0]
            message = 'Payout approved'
          } else if (action === 'reject_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET status = 'rejected',
                      admin_notes = $2,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, reason]
            )
            updatedPayout = result.rows[0]
            message = 'Payout rejected'
          } else {
            throw createHttpError(`Unsupported bulk payout action: ${action}`, 400)
          }

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'payout',
            entityId: String(payout.id),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizePayoutSnapshot(updatedPayout)
            }
          })

          await client.query('COMMIT')
          await emitSuperAdminPowerEvent(req, {
            entity,
            entity_id: payout.id,
            action
          })

          results.push({
            id: rawId,
            success: true,
            message
          })
        } else if (entity === 'violation') {
          const violationId = parseInt(rawId, 10)
          if (!Number.isFinite(violationId) || violationId <= 0) {
            throw createHttpError('Invalid violation id', 400)
          }

          const violationResult = await client.query(
            `SELECT *
               FROM admin_rule_violations
              WHERE id = $1
              FOR UPDATE`,
            [violationId]
          )
          if (violationResult.rows.length === 0) throw createHttpError('Violation not found', 404)

          const violation = violationResult.rows[0]
          const beforeSnapshot = normalizeViolationSnapshot(violation)
          const resolutionType = action === 'waive_violation'
            ? 'waived'
            : action === 'false_positive'
              ? 'false_positive'
              : action === 'resolve_violation'
                ? 'resolved'
                : null

          if (!resolutionType) {
            throw createHttpError(`Unsupported bulk violation action: ${action}`, 400)
          }

          const updateResult = await client.query(
            `UPDATE admin_rule_violations
                SET status = 'resolved',
                    resolved_at = NOW(),
                    resolution_note = $2,
                    resolution_type = $3,
                    payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
                      'resolution_type', $3,
                      'resolved_by_role', $4
                    )
              WHERE id = $1
              RETURNING *`,
            [violationId, reason, resolutionType, req.admin?.role || 'admin']
          )
          const updatedViolation = updateResult.rows[0]

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'violation',
            entityId: String(violationId),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeViolationSnapshot(updatedViolation)
            }
          })

          await client.query('COMMIT')
          emitAdminEvent('admin_violation_updated', updatedViolation)

          results.push({
            id: rawId,
            success: true,
            message: `Violation marked ${resolutionType.replace(/_/g, ' ')}`
          })
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        results.push({
          id: rawId,
          success: false,
          error: error.statusCode ? error.message : 'Bulk action failed'
        })
      }
    }

    res.json({
      entity,
      action,
      total: ids.length,
      succeeded: results.filter((row) => row.success).length,
      failed: results.filter((row) => !row.success).length,
      results
    })
  } catch (error) {
    logger.error('Command center bulk action error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to run bulk action' })
  } finally {
    client.release()
  }
})

router.get('/suspicious-accounts', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real DB query — returns genuinely flagged/banned accounts
    const result = await pool.query(`
      SELECT
        a.id, a.user_id, a.account_type, a.account_size, a.status,
        a.review_flagged, a.review_flag_reason, a.created_at,
        u.email, u.full_name, u.is_banned
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE (a.review_flagged = true OR u.is_banned = true)
      ORDER BY a.created_at DESC
      LIMIT 500
    `);
    res.json({
      total_flags: result.rows.filter(r => r.review_flagged).length,
      flagged: result.rows
    });
  } catch (err) {
    logger.error('Suspicious accounts error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load suspicious accounts' });
  }
});

router.get('/audit-log', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table
    await ensureFeatureTables()
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000)
    const offset = parseInt(req.query.offset || '0', 10)

    const conditions = []
    const values = []
    if (req.query.entity_id) {
      values.push(`%${String(req.query.entity_id)}%`)
      conditions.push(`entity_id ILIKE $${values.length}`)
    }
    if (req.query.event_type) {
      values.push(String(req.query.event_type))
      conditions.push(`event_type = $${values.length}`)
    }
    if (req.query.created_from) {
      values.push(String(req.query.created_from))
      conditions.push(`created_at >= $${values.length}::timestamptz`)
    }
    if (req.query.created_to) {
      values.push(String(req.query.created_to))
      conditions.push(`created_at < ($${values.length}::timestamptz + INTERVAL '1 day')`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    values.push(limit, offset)
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json,
              prev_hash, entry_hash, created_at
       FROM admin_immutable_audit
       ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({ entries: result.rows });
  } catch (err) {
    logger.error('Audit log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

router.get('/tos-acceptance', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id AS user_id, u.email, u.full_name, uaa.tos_version, uaa.accepted_at
         FROM users u
         LEFT JOIN LATERAL (
           SELECT tos_version, accepted_at
             FROM user_agreement_acceptances
            WHERE user_id = u.id
            ORDER BY accepted_at DESC
            LIMIT 1
         ) uaa ON true
        ORDER BY u.created_at DESC
        LIMIT 500`
    )
    const rows = result.rows.map((row) => ({
      ...row,
      current_version: CURRENT_TOS_VERSION,
      outdated: row.tos_version !== CURRENT_TOS_VERSION
    }))
    res.json({ current_version: CURRENT_TOS_VERSION, rows })
  } catch (err) {
    logger.error('ToS acceptance error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load ToS acceptance records' })
  }
})

router.get('/settings-log', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table filtered by settings events
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json, created_at
       FROM admin_immutable_audit
       WHERE event_type = 'settings_updated'
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Settings log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load settings log' });
  }
});

router.get('/platform-analytics', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-L1): Replaced wrong "estimation" calculations. The old code used
    // phase2 total as "phase1_passed" and funded total as "phase2_passed" — both wrong.
    // Now uses explicit status='passed' + account_type filter for accurate pass counts.
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE account_type = 'phase1')                         AS p1t,
        COUNT(*) FILTER (WHERE account_type = 'phase2')                         AS p2t,
        COUNT(*) FILTER (WHERE account_type = 'funded')                         AS ft,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded')   AS fa,
        COUNT(*) FILTER (WHERE status = 'passed' AND account_type = 'phase1')   AS p1_passed,
        COUNT(*) FILTER (WHERE status = 'passed' AND account_type = 'phase2')   AS p2_passed
      FROM accounts
    `);
    res.json({
      funnel: {
        phase1_total:  parseInt(r.rows[0].p1t || 0),
        phase1_passed: parseInt(r.rows[0].p1_passed || 0),
        phase2_total:  parseInt(r.rows[0].p2t || 0),
        phase2_passed: parseInt(r.rows[0].p2_passed || 0),
        funded_total:  parseInt(r.rows[0].ft || 0),
        funded_active: parseInt(r.rows[0].fa || 0)
      }
    });
  } catch (err) {
    logger.error('Platform analytics error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/bbook', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
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
      WHERE t.status = 'closed'
        AND a.account_type = 'funded'
      ORDER BY t.close_time DESC NULLS LAST, t.id DESC
      LIMIT 120
    `)

    res.json(result.rows)
  } catch (err) {
    logger.error('Bbook positions error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/bbook-report', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const q1 = await pool.query(`
      SELECT COALESCE(SUM(p.amount_payable), 0) as paid
      FROM payouts p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'paid'
    `);
    const q2 = await pool.query(`
      SELECT
        COUNT(*) FILTER(WHERE status='failed') as fails,
        COUNT(*) FILTER(WHERE status='active' AND account_type='funded') as active
      FROM accounts
    `);
    // FIX (BUG-L8): Replaced hardcoded 0 values with real PnL sums from trades table
    const q3 = await pool.query(`
      SELECT
        COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl > 0 AND t.status = 'closed'), 0) AS gross_profit,
        ABS(COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl < 0 AND t.status = 'closed'), 0)) AS gross_loss
      FROM trades t
      JOIN accounts a ON a.id = t.account_id
    `);

    const grossProfit = parseFloat(q3.rows[0].gross_profit || 0);
    const grossLoss   = parseFloat(q3.rows[0].gross_loss || 0);
    const totalPaidOut = parseFloat(q1.rows[0].paid || 0);

    res.json({
      totals: {
        total_trader_profits:  parseFloat(grossProfit.toFixed(2)),
        total_trader_losses:   parseFloat(grossLoss.toFixed(2)),
        total_paid_out:        parseFloat(totalPaidOut.toFixed(2)),
        net_firm_pnl:          parseFloat((grossLoss - grossProfit - totalPaidOut).toFixed(2)),
        total_failed:          parseInt(q2.rows[0].fails || 0),
        total_funded_active:   parseInt(q2.rows[0].active || 0)
      }
    });
  } catch (err) {
    logger.error('Bbook report error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/settings', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM platform_settings')
    const settings = {}
    result.rows.forEach(r => { settings[r.key] = r.value })
    res.json(settings)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.get('/settings/account-availability', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getTenantSettingsMap()
    const sizes = await buildAccountAvailability(pool, settings)

    res.json({
      period_start: settings.max_accounts_period_start || null,
      period_end: settings.max_accounts_period_end || null,
      sizes
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account availability' })
  }
});

const WRITABLE_SETTINGS_KEYS = new Set([
  'challenge_start_requires_kyc', 'hide_unavailable_sizes_on_landing', 'sold_out_message',
  'promotion_requires_admin_review', 'promotion_review_sla_hours', 'failed_account_visibility_days',
  'passed_account_visibility_days', 'expired_account_visibility_days',
  'funded_max_drawdown_pct', 'profit_share_pct', 'payouts_enabled', 'min_payout_amount',
  'payout_request_cooldown_hours', 'payout_requires_kyc_approved', 'payout_requires_no_open_positions',
  'min_hold_seconds', 'min_lot_size', 'forex_lots_per_1k', 'commodity_lots_per_1k',
  'max_trades_per_1k', 'max_daily_trades', 'weekend_holding_enabled',
  'dynamic_commission_per_lot', 'commission_per_lot_json',
  'slippage_simulator_enabled', 'slippage_max_pips_adverse', 'slippage_max_pips_adverse_json',
  'news_protection_enabled', 'news_protection_block_new_orders', 'news_protection_lookahead_minutes',
  'rollover_guard_enabled', 'rollover_guard_block_new_orders',
  'support_response_sla_hours', 'dispute_submission_window_days', 'support_ticket_categories',
  'support_escalation_label', 'inactivity_auto_fail_enabled', 'inactivity_fail_days',
  'payment_provider', 'payment_provider_public_key', 'payment_provider_secret_key',
  'payment_provider_webhook_secret', 'payment_provider_account_id',
  'affiliate_program_enabled', 'affiliate_referred_discount_pct',
  'affiliate_min_payout_amount', 'affiliate_default_commission_pct'
]);

router.post('/settings', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(req.body).filter(key => WRITABLE_SETTINGS_KEYS.has(key));
    for (const key of keys) {
      await client.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(req.body[key])]
      );
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'settings_updated',
        entityType: 'platform_settings',
        entityId: 'global',
        payload: { keys }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    await client.query('COMMIT');
    res.json({ message: 'Settings saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to save settings' });
  } finally {
    client.release();
  }
});

router.get('/price-feed-health', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT instrument, bid, ask, updated_at FROM price_feed');
    // FIX (BUG-L9): ticks_last_5min was hardcoded as 124. Now queries real count
    // from price_feed_history for each instrument over the last 5 minutes.
    const tickCounts = await pool.query(`
      SELECT instrument, COUNT(*) AS tick_count
      FROM price_feed_history
      WHERE recorded_at > NOW() - INTERVAL '5 minutes'
      GROUP BY instrument
    `);
    const tickMap = {};
    tickCounts.rows.forEach(r => { tickMap[r.instrument] = parseInt(r.tick_count || 0); });

    const mapped = result.rows.map(r => ({
      updated_at: r.updated_at || null,
      instrument: r.instrument,
      bid: r.bid,
      ask: r.ask,
      seconds_since_update: r.updated_at
        ? Math.max(0, Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 1000))
        : null,
      ticks_last_5min: tickMap[r.instrument] || 0,
      status: r.updated_at
        ? (Date.now() - new Date(r.updated_at).getTime() < 30000 ? 'operational' : 'stale')
        : 'unknown'
    }));
    res.json({ instruments: mapped });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/risk-dashboard', authenticateAdmin, async (req, res) => {
  try {
    const { exposureData, total_open_trades, total_floating_pnl } = await getExposureData(pool);

    res.json({
      exposure: exposureData,
      total_open_trades: total_open_trades,
      total_floating_pnl: total_floating_pnl,
      near_breach_accounts: [],
      near_target_accounts: [],
      updated_at: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/price-staleness', authenticateAdmin, async (req, res) => {
  res.json({ any_stale: false, stale_instruments: [] });
});

// ---------------------------------------------------------------------------
// FEATURE MODULES (MVP): Incident Center, Rule Builder, Auto Enforcement,
// Payout Fraud Scoring, Device/IP Link Graph
// ---------------------------------------------------------------------------

router.get('/incidents', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, title, severity, status, source, details, created_at, updated_at,
              acknowledged_at, resolved_at, acknowledged_by
       FROM admin_incidents ORDER BY created_at DESC LIMIT 300`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load incidents' })
  }
})

router.post('/incidents', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const { title, severity = 'medium', source = 'manual', details = '' } = req.body || {}
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'Title is required (min 3 chars)' })
    }
    const allowedSeverity = new Set(['low', 'medium', 'high', 'critical'])
    const sev = allowedSeverity.has(String(severity)) ? String(severity) : 'medium'

    const result = await pool.query(
      `INSERT INTO admin_incidents (title, severity, status, source, details, updated_at)
       VALUES ($1, $2, 'open', $3, $4, NOW())
       RETURNING *`,
      [String(title).trim(), sev, String(source || 'manual').trim(), String(details || '').trim()]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'incident_created',
        entityType: 'incident',
        entityId: String(result.rows[0].id),
        payload: {
          severity: sev,
          source: String(source || 'manual').trim()
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create incident' })
  }
})

router.post('/incidents/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const { status } = req.body || {}
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid incident id' })

    const allowed = new Set(['open', 'acknowledged', 'resolved'])
    if (!allowed.has(String(status))) return res.status(400).json({ error: 'Invalid status' })

    const isAck = status === 'acknowledged'
    const isResolved = status === 'resolved'
    const r = await pool.query(
      `UPDATE admin_incidents
          SET status = $1,
              updated_at = NOW(),
              acknowledged_at = CASE WHEN $2 THEN COALESCE(acknowledged_at, NOW()) ELSE acknowledged_at END,
              resolved_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
              acknowledged_by = CASE WHEN $2 THEN 'admin' ELSE acknowledged_by END
        WHERE id = $4
        RETURNING *`,
      [status, isAck, isResolved, id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Incident not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'incident_status_changed',
        entityType: 'incident',
        entityId: String(id),
        payload: { status: String(status) }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update incident status' })
  }
})

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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json(result.rows)
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reorder rules' })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Step-model (1-step / 2-step / 3-step challenge) admin management.
// Global/platform-wide — super-admin only.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/step-models', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const models = await fetchStepModels()
    res.json(models)
  } catch (err) {
    logger.error('[admin] Failed to load step models:', { error: err.message })
    res.status(500).json({ error: 'Failed to load step models' })
  }
})

router.post('/step-models/:slug/toggle', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const enabled = req.body?.enabled
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: '`enabled` (boolean) is required' })
    }
    const updated = await toggleStepModel(slug, enabled)
    if (!updated) return res.status(404).json({ error: 'Step model not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_toggled',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, enabled: !!updated.is_active }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(updated)
  } catch (err) {
    logger.error('[admin] Failed to toggle step model:', { error: err.message })
    res.status(500).json({ error: 'Failed to toggle step model' })
  }
})

router.patch('/step-models/:slug/phases/:phaseIndex', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const phaseIndex = parseInt(req.params.phaseIndex, 10)
    if (!Number.isFinite(phaseIndex) || phaseIndex < 1) {
      return res.status(400).json({ error: 'Invalid phase index' })
    }

    const model = await fetchStepModelBySlug(slug)
    if (!model) return res.status(404).json({ error: 'Step model not found' })
    if (phaseIndex > model.steps) return res.status(400).json({ error: `This model only has ${model.steps} phase(s)` })

    const phaseIdx0 = phaseIndex - 1
    const profitTargets = Array.isArray(model.profit_targets_pct) ? [...model.profit_targets_pct] : []
    const timeLimits = Array.isArray(model.time_limits_days) ? [...model.time_limits_days] : []
    const consistencyByPhase = Array.isArray(model.consistency_max_day_pct_by_phase) ? [...model.consistency_max_day_pct_by_phase] : []

    const body = req.body || {}
    if (body.profit_target_pct !== undefined) profitTargets[phaseIdx0] = parseFloat(body.profit_target_pct)
    if (body.max_time_limit_days !== undefined) timeLimits[phaseIdx0] = parseInt(body.max_time_limit_days, 10)
    if (body.consistency_rule_pct !== undefined) consistencyByPhase[phaseIdx0] = parseFloat(body.consistency_rule_pct)

    const trailingMaxDrawdownPct = body.trailing_max_drawdown_pct !== undefined ? parseFloat(body.trailing_max_drawdown_pct) : model.max_drawdown_pct
    const dailyLossLimitPct = body.daily_loss_limit_pct !== undefined ? parseFloat(body.daily_loss_limit_pct) : model.daily_drawdown_pct
    const minTradingDays = body.min_trading_days !== undefined ? parseInt(body.min_trading_days, 10) : model.min_trading_days

    const result = await pool.query(
      `UPDATE challenge_models SET
         profit_targets_pct = $2::jsonb,
         time_limits_days = $3::jsonb,
         consistency_max_day_pct_by_phase = $4::jsonb,
         max_drawdown_pct = $5,
         daily_drawdown_pct = $6,
         min_trading_days = $7,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        model.id, JSON.stringify(profitTargets), JSON.stringify(timeLimits), JSON.stringify(consistencyByPhase),
        trailingMaxDrawdownPct, dailyLossLimitPct, minTradingDays
      ]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_phase_updated',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, phase_index: phaseIndex, changes: body }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin] Failed to update step model phase:', { error: err.message })
    res.status(500).json({ error: 'Failed to update step model phase' })
  }
})

router.patch('/step-models/:slug/pricing/:accountSize', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const accountSize = parseInt(req.params.accountSize, 10)
    const price = parseFloat(req.body?.price)
    const isActive = req.body?.is_active

    if (!Number.isFinite(accountSize)) return res.status(400).json({ error: 'Invalid account size' })
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Invalid price' })

    const model = await fetchStepModelBySlug(slug)
    if (!model) return res.status(404).json({ error: 'Step model not found' })

    const result = await pool.query(
      `UPDATE challenge_model_pricing
          SET price = $3,
              is_active = COALESCE($4, is_active)
        WHERE challenge_model_id = $1 AND account_size = $2
        RETURNING *`,
      [model.id, accountSize, price, typeof isActive === 'boolean' ? isActive : null]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'No pricing row for this model/size' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_pricing_updated',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, account_size: accountSize, price }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin] Failed to update step model pricing:', { error: err.message })
    res.status(500).json({ error: 'Failed to update step model pricing' })
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

    if (action === 'lock_account') {
      await client.query(`UPDATE accounts SET status = 'locked', updated_at = NOW() WHERE id = $1`, [acc.id])
      message = 'Account locked'
    } else if (action === 'force_close_open_trades') {
      const closeResult = await forceCloseOpenTradesForAccount(client, acc.id)
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({ message, event: eventResult.rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to apply enforcement action' })
  } finally {
    client.release()
  }
})

router.get('/payout-fraud-scores', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.status, p.requested_at,
              u.full_name, u.email, u.kyc_status,
              a.account_size, a.created_at AS account_created_at
         FROM payouts p
         JOIN users u ON u.id = p.user_id
         JOIN accounts a ON a.id = p.account_id
        WHERE p.status IN ('pending', 'flagged')
        ORDER BY p.requested_at DESC
        LIMIT 250`
    )

    const scored = []
    for (const row of result.rows) {
      let score = 0
      const reasons = []
      const amount = parseFloat(row.amount_requested || 0)
      const accountSize = parseFloat(row.account_size || 0)
      const accountAgeDays = Math.max(0, Math.floor((Date.now() - new Date(row.account_created_at).getTime()) / (1000 * 60 * 60 * 24)))

      if (accountSize > 0 && amount > accountSize * 0.2) {
        score += 30
        reasons.push('Large payout relative to account size')
      }
      if (String(row.kyc_status) !== 'approved') {
        score += 25
        reasons.push('KYC not approved')
      }
      if (accountAgeDays < 7) {
        score += 20
        reasons.push('Very new account')
      }

      const openTrades = await pool.query(
        `SELECT COUNT(*)::int AS c FROM trades WHERE account_id = $1 AND status = 'open'`,
        [row.account_id]
      )
      if ((openTrades.rows[0]?.c || 0) > 0) {
        score += 10
        reasons.push('Open trades exist at payout request time')
      }

      const recentTrades = await pool.query(
        `SELECT COUNT(*)::int AS c
           FROM trades
          WHERE account_id = $1
            AND close_time >= NOW() - INTERVAL '24 hours'`,
        [row.account_id]
      )
      if ((recentTrades.rows[0]?.c || 0) >= 10) {
        score += 10
        reasons.push('High recent trade velocity')
      }

      let sharedUsers = 1
      try {
        const lastLoginIp = await pool.query(
          `SELECT ip_address FROM login_logs
            WHERE user_id = $1 AND ip_address IS NOT NULL
            ORDER BY logged_in_at DESC LIMIT 1`,
          [row.user_id]
        )
        const ip = lastLoginIp.rows[0]?.ip_address
        if (ip) {
          const shared = await pool.query(
            `SELECT COUNT(DISTINCT user_id)::int AS c
               FROM login_logs
              WHERE ip_address = $1
                AND logged_in_at >= NOW() - INTERVAL '30 days'`,
            [ip]
          )
          sharedUsers = shared.rows[0]?.c || 1
          if (sharedUsers >= 3) {
            score += 20
            reasons.push('IP shared by multiple users')
          }
        }
      } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

      const risk_level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
      scored.push({
        ...row,
        score,
        risk_level,
        account_age_days: accountAgeDays,
        shared_ip_users: sharedUsers,
        reasons
      })
    }

    scored.sort((a, b) => b.score - a.score)
    res.json(scored)
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute payout fraud scores' })
  }
})

router.get('/device-link-graph', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const focusUserId = req.query.user_id ? String(req.query.user_id) : null

    const loginRows = await pool.query(
      `SELECT user_id, ip_address, logged_in_at
         FROM login_logs
        WHERE ip_address IS NOT NULL
          AND logged_in_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_in_at DESC
        LIMIT 3000`
    )
    const tradeRows = await pool.query(
      `SELECT user_id, account_id, ip_address, logged_at
         FROM trade_logs
        WHERE ip_address IS NOT NULL
          AND logged_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_at DESC
        LIMIT 3000`
    )

    const allowedUsers = new Set()
    if (focusUserId) {
      allowedUsers.add(focusUserId)
      for (const r of loginRows.rows) {
        if (String(r.user_id) === focusUserId) allowedUsers.add(String(r.user_id))
      }
      for (const r of tradeRows.rows) {
        if (String(r.user_id) === focusUserId) allowedUsers.add(String(r.user_id))
      }
    }

    const nodes = new Map()
    const edges = new Map()
    function addNode(id, type, label) {
      if (!nodes.has(id)) nodes.set(id, { id, type, label })
    }
    function addEdge(from, to, type) {
      const key = `${from}|${to}|${type}`
      const prev = edges.get(key)
      if (prev) prev.weight += 1
      else edges.set(key, { id: key, from, to, type, weight: 1 })
    }

    for (const r of loginRows.rows) {
      const uid = String(r.user_id || '')
      const ip = String(r.ip_address || '')
      if (!uid || !ip) continue
      if (focusUserId && uid !== focusUserId) continue
      const uNode = `u:${uid}`
      const ipNode = `ip:${ip}`
      addNode(uNode, 'user', uid)
      addNode(ipNode, 'ip', ip)
      addEdge(uNode, ipNode, 'login_ip')
    }

    for (const r of tradeRows.rows) {
      const uid = String(r.user_id || '')
      const acc = String(r.account_id || '')
      const ip = String(r.ip_address || '')
      if (!uid || !ip) continue
      if (focusUserId && uid !== focusUserId) continue
      const uNode = `u:${uid}`
      const aNode = `a:${acc}`
      const ipNode = `ip:${ip}`
      addNode(uNode, 'user', uid)
      addNode(aNode, 'account', acc)
      addNode(ipNode, 'ip', ip)
      addEdge(uNode, ipNode, 'trade_ip')
      if (acc) addEdge(aNode, ipNode, 'account_ip')
      if (acc) addEdge(uNode, aNode, 'owns')
    }

    res.json({
      generated_at: new Date(),
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values())
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to build device link graph' })
  }
})

router.get('/news-protection', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'news_protection_enabled',
      'news_protection_lookahead_minutes',
      'news_protection_max_lots_multiplier',
      'news_protection_block_new_orders',
    ]
    const s = await getSettingsMap(keys)
    res.json({
      enabled: toBool(s.news_protection_enabled, false),
      lookahead_minutes: parseInt(s.news_protection_lookahead_minutes || '3', 10),
      max_lots_multiplier: parseFloat(s.news_protection_max_lots_multiplier || '0.6'),
      block_new_orders: toBool(s.news_protection_block_new_orders, true),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load news protection settings' })
  }
})

router.post('/news-protection', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const body = req.body || {}
    await client.query('BEGIN')
    await upsertSetting(client, 'news_protection_enabled', toBool(body.enabled, false))
    await upsertSetting(client, 'news_protection_lookahead_minutes', Math.max(0, parseInt(body.lookahead_minutes || 3, 10)))
    await upsertSetting(client, 'news_protection_max_lots_multiplier', Math.max(0.05, parseFloat(body.max_lots_multiplier || 0.6)))
    await upsertSetting(client, 'news_protection_block_new_orders', toBool(body.block_new_orders, true))
    try {
      await appendImmutableAudit(client, {
        eventType: 'news_protection_updated',
        entityType: 'risk_setting',
        entityId: 'news_protection',
        payload: {
          enabled: toBool(body.enabled, false),
          lookahead_minutes: Math.max(0, parseInt(body.lookahead_minutes || 3, 10)),
          max_lots_multiplier: Math.max(0.05, parseFloat(body.max_lots_multiplier || 0.6)),
          block_new_orders: toBool(body.block_new_orders, true)
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    await client.query('COMMIT')
    res.json({ message: 'News protection settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save news protection settings' })
  } finally {
    client.release()
  }
})

router.get('/rollover-guard', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'rollover_guard_enabled',
      'rollover_guard_start_utc',
      'rollover_guard_end_utc',
      'rollover_guard_block_new_orders',
    ]
    const s = await getSettingsMap(keys)
    res.json({
      enabled: toBool(s.rollover_guard_enabled, true),
      start_utc: s.rollover_guard_start_utc || '21:55',
      end_utc: s.rollover_guard_end_utc || '22:05',
      block_new_orders: toBool(s.rollover_guard_block_new_orders, true),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rollover guard settings' })
  }
})

router.post('/rollover-guard', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const body = req.body || {}
    await client.query('BEGIN')
    await upsertSetting(client, 'rollover_guard_enabled', toBool(body.enabled, true))
    await upsertSetting(client, 'rollover_guard_start_utc', String(body.start_utc || '21:55'))
    await upsertSetting(client, 'rollover_guard_end_utc', String(body.end_utc || '22:05'))
    await upsertSetting(client, 'rollover_guard_block_new_orders', toBool(body.block_new_orders, true))
    try {
      await appendImmutableAudit(client, {
        eventType: 'rollover_guard_updated',
        entityType: 'risk_setting',
        entityId: 'rollover_guard',
        payload: {
          enabled: toBool(body.enabled, true),
          start_utc: String(body.start_utc || '21:55'),
          end_utc: String(body.end_utc || '22:05'),
          block_new_orders: toBool(body.block_new_orders, true)
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    await client.query('COMMIT')
    res.json({ message: 'Rollover guard settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save rollover guard settings' })
  } finally {
    client.release()
  }
})

router.get('/slippage-monitor', authenticateAdmin, async (req, res) => {
  try {
    const prices = await pool.query(
      `SELECT instrument, bid, ask, updated_at
         FROM price_feed`
    )
    const recent = await pool.query(
      `SELECT instrument, direction, open_price, close_price, open_time, close_time
         FROM trades
        WHERE status = 'closed'
          AND close_time >= NOW() - INTERVAL '24 hours'
          AND open_price IS NOT NULL
          AND close_price IS NOT NULL
        ORDER BY close_time DESC
        LIMIT 3000`
    )

    const spreadRows = prices.rows.map(r => {
      const bid = parseFloat(r.bid || 0)
      const ask = parseFloat(r.ask || 0)
      const spreadAbs = Math.max(0, ask - bid)
      const spreadPoints = getSpreadPoints(spreadAbs, r.instrument)
      const threshold = getWideSpreadThreshold(r.instrument)
      return {
        instrument: r.instrument,
        spread_points: parseFloat(spreadPoints.toFixed(2)),
        threshold_points: threshold,
        is_alert: spreadPoints > threshold,
        updated_at: r.updated_at || null,
      }
    })

    let suspicious = 0
    let sampleCount = 0
    const byInstrument = {}
    for (const t of recent.rows) {
      const openPrice = parseFloat(t.open_price || 0)
      const closePrice = parseFloat(t.close_price || 0)
      const holdSec = Math.max(0, (new Date(t.close_time).getTime() - new Date(t.open_time).getTime()) / 1000)
      const points = getSpreadPoints(Math.abs(closePrice - openPrice), t.instrument)
      const quickMoveThreshold = getQuickMoveThreshold(t.instrument)
      sampleCount += 1

      if (!byInstrument[t.instrument]) byInstrument[t.instrument] = { instrument: t.instrument, trades: 0, avg_move_points: 0, suspicious_quick_moves: 0 }
      byInstrument[t.instrument].trades += 1
      byInstrument[t.instrument].avg_move_points += points

      if (holdSec < 60 && points > quickMoveThreshold) {
        suspicious += 1
        byInstrument[t.instrument].suspicious_quick_moves += 1
      }
    }

    const drift = Object.values(byInstrument).map(r => ({
      ...r,
      avg_move_points: r.trades > 0 ? parseFloat((r.avg_move_points / r.trades).toFixed(2)) : 0
    })).sort((a, b) => b.suspicious_quick_moves - a.suspicious_quick_moves)

    res.json({
      generated_at: new Date(),
      spread_monitor: spreadRows.sort((a, b) => (b.is_alert ? 1 : 0) - (a.is_alert ? 1 : 0)),
      drift_monitor: drift,
      suspicious_quick_moves: suspicious,
      sample_count: sampleCount,
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load slippage monitor' })
  }
})

router.get('/feed-anomalies', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap(['feed_stale_threshold_seconds'])
    const staleThreshold = Math.max(5, parseInt(settings.feed_stale_threshold_seconds || '30', 10))

    const result = await pool.query(`SELECT instrument, bid, ask, updated_at FROM price_feed`)
    const now = Date.now()
    const rows = []
    let staleCount = 0
    let wideSpreadCount = 0

    for (const r of result.rows) {
      const bid = parseFloat(r.bid || 0)
      const ask = parseFloat(r.ask || 0)
      const spreadAbs = Math.max(0, ask - bid)
      const spreadPoints = getSpreadPoints(spreadAbs, r.instrument)
      const spreadThreshold = getWideSpreadThreshold(r.instrument)
      const ageSec = r.updated_at ? Math.max(0, Math.floor((now - new Date(r.updated_at).getTime()) / 1000)) : 999999
      const stale = ageSec > staleThreshold
      const wide = spreadPoints > spreadThreshold
      if (stale) staleCount += 1
      if (wide) wideSpreadCount += 1

      rows.push({
        instrument: r.instrument,
        bid,
        ask,
        spread_points: parseFloat(spreadPoints.toFixed(2)),
        spread_threshold: spreadThreshold,
        seconds_since_update: ageSec,
        stale,
        wide_spread: wide,
      })
    }

    const anomalies = rows.filter(r => r.stale || r.wide_spread)
    res.json({
      generated_at: new Date(),
      stale_threshold_seconds: staleThreshold,
      stale_count: staleCount,
      wide_spread_count: wideSpreadCount,
      any_anomaly: anomalies.length > 0,
      instruments: rows,
      anomalies
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feed anomalies' })
  }
})

router.get('/challenge-funnel', authenticateAdmin, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE account_type = 'phase1') AS phase1_total,
         COUNT(*) FILTER (WHERE account_type = 'phase1' AND status = 'passed') AS phase1_passed,
         COUNT(*) FILTER (WHERE account_type = 'phase2') AS phase2_total,
         COUNT(*) FILTER (WHERE account_type = 'phase2' AND status = 'passed') AS phase2_passed,
         COUNT(*) FILTER (WHERE account_type = 'funded') AS funded_total,
         COUNT(*) FILTER (WHERE account_type = 'funded' AND status = 'active') AS funded_active,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_total,
         COUNT(*) FILTER (WHERE status = 'expired') AS expired_total
       FROM accounts`
    )

    const r = totals.rows[0] || {}
    const phase1Total = parseInt(r.phase1_total || 0, 10)
    const phase1Passed = parseInt(r.phase1_passed || 0, 10)
    const phase2Total = parseInt(r.phase2_total || 0, 10)
    const phase2Passed = parseInt(r.phase2_passed || 0, 10)
    const fundedTotal = parseInt(r.funded_total || 0, 10)
    const fundedActive = parseInt(r.funded_active || 0, 10)
    const failedTotal = parseInt(r.failed_total || 0, 10)
    const expiredTotal = parseInt(r.expired_total || 0, 10)

    const phase1PassRate = phase1Total > 0 ? parseFloat(((phase1Passed / phase1Total) * 100).toFixed(2)) : 0
    const phase2PassRate = phase2Total > 0 ? parseFloat(((phase2Passed / phase2Total) * 100).toFixed(2)) : 0
    const fundedActivationRate = fundedTotal > 0 ? parseFloat(((fundedActive / fundedTotal) * 100).toFixed(2)) : 0

    res.json({
      generated_at: new Date(),
      funnel: {
        phase1_total: phase1Total,
        phase1_passed: phase1Passed,
        phase1_pass_rate: phase1PassRate,
        phase2_total: phase2Total,
        phase2_passed: phase2Passed,
        phase2_pass_rate: phase2PassRate,
        funded_total: fundedTotal,
        funded_active: fundedActive,
        funded_activation_rate: fundedActivationRate,
      },
      outcomes: {
        failed_total: failedTotal,
        expired_total: expiredTotal,
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load challenge funnel' })
  }
})

router.get('/cohort-analytics', authenticateAdmin, async (req, res) => {
  try {
    const monthsBackRaw = parseInt(req.query.months || '12', 10)
    const monthsBack = Number.isFinite(monthsBackRaw) ? Math.max(3, Math.min(24, monthsBackRaw)) : 12
    const cohorts = await pool.query(
      `WITH user_base AS (
         SELECT
           u.id,
           DATE_TRUNC('month', u.created_at) AS cohort_month,
           CASE
             WHEN COALESCE(NULLIF(TRIM(u.referred_by), ''), '') <> '' THEN 'referral'
             ELSE 'direct'
           END AS source,
           COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
           COALESCE(u.kyc_status, 'pending') AS kyc_status
         FROM users u
         WHERE u.created_at >= NOW() - make_interval(months => $1::int)
       ),
       account_agg AS (
         SELECT
           a.user_id,
           COUNT(*)::int AS accounts_opened,
           COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
         FROM accounts a
         GROUP BY a.user_id
       ),
       payout_agg AS (
         SELECT
           p.user_id,
           COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric AS paid_out
         FROM payouts p
         GROUP BY p.user_id
       )
       SELECT
         ub.cohort_month,
         ub.source,
         ub.country,
         COUNT(*)::int AS signups,
         COUNT(*) FILTER (WHERE ub.kyc_status = 'approved')::int AS kyc_approved,
         COALESCE(SUM(COALESCE(aa.accounts_opened, 0)), 0)::int AS accounts_opened,
         COALESCE(SUM(COALESCE(aa.funded_accounts, 0)), 0)::int AS funded_accounts,
         COALESCE(SUM(COALESCE(pa.paid_out, 0)), 0)::numeric AS paid_out
       FROM user_base ub
       LEFT JOIN account_agg aa ON aa.user_id = ub.id
       LEFT JOIN payout_agg pa ON pa.user_id = ub.id
       GROUP BY ub.cohort_month, ub.source, ub.country
       ORDER BY ub.cohort_month DESC, signups DESC`,
      [monthsBack]
    )

    const rows = cohorts.rows.map(r => ({
      cohort_month: r.cohort_month,
      source: r.source,
      country: r.country,
      signups: parseInt(r.signups || 0, 10),
      kyc_approved: parseInt(r.kyc_approved || 0, 10),
      accounts_opened: parseInt(r.accounts_opened || 0, 10),
      funded_accounts: parseInt(r.funded_accounts || 0, 10),
      paid_out: parseFloat(r.paid_out || 0),
    }))

    const monthlyMap = new Map()
    const countryMap = new Map()
    for (const r of rows) {
      const monthKey = r.cohort_month ? new Date(r.cohort_month).toISOString().slice(0, 7) : 'unknown'
      const m = monthlyMap.get(monthKey) || {
        month: monthKey,
        signups: 0,
        kyc_approved: 0,
        funded_accounts: 0,
        paid_out: 0
      }
      m.signups += r.signups
      m.kyc_approved += r.kyc_approved
      m.funded_accounts += r.funded_accounts
      m.paid_out += r.paid_out
      monthlyMap.set(monthKey, m)

      const c = countryMap.get(r.country) || { country: r.country, signups: 0 }
      c.signups += r.signups
      countryMap.set(r.country, c)
    }

    const monthly = Array.from(monthlyMap.values())
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(m => ({
        ...m,
        kyc_approval_rate: m.signups > 0 ? parseFloat(((m.kyc_approved / m.signups) * 100).toFixed(2)) : 0
      }))
    const top_countries = Array.from(countryMap.values())
      .sort((a, b) => b.signups - a.signups)
      .slice(0, 12)

    res.json({
      generated_at: new Date(),
      months_back: monthsBack,
      cohorts: rows,
      monthly,
      top_countries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cohort analytics' })
  }
})

router.get('/aml-velocity', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `WITH active_users AS (
         SELECT DISTINCT user_id::text FROM login_logs WHERE logged_in_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM trade_logs WHERE logged_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM payouts WHERE requested_at >= NOW() - INTERVAL '7 days'
       ),
       login_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '1 hour')::int AS login_1h,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours')::int AS login_24h,
           COUNT(DISTINCT ip_address) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours' AND ip_address IS NOT NULL)::int AS unique_ip_24h
         FROM login_logs
         GROUP BY user_id::text
       ),
       trade_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '1 hour')::int AS trade_1h,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '24 hours')::int AS trade_24h
         FROM trade_logs
         GROUP BY user_id::text
       ),
       payout_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days')::int AS payout_req_7d,
           COALESCE(SUM(amount_requested) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days'), 0)::numeric AS payout_amt_7d
         FROM payouts
         GROUP BY user_id::text
       ),
       account_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*)::int AS accounts_total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_accounts
         FROM accounts
         GROUP BY user_id::text
       )
       SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(l.login_1h, 0)::int AS login_1h,
         COALESCE(l.login_24h, 0)::int AS login_24h,
         COALESCE(l.unique_ip_24h, 0)::int AS unique_ip_24h,
         COALESCE(t.trade_1h, 0)::int AS trade_1h,
         COALESCE(t.trade_24h, 0)::int AS trade_24h,
         COALESCE(p.payout_req_7d, 0)::int AS payout_req_7d,
         COALESCE(p.payout_amt_7d, 0)::numeric AS payout_amt_7d,
         COALESCE(a.accounts_total, 0)::int AS accounts_total,
         COALESCE(a.active_accounts, 0)::int AS active_accounts
       FROM active_users au
       JOIN users u ON u.id::text = au.user_id
       LEFT JOIN login_agg l ON l.user_id = u.id::text
       LEFT JOIN trade_agg t ON t.user_id = u.id::text
       LEFT JOIN payout_agg p ON p.user_id = u.id::text
       LEFT JOIN account_agg a ON a.user_id = u.id::text
       ORDER BY
         (COALESCE(l.login_1h, 0) + COALESCE(l.login_24h, 0) + COALESCE(t.trade_1h, 0) + COALESCE(t.trade_24h, 0) + COALESCE(p.payout_req_7d, 0)) DESC,
         COALESCE(p.payout_amt_7d, 0) DESC
       LIMIT 300`
    )

    const rows = []
    for (const r of result.rows) {
      let riskScore = 0
      const flags = []

      if (r.login_1h >= 8) { riskScore += 25; flags.push('High login burst (1h)') }
      if (r.login_24h >= 25) { riskScore += 15; flags.push('High login velocity (24h)') }
      if (r.unique_ip_24h >= 4) { riskScore += 20; flags.push('Many unique IPs (24h)') }
      if (r.trade_1h >= 30) { riskScore += 20; flags.push('Trade burst (1h)') }
      if (r.trade_24h >= 120) { riskScore += 20; flags.push('High trade count (24h)') }
      if (r.payout_req_7d >= 2) { riskScore += 15; flags.push('Multiple payout requests (7d)') }
      if (parseFloat(r.payout_amt_7d || 0) >= 10000) { riskScore += 10; flags.push('Large payout amount (7d)') }
      if (String(r.kyc_status || '') !== 'approved') { riskScore += 10; flags.push('KYC not approved') }

      if (riskScore <= 0) continue
      rows.push({
        ...r,
        payout_amt_7d: parseFloat(r.payout_amt_7d || 0),
        risk_score: riskScore,
        risk_level: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
        flags
      })
    }

    rows.sort((a, b) => b.risk_score - a.risk_score)
    const sliced = rows.slice(0, 200)
    res.json({
      generated_at: new Date(),
      flagged_count: sliced.length,
      high_risk_count: sliced.filter(r => r.risk_level === 'high').length,
      medium_risk_count: sliced.filter(r => r.risk_level === 'medium').length,
      rows: sliced
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AML velocity checks' })
  }
})

router.get('/kyc-sla', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const slaHoursRaw = parseInt(req.query.sla_hours || '24', 10)
    const slaHours = Number.isFinite(slaHoursRaw) ? Math.max(1, Math.min(168, slaHoursRaw)) : 24

    const pending = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(u.kyc_submitted_at, u.created_at))) / 3600.0 AS wait_hours,
         COUNT(a.id)::int AS accounts_total,
         COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.kyc_status = 'pending'
       GROUP BY u.id, u.full_name, u.email, u.country, u.kyc_submitted_at, u.created_at
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) ASC
       LIMIT 600`
    )

    const queue = pending.rows.map(r => {
      const waitHours = parseFloat(r.wait_hours || 0)
      const sla_status =
        waitHours >= slaHours * 2 ? 'breach'
          : waitHours >= slaHours ? 'overdue'
            : waitHours >= slaHours * 0.6 ? 'warning'
              : 'within_sla'
      return {
        ...r,
        wait_hours: parseFloat(waitHours.toFixed(2)),
        wait_minutes: Math.max(0, Math.floor(waitHours * 60)),
        sla_status
      }
    })

    const pendingTotal = queue.length
    const overdueCount = queue.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length
    const breachCount = queue.filter(r => r.sla_status === 'breach').length
    const avgWaitHours = pendingTotal > 0
      ? parseFloat((queue.reduce((s, r) => s + (r.wait_hours || 0), 0) / pendingTotal).toFixed(2))
      : 0

    res.json({
      generated_at: new Date(),
      sla_hours: slaHours,
      summary: {
        pending_total: pendingTotal,
        overdue_total: overdueCount,
        breach_total: breachCount,
        avg_wait_hours: avgWaitHours
      },
      queue
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC SLA queue' })
  }
})

router.get('/kyc-quality-flags', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const uploadsRoot = path.resolve(__dirname, '../uploads')
    const docs = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         u.id_document_path,
         u.id_document_back_path,
         u.selfie_path
       FROM users u
       WHERE ${buildKycDocumentPresencePredicate('u')}
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) DESC
       LIMIT 500`
    )

    function inspectRelativeFile(relPath) {
      // getOriginalKycExtension strips a `.enc` at-rest-encryption suffix (if present)
      // before reading the extension, so encrypted and legacy plaintext files report
      // the same logical extension for the quality heuristics below.
      if (!relPath) return { exists: false, size_bytes: 0, ext: '' }
      const raw = String(relPath).replace(/^[/\\]+/, '')
      const safe = raw.replace(/\.\./g, '')
      const abs = path.resolve(uploadsRoot, safe)
      if (!abs.startsWith(uploadsRoot + path.sep) && abs !== uploadsRoot) {
        return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
      }
      try {
        if (!fs.existsSync(abs)) return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
        const st = fs.statSync(abs)
        return { exists: true, size_bytes: st.size, ext: getOriginalKycExtension(raw) }
      } catch {
        return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
      }
    }

    const rows = docs.rows.map(r => {
      const idFile = inspectRelativeFile(r.id_document_path)
      const idBackFile = inspectRelativeFile(r.id_document_back_path)
      const selfieFile = inspectRelativeFile(r.selfie_path)
      const flags = []
      let qualityScore = 0

      if (!idFile.exists) { flags.push('Missing ID document file'); qualityScore += 50 }
      if (!idBackFile.exists) { flags.push('Missing ID document back file'); qualityScore += 30 }
      if (!selfieFile.exists) { flags.push('Missing selfie file'); qualityScore += 50 }

      if (idFile.exists && !['.jpg', '.jpeg', '.png', '.pdf'].includes(idFile.ext)) {
        flags.push('Unexpected ID document extension')
        qualityScore += 20
      }
      if (selfieFile.exists && !['.jpg', '.jpeg', '.png'].includes(selfieFile.ext)) {
        flags.push('Unexpected selfie extension')
        qualityScore += 25
      }
      if (idFile.exists && idFile.ext !== '.pdf' && idFile.size_bytes < 70 * 1024) {
        flags.push('ID image file very small')
        qualityScore += 20
      }
      if (selfieFile.exists && selfieFile.size_bytes < 60 * 1024) {
        flags.push('Selfie file very small')
        qualityScore += 25
      }
      if (idFile.exists && selfieFile.exists && (idFile.size_bytes + selfieFile.size_bytes) < 180 * 1024) {
        flags.push('Combined KYC payload unusually small')
        qualityScore += 15
      }

      const submittedAt = r.submitted_at ? new Date(r.submitted_at) : null
      if (submittedAt && String(r.kyc_status || '') === 'pending') {
        const ageHours = (Date.now() - submittedAt.getTime()) / 3600000
        if (ageHours >= 48) {
          flags.push('Pending review for more than 48 hours')
          qualityScore += 10
        }
      }

      return {
        ...r,
        id_file_exists: idFile.exists,
        id_file_size: idFile.size_bytes,
        back_file_exists: idBackFile.exists,
        back_file_size: idBackFile.size_bytes,
        selfie_file_exists: selfieFile.exists,
        selfie_file_size: selfieFile.size_bytes,
        quality_score: qualityScore,
        risk_level: qualityScore >= 60 ? 'high' : qualityScore >= 30 ? 'medium' : 'low',
        flags
      }
    }).sort((a, b) => b.quality_score - a.quality_score)

    res.json({
      generated_at: new Date(),
      summary: {
        total_profiles: rows.length,
        high_risk_count: rows.filter(r => r.risk_level === 'high').length,
        medium_risk_count: rows.filter(r => r.risk_level === 'medium').length,
        missing_file_count: rows.filter(r => !r.id_file_exists || !r.back_file_exists || !r.selfie_file_exists).length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC quality flags' })
  }
})

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

router.post('/stress-simulator', authenticateAdmin, async (req, res) => {
  try {
    const shockPctRaw = parseFloat(req.body?.shock_pct ?? req.query.shock_pct ?? 2)
    const shockPct = Number.isFinite(shockPctRaw) ? Math.max(0.1, Math.min(25, shockPctRaw)) : 2
    const slippageRaw = parseFloat(req.body?.slippage_points ?? req.query.slippage_points ?? 0)
    const slippagePoints = Number.isFinite(slippageRaw) ? Math.max(0, Math.min(500, slippageRaw)) : 0
    const instrument = String(req.body?.instrument || req.query.instrument || '').trim().toUpperCase()

    const query = await pool.query(
      `SELECT
         t.id::text AS trade_id,
         t.account_id::text AS account_id,
         COALESCE(a.account_uid::text, a.id::text) AS account_uid,
         a.account_type,
         a.status AS account_status,
         COALESCE(u.full_name, '') AS full_name,
         COALESCE(u.email, '') AS email,
         t.instrument,
         t.direction,
         COALESCE(t.open_price, 0)::numeric AS open_price,
         COALESCE(t.lot_size, 0)::numeric AS lot_size,
         COALESCE(p.bid, t.open_price)::numeric AS bid,
         COALESCE(p.ask, t.open_price)::numeric AS ask
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       WHERE t.status = 'open'
         AND ($1 = '' OR t.instrument = $1)
       ORDER BY t.open_time DESC
       LIMIT 5000`,
      [instrument]
    )

    const byAccount = new Map()
    const tradeRows = []

    for (const row of query.rows) {
      const openPrice = parseFloat(row.open_price || 0)
      const lots = parseFloat(row.lot_size || 0)
      const currentPrice = String(row.direction) === 'buy'
        ? parseFloat(row.bid || openPrice)
        : parseFloat(row.ask || openPrice)

      const pointSize = getPipSize(String(row.instrument))
      const shockMove = currentPrice * (shockPct / 100)
      const slippageMove = slippagePoints * pointSize
      const stressedPrice = String(row.direction) === 'buy'
        ? Math.max(0, currentPrice - shockMove - slippageMove)
        : Math.max(0, currentPrice + shockMove + slippageMove)

      const currentPnl = calcTradePnl(String(row.direction), openPrice, currentPrice, lots, String(row.instrument))
      const stressedPnl = calcTradePnl(String(row.direction), openPrice, stressedPrice, lots, String(row.instrument))
      const pnlDelta = parseFloat((stressedPnl - currentPnl).toFixed(2))

      tradeRows.push({
        trade_id: row.trade_id,
        account_id: row.account_id,
        account_uid: row.account_uid,
        account_type: row.account_type,
        full_name: row.full_name,
        email: row.email,
        instrument: row.instrument,
        direction: row.direction,
        lot_size: lots,
        current_price: roundPrice(currentPrice, row.instrument),
        stressed_price: roundPrice(stressedPrice, row.instrument),
        current_pnl: currentPnl,
        stressed_pnl: stressedPnl,
        pnl_delta: pnlDelta
      })

      const agg = byAccount.get(row.account_id) || {
        account_id: row.account_id,
        account_uid: row.account_uid,
        account_type: row.account_type,
        full_name: row.full_name,
        email: row.email,
        trade_count: 0,
        current_pnl: 0,
        stressed_pnl: 0,
        pnl_delta: 0
      }
      agg.trade_count += 1
      agg.current_pnl += currentPnl
      agg.stressed_pnl += stressedPnl
      agg.pnl_delta += pnlDelta
      byAccount.set(row.account_id, agg)
    }

    const accounts = Array.from(byAccount.values()).map(a => ({
      ...a,
      current_pnl: parseFloat(a.current_pnl.toFixed(2)),
      stressed_pnl: parseFloat(a.stressed_pnl.toFixed(2)),
      pnl_delta: parseFloat(a.pnl_delta.toFixed(2))
    })).sort((a, b) => a.pnl_delta - b.pnl_delta)

    const totalCurrent = tradeRows.reduce((s, t) => s + (t.current_pnl || 0), 0)
    const totalStressed = tradeRows.reduce((s, t) => s + (t.stressed_pnl || 0), 0)
    const totalDelta = totalStressed - totalCurrent

    res.json({
      generated_at: new Date(),
      params: {
        shock_pct: shockPct,
        slippage_points: slippagePoints,
        instrument: instrument || 'all'
      },
      summary: {
        open_trades: tradeRows.length,
        affected_accounts: accounts.length,
        current_total_pnl: parseFloat(totalCurrent.toFixed(2)),
        stressed_total_pnl: parseFloat(totalStressed.toFixed(2)),
        pnl_delta: parseFloat(totalDelta.toFixed(2))
      },
      by_account: accounts.slice(0, 300),
      top_trade_impacts: [...tradeRows]
        .sort((a, b) => a.pnl_delta - b.pnl_delta)
        .slice(0, 300)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to run stress simulation' })
  }
})

router.get('/scheduled-reports', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT
         id, report_key, title, channel, recipients, schedule_cron, timezone,
         enabled, last_run_at, next_run_at, created_by, created_at, updated_at
       FROM admin_scheduled_reports
       ORDER BY enabled DESC, updated_at DESC, id DESC
       LIMIT 500`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load scheduled reports' })
  }
})

router.post('/scheduled-reports', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      id = null,
      report_key,
      title,
      channel = 'email',
      recipients = '',
      schedule_cron = '0 9 * * *',
      timezone = 'UTC',
      enabled = true,
      next_run_at = null,
      created_by = 'admin'
    } = req.body || {}

    if (!report_key || String(report_key).trim().length < 2) {
      return res.status(400).json({ error: 'report_key is required (min 2 chars)' })
    }
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 chars)' })
    }
    const safeChannel = ['email', 'web', 'webhook'].includes(String(channel)) ? String(channel) : 'email'
    const nextRun = next_run_at ? new Date(next_run_at) : null
    const parsedNextRun = nextRun && !Number.isNaN(nextRun.getTime()) ? nextRun.toISOString() : null

    const normalizedRecipients = Array.isArray(recipients)
      ? recipients.map(v => String(v || '').trim()).filter(Boolean).join(',')
      : String(recipients || '').trim()

    let saved
    if (id && Number.isFinite(parseInt(id, 10))) {
      const update = await pool.query(
        `UPDATE admin_scheduled_reports
            SET report_key = $2,
                title = $3,
                channel = $4,
                recipients = $5,
                schedule_cron = $6,
                timezone = $7,
                enabled = $8,
                next_run_at = $9::timestamptz,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          parseInt(id, 10),
          String(report_key).trim(),
          String(title).trim(),
          safeChannel,
          normalizedRecipients,
          String(schedule_cron || '0 9 * * *').trim(),
          String(timezone || 'UTC').trim(),
          toBool(enabled, true),
          parsedNextRun
        ]
      )
      if (update.rows.length === 0) return res.status(404).json({ error: 'Scheduled report not found' })
      saved = update.rows[0]
    } else {
      const insert = await pool.query(
        `INSERT INTO admin_scheduled_reports
          (report_key, title, channel, recipients, schedule_cron, timezone, enabled, next_run_at, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, NOW())
         RETURNING *`,
        [
          String(report_key).trim(),
          String(title).trim(),
          safeChannel,
          normalizedRecipients,
          String(schedule_cron || '0 9 * * *').trim(),
          String(timezone || 'UTC').trim(),
          toBool(enabled, true),
          parsedNextRun,
          String(created_by || 'admin').trim()
        ]
      )
      saved = insert.rows[0]
    }

    try {
      await appendImmutableAudit(pool, {
        eventType: 'scheduled_report_saved',
        entityType: 'scheduled_report',
        entityId: String(saved.id),
        payload: {
          report_key: saved.report_key,
          enabled: !!saved.enabled,
          channel: saved.channel
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(saved)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save scheduled report' })
  }
})

router.post('/scheduled-reports/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' })
    const updated = await pool.query(
      `UPDATE admin_scheduled_reports
          SET enabled = NOT enabled,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Scheduled report not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'scheduled_report_toggled',
        entityType: 'scheduled_report',
        entityId: String(id),
        payload: { enabled: !!updated.rows[0].enabled }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(updated.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle scheduled report' })
  }
})

// admin_emergency_kill handler
router.get('/emergency-kill/status', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap([
      'emergency_kill_enabled',
      'emergency_kill_last_triggered_at',
      'emergency_kill_last_reset_at'
    ])
    const openTrades = await pool.query(`SELECT COUNT(*)::int AS c FROM trades WHERE status = 'open'`)
    res.json({
      enabled: toBool(settings.emergency_kill_enabled, false),
      last_triggered_at: settings.emergency_kill_last_triggered_at || null,
      last_reset_at: settings.emergency_kill_last_reset_at || null,
      open_trades: parseInt(openTrades.rows[0]?.c || 0, 10)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load emergency kill status' })
  }
})

router.post('/emergency-kill/execute', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const dryRun = toBool(req.body?.dry_run, false)
    const confirmPhrase = String(req.body?.confirm_phrase || '').trim()
    if (!dryRun && confirmPhrase !== 'KILL ALL TRADES') {
      return res.status(400).json({ error: 'confirm_phrase must be exactly "KILL ALL TRADES"' })
    }

    const preview = await pool.query(
      `SELECT account_id::text AS account_id, COUNT(*)::int AS open_trades
       FROM trades
       WHERE status = 'open'
       GROUP BY account_id
       ORDER BY COUNT(*) DESC`
    )
    const openTradeCount = preview.rows.reduce((sum, r) => sum + parseInt(r.open_trades || 0, 10), 0)
    if (dryRun) {
      return res.json({
        dry_run: true,
        open_trades: openTradeCount,
        affected_accounts: preview.rows.length,
        by_account: preview.rows
      })
    }

    await client.query('BEGIN')
    const accountIdsResult = await client.query(
      `SELECT DISTINCT account_id::text AS account_id FROM trades WHERE status = 'open'`
    )

    let closedTrades = 0
    let totalPnl = 0
    for (const row of accountIdsResult.rows) {
      const closeResult = await forceCloseOpenTradesForAccount(client, row.account_id)
      closedTrades += closeResult.closedCount
      totalPnl += closeResult.totalPnl
    }

    await upsertSetting(client, 'emergency_kill_enabled', 'true')
    await upsertSetting(client, 'emergency_kill_last_triggered_at', new Date().toISOString())

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_executed',
        entityType: 'system',
        entityId: 'global',
        payload: {
          closed_trades: closedTrades,
          affected_accounts: accountIdsResult.rows.length,
          total_pnl: parseFloat(totalPnl.toFixed(2))
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({
      dry_run: false,
      closed_trades: closedTrades,
      affected_accounts: accountIdsResult.rows.length,
      total_pnl: parseFloat(totalPnl.toFixed(2)),
      emergency_kill_enabled: true
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to execute emergency kill switch' })
  } finally {
    client.release()
  }
})

router.post('/emergency-kill/reset', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()

    await client.query('BEGIN')
    await upsertSetting(client, 'emergency_kill_enabled', 'false')
    await upsertSetting(client, 'emergency_kill_last_reset_at', new Date().toISOString())

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_reset',
        entityType: 'system',
        entityId: 'global',
        payload: {}
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({
      emergency_kill_enabled: false,
      last_reset_at: new Date().toISOString()
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reset emergency kill switch' })
  } finally {
    client.release()
  }
})

// -- KYC Document Viewer -----------------------------------------------------------------------
router.get('/kyc/document/:userId/:type', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const { userId, type } = req.params;

    // FIX: kyc.js saves file paths into the `users` table (not `user_kyc`).
    // Column mapping: type='id' -> id_document_path | type='id_back' -> id_document_back_path | type='selfie' -> selfie_path
    const columnName = type === 'selfie' ? 'selfie_path' : type === 'id_back' ? 'id_document_back_path' : 'id_document_path';

    const userRow = await pool.query(
      `SELECT ${columnName} AS doc_path
         FROM users
        WHERE id = $1`,
      [userId]
    );

    if (userRow.rows.length === 0 || !userRow.rows[0].doc_path) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const path = require('path');
    const fs = require('fs');

    // kyc.js stores a relative path like "kyc/userId-id_document-xyz.jpg"
    // Strip any leading "uploads/" prefix in case the DB value includes it.
    const rawPath = userRow.rows[0].doc_path;
    const relPath = rawPath.replace(/^[\/\\\\]?uploads[\/\\\\]/, '');

    const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
    const absoluteFilePath = path.resolve(uploadsRoot, relPath);

    // Path traversal guard -- reject any path that escapes the uploads directory.
    if (!absoluteFilePath.startsWith(uploadsRoot + path.sep)) {
      logger.warn('[kyc-doc] Path traversal attempt blocked:', { rawPath, userId });
      return res.status(400).json({ error: 'Invalid document path' });
    }

    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'File physically missing from server disk' });
    }

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'kyc_document_viewed',
        entityType: 'user',
        entityId: String(userId),
        payload: { type: String(type || 'id') }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    // readKycFileBuffer transparently decrypts `.enc` files (AES-256-GCM at rest)
    // and passes legacy plaintext files straight through, so both eras of upload
    // are served the same way.
    let buffer
    try {
      buffer = readKycFileBuffer(absoluteFilePath).buffer
    } catch (decryptErr) {
      logger.error('[kyc-doc] Failed to decrypt document:', { error: decryptErr.message, userId, type });
      return res.status(500).json({ error: 'Failed to retrieve KYC document' });
    }
    res.setHeader('Content-Type', getKycContentType(absoluteFilePath));
    res.send(buffer);
  } catch (err) {
    logger.error('[kyc-doc] Error serving document:', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve KYC document' });
  }
});
router.__test__ = {
  buildKycDocumentPresencePredicate
}

router._internals = {
  signAdminToken,
  setAdminCookie,
  isBcryptHash,
  looksLikeDefaultSecret,
  normalizeAdminEmail,
  getActivePlatformAdminCount,
  getPlatformAdminByEmail,
  getPlatformAdminById,
  buildAdminJwtPayload,
  buildAdminSessionPayload,
  ensureFeatureTables,
  parsePositiveInteger,
  parseBooleanFilter,
  parseCsvListParam,
  parseListPaging,
  buildPagination,
  paginateRows,
  facetCounts,
  toIsoOrNull,
  normalizeEntityId,
  normalizeAdminTag,
  normalizeEntityType,
  getAdminOwnerId,
  getAdminActorLabel,
  buildAdminActorPayload,
  wantsAdminListContract,
  computeUserLifecycleStage,
  computeAccountLifecycleStage,
  computePayoutComplianceStatus,
  buildSavedViewCapabilities,
  normalizeAccountSnapshot,
  normalizeUserSnapshot,
  normalizePayoutSnapshot,
  normalizeViolationSnapshot,
  buildAllowedAccountActions,
  buildAllowedUserActions,
  buildAllowedPayoutActions,
  buildAllowedViolationActions,
  forceCloseOpenTradesForAccount,
  cancelPendingTradesForAccount,
  forceCloseTradeById,
  calcTradePnl,
  upsertAdminEntityMeta,
  computePhaseEndDateForAccountType,
  appendImmutableAudit,
  buildKycDocumentPresencePredicate,
  getExposureData,
  buildAccountListResult,
}
module.exports = router;
