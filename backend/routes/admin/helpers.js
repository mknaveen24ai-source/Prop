'use strict'
/**
 * Admin Shared Helpers & Utilities
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from the monolithic admin.js so every sub-router can import
 * only what it needs without duplicating code.
 *
 * Exports:
 *  - Helper functions (normalise, build, parse)
 *  - Fetch helpers (fetchAccountForAdmin, fetchUserForAdmin, fetchPayoutForAdmin)
 *  - Snapshot normalisers (normalizeAccountSnapshot, etc.)
 *  - Action builders (buildAllowedAccountActions, etc.)
 *  - Pagination helpers (parseListPaging, buildPagination, etc.)
 *  - CSV serialiser (serializeCsv)
 */

const pool = require('../../db')
const { emitAdminEvent } = require('../../utils/realtime')
const { DEFAULT_TENANT_SLUG } = require('../../utils/tenants')

// ── Entity ID / admin identity ────────────────────────────────────────────────

function getScopedTenantId(req) {
  if (req.admin?.tenantId) return parseInt(req.admin.tenantId, 10) || null
  if (req.tenant?.id && req.tenant?.slug && req.tenant.slug !== DEFAULT_TENANT_SLUG) return req.tenant.id
  return null
}

function getAdminActorLabel(admin) {
  const role = String(admin?.role || 'admin')
  const identity = admin?.email || admin?.full_name || admin?.adminId || 'unknown'
  return `${role}:${identity}`
}

function buildAdminActorPayload(admin) {
  return {
    admin_id:  admin?.adminId || null,
    role:      admin?.role || null,
    email:     admin?.email || null,
    full_name: admin?.full_name || null,
    tenant_id: admin?.tenantId || null,
  }
}

function getAdminOwnerId(admin) {
  return String(admin?.adminId || admin?.email || admin?.role || 'admin')
}

function normalizeEntityId(value) {
  const normalized = String(value || '').trim()
  return normalized ? normalized.slice(0, 128) : null
}

function normalizeAdminEmail(email) {
  return String(email || '').trim().toLowerCase()
}

