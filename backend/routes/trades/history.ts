// GET /api/trades/open, /pending, /history, /export — read-only listings.
// Mounted at the trades router root; public paths and response shapes are unchanged.

import type { IsoTimestamp, LegacyErrorResponse, TradeListItemDto } from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import { z } from 'zod'
import constants = require('../../constants')
import pool = require('../../db')
import tradeShared = require('../../services/tradeShared')
import logger = require('../../utils/logger')
import { authenticateToken } from '../middleware'

type ListingResponse = TradeListItemDto[] | LegacyErrorResponse
type ListingRequest = ExpressRequest<Record<string, never>, ListingResponse, unknown, Record<string, unknown>>
type ExportResponse = string | LegacyErrorResponse
type ExportRequest = ExpressRequest<Record<string, never>, ExportResponse, unknown, Record<string, unknown>>

interface AccountOwnershipRow extends QueryResultRow {
  id: string
}

interface ExportAccountRow extends AccountOwnershipRow {
  account_type: string
  account_size: string
}

interface TradeListRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: string
  open_price?: string | null
  close_price?: string | null
  pending_price?: string | null
  stop_loss: string | null
  take_profit: string | null
  status: string
  demo_pnl?: string | null
  open_time: Date | string | null
  close_time?: Date | string | null
  close_reason?: string | null
  order_type: string | null
  demo_trade_id?: string | null
  oco_group_id?: string | null
  open_screenshot_path: string | null
  close_screenshot_path: string | null
}

interface ExportTradeRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: string
  open_price: string | null
  close_price: string | null
  stop_loss: string | null
  take_profit: string | null
  status: string
  demo_pnl: string | null
  open_time: Date | string | null
  close_time: Date | string | null
  close_reason: string | null
  order_type: string | null
}

interface HistoryTestApi {
  mapTradeRow: (row: TradeListRow) => TradeListItemDto
  csvSafeValue: (value: unknown) => string
}

interface HistoryRouter extends Router {
  __test__: HistoryTestApi
}

const queryRecordSchema = z.record(z.string(), z.unknown())
const { formatPrice } = constants
const { ensureTradeExperienceInfrastructure, computeRMultiple } = tradeShared
const router = express.Router() as HistoryRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function requestQuery(value: unknown): Record<string, unknown> {
  const parsed = queryRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function timestampValue(value: Date | string | null): IsoTimestamp | null {
  return value instanceof Date ? value.toISOString() : value
}

function mapTradeRow(row: TradeListRow): TradeListItemDto {
  return {
    id: row.id,
    account_id: row.account_id,
    instrument: row.instrument,
    direction: row.direction,
    lot_size: row.lot_size,
    ...(row.open_price === undefined ? {} : { open_price: row.open_price }),
    ...(row.close_price === undefined ? {} : { close_price: row.close_price }),
    ...(row.pending_price === undefined ? {} : { pending_price: row.pending_price }),
    stop_loss: row.stop_loss,
    take_profit: row.take_profit,
    status: row.status,
    ...(row.demo_pnl === undefined ? {} : { demo_pnl: row.demo_pnl }),
    open_time: timestampValue(row.open_time),
    ...(row.close_time === undefined ? {} : { close_time: timestampValue(row.close_time) }),
    ...(row.close_reason === undefined ? {} : { close_reason: row.close_reason }),
    order_type: row.order_type,
    ...(row.demo_trade_id === undefined ? {} : { demo_trade_id: row.demo_trade_id }),
    ...(row.oco_group_id === undefined ? {} : { oco_group_id: row.oco_group_id }),
    open_screenshot_path: row.open_screenshot_path,
    close_screenshot_path: row.close_screenshot_path,
    r_multiple: ['closed', 'cancelled'].includes(row.status) ? computeRMultiple(row) : null,
    open_screenshot_url: row.open_screenshot_path ? `/api/trades/${row.id}/screenshot/open` : null,
    close_screenshot_url: row.close_screenshot_path ? `/api/trades/${row.id}/screenshot/close` : null
  }
}

function csvSafeValue(value: unknown): string {
  let text = String(value).replace(/"/g, '""')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return `"${text}"`
}

async function openTradesHandler(
  req: ListingRequest,
  res: ExpressResponse<ListingResponse>
): Promise<ExpressResponse<ListingResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id: accountId } = requestQuery(req.query)
    if (!accountId) return res.status(400).json({ error: 'account_id required' })
    const accountCheck = await pool.query<AccountOwnershipRow>(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountId, authenticatedUserId(req)]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })
    const trades = await pool.query<TradeListRow>(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, stop_loss,
              take_profit, status, demo_pnl, open_time, close_time, close_reason, order_type,
              open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status = 'open' ORDER BY open_time DESC`,
      [accountId]
    )
    return res.json(trades.rows.map(mapTradeRow))
  } catch (error: unknown) {
    logger.error('Open trades error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch open trades' })
  }
}

async function pendingTradesHandler(
  req: ListingRequest,
  res: ExpressResponse<ListingResponse>
): Promise<ExpressResponse<ListingResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id: accountId } = requestQuery(req.query)
    if (!accountId) return res.status(400).json({ error: 'account_id required' })
    const accountCheck = await pool.query<AccountOwnershipRow>(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountId, authenticatedUserId(req)]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })
    const trades = await pool.query<TradeListRow>(
      `SELECT id, account_id, instrument, direction, lot_size, pending_price, order_type,
              status, open_time, demo_trade_id, stop_loss, take_profit,
              oco_group_id, open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status = 'pending' ORDER BY open_time DESC`,
      [accountId]
    )
    return res.json(trades.rows.map(mapTradeRow))
  } catch (error: unknown) {
    logger.error('Pending orders error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch pending orders' })
  }
}

async function tradeHistoryHandler(
  req: ListingRequest,
  res: ExpressResponse<ListingResponse>
): Promise<ExpressResponse<ListingResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id: accountId } = requestQuery(req.query)
    if (!accountId) return res.status(400).json({ error: 'account_id required' })
    const accountCheck = await pool.query<AccountOwnershipRow>(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountId, authenticatedUserId(req)]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })
    const trades = await pool.query<TradeListRow>(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type, pending_price, open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status NOT IN ('open', 'pending') ORDER BY close_time DESC`,
      [accountId]
    )
    return res.json(trades.rows.map(mapTradeRow))
  } catch (error: unknown) {
    logger.error('Trade history error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch trade history' })
  }
}

