// The three admin list-contract builders (traders / accounts / payouts) plus
// admin-issued account creation, moved verbatim from routes/admin.js during the
// admin modularization.
const pool = require('../../../db')
const { generateAccountUid } = require('../../../utils/accountIds')
const {
  buildKycDocumentPresencePredicate,
  buildSavedViewCapabilities,
  buildAllowedAccountActions,
  buildAllowedUserActions,
  buildAllowedPayoutActions,
  computeAccountLifecycleStage,
  computePayoutComplianceStatus,
  computeUserLifecycleStage,
  computePhaseEndDateForAccountType,
  facetCounts,
  paginateRows,
  parseCsvListParam,
  buildPagination,
  toIsoOrNull
} = require('./helpers')
const { ensureDisputesInfrastructure } = require('../../disputes')

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
        u.trader_uid,
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

  // Admin-issued/replacement accounts never carry a challenge_model_slug (this
  // path predates the step-model system), so generateAccountUid falls back to
  // its 2-step default for category purposes — see utils/accountIds.js.
  const accountUid = await generateAccountUid(client, { accountType: normalizedType, challengeModelSlug: null })

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
      accountUid
    ]
  )

  return result.rows[0]
}

module.exports = {
  buildTraderListResult,
  buildAccountListResult,
  buildPayoutListResult,
  createAdminIssuedAccount
}
