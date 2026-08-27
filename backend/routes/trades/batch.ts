// POST /api/trades/batch-action — bulk close / breakeven.
// This remains one transaction per matched trade, exactly like the legacy route.

import type {
  BatchTradeAction,
  BatchTradeActionRequestDto,
  BatchTradeActionResponseDto,
  BatchTradeSkippedDto,
  LegacyErrorResponse
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
import pool = require('../../db')
import newsService = require('../../services/newsService')
import tradeShared = require('../../services/tradeShared')
import * as tradeIndex from '../../utils/tradeIndex'
import type { AccountEntry, TradeIndexRow } from '../../utils/tradeIndex'
import { serializeDecimal } from '../../utils/money'
import { calculatePnL } from '../../utils/pnlCalculator'
import logger = require('../../utils/logger')
import tradeRouteShared = require('./shared')
import { authenticateToken } from '../middleware'

type BatchResponse = BatchTradeActionResponseDto | LegacyErrorResponse
type BatchRequest = ExpressRequest<Record<string, never>, BatchResponse, unknown>

interface NewsEvent {
  title: string
}

interface NewsServiceApi {
  getActiveNewsEvent: (minutes: number) => NewsEvent | null
}

interface SecurityApi {
  tradingLimiter: RequestHandler
}

interface TradeIndexSyncApi {
  publish: (type: unknown, payload: unknown) => Promise<boolean>
}

interface BatchEngineApi {
  syncOpenedTrade: (trade: TradeIndexRow) => Promise<unknown>
  syncClosedTrade: (tradeId: string, accountId: string | null, realizedPnl: number | null) => void
}

interface BatchTradeRow extends TradeIndexRow {
  open_time: Date | string
}

interface LockRow extends QueryResultRow {
  id: string
}

interface BatchDependencies {
  getActiveNewsEvent: (minutes: number) => NewsEvent | null
  getTradingRules: () => Promise<{ minHoldSeconds: number }>
  getLivePrice: (instrument: string) => Promise<{ bid: unknown; ask: unknown }>
  getMarketStatus: (instrument: string, options: { purpose: string }) => { open: boolean; reason: string }
  calculatePnl: typeof calculatePnL
  engine: () => BatchEngineApi
  publishTradeIndex: (type: unknown, payload: unknown) => Promise<boolean>
  getAccountEntry: (accountId: string) => AccountEntry | null | undefined
  updateAccountBalance: (accountId: string, currentBalance: number) => void
}

interface BatchTestApi {
  batchActionHandler: (
    req: BatchRequest,
    res: ExpressResponse<BatchResponse>
  ) => Promise<ExpressResponse<BatchResponse>>
  dependencies: BatchDependencies
}

interface BatchRouter extends Router {
  __test__: BatchTestApi
}

const batchBodySchema = z.object({
  action: z.enum(['close_winning', 'close_losing', 'breakeven_winning']),
  account_id: z.string().min(1)
}).passthrough() satisfies z.ZodType<BatchTradeActionRequestDto>

const { tradingLimiter } = require('../../utils/security') as SecurityApi
const typedNewsService = newsService as NewsServiceApi
const dependencies: BatchDependencies = {
  getActiveNewsEvent: typedNewsService.getActiveNewsEvent.bind(typedNewsService),
  getTradingRules: tradeShared.getTradingRules,
  getLivePrice: tradeShared.getLivePrice,
  getMarketStatus: tradeShared.getMarketStatus,
  calculatePnl: calculatePnL,
  engine: tradeRouteShared.engine,
  publishTradeIndex: async (type: unknown, payload: unknown): Promise<boolean> => {
    const sync = require('../../services/tradeIndexSync') as TradeIndexSyncApi
    return sync.publish(type, payload)
  },
  getAccountEntry: tradeIndex.getAccountEntry,
  updateAccountBalance: tradeIndex.updateAccountBalance
}
const router = express.Router() as BatchRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function actionMatches(action: BatchTradeAction, pnl: number): boolean {
  if (action === 'close_winning') return pnl > 0
  if (action === 'close_losing') return pnl < 0
  return pnl > 0
}

function successMessage(
  action: BatchTradeAction,
  affectedCount: number,
  skipped: BatchTradeSkippedDto
): string {
  const skippedCount = skipped.min_hold
    + skipped.price_unavailable
    + skipped.no_match
    + skipped.locked
    + skipped.error
  const actionLabel = action.replace(/_/g, ' ')
  if (affectedCount === 0) {
    if (skipped.min_hold > 0) {
      return `No trades closed yet. ${skipped.min_hold} trade(s) are still inside the minimum hold time.`
    }
    if (skipped.no_match > 0) {
      if (action === 'close_winning') return 'No winning trades are available to close right now.'
      if (action === 'close_losing') return 'No losing trades are available to close right now.'
      return 'No profitable trades are available to move to breakeven right now.'
    }
    if (skipped.price_unavailable > 0) {
      return 'Live price data is unavailable for the selected trade(s). Please try again in a moment.'
    }
    return `No trades were updated for batch ${actionLabel}.`
  }
  if (skippedCount > 0) {
    return `Batch ${actionLabel} completed. ${affectedCount} trade(s) updated, ${skippedCount} skipped.`
  }
  return `Batch ${actionLabel} completed successfully`
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch (_error: unknown) {
    // Preserve the original best-effort rollback: the primary trade error wins.
  }
}

async function batchActionHandler(
  req: BatchRequest,
  res: ExpressResponse<BatchResponse>
): Promise<ExpressResponse<BatchResponse>> {
  try {
    const parsedBody = batchBodySchema.safeParse(req.body)
    if (!parsedBody.success) {
      return res.status(400).json({ error: 'Invalid batch action or account ID' })
    }
    const { action, account_id: accountId } = parsedBody.data
    const openTradesResult = await pool.query<BatchTradeRow>(
      `SELECT t.* FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1 AND t.account_id = $2 AND t.status = 'open'`,
      [authenticatedUserId(req), accountId]
    )
    if (openTradesResult.rows.length === 0) {
      return res.json({ message: 'No open trades to process', affected: 0 })
    }

    const activeNews = dependencies.getActiveNewsEvent(3)
    if (activeNews && action !== 'breakeven_winning') {
      return res.status(400).json({
        error: `Cannot close trades. USD High-impact news event '${activeNews.title}' is active.`
      })
    }
    if (action !== 'breakeven_winning') {
      const batchMarketStatus = dependencies.getMarketStatus('EURUSD', { purpose: 'close' })
      if (!batchMarketStatus.open) {
        return res.status(400).json({ error: `Cannot close trades: ${batchMarketStatus.reason}` })
      }
    }

    const rules = await dependencies.getTradingRules()
    let affectedCount = 0
    const skipped: BatchTradeSkippedDto = {
      min_hold: 0,
      price_unavailable: 0,
      no_match: 0,
      locked: 0,
      error: 0
    }

    const client = await pool.connect()
    try {
      for (const trade of openTradesResult.rows) {
        if (action !== 'breakeven_winning') {
          const secondsOpen = (Date.now() - new Date(trade.open_time).getTime()) / 1000
          if (secondsOpen < rules.minHoldSeconds) {
            skipped.min_hold += 1
            continue
          }
        }

        let currentPrice: number
        try {
          const price = await dependencies.getLivePrice(trade.instrument)
          currentPrice = Number(trade.direction === 'buy' ? price.bid : price.ask)
          if (!Number.isFinite(currentPrice)) throw new Error('Invalid live price')
        } catch (_error: unknown) {
          skipped.price_unavailable += 1
          continue
        }

        const demoPnl = dependencies.calculatePnl(
          trade.direction,
          Number(trade.open_price),
          currentPrice,
          Number(trade.lot_size),
          trade.instrument,
          Number(trade.commission || 0)
        )
        if (!actionMatches(action, demoPnl)) {
          skipped.no_match += 1
          continue
        }

        try {
          await client.query('BEGIN')
          const lock = await client.query<LockRow>(
            `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
            [trade.id]
          )
          if (lock.rows.length === 0) {
            skipped.locked += 1
            await client.query('ROLLBACK')
            continue
          }

          if (action === 'breakeven_winning') {
            await client.query(`UPDATE trades SET stop_loss = $1 WHERE id = $2`, [trade.open_price, trade.id])
            await client.query('COMMIT')
            const updatedTrade = { ...trade, stop_loss: trade.open_price }
            await dependencies.engine().syncOpenedTrade(updatedTrade)
            await dependencies.publishTradeIndex('open', { trade: updatedTrade })
            affectedCount += 1
          } else {
            const persistedPrice = serializeDecimal(new Decimal(currentPrice))
            const persistedPnl = serializeDecimal(new Decimal(demoPnl))
            await client.query(
              `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(), demo_pnl = $2, close_reason = 'Batch Close' WHERE id = $3`,
              [persistedPrice, persistedPnl, trade.id]
            )
            await client.query(
              `UPDATE accounts SET current_balance = current_balance + $1, peak_balance = GREATEST(peak_balance, current_balance + $1) WHERE id = $2`,
              [persistedPnl, trade.account_id]
            )
            await client.query('COMMIT')
            dependencies.engine().syncClosedTrade(trade.id, trade.account_id, demoPnl)
            const batchAccount = dependencies.getAccountEntry(trade.account_id)
            if (batchAccount) {
              dependencies.updateAccountBalance(trade.account_id, batchAccount.currentBalance + demoPnl)
            }
            await dependencies.publishTradeIndex('closed', {
              tradeId: trade.id,
              accountId: trade.account_id,
              realizedPnl: demoPnl,
              currentBalance: batchAccount ? batchAccount.currentBalance + demoPnl : null
            })
            affectedCount += 1
          }
        } catch (transactionError: unknown) {
          await rollback(client)
          logger.error('Batch action trade error:', {
            tradeId: trade.id,
            error: errorMessage(transactionError)
          })
          skipped.error += 1
        }
      }
    } finally {
      client.release()
    }

    return res.json({
      message: successMessage(action, affectedCount, skipped),
      affected: affectedCount,
      attempted: openTradesResult.rows.length,
      skipped,
      minHoldSeconds: rules.minHoldSeconds
    })
  } catch (error: unknown) {
    logger.error('Batch action error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not process batch action' })
  }
}

router.post(
  '/batch-action',
  authenticateToken as RequestHandler,
  tradingLimiter,
  batchActionHandler
)

router.__test__ = { batchActionHandler, dependencies }

export = router
