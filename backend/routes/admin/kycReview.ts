// Admin KYC SLA tracking and document quality flags.

import type {
  AdminKycQualityFlagDto,
  AdminKycQualityFlagsResponseDto,
  AdminKycQualityRiskLevel,
  AdminKycSlaQueueItemDto,
  AdminKycSlaResponseDto,
  AdminKycSlaStatus,
  LegacyErrorResponse
} from '@propfirm/contracts'
import fs from 'node:fs'
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
import { UPLOADS_ROOT, resolveWithinUploads } from '../../utils/uploadPaths'

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
  requireAdminCapability: (capability: string) => RequestHandler
}

interface SecureKycStorageApi {
  getOriginalKycExtension: (filePath: string) => string
}

interface AdminHelperApi {
  buildKycDocumentPresencePredicate: (alias: string) => string
}

interface KycSlaRow extends QueryResultRow {
  user_id: string
  full_name: string | null
  email: string
  country: string
  submitted_at: Date | string
  wait_hours: number | string
  accounts_total: number | string
  funded_accounts: number | string
}

interface KycQualityRow extends QueryResultRow {
  user_id: string
  full_name: string | null
  email: string
  kyc_status: string
  submitted_at: Date | string
  id_document_path: string | null
  id_document_back_path: string | null
  selfie_path: string | null
}

interface InspectedFile {
  exists: boolean
  size_bytes: number
  ext: string
}

interface KycReviewTestApi {
  inspectRelativeFile: (relativePath: unknown) => InspectedFile
  normalizeSlaHours: (value: unknown) => number
  slaStatusForWait: (waitHours: number, slaHours: number) => AdminKycSlaStatus
}

interface KycReviewRouter extends Router {
  __test__: KycReviewTestApi
}

type KycReviewResponse = AdminKycSlaResponseDto
  | AdminKycQualityFlagsResponseDto
  | LegacyErrorResponse

const { authenticateAdmin, requireAdminCapability } = require('../middleware') as MiddlewareApi
const { getOriginalKycExtension } = require('../../utils/secureKycStorage') as SecureKycStorageApi
const { buildKycDocumentPresencePredicate } = require('./shared/helpers') as AdminHelperApi
const router = express.Router() as KycReviewRouter

