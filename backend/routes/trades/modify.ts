// PATCH /api/trades/modify and /modify-pending — SL/TP and trigger edits.

import type {
  JsonValue,
  LegacyErrorResponse,
  ModifyPendingTradeResponseDto,
  ModifyTradeResponseDto,
  TradeMutationRecordDto
} from '@propfirm/contracts'
import Decimal from 'decimal.js'
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
import type { PendingIndexRow, TradeIndexRow } from '../../utils/tradeIndex'
import { serializeDecimal } from '../../utils/money'
import logger = require('../../utils/logger')
import security = require('../../utils/security')
import tradeRouteShared = require('./shared')
import { authenticateToken } from '../middleware'

type PendingResponse = ModifyPendingTradeResponseDto | LegacyErrorResponse
type ModifyResponse = ModifyTradeResponseDto | LegacyErrorResponse
type PendingRequest = ExpressRequest<Record<string, never>, PendingResponse, unknown>
type ModifyRequest = ExpressRequest<Record<string, never>, ModifyResponse, unknown>

interface PendingOrderValidationApi {
  validatePendingOrderPrice: (
    orderType: string,
    pendingPrice: number,
    bid: number,
    ask: number
  ) => string | null
}

interface TradeIndexSyncApi {
  publish: (type: unknown, payload: unknown) => Promise<boolean>
}

interface PendingTradeRow extends PendingIndexRow {
  user_id: string
  pending_price: string
  stop_loss: string | null
  take_profit: string | null
}

interface OpenTradeRow extends TradeIndexRow {
  user_id: string
  direction: string
  open_price: string
}

interface ModifiedPendingTradeRow extends PendingTradeRow, QueryResultRow {}

interface ModifyTestApi {
  validateLevel: (
    value: number,
    marketPrice: number,
    minimumDistance: number,
    mustBeBelowMarket: boolean,
    label: string
  ) => string | null
  mapMutationRecord: (row: QueryResultRow) => TradeMutationRecordDto
}

interface ModifyRouter extends Router {
  __test__: ModifyTestApi
}

const requestRecordSchema = z.record(z.string(), z.unknown())

const { getMinDistance, roundPrice } = constants
const { ensureTradeExperienceInfrastructure, getLivePriceMap } = tradeShared
const { validatePendingOrderPrice } = require('../../utils/pendingOrderValidation') as PendingOrderValidationApi
const tradeModifyLimiter = security.createLimiter('trade-modify', {
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many modify requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: ExpressRequest) => req.user ? String(req.user.userId) : 'anon'
})
const router = express.Router() as ModifyRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function requestBody(value: unknown): Record<string, unknown> {
  const parsed = requestRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function persistedDecimal(value: unknown): string {
  const parsed = Number.parseFloat(String(value))
  return serializeDecimal(new Decimal(parsed))
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) output[key] = toJsonValue(nestedValue)
    }
    return output
  }
  return String(value)
}

function mapMutationRecord(row: QueryResultRow): TradeMutationRecordDto {
  const output: { [key: string]: JsonValue } = {}
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) output[key] = toJsonValue(value)
  }
  return output
}

function validateLevel(
  value: number,
  marketPrice: number,
  minimumDistance: number,
  mustBeBelowMarket: boolean,
  label: string
): string | null {
  const side = mustBeBelowMarket ? 'below' : 'above'
  if (mustBeBelowMarket ? value >= marketPrice : value <= marketPrice) {
    return `${label} must be ${side} the current market price (${marketPrice})`
  }
  if (Math.abs(marketPrice - value) < minimumDistance) {
    return `${label} must be at least ${minimumDistance} from the current market price (${marketPrice})`
  }
  return null
}

async function publishTradeIndex(type: unknown, payload: unknown): Promise<boolean> {
  const sync = require('../../services/tradeIndexSync') as TradeIndexSyncApi
  return sync.publish(type, payload)
}

