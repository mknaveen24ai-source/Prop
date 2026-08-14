// Email job queue list contract, shared by the /export and /email-jobs routes.
const pool = require('../../../db')
const { ensureEmailQueueInfrastructure } = require('../../../utils/emailQueue')
const { facetCounts, buildSavedViewCapabilities, buildPagination } = require('./helpers')

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

module.exports = { buildAllowedEmailJobActions, buildEmailJobListResult }
