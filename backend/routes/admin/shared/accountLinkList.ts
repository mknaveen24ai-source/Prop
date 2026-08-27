// Account-linking cluster list contract, shared by /account-links and /export.

import type {
  AdminAccountLinkAction,
  AdminAccountLinkClusterDto,
  AdminAccountLinkListResultDto,
  AdminListPaginationDto,
  AdminSavedViewCapabilitiesDto
} from '@propfirm/contracts'
import type { QueryResultRow } from 'pg'
import pool = require('../../../db')
import { jsonValueSchema, parseExternal } from '../../../validation/unknown'

interface HelperApi {
  buildPagination: (input: { page: number; pageSize: number; total: number }) => AdminListPaginationDto
  buildSavedViewCapabilities: (resource: string) => AdminSavedViewCapabilitiesDto
  parseCsvListParam: (value: unknown) => string[]
}

interface AccountLinkClusterRow extends QueryResultRow {
  id: string
  cluster_key: string
  score: number
  confidence: string
  member_user_ids: string[] | null
  member_count: number
  signal_types: string[] | null
  signal_summary: unknown
  status: string
  first_detected_at: Date | string
  last_detected_at: Date | string
  resolved_at: Date | string | null
  resolved_by: string | null
  resolution_note: string | null
  member_emails: string[] | null
  member_names: string[] | null
  evidence_count: number | string
}

interface CountRow extends QueryResultRow {
  count: number | string
}

interface AccountLinkSummaryRow extends QueryResultRow {
  total: number | string
  open: number | string
  high_confidence: number | string
  confirmed: number | string
  false_positive: number | string
  users_involved: number | string
}

interface AccountLinkFacetRow extends QueryResultRow {
  confidence: string
  status: string
  count: number | string
}

interface AccountLinkFilters {
  status?: unknown
  confidence?: unknown
  signal_types?: unknown
  min_score?: unknown
}

interface AccountLinkListQuery {
  search?: unknown
  page?: unknown
  pageSize?: unknown
  filters?: unknown
  sort?: unknown
  order?: unknown
}

interface AccountLinkListInput {
  query?: AccountLinkListQuery
}

const {
  buildSavedViewCapabilities,
  buildPagination,
  parseCsvListParam
} = require('./helpers') as HelperApi

const SORTABLE_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  score: 'c.score',
  confidence: 'c.score',
  member_count: 'c.member_count',
  first_detected_at: 'c.first_detected_at',
  last_detected_at: 'c.last_detected_at',
  status: 'c.status'
})

const RESOLVABLE_STATUSES = Object.freeze([
  'open',
  'monitoring',
  'confirmed_sharing',
  'false_positive'
] as const)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filtersFrom(value: unknown): AccountLinkFilters {
  return isRecord(value) ? value : {}
}

function integer(value: number | string | undefined): number {
  return Number.parseInt(String(value || 0), 10) || 0
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value)
}

function buildAllowedAccountLinkActions(
  cluster: Pick<AccountLinkClusterRow, 'status'>
): AdminAccountLinkAction[] {
  const status = String(cluster.status || '').toLowerCase()
  const actions: AdminAccountLinkAction[] = ['view_evidence', 'view_graph']
  if (status === 'open' || status === 'monitoring') {
    actions.push('confirm_sharing', 'mark_false_positive', 'mark_monitoring')
  } else {
    actions.push('reopen_cluster')
  }
  return actions
}

function mapAccountLinkCluster(row: AccountLinkClusterRow): AdminAccountLinkClusterDto {
  return {
    id: String(row.id),
    cluster_key: row.cluster_key,
    score: row.score,
    confidence: row.confidence,
    member_user_ids: (row.member_user_ids || []).map(String),
    member_count: row.member_count,
    signal_types: row.signal_types || [],
    signal_summary: parseExternal(
      jsonValueSchema,
      row.signal_summary,
      'account_link_clusters.signal_summary'
    ),
    status: row.status,
    first_detected_at: isoTimestamp(row.first_detected_at),
    last_detected_at: isoTimestamp(row.last_detected_at),
    resolved_at: nullableIsoTimestamp(row.resolved_at),
    resolved_by: row.resolved_by,
    resolution_note: row.resolution_note,
    member_emails: row.member_emails || [],
    member_names: row.member_names || [],
    evidence_count: integer(row.evidence_count),
    allowed_actions: buildAllowedAccountLinkActions(row)
  }
}

