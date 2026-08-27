// Admin trade list and force-close. CommonJS output is intentional.

import type {
  AccountUpdateDto,
  AdminListPaginationDto,
  AdminTradeForceCloseResponseDto,
  AdminTradeListItemDto,
  AdminTradeListResponseDto,
  AdminTradeSummaryDto,
  LegacyErrorResponse
} from '@propfirm/contracts'
import express from 'express'
import type {
  Application,
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { PoolClient, QueryResultRow } from 'pg'
import pool = require('../../db')
import '../../loadEnv'
import { computeRMultiple } from '../../services/tradeShared'
import logger = require('../../utils/logger')
import { appendImmutableAudit } from './shared/audit'
import { calcTradePnl, forceCloseTradeById } from './shared/tradeOps'

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
  requireAdminCapability: (capability: string) => RequestHandler
}

interface AdminHelpersApi {
  parseListPaging: (
    req: ExpressRequest,
    options?: { defaultPageSize?: number; maxPageSize?: number }
  ) => { page: number; pageSize: number }
  buildPagination: (input: {
    page: number
    pageSize: number
    total: number
  }) => AdminListPaginationDto
}

interface TradeListRow extends QueryResultRow {
  id: string
  account_id: string
  user_id: string
  symbol: string
  type: string
  lots: string
  open_price: string
  close_price: string | null
  sl: string | null
  tp: string | null
  status: string
  demo_pnl: string | null
  commission: string | null
  bid: string | null
  ask: string | null
  open_time: Date | string
  close_time: Date | string | null
}

interface CountRow extends QueryResultRow {
  count: string
}

interface StatusCountRow extends QueryResultRow {
  status: string
  count: string
}

interface TradeParams {
  [key: string]: string
  tradeId: string
}

interface ForceClosedTrade {
  trade_id: string
  account_id: string
  user_id: string
  instrument: string
  pnl: number
  close_price: number
}

interface ForceCloseDatabase {
  connect: () => Promise<PoolClient>
}

interface ForceCloseDependencies {
  database: ForceCloseDatabase
  forceClose: (
    client: PoolClient,
    tradeId: string,
    closeReason: unknown
  ) => Promise<ForceClosedTrade | null>
  audit: (
    client: PoolClient,
    input: {
      eventType: string
      entityType: string
      entityId: string
      payload: {
        account_id: string
        instrument: string
        pnl: number
      }
    }
  ) => Promise<unknown>
}

interface SocketRoom {
  emit: (event: 'account_update', payload: AccountUpdateDto) => void
}

interface SocketServer {
  to: (room: string) => SocketRoom
}

interface NormalizedTradeListQuery {
  direction: string
  status: string
  search: string
}

interface AdminTradesTestApi {
  forceCloseTradeHandlerWithDependencies: (
    req: CloseTradeRequest,
    res: CloseTradeResponse,
    dependencies: ForceCloseDependencies
  ) => Promise<ExpressResponse<AdminTradesResponse> | void>
  mapTradeListRow: (row: TradeListRow) => AdminTradeListItemDto
  normalizeTradeListQuery: (query: ExpressRequest['query']) => NormalizedTradeListQuery
}

interface AdminTradesRouter extends Router {
  __test__: AdminTradesTestApi
}

type AdminTradesResponse = AdminTradeListResponseDto
  | AdminTradeForceCloseResponseDto
  | LegacyErrorResponse
type CloseTradeRequest = ExpressRequest<TradeParams, AdminTradesResponse, unknown>
type CloseTradeResponse = ExpressResponse<AdminTradesResponse>

const { authenticateAdmin, requireAdminCapability } = require('../middleware') as MiddlewareApi
const { parseListPaging, buildPagination } = require('./shared/helpers') as AdminHelpersApi
const router = express.Router() as AdminTradesRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value)
}

function normalizeTradeListQuery(query: ExpressRequest['query']): NormalizedTradeListQuery {
  return {
    direction: String(query.direction || 'all').toLowerCase(),
    status: String(query.status || 'all').toLowerCase(),
    search: String(query.search || query.q || '').trim()
  }
}

