// POST /api/trades/close and /cancel — exits and pending-order cancellation.
// The backend remains CommonJS; authored imports compile to require/exports.

import type {
  AccountUpdateDto,
  CancelTradeResponseDto,
  CloseTradeResponseDto,
  LegacyErrorResponse,
  TradeConflictErrorResponseDto
} from '@propfirm/contracts'
import Decimal from 'decimal.js'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { PoolClient, QueryResultRow } from 'pg'
import { z } from 'zod'
import constants = require('../../constants')
import pool = require('../../db')
import tradeShared = require('../../services/tradeShared')
import * as tradeIndex from '../../utils/tradeIndex'
import type { AccountEntry, TradeIndexRow } from '../../utils/tradeIndex'
import logger = require('../../utils/logger')
import { serializeDecimal } from '../../utils/money'
import { calculatePnL } from '../../utils/pnlCalculator'
import security = require('../../utils/security')
import { resolveTieredInstrumentSetting } from '../../utils/tenantSettings'
import validation = require('../../utils/validation')
import tradeRouteShared = require('./shared')
import { authenticateToken } from '../middleware'

type CloseResponse = CloseTradeResponseDto | LegacyErrorResponse | TradeConflictErrorResponseDto
type CancelResponse = CancelTradeResponseDto | LegacyErrorResponse
type CloseRequest = ExpressRequest<Record<string, never>, CloseResponse, unknown>
type CancelRequest = ExpressRequest<Record<string, never>, CancelResponse, unknown>
type TradingRules = Awaited<ReturnType<typeof tradeShared.getTradingRules>>
type LivePrice = Awaited<ReturnType<typeof tradeShared.getLivePrice>>

interface UuidApi {
  v4: () => string
}

interface TradeIndexSyncApi {
  publish: (type: unknown, payload: unknown) => Promise<boolean>
}

interface CloseEngineApi {
  syncOpenedTrade: (trade: TradeIndexRow) => Promise<unknown>
  syncClosedTrade: (tradeId: string, accountId: string, realizedPnl: number) => void
}

interface SocketRoomApi {
  emit: (event: 'account_update', payload: AccountUpdateDto) => void
}

interface SocketServerApi {
  to: (room: string) => SocketRoomApi
}

interface PreflightTradeRow extends TradeIndexRow {
  user_id: string
  account_type: string
  status: string
  open_time: Date | string
  original_commission: string | null
}

interface LockedTradeRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: string
  open_price: string
  open_time: Date | string
  commission: string | null
  original_commission: string | null
}

interface TradeStatusRow extends QueryResultRow {
  id: string
  status: string
}

interface ReturningIdRow extends QueryResultRow {
  id: string
}

interface PendingTradeOwnerRow extends QueryResultRow {
  id: string
  account_id: string
  user_id: string
}

interface IndexSyncState {
  accountId: string
  remainingTrade: TradeIndexRow | null
}

interface CloseDependencies {
  ensureInfrastructure: () => Promise<void>
  getTradingRules: () => Promise<TradingRules>
  getLivePrice: (instrument: string) => Promise<LivePrice>
  getMarketStatus: typeof tradeShared.getMarketStatus
  calculatePnl: typeof calculatePnL
  engine: () => CloseEngineApi
  publishTradeIndex: (type: unknown, payload: unknown) => Promise<boolean>
  getAccountEntry: (accountId: string) => AccountEntry | null | undefined
  applyRealizedPnl: (accountId: string, pnl: number) => void
  updateAccountBalance: (accountId: string, balance: number) => void
  removePending: (tradeId: string) => boolean
  persistScreenshot: typeof tradeRouteShared.persistTradeScreenshot
  random: () => number
  waitForLockRetry: () => Promise<void>
}

interface CloseTestApi {
  closeTradeHandler: (
    req: CloseRequest,
    res: ExpressResponse<CloseResponse>
  ) => Promise<ExpressResponse<CloseResponse>>
  cancelTradeHandler: (
    req: CancelRequest,
    res: ExpressResponse<CancelResponse>
  ) => Promise<ExpressResponse<CancelResponse>>
  dependencies: CloseDependencies
}

interface CloseRouter extends Router {
  __test__: CloseTestApi
}

const requestRecordSchema = z.record(z.string(), z.unknown())
const { getPipSize, roundPrice } = constants
const { isValidLotSize } = validation
const { v4: uuidv4 } = require('uuid') as UuidApi
const tradeCloseLimiter: RequestHandler = security.createLimiter('trade-close', {
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many close requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
})
const router = express.Router() as CloseRouter

