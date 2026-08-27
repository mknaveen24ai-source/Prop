// Admin email job queue listing and retry.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

import type {
  AdminEmailJobListResultDto,
  LegacyErrorResponse
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import pool = require('../../db')
import '../../loadEnv'
import logger = require('../../utils/logger')

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
}

interface EmailQueueApi {
  ensureEmailQueueInfrastructure: () => Promise<void>
}

interface FeatureSchemaApi {
  ensureFeatureTables: () => Promise<void>
}

interface ListPaging {
  page: number
  pageSize: number
}

interface AdminHelpersApi {
  parseListPaging: (req: ExpressRequest) => ListPaging
  wantsAdminListContract: (req: ExpressRequest) => boolean
}

interface EmailJobListQuery {
  page: number
  pageSize: number
  search: unknown
  sort: unknown
  order: unknown
  filters: {
    status: unknown
    template_key: unknown
    delivery_type: unknown
  }
}

interface EmailJobListApi {
  buildEmailJobListResult: (input: { query: EmailJobListQuery }) => Promise<AdminEmailJobListResultDto>
}

interface EmailJobStatusRow extends QueryResultRow {
  id: string
  status: string | null
}

interface EmailJobParams {
  [key: string]: string
  jobId: string
}

/** Existing retry wire format keeps this legacy numeric identifier. */
interface EmailJobRetryResponse {
  message: 'Email job re-queued'
  job_id: number
}

interface EmailJobsTestApi {
  buildEmailJobsListQuery: (query: ExpressRequest['query'], paging: ListPaging) => EmailJobListQuery
  isRetryableEmailJobStatus: (status: unknown) => boolean
  parseEmailJobId: (value: unknown) => number | null
}

interface EmailJobsRouter extends Router {
  __test__: EmailJobsTestApi
}

type EmailJobsResponse = AdminEmailJobListResultDto
  | Pick<AdminEmailJobListResultDto, 'summary' | 'rows'>
  | EmailJobRetryResponse
  | LegacyErrorResponse

const { authenticateAdmin } = require('../middleware') as MiddlewareApi
const { ensureEmailQueueInfrastructure } = require('../../utils/emailQueue') as EmailQueueApi
const { ensureFeatureTables } = require('./shared/schema') as FeatureSchemaApi
const { wantsAdminListContract, parseListPaging } = require('./shared/helpers') as AdminHelpersApi
const { buildEmailJobListResult } = require('./shared/emailJobList') as EmailJobListApi
const router = express.Router() as EmailJobsRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function queryValue(query: ExpressRequest['query'], key: string, fallback: unknown): unknown {
  return query[key] || fallback
}

function buildEmailJobsListQuery(
  query: ExpressRequest['query'],
  paging: ListPaging
): EmailJobListQuery {
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    search: queryValue(query, 'search', ''),
    sort: queryValue(query, 'sort', 'created_at'),
    order: queryValue(query, 'order', 'desc'),
    filters: {
      status: queryValue(query, 'status', null),
      template_key: queryValue(query, 'template_key', null),
      delivery_type: queryValue(query, 'delivery_type', null)
    }
  }
}

function parseEmailJobId(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const jobId = Number.parseInt(value, 10)
  return Number.isFinite(jobId) && jobId > 0 ? jobId : null
}

function isRetryableEmailJobStatus(status: unknown): boolean {
  return ['retry', 'dead', 'failed'].includes(String(status || '').toLowerCase())
}

async function listEmailJobsHandler(
  req: ExpressRequest,
  res: ExpressResponse<EmailJobsResponse>
): Promise<ExpressResponse<EmailJobsResponse>> {
  try {
    await ensureFeatureTables()
    await ensureEmailQueueInfrastructure()
    const paging = parseListPaging(req)
    const listResult = await buildEmailJobListResult({
      query: buildEmailJobsListQuery(req.query, paging)
    })
    return res.json(wantsAdminListContract(req) ? listResult : {
      summary: listResult.summary,
      rows: listResult.rows
    })
  } catch (error: unknown) {
    logger.error('Admin email jobs fetch error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch email jobs' })
  }
}

async function retryEmailJobHandler(
  req: ExpressRequest<EmailJobParams>,
  res: ExpressResponse<EmailJobsResponse>
): Promise<ExpressResponse<EmailJobsResponse>> {
  try {
    await ensureEmailQueueInfrastructure()
    const rawJobId: unknown = req.params.jobId
    const jobId = parseEmailJobId(rawJobId)
    if (jobId === null) {
      return res.status(400).json({ error: 'Valid email job id is required' })
    }

    const lookup = await pool.query<EmailJobStatusRow>(
      `SELECT id, status
         FROM email_jobs
        WHERE id = $1
        LIMIT 1`,
      [jobId]
    )
    const job = lookup.rows[0]
    if (!job) {
      return res.status(404).json({ error: 'Email job not found' })
    }

    if (!isRetryableEmailJobStatus(job.status)) {
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

    return res.json({ message: 'Email job re-queued', job_id: jobId })
  } catch (error: unknown) {
    logger.error('Admin email job retry error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not re-queue email job' })
  }
}

router.get('/email-jobs', authenticateAdmin, listEmailJobsHandler)
router.post<EmailJobParams>('/email-jobs/:jobId/retry', authenticateAdmin, retryEmailJobHandler)

router.__test__ = { buildEmailJobsListQuery, isRetryableEmailJobStatus, parseEmailJobId }

export = router