function mapTradeListRow(row: TradeListRow): AdminTradeListItemDto {
  let pnl = Number.parseFloat(row.demo_pnl || '0')
  if (row.status === 'open') {
    const livePrice = row.type === 'BUY'
      ? Number.parseFloat(row.bid || row.open_price || '0')
      : Number.parseFloat(row.ask || row.open_price || '0')
    pnl = Number.parseFloat((
      calcTradePnl(
        String(row.type || '').toLowerCase(),
        Number.parseFloat(row.open_price || '0'),
        livePrice,
        Number.parseFloat(row.lots || '0'),
        row.symbol
      ) - Number.parseFloat(row.commission || '0')
    ).toFixed(2))
  }
  const rMultiple = ['closed', 'cancelled'].includes(row.status)
    ? computeRMultiple({
      stop_loss: row.sl,
      open_price: row.open_price,
      lot_size: row.lots,
      demo_pnl: pnl,
      instrument: row.symbol
    })
    : null

  return {
    id: String(row.id),
    account_id: String(row.account_id),
    user_id: String(row.user_id),
    symbol: row.symbol,
    type: row.type,
    lots: String(row.lots),
    open_price: String(row.open_price),
    close_price: row.close_price === null ? null : String(row.close_price),
    sl: row.sl === null ? null : String(row.sl),
    tp: row.tp === null ? null : String(row.tp),
    status: row.status,
    demo_pnl: row.demo_pnl === null ? null : String(row.demo_pnl),
    commission: row.commission === null ? null : String(row.commission),
    bid: row.bid === null ? null : String(row.bid),
    ask: row.ask === null ? null : String(row.ask),
    open_time: isoTimestamp(row.open_time),
    close_time: nullableIsoTimestamp(row.close_time),
    pnl,
    r_multiple: rMultiple
  }
}

function socketServerFromApplication(app: Application): SocketServer | null {
  const candidate: unknown = app.get('io')
  if (!candidate || typeof candidate !== 'object') return null
  const possibleServer = candidate as { to?: unknown }
  return typeof possibleServer.to === 'function' ? candidate as SocketServer : null
}

function emitForceCloseUpdate(app: Application, closed: ForceClosedTrade): void {
  const io = socketServerFromApplication(app)
  if (!io) return
  io.to(String(closed.user_id)).emit('account_update', {
    message: `Admin force-closed ${closed.instrument}: ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`,
    pnl: closed.pnl,
    account_id: closed.account_id,
    event: 'admin_trade_force_closed'
  })
}