async function tradeExportHandler(
  req: ExportRequest,
  res: ExpressResponse<ExportResponse>
): Promise<ExpressResponse<ExportResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id: accountId } = requestQuery(req.query)
    if (!accountId) return res.status(400).json({ error: 'account_id required' })
    const accountCheck = await pool.query<ExportAccountRow>(
      `SELECT id, account_type, account_size FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountId, authenticatedUserId(req)]
    )
    const account = accountCheck.rows[0]
    if (!account) return res.status(404).json({ error: 'Account not found' })
    const tradesResult = await pool.query<ExportTradeRow>(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades
       WHERE account_id = $1
       AND status NOT IN ('open', 'pending')
       ORDER BY close_time DESC`,
      [accountId]
    )
    const headers = [
      'ID', 'Instrument', 'Direction', 'Lots',
      'Open Price', 'Close Price', 'Open Time', 'Close Time',
      'P&L', 'Close Reason', 'Order Type'
    ]
    const rows = tradesResult.rows.map((trade) => [
      trade.id,
      trade.instrument,
      trade.direction,
      parseFloat(trade.lot_size).toFixed(2),
      trade.open_price ? formatPrice(trade.open_price, trade.instrument) : '',
      trade.close_price ? formatPrice(trade.close_price, trade.instrument) : '',
      trade.open_time ? new Date(trade.open_time).toISOString() : '',
      trade.close_time ? new Date(trade.close_time).toISOString() : '',
      trade.demo_pnl ? parseFloat(trade.demo_pnl).toFixed(2) : '0.00',
      trade.close_reason || 'Manual',
      trade.order_type || 'market'
    ])
    const csvContent = [headers, ...rows]
      .map((row) => row.map((value) => csvSafeValue(value)).join(','))
      .join('\r\n')
    const filename = `trades_${account.account_type}_${account.account_size}_${new Date().toISOString().slice(0, 10)}.csv`
    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.send(csvContent)
  } catch (error: unknown) {
    logger.error('Trade export error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not export trades' })
  }
}

router.get('/open', authenticateToken as RequestHandler, openTradesHandler)
router.get('/pending', authenticateToken as RequestHandler, pendingTradesHandler)
router.get('/history', authenticateToken as RequestHandler, tradeHistoryHandler)
router.get('/export', authenticateToken as RequestHandler, tradeExportHandler)

router.__test__ = { mapTradeRow, csvSafeValue }

export = router
