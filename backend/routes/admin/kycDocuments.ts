// Admin authenticated KYC document streaming.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

import type { LegacyErrorResponse } from '@propfirm/contracts'
import fs from 'node:fs'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import { z } from 'zod'
import pool = require('../../db')
import '../../loadEnv'
import logger = require('../../utils/logger')
import { UPLOADS_ROOT, resolveWithinUploads } from '../../utils/uploadPaths'
import { appendImmutableAudit } from './shared/audit'

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
  requireAdminCapability: (capability: string) => RequestHandler
}

interface KycStorageApi {
  getKycContentType: (absolutePath: string) => string
  readKycFileBuffer: (absolutePath: string) => { buffer: Buffer; encrypted: boolean }
}

interface AdminHelpersApi {
  buildAdminAuditActor: (admin: Express.AuthenticatedAdmin | undefined) => unknown
}

interface KycDocumentRow extends QueryResultRow {
  doc_path: string | null
}

interface KycDocumentParams {
  [key: string]: string
  userId: string
  type: string
}

interface KycDocumentsTestApi {
  documentColumnForType: (type: string) => KycDocumentColumn
  parseKycDocumentParams: (value: unknown) => KycDocumentParams | null
}

interface KycDocumentsRouter extends Router {
  __test__: KycDocumentsTestApi
}

type KycDocumentColumn = 'selfie_path' | 'id_document_back_path' | 'id_document_path'
type KycDocumentResponse = Buffer | LegacyErrorResponse
type KycDocumentRequest = ExpressRequest<KycDocumentParams, KycDocumentResponse>

const { authenticateAdmin, requireAdminCapability } = require('../middleware') as MiddlewareApi
const { readKycFileBuffer, getKycContentType } = require('../../utils/secureKycStorage') as KycStorageApi
const { buildAdminAuditActor } = require('./shared/helpers') as AdminHelpersApi
const router = express.Router() as KycDocumentsRouter

const kycDocumentParamsSchema = z.object({
  userId: z.string(),
  type: z.string()
})

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function parseKycDocumentParams(value: unknown): KycDocumentParams | null {
  const parsed = kycDocumentParamsSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

function documentColumnForType(type: string): KycDocumentColumn {
  return type === 'selfie'
    ? 'selfie_path'
    : type === 'id_back'
      ? 'id_document_back_path'
      : 'id_document_path'
}

// -- KYC Document Viewer -----------------------------------------------------------------------
async function kycDocumentHandler(
  req: KycDocumentRequest,
  res: ExpressResponse<KycDocumentResponse>
): Promise<ExpressResponse<KycDocumentResponse>> {
  try {
    const rawParams: unknown = req.params
    const params = parseKycDocumentParams(rawParams)
    if (!params) return res.status(404).json({ error: 'Document not found' })
    const { userId, type } = params

    // FIX: kyc.js saves file paths into the `users` table (not `user_kyc`).
    const columnName = documentColumnForType(type)
    const userRow = await pool.query<KycDocumentRow>(
      `SELECT ${columnName} AS doc_path
         FROM users
        WHERE id = $1`,
      [userId]
    )

    const row = userRow.rows[0]
    if (!row?.doc_path) {
      return res.status(404).json({ error: 'Document not found' })
    }

    // Stored paths are relative to the stable runtime uploads directory.
    const rawPath = row.doc_path
    const absoluteFilePath = resolveWithinUploads(UPLOADS_ROOT, rawPath)

    if (!absoluteFilePath) {
      logger.warn('[kyc-doc] Path traversal attempt blocked:', { rawPath, userId })
      return res.status(400).json({ error: 'Invalid document path' })
    }

    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'File physically missing from server disk' })
    }

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'kyc_document_viewed',
        entityType: 'user',
        entityId: userId,
        payload: { type: String(type || 'id') }
      })
    } catch (silentError: unknown) {
      logger.warn('[admin] Non-critical operation failed silently:', { error: errorMessage(silentError) })
    }

    // readKycFileBuffer transparently decrypts `.enc` files (AES-256-GCM at rest)
    // and passes legacy plaintext files straight through.
    let buffer: Buffer
    try {
      buffer = readKycFileBuffer(absoluteFilePath).buffer
    } catch (decryptError: unknown) {
      logger.error('[kyc-doc] Failed to decrypt document:', {
        error: errorMessage(decryptError),
        userId,
        type
      })
      return res.status(500).json({ error: 'Failed to retrieve KYC document' })
    }
    res.setHeader('Content-Type', getKycContentType(absoluteFilePath))
    return res.send(buffer)
  } catch (error: unknown) {
    logger.error('[kyc-doc] Error serving document:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Failed to retrieve KYC document' })
  }
}

router.get<KycDocumentParams, KycDocumentResponse>(
  '/kyc/document/:userId/:type',
  authenticateAdmin,
  requireAdminCapability('kyc:review:scoped'),
  kycDocumentHandler
)

router.__test__ = { documentColumnForType, parseKycDocumentParams }

export = router
