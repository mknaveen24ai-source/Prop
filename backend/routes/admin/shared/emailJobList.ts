// Email job queue list contract, shared by the /export and /email-jobs routes.

import type {
  AdminEmailJobAction,
  AdminEmailJobDeliveryType,
  AdminEmailJobDto,
  AdminEmailJobListResultDto,
  AdminListPaginationDto,
  AdminSavedViewCapabilitiesDto
} from '@propfirm/contracts'
import type { QueryResultRow } from 'pg'
import pool = require('../../../db')
import { jsonValueSchema, parseExternal } from '../../../validation/unknown'

interface EmailQueueApi {
  ensureEmailQueueInfrastructure: () => Promise<void>
}

interface HelperApi {
  buildPagination: (input: { page: number; pageSize: number; total: number }) => AdminListPaginationDto
  buildSavedViewCapabilities: (resource: string) => AdminSavedViewCapabilitiesDto
  facetCounts: <Row>(rows: readonly Row[], selector: (row: Row) => unknown) => Record<string, number>
}

interface EmailJobRow extends QueryResultRow {
  id: string
  user_id: string | null
  to_email: string
  template_key: string
  payload_json: unknown
  status: string
  attempt_count: number | string
  last_error: string | null
  provider_message_id: string | null
  preview_url: string | null
  unique_key: string | null
  scheduled_for: Date | string
  last_attempt_at: Date | string | null
  sent_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
  full_name_hint: string
  delivery_type: AdminEmailJobDeliveryType | null
}

interface CountRow extends QueryResultRow {
  count: number | string
}

interface SummaryRow extends QueryResultRow {
  total: number | string
  pending: number | string
  sending: number | string
  retry: number | string
  sent: number | string
  dead: number | string
}

interface FacetRow extends QueryResultRow {
  key: string
  count: number | string
}

interface EmailJobFilterInput {
  status?: unknown
  template_key?: unknown
  delivery_type?: unknown
}

interface EmailJobListQueryInput {
  search?: unknown
  page?: unknown
  pageSize?: unknown
  filters?: unknown
  sort?: unknown
  order?: unknown
}

interface EmailJobListInput {
  query?: EmailJobListQueryInput
}