async function listTradesHandler(
  req: ExpressRequest,
  res: ExpressResponse<AdminTradesResponse>
): Promise<ExpressResponse<AdminTradesResponse>> {
  try {
    const paging = parseListPaging(req)
    const { direction, status, search } = normalizeTradeListQuery(req.query)
    const searchDirectionConditions: string[] = []
    const searchDirectionValues: unknown[] = []
    let sdParamIndex = 1

    if (['buy', 'sell'].includes(direction)) {
      searchDirectionConditions.push(`t.direction = $${sdParamIndex}`)
      searchDirectionValues.push(direction)
      sdParamIndex += 1
    }
    if (search) {
      searchDirectionConditions.push(`(
        t.id::text ILIKE $${sdParamIndex} OR
        t.account_id::text ILIKE $${sdParamIndex} OR
        a.user_id::text ILIKE $${sdParamIndex} OR
        t.instrument ILIKE $${sdParamIndex}
      )`)
      searchDirectionValues.push(`%${search}%`)
      sdParamIndex += 1
    }

    const conditions = [...searchDirectionConditions]
    const values = [...searchDirectionValues]
    let paramIndex = sdParamIndex
    if (['open', 'pending', 'closed'].includes(status)) {
      conditions.push(`t.status = $${paramIndex}`)
      values.push(status)
      paramIndex += 1
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const searchDirectionWhereClause = searchDirectionConditions.length > 0
      ? `WHERE ${searchDirectionConditions.join(' AND ')}`
      : ''

    const [countResult, breakdownResult] = await Promise.all([
      pool.query<CountRow>(
        `SELECT COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id ${whereClause}`,
        values
      ),
      pool.query<StatusCountRow>(
        `SELECT t.status, COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id ${searchDirectionWhereClause} GROUP BY t.status`,
        searchDirectionValues
      )
    ])
    const totalItems = Number.parseInt(countResult.rows[0]?.count || '0', 10)
    const summary: AdminTradeSummaryDto = { total: totalItems, open: 0, pending: 0, closed: 0 }
    for (const row of breakdownResult.rows) {
      if (row.status === 'open') summary.open = Number.parseInt(row.count, 10)
      else if (row.status === 'pending') summary.pending = Number.parseInt(row.count, 10)
      else summary.closed += Number.parseInt(row.count, 10)
    }

    const result = await pool.query<TradeListRow>(
      `SELECT t.id,
              t.account_id,
              a.user_id,
              t.instrument AS symbol,
              UPPER(t.direction) AS type,
              t.lot_size AS lots,
              t.open_price,
              t.close_price,
              t.stop_loss AS sl,
              t.take_profit AS tp,
              t.status,
              t.demo_pnl,
              t.commission,
              p.bid,
              p.ask,
              t.open_time,
              t.close_time
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       ${whereClause}
       ORDER BY
         CASE WHEN t.status = 'open' THEN 0 WHEN t.status = 'pending' THEN 1 ELSE 2 END,
         COALESCE(t.close_time, t.open_time) DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...values, paging.pageSize, (paging.page - 1) * paging.pageSize]
    )

    return res.json({
      rows: result.rows.map(mapTradeListRow),
      summary,
      pagination: buildPagination({
        page: paging.page,
        pageSize: paging.pageSize,
        total: totalItems
      })
    })
  } catch (error: unknown) {
    logger.error('Admin trades fetch error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch trades' })
  }
}

async function forceCloseTradeHandlerWithDependencies(
  req: CloseTradeRequest,
  res: CloseTradeResponse,
  dependencies: ForceCloseDependencies
): Promise<ExpressResponse<AdminTradesResponse> | void> {
  const client = await dependencies.database.connect()
  try {
    const rawTradeId: unknown = req.params.tradeId
    const tradeId = typeof rawTradeId === 'string' ? rawTradeId.trim() : ''
    if (!tradeId) return res.status(400).json({ error: 'Valid trade id is required' })

    await client.query('BEGIN')
    const closed = await dependencies.forceClose(client, tradeId, 'Admin Force Close')
    if (!closed) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    try {
      await dependencies.audit(client, {
        eventType: 'admin_trade_force_closed',
        entityType: 'trade',
        entityId: String(closed.trade_id),
        payload: {
          account_id: String(closed.account_id),
          instrument: closed.instrument,
          pnl: closed.pnl
        }
      })
    } catch (error: unknown) {
      logger.warn('[admin] Non-critical operation failed silently:', { error: errorMessage(error) })
    }

    await client.query('COMMIT')
    emitForceCloseUpdate(req.app, closed)
    return res.json({
      message: 'Trade force-closed successfully',
      pnl: closed.pnl,
      close_price: closed.close_price
    })
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch((_rollbackError: unknown) => undefined)
    logger.error('Admin trade force-close error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not force close trade' })
  } finally {
    client.release()
  }
}

async function forceCloseTradeHandler(
  req: CloseTradeRequest,
  res: CloseTradeResponse
): Promise<ExpressResponse<AdminTradesResponse> | void> {
  return forceCloseTradeHandlerWithDependencies(req, res, {
    database: pool,
    forceClose: forceCloseTradeById,
    audit: appendImmutableAudit
  })
}

router.get('/trades', authenticateAdmin, requireAdminCapability('trader:read'), listTradesHandler)
router.post<TradeParams>(
  '/trades/:tradeId/close',
  authenticateAdmin,
  requireAdminCapability('trader:write:scoped'),
  forceCloseTradeHandler
)

router.__test__ = {
  forceCloseTradeHandlerWithDependencies,
  mapTradeListRow,
  normalizeTradeListQuery
}

export = router