async function modifyPendingHandler(
  req: PendingRequest,
  res: ExpressResponse<PendingResponse>
): Promise<ExpressResponse<PendingResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    const body = requestBody(req.body)
    const {
      trade_id: rawTradeId,
      pending_price: pendingPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit
    } = body
    if (!rawTradeId) return res.status(400).json({ error: 'Trade ID required' })
    const tradeId = String(rawTradeId)

    const tradeResult = await pool.query<PendingTradeRow>(
      `SELECT t.*, a.user_id FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.id = $1 AND t.status = 'pending'`,
      [tradeId]
    )
    const trade = tradeResult.rows[0]
    if (!trade) return res.status(404).json({ error: 'Pending order not found or already processed' })
    if (trade.user_id !== authenticatedUserId(req)) return res.status(403).json({ error: 'Unauthorized' })

    const prices = await getLivePriceMap()
    const price = prices[trade.instrument]
    const bid = price ? Number(price.bid) : Number.NaN
    const ask = price ? Number(price.ask) : Number.NaN
    const nextPendingPrice = Number.parseFloat(String(pendingPrice ?? trade.pending_price))
    const priceError = validatePendingOrderPrice(trade.order_type, nextPendingPrice, bid, ask)
    if (priceError) return res.status(400).json({ error: priceError })

    const updates: string[] = []
    const values: unknown[] = []
    let parameterIndex = 1
    if (pendingPrice !== undefined) {
      updates.push(`pending_price = $${parameterIndex++}`)
      values.push(persistedDecimal(nextPendingPrice))
    }
    if (stopLoss !== undefined) {
      updates.push(`stop_loss = $${parameterIndex++}`)
      values.push(persistedDecimal(stopLoss))
    }
    if (takeProfit !== undefined) {
      updates.push(`take_profit = $${parameterIndex++}`)
      values.push(persistedDecimal(takeProfit))
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })
    updates.push('updated_at = NOW()')
    values.push(tradeId)

    const updated = await pool.query<ModifiedPendingTradeRow>(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${parameterIndex} AND status = 'pending' RETURNING *`,
      values
    )
    const row = updated.rows[0]
    if (updated.rowCount === 0 || !row) return res.status(409).json({ error: 'Trade was already processed' })

    await tradeRouteShared.engine().syncPendingOrder(row)
    await publishTradeIndex('pending', { trade: row })
    return res.json({ message: 'Pending order updated', trade: mapMutationRecord(row) })
  } catch (error: unknown) {
    logger.error('Modify pending order error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not modify pending order' })
  }
}

async function modifyTradeHandler(
  req: ModifyRequest,
  res: ExpressResponse<ModifyResponse>
): Promise<ExpressResponse<ModifyResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    const body = requestBody(req.body)
    const {
      trade_id: rawTradeId,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      move_to_breakeven: moveToBreakevenInput
    } = body
    if (!rawTradeId) return res.status(400).json({ error: 'Trade ID required' })
    const tradeId = String(rawTradeId)
    const moveToBreakeven = Boolean(moveToBreakevenInput)
    if (stopLoss === undefined && takeProfit === undefined && !moveToBreakeven) {
      return res.status(400).json({ error: 'Provide at least one trade modification field' })
    }

    const tradeResult = await pool.query<OpenTradeRow>(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [tradeId]
    )
    const trade = tradeResult.rows[0]
    if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' })
    if (trade.user_id !== authenticatedUserId(req)) return res.status(403).json({ error: 'Unauthorized' })

    const openPrice = Number(trade.open_price)
    const minimumDistance = getMinDistance(trade.instrument)
    const livePrices = await getLivePriceMap()
    const livePrice = livePrices[trade.instrument]
    const marketPrice = trade.direction === 'buy'
      ? (livePrice ? Number(livePrice.bid) : Number.NaN)
      : (livePrice ? Number(livePrice.ask) : Number.NaN)
    if (!Number.isFinite(marketPrice)) {
      return res.status(503).json({ error: 'Live price unavailable for this instrument. Please try again shortly.' })
    }

    const isBuy = trade.direction === 'buy'
    if (stopLoss !== undefined && stopLoss !== '' && stopLoss !== null && !moveToBreakeven) {
      const stopLossNumber = Number.parseFloat(String(stopLoss))
      if (Number.isNaN(stopLossNumber)) return res.status(400).json({ error: 'Invalid stop loss value' })
      const validationError = validateLevel(stopLossNumber, marketPrice, minimumDistance, isBuy, 'Stop loss')
      if (validationError) return res.status(400).json({ error: validationError })
    }
    if (takeProfit !== undefined && takeProfit !== '' && takeProfit !== null) {
      const takeProfitNumber = Number.parseFloat(String(takeProfit))
      if (Number.isNaN(takeProfitNumber)) return res.status(400).json({ error: 'Invalid take profit value' })
      const validationError = validateLevel(takeProfitNumber, marketPrice, minimumDistance, !isBuy, 'Take profit')
      if (validationError) return res.status(400).json({ error: validationError })
    }
    if (moveToBreakeven) {
      const validationError = validateLevel(openPrice, marketPrice, minimumDistance, isBuy, 'Breakeven stop')
      if (validationError) {
        return res.status(400).json({ error: 'Cannot move to breakeven: the trade is not far enough in profit yet.' })
      }
    }

    const updates: string[] = []
    const values: unknown[] = []
    let parameterIndex = 1
    if (moveToBreakeven) {
      updates.push(`stop_loss = $${parameterIndex++}`)
      values.push(serializeDecimal(new Decimal(roundPrice(openPrice, trade.instrument))))
    } else if (stopLoss !== undefined) {
      updates.push(`stop_loss = $${parameterIndex++}`)
      values.push(stopLoss === '' || stopLoss === null ? null : persistedDecimal(stopLoss))
    }
    if (takeProfit !== undefined) {
      updates.push(`take_profit = $${parameterIndex++}`)
      values.push(takeProfit === '' || takeProfit === null ? null : persistedDecimal(takeProfit))
    }
    updates.push('pending_close_price = NULL')
    updates.push('pending_close_reason = NULL')
    updates.push('pending_close_at = NULL')
    values.push(tradeId)

    const modified = await pool.query<OpenTradeRow>(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${parameterIndex} AND status = 'open'
       RETURNING id, account_id, instrument, direction, lot_size, open_price,
                 stop_loss, take_profit, commission, open_time,
                 pending_close_price, pending_close_reason`,
      values
    )
    const row = modified.rows[0]
    if (modified.rowCount === 0 || !row) return res.status(409).json({ error: 'Trade was already processed' })

    await tradeRouteShared.engine().syncOpenedTrade(row)
    await publishTradeIndex('open', { trade: row })
    return res.json({ message: 'Trade modified successfully' })
  } catch (error: unknown) {
    logger.error('Modify trade error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not modify trade' })
  }
}

router.patch('/modify-pending', authenticateToken as RequestHandler, tradeModifyLimiter, modifyPendingHandler)
router.patch('/modify', authenticateToken as RequestHandler, tradeModifyLimiter, modifyTradeHandler)

router.__test__ = { validateLevel, mapMutationRecord }

export = router