function requestBody(value: unknown): Record<string, unknown> {
  const parsed = requestRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isNamedError(value: unknown, name: string): value is Error {
  return value instanceof Error && value.name === name
}

function isSocketServer(value: unknown): value is SocketServerApi {
  return typeof value === 'object'
    && value !== null
    && 'to' in value
    && typeof value.to === 'function'
}

function timestampMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return new Date(value).getTime()
  return new Date(String(value)).getTime()
}

function persistedDecimal(value: Decimal.Value): string {
  return serializeDecimal(new Decimal(value))
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch (_error: unknown) {
    // Preserve the primary transaction failure.
  }
}

async function publishTradeIndex(type: unknown, payload: unknown): Promise<boolean> {
  // Deliberately lazy: this boundary participates in the trade-engine cycle.
  const sync = require('../../services/tradeIndexSync') as TradeIndexSyncApi
  return sync.publish(type, payload)
}

const dependencies: CloseDependencies = {
  ensureInfrastructure: tradeShared.ensureTradeExperienceInfrastructure,
  getTradingRules: tradeShared.getTradingRules,
  getLivePrice: tradeShared.getLivePrice,
  getMarketStatus: tradeShared.getMarketStatus,
  calculatePnl: calculatePnL,
  engine: tradeRouteShared.engine,
  publishTradeIndex,
  getAccountEntry: tradeIndex.getAccountEntry,
  applyRealizedPnl: tradeIndex.applyRealizedPnl,
  updateAccountBalance: tradeIndex.updateAccountBalance,
  removePending: tradeIndex.removePending,
  persistScreenshot: tradeRouteShared.persistTradeScreenshot,
  random: Math.random,
  waitForLockRetry: async (): Promise<void> => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
  }
}

