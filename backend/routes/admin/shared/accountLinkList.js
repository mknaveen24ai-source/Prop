// Account-linking cluster list contract, shared by the /account-links and
// /export routes.
//
// Paginates in SQL rather than in JS like the trader/account/payout builders do.
// Those slice a fully-materialized result set with paginateRows(); this table
// grows with every detected cluster and has no natural ceiling, so it follows
// the emailJobList.js pattern instead.
const pool = require('../../../db')
const {
  buildSavedViewCapabilities,
  buildPagination,
  parseCsvListParam
} = require('./helpers')

const SORTABLE_COLUMNS = Object.freeze({
  score: 'c.score',
  confidence: 'c.score',
  member_count: 'c.member_count',
  first_detected_at: 'c.first_detected_at',
  last_detected_at: 'c.last_detected_at',
  status: 'c.status'
})

const RESOLVABLE_STATUSES = Object.freeze([
  'open', 'monitoring', 'confirmed_sharing', 'false_positive'
])

function buildAllowedAccountLinkActions (cluster) {
  const status = String(cluster?.status || '').toLowerCase()
  const actions = ['view_evidence', 'view_graph']
  if (status === 'open' || status === 'monitoring') {
    actions.push('confirm_sharing', 'mark_false_positive', 'mark_monitoring')
  } else {
    actions.push('reopen_cluster')
  }
  return actions
}

async function buildAccountLinkListResult ({ query = {} } = {}) {
  const search = String(query.search || '').trim().toLowerCase()
  const page = Number.isFinite(query.page) ? query.page : 1
  const pageSize = Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = query.filters || {}
  const sortKey = String(query.sort || 'score').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'

  const where = []
  const params = []
  let index = 1

  if (filters.status) {
    params.push(String(filters.status).toLowerCase())
    where.push(`LOWER(c.status) = $${index}`)
    index += 1
  }

  if (filters.confidence) {
    params.push(String(filters.confidence).toLowerCase())
    where.push(`LOWER(c.confidence) = $${index}`)
    index += 1
  }

  const signalTypes = parseCsvListParam(filters.signal_types || [])
  if (signalTypes.length > 0) {
    params.push(signalTypes)
    where.push(`c.signal_types && $${index}::text[]`)
    index += 1
  }

  if (Number.isFinite(filters.min_score)) {
    params.push(filters.min_score)
    where.push(`c.score >= $${index}`)
    index += 1
  }

  // Search matches any member's email or name, so an admin can pivot from a
  // trader they are already looking at straight to the ring they belong to.
  if (search) {
    params.push(`%${search}%`)
    where.push(`EXISTS (
      SELECT 1 FROM users u
       WHERE u.id = ANY(c.member_user_ids)
         AND (LOWER(u.email) LIKE $${index} OR LOWER(COALESCE(u.full_name, '')) LIKE $${index})
    )`)
    index += 1
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const orderBy = SORTABLE_COLUMNS[sortKey] || SORTABLE_COLUMNS.score

  const listValues = [...params, pageSize, (page - 1) * pageSize]

  const listResult = await pool.query(
    `SELECT
        c.id,
        c.cluster_key,
        c.score,
        c.confidence,
        c.member_user_ids,
        c.member_count,
        c.signal_types,
        c.signal_summary,
        c.status,
        c.first_detected_at,
        c.last_detected_at,
        c.resolved_at,
        c.resolved_by,
        c.resolution_note,
        members.member_emails,
        members.member_names,
        COALESCE(ev.evidence_count, 0) AS evidence_count
      FROM account_link_clusters c
      LEFT JOIN LATERAL (
        SELECT ARRAY_AGG(u.email ORDER BY u.email)                    AS member_emails,
               ARRAY_AGG(COALESCE(u.full_name, '') ORDER BY u.email)  AS member_names
          FROM users u
         WHERE u.id = ANY(c.member_user_ids)
      ) members ON TRUE
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS evidence_count
          FROM account_link_evidence e
         WHERE e.cluster_id = c.id
      ) ev ON TRUE
      ${whereClause}
      ORDER BY ${orderBy} ${sortDirection}, c.id DESC
      LIMIT $${listValues.length - 1}
      OFFSET $${listValues.length}`,
    listValues
  )

  const totalResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM account_link_clusters c ${whereClause}`,
    params
  )

  // Summary is deliberately unfiltered apart from the caller's filters, so the
  // stat cards describe the same set the table is showing.
  const summaryResult = await pool.query(
    `SELECT
        COUNT(*)::int                                                        AS total,
        COUNT(*) FILTER (WHERE c.status = 'open')::int                       AS open,
        COUNT(*) FILTER (WHERE c.confidence = 'high')::int                   AS high_confidence,
        COUNT(*) FILTER (WHERE c.status = 'confirmed_sharing')::int          AS confirmed,
        COUNT(*) FILTER (WHERE c.status = 'false_positive')::int             AS false_positive,
        COALESCE(SUM(c.member_count) FILTER (WHERE c.status = 'open'), 0)::int AS users_involved
      FROM account_link_clusters c
      ${whereClause}`,
    params
  )

  const facetResult = await pool.query(
    `SELECT c.confidence, c.status, COUNT(*)::int AS count
       FROM account_link_clusters c
       ${whereClause}
      GROUP BY c.confidence, c.status`,
    params
  )

  const facets = { confidence: {}, status: {} }
  for (const row of facetResult.rows) {
    facets.confidence[row.confidence] = (facets.confidence[row.confidence] || 0) + row.count
    facets.status[row.status] = (facets.status[row.status] || 0) + row.count
  }

  const rows = listResult.rows.map(row => ({
    ...row,
    member_user_ids: (row.member_user_ids || []).map(String),
    member_emails: row.member_emails || [],
    member_names: row.member_names || [],
    signal_types: row.signal_types || [],
    allowed_actions: buildAllowedAccountLinkActions(row)
  }))

  return {
    summary: summaryResult.rows[0] || {},
    rows,
    pagination: buildPagination({ page, pageSize, total: totalResult.rows[0]?.count || 0 }),
    facets,
    default_sort: { key: 'score', direction: 'desc' },
    saved_view_capabilities: buildSavedViewCapabilities('account_links'),
    allRows: rows
  }
}

module.exports = {
  buildAccountLinkListResult,
  buildAllowedAccountLinkActions,
  RESOLVABLE_STATUSES
}