async function buildAccountLinkListResult(
  { query = {} }: AccountLinkListInput = {}
): Promise<AdminAccountLinkListResultDto> {
  const search = String(query.search || '').trim().toLowerCase()
  const page = typeof query.page === 'number' && Number.isFinite(query.page) ? query.page : 1
  const pageSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = filtersFrom(query.filters)
  const sortKey = String(query.sort || 'score').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const where: string[] = []
  const params: unknown[] = []
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
  if (typeof filters.min_score === 'number' && Number.isFinite(filters.min_score)) {
    params.push(filters.min_score)
    where.push(`c.score >= $${index}`)
    index += 1
  }
  if (search) {
    params.push(`%${search}%`)
    where.push(`EXISTS (
      SELECT 1 FROM users u
       WHERE u.id = ANY(c.member_user_ids)
         AND (LOWER(u.email) LIKE $${index} OR LOWER(COALESCE(u.full_name, '')) LIKE $${index})
    )`)
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const orderBy = SORTABLE_COLUMNS[sortKey] || SORTABLE_COLUMNS.score || 'c.score'
  const listValues = [...params, pageSize, (page - 1) * pageSize]
  const listResult = await pool.query<AccountLinkClusterRow>(
    `SELECT c.id, c.cluster_key, c.score, c.confidence, c.member_user_ids,
            c.member_count, c.signal_types, c.signal_summary, c.status,
            c.first_detected_at, c.last_detected_at, c.resolved_at,
            c.resolved_by, c.resolution_note, members.member_emails,
            members.member_names, COALESCE(ev.evidence_count, 0) AS evidence_count
       FROM account_link_clusters c
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(u.email ORDER BY u.email) AS member_emails,
                ARRAY_AGG(COALESCE(u.full_name, '') ORDER BY u.email) AS member_names
           FROM users u WHERE u.id = ANY(c.member_user_ids)
       ) members ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS evidence_count
           FROM account_link_evidence e WHERE e.cluster_id = c.id
       ) ev ON TRUE
       ${whereClause}
       ORDER BY ${orderBy} ${sortDirection}, c.id DESC
       LIMIT $${listValues.length - 1}
       OFFSET $${listValues.length}`,
    listValues
  )
  const totalResult = await pool.query<CountRow>(
    `SELECT COUNT(*)::int AS count FROM account_link_clusters c ${whereClause}`,
    params
  )
  const summaryResult = await pool.query<AccountLinkSummaryRow>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE c.status = 'open')::int AS open,
            COUNT(*) FILTER (WHERE c.confidence = 'high')::int AS high_confidence,
            COUNT(*) FILTER (WHERE c.status = 'confirmed_sharing')::int AS confirmed,
            COUNT(*) FILTER (WHERE c.status = 'false_positive')::int AS false_positive,
            COALESCE(SUM(c.member_count) FILTER (WHERE c.status = 'open'), 0)::int AS users_involved
       FROM account_link_clusters c ${whereClause}`,
    params
  )
  const facetResult = await pool.query<AccountLinkFacetRow>(
    `SELECT c.confidence, c.status, COUNT(*)::int AS count
       FROM account_link_clusters c ${whereClause}
       GROUP BY c.confidence, c.status`,
    params
  )

  const facets = {
    confidence: {} as Record<string, number>,
    status: {} as Record<string, number>
  }
  for (const row of facetResult.rows) {
    facets.confidence[row.confidence] = (facets.confidence[row.confidence] || 0) + integer(row.count)
    facets.status[row.status] = (facets.status[row.status] || 0) + integer(row.count)
  }
  const rows = listResult.rows.map(mapAccountLinkCluster)
  const summary = summaryResult.rows[0]

  return {
    summary: {
      total: integer(summary?.total),
      open: integer(summary?.open),
      high_confidence: integer(summary?.high_confidence),
      confirmed: integer(summary?.confirmed),
      false_positive: integer(summary?.false_positive),
      users_involved: integer(summary?.users_involved)
    },
    rows,
    pagination: buildPagination({
      page,
      pageSize,
      total: integer(totalResult.rows[0]?.count)
    }),
    facets,
    default_sort: { key: 'score', direction: 'desc' },
    saved_view_capabilities: buildSavedViewCapabilities('account_links'),
    allRows: rows
  }
}

export {
  RESOLVABLE_STATUSES,
  buildAccountLinkListResult,
  buildAllowedAccountLinkActions,
  mapAccountLinkCluster
}