const { ensureEmailQueueInfrastructure } = require('../../../utils/emailQueue') as EmailQueueApi
const {
  facetCounts,
  buildSavedViewCapabilities,
  buildPagination
} = require('./helpers') as HelperApi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filtersFrom(value: unknown): EmailJobFilterInput {
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

function buildAllowedEmailJobActions(job: Pick<EmailJobRow, 'preview_url' | 'status'>): AdminEmailJobAction[] {
  const status = String(job.status || '').toLowerCase()
  const actions: AdminEmailJobAction[] = ['preview_email_job']
  if (['retry', 'dead', 'failed'].includes(status)) actions.push('retry_email_job')
  if (job.preview_url) actions.push('copy_preview_path')
  return actions
}

function mapEmailJob(row: EmailJobRow): AdminEmailJobDto {
  return {
    id: String(row.id),
    user_id: row.user_id,
    to_email: row.to_email,
    template_key: row.template_key,
    payload_json: parseExternal(jsonValueSchema, row.payload_json, 'email_jobs.payload_json'),
    status: row.status,
    attempt_count: integer(row.attempt_count),
    last_error: row.last_error,
    provider_message_id: row.provider_message_id,
    preview_url: row.preview_url,
    unique_key: row.unique_key,
    scheduled_for: isoTimestamp(row.scheduled_for),
    last_attempt_at: nullableIsoTimestamp(row.last_attempt_at),
    sent_at: nullableIsoTimestamp(row.sent_at),
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
    full_name_hint: row.full_name_hint,
    delivery_type: row.delivery_type || 'transactional',
    allowed_actions: buildAllowedEmailJobActions(row)
  }
}

async function buildEmailJobListResult(
  { query = {} }: EmailJobListInput = {}
): Promise<AdminEmailJobListResultDto> {
  await ensureEmailQueueInfrastructure()

  const search = String(query.search || '').trim().toLowerCase()
  const page = typeof query.page === 'number' && Number.isFinite(query.page) ? query.page : 1
  const pageSize = typeof query.pageSize === 'number' && Number.isFinite(query.pageSize) ? query.pageSize : 25
  const filters = filtersFrom(query.filters)
  const sortKey = String(query.sort || 'created_at').trim().toLowerCase()
  const sortDirection = String(query.order || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC'
  const where: string[] = []
  const params: unknown[] = []
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
  }
  if (filters.delivery_type === 'automation') where.push('ej.unique_key IS NOT NULL')
  else if (filters.delivery_type === 'transactional') where.push('ej.unique_key IS NULL')

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const orderByMap: Readonly<Record<string, string>> = {
    id: 'ej.id',
    created_at: 'ej.created_at',
    scheduled_for: 'ej.scheduled_for',
    sent_at: 'ej.sent_at',
    status: 'ej.status',
    template_key: 'ej.template_key',
    to_email: 'ej.to_email',
    attempt_count: 'ej.attempt_count'
  }
  const orderBy = orderByMap[sortKey] || orderByMap.created_at || 'ej.created_at'
  const offset = Math.max(0, (page - 1) * pageSize)
  const listValues = [...params, pageSize, offset]

  const rowsResult = await pool.query<EmailJobRow>(
    `SELECT ej.id, ej.user_id, ej.to_email, ej.template_key, ej.payload_json,
            ej.status, ej.attempt_count, ej.last_error, ej.provider_message_id,
            ej.preview_url, ej.unique_key, ej.scheduled_for, ej.last_attempt_at,
            ej.sent_at, ej.created_at, ej.updated_at,
            COALESCE(ej.payload_json->>'fullName', '') AS full_name_hint,
            CASE WHEN ej.unique_key IS NULL THEN 'transactional' ELSE 'automation' END AS delivery_type
       FROM email_jobs ej
       ${whereClause}
       ORDER BY ${orderBy} ${sortDirection}, ej.id DESC
       LIMIT $${listValues.length - 1}
       OFFSET $${listValues.length}`,
    listValues
  )
  const totalResult = await pool.query<CountRow>(
    `SELECT COUNT(*)::int AS count FROM email_jobs ej ${whereClause}`,
    params
  )
  const summaryResult = await pool.query<SummaryRow>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ej.status = 'pending')::int AS pending,
            COUNT(*) FILTER (WHERE ej.status = 'sending')::int AS sending,
            COUNT(*) FILTER (WHERE ej.status = 'retry')::int AS retry,
            COUNT(*) FILTER (WHERE ej.status = 'sent')::int AS sent,
            COUNT(*) FILTER (WHERE ej.status = 'dead')::int AS dead
       FROM email_jobs ej ${whereClause}`,
    params
  )
  const statusFacetResult = await pool.query<FacetRow>(
    `SELECT COALESCE(ej.status, 'pending') AS key, COUNT(*)::int AS count
       FROM email_jobs ej ${whereClause}
       GROUP BY COALESCE(ej.status, 'pending')
       ORDER BY count DESC, key ASC`,
    params
  )
  const templateFacetResult = await pool.query<FacetRow>(
    `SELECT COALESCE(ej.template_key, 'unknown') AS key, COUNT(*)::int AS count
       FROM email_jobs ej ${whereClause}
       GROUP BY COALESCE(ej.template_key, 'unknown')
       ORDER BY count DESC, key ASC`,
    params
  )

  const rows = rowsResult.rows.map(mapEmailJob)
  const statusFacets: Record<string, number> = {}
  for (const row of statusFacetResult.rows) statusFacets[row.key] = integer(row.count)
  const templateFacets: Record<string, number> = {}
  for (const row of templateFacetResult.rows) templateFacets[row.key] = integer(row.count)
  const summary = summaryResult.rows[0]

  return {
    summary: {
      total: integer(summary?.total),
      pending: integer(summary?.pending),
      sending: integer(summary?.sending),
      retry: integer(summary?.retry),
      sent: integer(summary?.sent),
      dead: integer(summary?.dead)
    },
    rows,
    pagination: buildPagination({
      page,
      pageSize,
      total: integer(totalResult.rows[0]?.count)
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

export { buildAllowedEmailJobActions, buildEmailJobListResult, mapEmailJob }
