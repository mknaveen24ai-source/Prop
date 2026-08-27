import type {
  AdminGiftVoucherDto,
  AdminGiftVoucherListItemDto,
  AdminGiftVoucherListResponseDto,
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
import pool = require('../db')
import logger = require('../utils/logger')

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
  requireSuperAdmin: RequestHandler
}

interface AdminInternalsApi {
  appendImmutableAudit: (
    database: typeof pool,
    input: {
      eventType: string
      entityType: string
      entityId: string
      actor: unknown
      payload: unknown
    }
  ) => Promise<unknown>
  ensureFeatureTables: () => Promise<void>
  getAdminActorLabel: (admin: Express.AuthenticatedAdmin | undefined) => string
}

interface GiftVoucherListRow extends QueryResultRow {
  id: string
  code: string
  status: string
  account_size: string
  challenge_model_slug: string
  amount_paid: string
  gift_message: string | null
  recipient_email: string
  recipient_user_id: string | null
  issued_at: Date | string
  expires_at: Date | string | null
  claimed_at: Date | string | null
  purchaser_email: string
  purchaser_name: string | null
}

interface GiftVoucherRow extends QueryResultRow {
  id: string
  code: string
  purchaser_user_id: string
  order_id: string | null
  recipient_email: string
  recipient_user_id: string | null
  account_size: string
  challenge_model_slug: string
  amount_paid: string
  gift_message: string | null
  status: string
  issued_at: Date | string
  expires_at: Date | string | null
  claimed_at: Date | string | null
  claimed_order_id: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface CountRow extends QueryResultRow {
  total: string
}

interface GiftVoucherParams {
  [key: string]: string
  id: string
}

interface GiftListQuery {
  status: string
  search: string
  page: number
  pageSize: number
  offset: number
}

interface AdminGiftsTestApi {
  mapGiftVoucher: (row: GiftVoucherRow) => AdminGiftVoucherDto
  mapGiftVoucherListItem: (row: GiftVoucherListRow) => AdminGiftVoucherListItemDto
  normalizeGiftListQuery: (query: ExpressRequest['query']) => GiftListQuery
}

interface AdminGiftsRouter extends Router {
  __test__: AdminGiftsTestApi
}

type AdminGiftsResponse = AdminGiftVoucherListResponseDto | AdminGiftVoucherDto | LegacyErrorResponse
type AdminGiftRequest = ExpressRequest<GiftVoucherParams, AdminGiftsResponse, unknown>

const { authenticateAdmin, requireSuperAdmin } = require('./middleware') as MiddlewareApi
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = (
  require('./admin') as { _internals: AdminInternalsApi }
)._internals
const router = express.Router() as AdminGiftsRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value)
}

function mapGiftVoucherListItem(row: GiftVoucherListRow): AdminGiftVoucherListItemDto {
  return {
    id: String(row.id),
    code: row.code,
    status: row.status,
    account_size: String(row.account_size),
    challenge_model_slug: row.challenge_model_slug,
    amount_paid: String(row.amount_paid),
    gift_message: row.gift_message,
    recipient_email: row.recipient_email,
    recipient_user_id: row.recipient_user_id,
    issued_at: isoTimestamp(row.issued_at),
    expires_at: nullableIsoTimestamp(row.expires_at),
    claimed_at: nullableIsoTimestamp(row.claimed_at),
    purchaser_email: row.purchaser_email,
    purchaser_name: row.purchaser_name
  }
}

function mapGiftVoucher(row: GiftVoucherRow): AdminGiftVoucherDto {
  return {
    id: String(row.id),
    code: row.code,
    purchaser_user_id: row.purchaser_user_id,
    order_id: row.order_id === null ? null : String(row.order_id),
    recipient_email: row.recipient_email,
    recipient_user_id: row.recipient_user_id,
    account_size: String(row.account_size),
    challenge_model_slug: row.challenge_model_slug,
    amount_paid: String(row.amount_paid),
    gift_message: row.gift_message,
    status: row.status,
    issued_at: isoTimestamp(row.issued_at),
    expires_at: nullableIsoTimestamp(row.expires_at),
    claimed_at: nullableIsoTimestamp(row.claimed_at),
    claimed_order_id: row.claimed_order_id === null ? null : String(row.claimed_order_id),
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at)
  }
}