function normalizeAdminTag(value) {
  const normalized = String(value || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return normalized || null
}

function normalizeEntityType(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return ['user', 'account', 'payout', 'trade', 'case', 'violation', 'dispute'].includes(normalized)
    ? normalized : null
}

// ── Error factory ────────────────────────────────────────────────────────────

function createHttpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function requireReasonText(value, fieldName = 'reason') {
  const reason = String(value || '').trim()
  if (reason.length < 5) throw createHttpError(`A clear ${fieldName} is required`, 400)
  return reason.slice(0, 1000)
}

// ── Parsing / filtering ──────────────────────────────────────────────────────

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

function parseCsvListParam(value, { normalize = true } = {}) {
  if (value == null || value === '') return []
  const parts = Array.isArray(value) ? value : String(value).split(',')
  return parts
    .map(part => String(part || '').trim())
    .filter(Boolean)
    .map(part => normalize ? part.toLowerCase() : part)
}

function wantsAdminListContract(req) {
  const format = String(req.query?.format || '').trim().toLowerCase()
  return format === 'list' || format === 'v2'
}

// ── Pagination ────────────────────────────────────────────────────────────────

function parseListPaging(req, { defaultPageSize = 25, maxPageSize = 100 } = {}) {
  const page = parsePositiveInteger(req.query?.page, { fallback: 1, min: 1, max: 100000 }) || 1
  const pageSize = parsePositiveInteger(req.query?.page_size, { fallback: defaultPageSize, min: 1, max: maxPageSize }) || defaultPageSize
  return { page, pageSize }
}

function buildPagination({ page, pageSize, total }) {
  const totalItems = Math.max(0, parseInt(total || 0, 10) || 0)
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  return {
    current:     Math.min(page, totalPages),
    total:       totalPages,
    total_items: totalItems,
    page_size:   pageSize,
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
      value.forEach(item => {
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

// ── Date utility ─────────────────────────────────────────────────────────────

function toIsoOrNull(value) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

// ── Lifecycle computers ──────────────────────────────────────────────────────

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

// ── Snapshot normalisers ─────────────────────────────────────────────────────

function normalizeAccountSnapshot(account) {
  if (!account) return null
  return {
    id:               account.id,
    tenant_id:        account.tenant_id || null,
    user_id:          account.user_id,
    account_type:     account.account_type,
    account_size:     account.account_size,
    status:           account.status,
    current_balance:  parseFloat(account.current_balance || 0),
    starting_balance: parseFloat(account.starting_balance || 0),
    peak_balance:     parseFloat(account.peak_balance || 0),
    profit_target:    parseFloat(account.profit_target || 0),
    max_drawdown_pct: parseFloat(account.max_drawdown_pct || 0),
    phase_start_date: account.phase_start_date || null,
    phase_end_date:   account.phase_end_date || null,
    review_flagged:   !!account.review_flagged,
    review_flag_reason: account.review_flag_reason || null,
    account_uid:      account.account_uid || null,
  }
}

function normalizeUserSnapshot(user) {
  if (!user) return null
  return {
    id:            user.id,
    tenant_id:     user.tenant_id || null,
    email:         user.email || null,
    full_name:     user.full_name || null,
    is_banned:     !!user.is_banned,
    kyc_status:    user.kyc_status || null,
    token_version: parseInt(user.token_version || 1, 10),
  }
}

function normalizePayoutSnapshot(payout) {
  if (!payout) return null
  return {
    id:               payout.id,
    tenant_id:        payout.tenant_id || null,
    user_id:          payout.user_id || null,
    account_id:       payout.account_id || null,
    status:           payout.status || null,
    is_flagged:       !!payout.is_flagged,
    flag_reason:      payout.flag_reason || null,
    admin_notes:      payout.admin_notes || null,
    amount_requested: parseFloat(payout.amount_requested || 0),
    amount_payable:   parseFloat(payout.amount_payable || 0),
  }
}

function normalizeViolationSnapshot(violation) {
  if (!violation) return null
  return {
    id:               violation.id,
    tenant_id:        violation.tenant_id || null,
    account_id:       violation.account_id || null,
    user_id:          violation.user_id || null,
    violation_type:   violation.violation_type || null,
    severity:         violation.severity || null,
    status:           violation.status || null,
    resolution_note:  violation.resolution_note || null,
    resolution_type:  violation.resolution_type || null,
  }
}

// ── Allowed action builders ──────────────────────────────────────────────────

function buildAllowedAccountActions(account) {
  if (!account) return []
  const actions = ['open_account_detail', 'force_close_open_trades']
  const status = String(account.status || '').toLowerCase()
  const accountType = String(account.account_type || '').toLowerCase()

  if (['phase1', 'phase2'].includes(accountType) && status === 'active') actions.push('pass', 'fail', 'extend_days')
  if (accountType === 'funded' && status === 'active') actions.push('revoke_funded')
  if (['failed', 'locked'].includes(status)) actions.push('restore_active')
  if (['phase1', 'phase2'].includes(accountType) && ['failed', 'locked', 'expired'].includes(status)) {
    actions.push('restore_with_reset', 'replace_account')
  } else if (!['active', 'passed'].includes(status)) {
    actions.push('replace_account')
  }
  if (status !== 'locked') actions.push('lock_account')
  if (['phase1', 'phase2'].includes(accountType) && status !== 'passed') actions.push('extend_days')
  if (account.review_flagged) actions.push('clear_review_flag')
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

function buildSavedViewCapabilities(resource) {
  return { resource, can_save: true, can_update: true, can_delete: true }
}

// ── DB fetch helpers ─────────────────────────────────────────────────────────

async function fetchAccountForAdmin(client, accountId, tenantId = null, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT a.id, a.tenant_id, a.user_id, a.account_type, a.account_size,
            a.current_balance, a.starting_balance, a.peak_balance, a.status,
            a.max_drawdown_pct, a.profit_target, a.phase_start_date, a.phase_end_date,
            a.account_uid, a.review_flagged, a.review_flag_reason,
            u.email AS user_email, u.full_name
       FROM accounts a
       JOIN users u ON u.id = a.user_id
      WHERE a.id = $1
        AND ($2::bigint IS NULL OR COALESCE(a.tenant_id, u.tenant_id, $2) = $2)
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [String(accountId), tenantId]
  )
  return result.rows[0] || null
}

async function fetchUserForAdmin(client, userId, tenantId = null, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT id, tenant_id, email, full_name, kyc_status, is_banned, token_version
       FROM users
      WHERE id = $1
        AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [normalizeEntityId(userId), tenantId]
  )
  return result.rows[0] || null
}

async function fetchPayoutForAdmin(client, payoutId, tenantId = null, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT p.id, p.tenant_id, p.user_id, p.account_id, p.amount_requested, p.amount_payable,
            p.status, p.is_flagged, p.flag_reason, p.admin_notes, p.requested_at,
            u.email, u.full_name
       FROM payouts p
       JOIN users u ON u.id = p.user_id
      WHERE p.id = $1
        AND ($2::bigint IS NULL OR COALESCE(p.tenant_id, u.tenant_id, $2) = $2)
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [parseInt(payoutId, 10), tenantId]
  )
  return result.rows[0] || null
}

// ── CSV serialiser ────────────────────────────────────────────────────────────

function serializeCsv(rows, columns) {
  const escapeValue = (value) => {
    const normalized = value == null ? '' : String(value)
    if (/[",\n]/.test(normalized)) return `"${normalized.replace(/"/g, '""')}"`
    return normalized
  }
  const header = columns.map(column => escapeValue(column.header)).join(',')
  const body = rows.map(row =>
    columns.map(column => escapeValue(typeof column.value === 'function' ? column.value(row) : row[column.key])).join(',')
  )
  return [header, ...body].join('\n')
}

// ── Realtime event ────────────────────────────────────────────────────────────

async function emitSuperAdminPowerEvent(req, tenantId, payload = {}) {
  emitAdminEvent('admin_command_center_updated', { ...payload, tenant_id: tenantId || null }, tenantId || null)
}

module.exports = {
  // Identity
  getScopedTenantId,
  getAdminActorLabel,
  buildAdminActorPayload,
  getAdminOwnerId,
  normalizeEntityId,
  normalizeAdminEmail,
  normalizeAdminTag,
  normalizeEntityType,
  // Errors
  createHttpError,
  requireReasonText,
  // Parsing
  parsePositiveInteger,
  parseBooleanFilter,
  parseCsvListParam,
  wantsAdminListContract,
  // Pagination
  parseListPaging,
  buildPagination,
  paginateRows,
  facetCounts,
  // Date
  toIsoOrNull,
  // Lifecycle
  computeUserLifecycleStage,
  computeAccountLifecycleStage,
  computePayoutComplianceStatus,
  // Snapshots
  normalizeAccountSnapshot,
  normalizeUserSnapshot,
  normalizePayoutSnapshot,
  normalizeViolationSnapshot,
  // Actions
  buildAllowedAccountActions,
  buildAllowedUserActions,
  buildAllowedPayoutActions,
  buildAllowedViolationActions,
  buildSavedViewCapabilities,
  // DB fetch
  fetchAccountForAdmin,
  fetchUserForAdmin,
  fetchPayoutForAdmin,
  // CSV
  serializeCsv,
  // Realtime
  emitSuperAdminPowerEvent,
}