async function closeTradeHandler(
  req: CloseRequest,
  res: ExpressResponse<CloseResponse>
): Promise<ExpressResponse<CloseResponse>> {
  try {
    await dependencies.ensureInfrastructure()
    const body = requestBody(req.body)
    const rawTradeId = body.trade_id
    const rawCloseLots = body.close_lots
    const screenshotDataUrl = body.screenshot_data_url

    if (!rawTradeId) return res.status(400).json({ error: 'Trade ID required' })
    const tradeId = String(rawTradeId)
    if (screenshotDataUrl != null && !tradeRouteShared.isValidImageDataUrl(screenshotDataUrl)) {
      return res.status(400).json({ error: 'Invalid screenshot data' })
    }

    const tradeResult = await pool.query<PreflightTradeRow>(
      `SELECT t.*, t.original_commission, a.user_id, a.account_type FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [tradeId]
    )
    const trade = tradeResult.rows[0]
    if (!trade) return res.status(404).json({ error: 'Trade not found or already closed' })
    const userId = authenticatedUserId(req)
    if (trade.user_id !== userId) return res.status(403).json({ error: 'Unauthorized' })

    const secondsOpen = (Date.now() - timestampMillis(trade.open_time)) / 1000
    const rules = await dependencies.getTradingRules()
    const { minHoldSeconds } = rules
    if (secondsOpen < minHoldSeconds) {
      return res.status(400).json({
        error: `Minimum trade duration is ${minHoldSeconds} seconds. Please wait ${Math.ceil(minHoldSeconds - secondsOpen)} more seconds.`
      })
    }

    const closeMarketStatus = dependencies.getMarketStatus(trade.instrument, { purpose: 'close' })
    if (!closeMarketStatus.open) {
      return res.status(400).json({ error: `Cannot close trade: ${closeMarketStatus.reason}` })
    }

    const price = await dependencies.getLivePrice(trade.instrument)
    const priceAgeMs = Date.now() - timestampMillis(price.updated_at)
    if (priceAgeMs > 10000) {
      logger.warn('Price feed too old on close:', { instrument: trade.instrument, ageMs: priceAgeMs })
      return res.status(400).json({ error: 'Price feed is currently delayed. Close rejected due to volatility protection/latency.' })
    }

    let closePrice = trade.direction === 'buy'
      ? Number.parseFloat(String(price.bid))
      : Number.parseFloat(String(price.ask))
    const closeSlippageMaxPips = resolveTieredInstrumentSetting(
      rules.slippageMaxPipsAdverseJson,
      trade.account_type,
      trade.instrument,
      rules.slippageMaxPipsAdverse
    )
    if (rules.slippageSimulatorEnabled && closeSlippageMaxPips > 0) {
      const randomPips = (dependencies.random() * 2 - 1) * closeSlippageMaxPips
      const slippageAmount = randomPips * getPipSize(trade.instrument)
      closePrice = trade.direction === 'buy'
        ? closePrice - slippageAmount
        : closePrice + slippageAmount
      closePrice = roundPrice(closePrice, trade.instrument)
    }

    let demoPnl = 0
    let isPartial = false
    let remainingLots = 0
    let closedTradeId: string | null = null
    let indexSync: IndexSyncState | null = null
    const requestedCloseLots = rawCloseLots == null
      ? null
      : Number.parseFloat(String(rawCloseLots))
    if (requestedCloseLots != null && !Number.isFinite(requestedCloseLots)) {
      return res.status(400).json({ error: 'Invalid close amount' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let lockedTrade: LockedTradeRow | undefined
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const lockResult = await client.query<LockedTradeRow>(
          `SELECT id, account_id, instrument, direction, lot_size, open_price, open_time,
                  commission, original_commission
           FROM trades
           WHERE id = $1 AND status = 'open'
           FOR UPDATE SKIP LOCKED`,
          [tradeId]
        )
        lockedTrade = lockResult.rows[0]
        if (lockedTrade) break
        if (attempt === 0) await dependencies.waitForLockRetry()
      }

      if (!lockedTrade) {
        const currentTradeState = await client.query<TradeStatusRow>(
          'SELECT id, status FROM trades WHERE id = $1',
          [tradeId]
        )
        await rollback(client)
        const state = currentTradeState.rows[0]
        if (state) {
          const isBusy = state.status === 'open'
          return res.status(409).json({
            error: isBusy
              ? 'Trade is already being updated. Please try again in a moment.'
              : 'Trade was already processed. Refreshing latest trade state.',
            code: isBusy ? 'TRADE_BUSY' : 'TRADE_ALREADY_PROCESSED'
          })
        }
        return res.status(404).json({ error: 'Trade not found or already closed' })
      }

      const currentLotSize = new Decimal(lockedTrade.lot_size)
      const minLotSize = Number.parseFloat(String(rules.minLotSize || 0.01))
      const closeLots = requestedCloseLots == null
        ? currentLotSize
        : new Decimal(requestedCloseLots)
      if (!closeLots.isFinite() || closeLots.lte(0) || closeLots.gt(currentLotSize)) {
        await rollback(client)
        return res.status(400).json({ error: 'Invalid close amount' })
      }

      const closeLotsNumber = closeLots.toNumber()
      if (!isValidLotSize(closeLotsNumber)) {
        await rollback(client)
        return res.status(400).json({ error: 'Close amount must be in 0.01 lot steps' })
      }

      const remainingLotsDecimal = currentLotSize.minus(closeLots).toDecimalPlaces(2)
      remainingLots = remainingLotsDecimal.toNumber()
      isPartial = remainingLots > 0
      if (isPartial && (remainingLots < minLotSize || !isValidLotSize(remainingLots))) {
        await rollback(client)
        return res.status(400).json({
          error: `Partial close must leave at least ${minLotSize.toFixed(2)} lots open`
        })
      }

      const ratio = closeLots.div(currentLotSize)
      const originalCommission = new Decimal(
        lockedTrade.commission ?? lockedTrade.original_commission ?? 0
      )
      const partialCommission = originalCommission.times(ratio).toDecimalPlaces(2).toNumber()
      const remainingCommission = originalCommission.minus(partialCommission).toDecimalPlaces(2).toNumber()
      demoPnl = dependencies.calculatePnl(
        lockedTrade.direction,
        lockedTrade.open_price,
        closePrice,
        closeLotsNumber,
        lockedTrade.instrument,
        partialCommission
      )

      if (isPartial) {
        const partialCloseResult = await client.query<ReturningIdRow>(
          `INSERT INTO trades (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
           status, close_price, close_time, demo_pnl, close_reason, commission, original_commission, parent_trade_id, is_partial,
           close_screenshot_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'closed', $8, NOW(), $9, 'Manual Partial Close', $10, $10, $11, true, NULL)
           RETURNING id`,
          [
            lockedTrade.account_id,
            uuidv4(),
            lockedTrade.instrument,
            lockedTrade.direction,
            persistedDecimal(closeLots),
            lockedTrade.open_price,
            lockedTrade.open_time,
            persistedDecimal(closePrice),
            persistedDecimal(demoPnl),
            persistedDecimal(partialCommission),
            tradeId
          ]
        )
        closedTradeId = partialCloseResult.rows[0]?.id ?? null
        await client.query(
          'UPDATE trades SET lot_size = $1, commission = $2 WHERE id = $3',
          [persistedDecimal(remainingLotsDecimal), persistedDecimal(remainingCommission), tradeId]
        )
      } else {
        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Manual Close',
             pending_close_price  = NULL,
             pending_close_reason = NULL,
             pending_close_at     = NULL
           WHERE id = $3`,
          [persistedDecimal(closePrice), persistedDecimal(demoPnl), tradeId]
        )
        closedTradeId = tradeId
      }

      if (screenshotDataUrl && closedTradeId) {
        const screenshotPath = await dependencies.persistScreenshot({
          tradeId: closedTradeId,
          userId,
          kind: 'close',
          dataUrl: screenshotDataUrl
        })
        if (screenshotPath) {
          await client.query(
            'UPDATE trades SET close_screenshot_path = $1 WHERE id = $2',
            [screenshotPath, closedTradeId]
          )
        }
      }

      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [persistedDecimal(demoPnl), lockedTrade.account_id]
      )
      await client.query('COMMIT')

      const remainingTrade: TradeIndexRow | null = isPartial
        ? {
            ...lockedTrade,
            lot_size: remainingLots,
            commission: remainingCommission,
            stop_loss: undefined,
            take_profit: undefined
          }
        : null
      indexSync = { accountId: lockedTrade.account_id, remainingTrade }
    } catch (transactionError: unknown) {
      await rollback(client)
      throw transactionError
    } finally {
      client.release()
    }

    if (indexSync) {
      const accountEntry = dependencies.getAccountEntry(indexSync.accountId)
      const currentBalance = accountEntry ? accountEntry.currentBalance + demoPnl : null
      if (indexSync.remainingTrade) {
        await dependencies.engine().syncOpenedTrade(indexSync.remainingTrade)
        dependencies.applyRealizedPnl(indexSync.accountId, demoPnl)
        if (accountEntry && currentBalance !== null) {
          dependencies.updateAccountBalance(indexSync.accountId, currentBalance)
        }
        await dependencies.publishTradeIndex('open', {
          trade: indexSync.remainingTrade,
          realizedPnl: demoPnl,
          currentBalance
        })
      } else {
        dependencies.engine().syncClosedTrade(tradeId, indexSync.accountId, demoPnl)
        await dependencies.publishTradeIndex('closed', {
          tradeId,
          accountId: indexSync.accountId,
          realizedPnl: demoPnl,
          currentBalance
        })
      }
      if (!indexSync.remainingTrade && accountEntry && currentBalance !== null) {
        dependencies.updateAccountBalance(indexSync.accountId, currentBalance)
      }
    }

    const io: unknown = req.app.get('io')
    if (isSocketServer(io)) {
      io.to(String(trade.user_id)).emit('account_update', {
        message: `${isPartial ? 'Trade partially closed' : 'Trade closed'} on ${trade.instrument}: ${demoPnl >= 0 ? '+' : ''}$${demoPnl.toFixed(2)}`,
        pnl: demoPnl
      })
    }

    return res.json({
      message: isPartial ? 'Trade partially closed successfully' : 'Trade closed successfully',
      pnl: demoPnl,
      close_price: closePrice,
      is_partial: isPartial,
      remaining_lots: remainingLots
    })
  } catch (error: unknown) {
    if (isNamedError(error, 'FxRateUnavailableError')) {
      logger.warn('Close trade deferred: no USD rate for the instrument', { error: error.message })
      return res.status(503).json({
        error: 'This position cannot be closed right now because a currency rate is unavailable. ' +
               'Your position is unchanged. Please try again shortly.'
      })
    }
    logger.error('Close trade error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not close trade' })
  }
}