function firstQueryString(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

function normalizeGiftListQuery(query: ExpressRequest['query']): GiftListQuery {
  const status = firstQueryString(query.status).trim().toLowerCase()
  const search = firstQueryString(query.search).trim()
  const page = Math.max(1, Number.parseInt(firstQueryString(query.page), 10) || 1)
  const pageSize = Math.min(
    100,
    Math.max(1, Number.parseInt(firstQueryString(query.page_size), 10) || 25)
  )
  return { status, search, page, pageSize, offset: (page - 1) * pageSize }
}

async function auditLog(
  req: AdminGiftRequest,
  eventType: string,
  entityId: string,
  payload: unknown
): Promise<void> {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'gift_voucher',
      entityId,
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (error: unknown) {
    logger.warn('[admin-gifts] Non-critical audit log failed:', { error: errorMessage(error) })
  }
}

async function listGiftVouchersHandler(
  req: ExpressRequest,
  res: ExpressResponse<AdminGiftsResponse>
): Promise<ExpressResponse<AdminGiftsResponse>> {
  try {
    const { status, search, page, pageSize, offset } = normalizeGiftListQuery(req.query)
    const conditions: string[] = []
    const params: unknown[] = []
    if (status && ['issued', 'claimed', 'expired', 'revoked'].includes(status)) {
      params.push(status)
      conditions.push(`gv.status = $${params.length}`)
    }
    if (search) {
      params.push(`%${search.toLowerCase()}%`)
      conditions.push(`(LOWER(gv.recipient_email) LIKE $${params.length} OR LOWER(gv.code) LIKE $${params.length} OR LOWER(pu.email) LIKE $${params.length})`)
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countResult = await pool.query<CountRow>(
      `SELECT COUNT(*) AS total
         FROM gift_vouchers gv
         LEFT JOIN users pu ON pu.id = gv.purchaser_user_id
        ${whereClause}`,
      params
    )
    const rowsResult = await pool.query<GiftVoucherListRow>(
      `SELECT gv.id, gv.code, gv.status, gv.account_size, gv.challenge_model_slug,
              gv.amount_paid, gv.gift_message, gv.recipient_email, gv.recipient_user_id,
              gv.issued_at, gv.expires_at, gv.claimed_at,
              pu.email AS purchaser_email, pu.full_name AS purchaser_name
         FROM gift_vouchers gv
         LEFT JOIN users pu ON pu.id = gv.purchaser_user_id
        ${whereClause}
        ORDER BY gv.issued_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, offset]
    )

    return res.json({
      gifts: rowsResult.rows.map(mapGiftVoucherListItem),
      total: Number.parseInt(countResult.rows[0]?.total || '0', 10),
      page,
      page_size: pageSize
    })
  } catch (error: unknown) {
    logger.error('[admin-gifts] Failed to list gift vouchers:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Failed to load gift vouchers' })
  }
}

async function revokeGiftVoucherHandler(
  req: AdminGiftRequest,
  res: ExpressResponse<AdminGiftsResponse>
): Promise<ExpressResponse<AdminGiftsResponse>> {
  try {
    const rawId: unknown = req.params.id
    const id = typeof rawId === 'string' ? rawId : ''
    const result = await pool.query<GiftVoucherRow>(
      `UPDATE gift_vouchers
          SET status = 'revoked', updated_at = NOW()
        WHERE id = $1 AND status = 'issued'
        RETURNING id, code, purchaser_user_id, order_id, recipient_email,
                  recipient_user_id, account_size, challenge_model_slug,
                  amount_paid, gift_message, status, issued_at, expires_at,
                  claimed_at, claimed_order_id, created_at, updated_at`,
      [id]
    )
    const gift = result.rows[0]
    if (!gift) {
      return res.status(409).json({ error: 'Only an unclaimed gift can be revoked' })
    }
    await auditLog(req, 'gift_voucher_revoked', id, { code: gift.code })
    return res.json(mapGiftVoucher(gift))
  } catch (error: unknown) {
    logger.error('[admin-gifts] Failed to revoke gift voucher:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Failed to revoke gift voucher' })
  }
}

router.get('/gift-vouchers', authenticateAdmin, requireSuperAdmin, listGiftVouchersHandler)
router.post<GiftVoucherParams>(
  '/gift-vouchers/:id/revoke',
  authenticateAdmin,
  requireSuperAdmin,
  revokeGiftVoucherHandler
)

router.__test__ = { mapGiftVoucher, mapGiftVoucherListItem, normalizeGiftListQuery }

export = router