function integer(value: number | string): number {
  return Number.parseInt(String(value || 0), 10) || 0
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function normalizeSlaHours(value: unknown): number {
  const parsed = Number.parseInt(String(value || '24'), 10)
  return Number.isFinite(parsed) ? Math.max(1, Math.min(168, parsed)) : 24
}

function slaStatusForWait(waitHours: number, slaHours: number): AdminKycSlaStatus {
  if (waitHours >= slaHours * 2) return 'breach'
  if (waitHours >= slaHours) return 'overdue'
  if (waitHours >= slaHours * 0.6) return 'warning'
  return 'within_sla'
}

function inspectRelativeFile(relativePath: unknown): InspectedFile {
  if (!relativePath) return { exists: false, size_bytes: 0, ext: '' }
  const raw = String(relativePath).replace(/^[/\\]+/u, '')
  const absolutePath = resolveWithinUploads(UPLOADS_ROOT, raw)
  if (!absolutePath) {
    return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
  }
  try {
    if (!fs.existsSync(absolutePath)) {
      return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
    }
    const stat = fs.statSync(absolutePath)
    return { exists: true, size_bytes: stat.size, ext: getOriginalKycExtension(raw) }
  } catch (_error: unknown) {
    return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
  }
}

function mapSlaRow(row: KycSlaRow, slaHours: number): AdminKycSlaQueueItemDto {
  const rawWaitHours = Number.parseFloat(String(row.wait_hours || 0))
  const waitHours = Number.parseFloat(rawWaitHours.toFixed(2))
  return {
    user_id: String(row.user_id),
    full_name: row.full_name,
    email: row.email,
    country: row.country,
    submitted_at: isoTimestamp(row.submitted_at),
    wait_hours: waitHours,
    wait_minutes: Math.max(0, Math.floor(rawWaitHours * 60)),
    accounts_total: integer(row.accounts_total),
    funded_accounts: integer(row.funded_accounts),
    sla_status: slaStatusForWait(rawWaitHours, slaHours)
  }
}

function riskLevel(qualityScore: number): AdminKycQualityRiskLevel {
  return qualityScore >= 60 ? 'high' : qualityScore >= 30 ? 'medium' : 'low'
}

function mapQualityRow(row: KycQualityRow, nowMs: number): AdminKycQualityFlagDto {
  const idFile = inspectRelativeFile(row.id_document_path)
  const idBackFile = inspectRelativeFile(row.id_document_back_path)
  const selfieFile = inspectRelativeFile(row.selfie_path)
  const flags: string[] = []
  let qualityScore = 0

  if (!idFile.exists) { flags.push('Missing ID document file'); qualityScore += 50 }
  if (!idBackFile.exists) { flags.push('Missing ID document back file'); qualityScore += 30 }
  if (!selfieFile.exists) { flags.push('Missing selfie file'); qualityScore += 50 }
  if (idFile.exists && !['.jpg', '.jpeg', '.png', '.pdf'].includes(idFile.ext)) {
    flags.push('Unexpected ID document extension'); qualityScore += 20
  }
  if (selfieFile.exists && !['.jpg', '.jpeg', '.png'].includes(selfieFile.ext)) {
    flags.push('Unexpected selfie extension'); qualityScore += 25
  }
  if (idFile.exists && idFile.ext !== '.pdf' && idFile.size_bytes < 70 * 1024) {
    flags.push('ID image file very small'); qualityScore += 20
  }
  if (selfieFile.exists && selfieFile.size_bytes < 60 * 1024) {
    flags.push('Selfie file very small'); qualityScore += 25
  }
  if (idFile.exists && selfieFile.exists && idFile.size_bytes + selfieFile.size_bytes < 180 * 1024) {
    flags.push('Combined KYC payload unusually small'); qualityScore += 15
  }
  if (row.kyc_status === 'pending') {
    const ageHours = (nowMs - new Date(row.submitted_at).getTime()) / 3_600_000
    if (ageHours >= 48) { flags.push('Pending review for more than 48 hours'); qualityScore += 10 }
  }

  return {
    user_id: String(row.user_id),
    full_name: row.full_name,
    email: row.email,
    kyc_status: row.kyc_status,
    submitted_at: isoTimestamp(row.submitted_at),
    id_document_path: row.id_document_path,
    id_document_back_path: row.id_document_back_path,
    selfie_path: row.selfie_path,
    id_file_exists: idFile.exists,
    id_file_size: idFile.size_bytes,
    back_file_exists: idBackFile.exists,
    back_file_size: idBackFile.size_bytes,
    selfie_file_exists: selfieFile.exists,
    selfie_file_size: selfieFile.size_bytes,
    quality_score: qualityScore,
    risk_level: riskLevel(qualityScore),
    flags
  }
}

async function kycSlaHandler(
  req: ExpressRequest,
  res: ExpressResponse<KycReviewResponse>
): Promise<ExpressResponse<KycReviewResponse>> {
  try {
    const rawSlaHours: unknown = req.query.sla_hours
    const slaHours = normalizeSlaHours(rawSlaHours)
    const pending = await pool.query<KycSlaRow>(
      `SELECT u.id::text AS user_id, u.full_name, u.email,
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
    const queue = pending.rows.map((row) => mapSlaRow(row, slaHours))
    const pendingTotal = queue.length
    const overdueCount = queue.filter((row) => row.sla_status === 'overdue' || row.sla_status === 'breach').length
    const breachCount = queue.filter((row) => row.sla_status === 'breach').length
    const avgWaitHours = pendingTotal > 0
      ? Number.parseFloat((queue.reduce((sum, row) => sum + row.wait_hours, 0) / pendingTotal).toFixed(2))
      : 0
    return res.json({
      generated_at: new Date().toISOString(),
      sla_hours: slaHours,
      summary: {
        pending_total: pendingTotal,
        overdue_total: overdueCount,
        breach_total: breachCount,
        avg_wait_hours: avgWaitHours
      },
      queue
    })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to load KYC SLA queue' })
  }
}

async function kycQualityFlagsHandler(
  _req: ExpressRequest,
  res: ExpressResponse<KycReviewResponse>
): Promise<ExpressResponse<KycReviewResponse>> {
  try {
    const docs = await pool.query<KycQualityRow>(
      `SELECT u.id::text AS user_id, u.full_name, u.email, u.kyc_status,
              COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
              u.id_document_path, u.id_document_back_path, u.selfie_path
         FROM users u
        WHERE ${buildKycDocumentPresencePredicate('u')}
        ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) DESC
        LIMIT 500`
    )
    const nowMs = Date.now()
    const rows = docs.rows
      .map((row) => mapQualityRow(row, nowMs))
      .sort((left, right) => right.quality_score - left.quality_score)
    return res.json({
      generated_at: new Date().toISOString(),
      summary: {
        total_profiles: rows.length,
        high_risk_count: rows.filter((row) => row.risk_level === 'high').length,
        medium_risk_count: rows.filter((row) => row.risk_level === 'medium').length,
        missing_file_count: rows.filter((row) => !row.id_file_exists || !row.back_file_exists || !row.selfie_file_exists).length
      },
      rows
    })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to load KYC quality flags' })
  }
}

router.get('/kyc-sla', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), kycSlaHandler)
router.get(
  '/kyc-quality-flags',
  authenticateAdmin,
  requireAdminCapability('kyc:review:scoped'),
  kycQualityFlagsHandler
)

router.__test__ = { inspectRelativeFile, normalizeSlaHours, slaStatusForWait }

export = router