async function cancelTradeHandler(
  req: CancelRequest,
  res: ExpressResponse<CancelResponse>
): Promise<ExpressResponse<CancelResponse>> {
  try {
    const body = requestBody(req.body)
    const rawTradeId = body.trade_id
    if (!rawTradeId) return res.status(400).json({ error: 'Trade ID required' })
    const tradeId = String(rawTradeId)

    const tradeResult = await pool.query<PendingTradeOwnerRow>(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'pending'`,
      [tradeId]
    )
    const trade = tradeResult.rows[0]
    if (!trade) return res.status(404).json({ error: 'Pending order not found' })
    if (trade.user_id !== authenticatedUserId(req)) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const cancelResult = await pool.query<ReturningIdRow>(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = 'Cancelled by trader'
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [tradeId]
    )
    if (cancelResult.rowCount === 0) {
      return res.status(409).json({ error: 'Pending order was already processed' })
    }

    dependencies.removePending(tradeId)
    return res.json({ message: 'Order cancelled' })
  } catch (error: unknown) {
    logger.error('Cancel order error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not cancel order' })
  }
}

router.post('/close', authenticateToken, tradeCloseLimiter, closeTradeHandler)
router.post('/cancel', authenticateToken, tradeCloseLimiter, cancelTradeHandler)

router.__test__ = { closeTradeHandler, cancelTradeHandler, dependencies }

export = router
