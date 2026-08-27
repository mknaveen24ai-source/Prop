import Decimal from 'decimal.js'
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { PoolClient, QueryResultRow } from 'pg'
import type { Server } from 'socket.io'
import pool = require('../db')
import logger = require('../utils/logger')
import * as priceCache from '../utils/priceCache'
import * as tradeIndex from '../utils/tradeIndex'
import type {
  AccountEntry,
  AccountIndexRow,
  PendingEntry,
  PendingIndexRow,
  TradeEntry,
  TradeIndexRow
} from '../utils/tradeIndex'
import drawdownService = require('./drawdownService')
import { checkFeedHealthWithAlerting } from './feedHealth'
import tradingDaysService = require('./tradingDaysService')
import { calculatePnL } from '../utils/pnlCalculator'
import { getUsdRateForInstrument } from '../utils/fxRates'
import { getCurrentPricesForTenant } from '../priceFeed'
import tradeShared = require('./tradeShared')
import {
  DIRECTION_BUY,
  closePriceFor,
  fastPnL,
  isPendingTriggered,
  isSLTriggered,
  isTPTriggered
} from '../utils/fastPnL'

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type NumericInput = string | number | null | undefined
type CachedPriceMap = ReturnType<typeof priceCache.getAllPrices>
type TenantPriceMap = Awaited<ReturnType<typeof getCurrentPricesForTenant>>
type LivePriceMap = Awaited<ReturnType<typeof tradeShared.getLivePriceMap>>
type TradingRules = Awaited<ReturnType<typeof tradeShared.getTradingRules>>

interface StepModelRow {
  funded_max_drawdown_pct: NumericInput
  funded_daily_drawdown_pct: NumericInput
  funded_drawdown_locks_at_pct: NumericInput
}

interface StepModelsApi {
  fetchStepModelBySlug: (slug: string) => Promise<StepModelRow | null>
}

interface PromotionReview {
  id: string
  target_account_type: string
}

interface ProgressionApi {
  createPendingPromotionReview: (
    client: PoolClient,
    account: EngineAccount,
    options: {
      triggeredBy: string
      reason: string
      payload: Record<string, unknown>
    }
  ) => Promise<PromotionReview | null>
}

interface MetricsApi {
  recordEngineTick: (kind: string, durationMs: number | undefined) => void
}

interface OpenTradeRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: string
  open_price: string
  stop_loss: string | null
  take_profit: string | null
  status: string
  open_time: Date | string | null
  demo_trade_id: string
  commission: string | null
  pending_close_price: string | null
  pending_close_reason: string | null
  user_id: string | null
}

interface PendingOrderRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: NumericInput
  order_type: string
  pending_price: NumericInput
  user_id: string | null
  current_balance?: NumericInput
  peak_balance?: NumericInput
  account_status?: string
  account_size: NumericInput
  phase_end_date?: Date | string | null
  account_type: string
  scaling_multiplier: NumericInput
  oco_group_id: string | null
}

interface CountRow extends QueryResultRow {
  count: string
}

interface IdRow extends QueryResultRow {
  id: string
}

interface EngineAccount {
  id: string
  user_id: string | null
  current_balance: number
  starting_balance: number
  peak_balance: number
  max_drawdown_pct: number
  account_type: string
  account_size: number
  profit_target: number
  eod_peak_equity: NumericInput
  eod_trailing_floor: NumericInput
  challenge_model_slug: string | null
  daily_drawdown_pct: number | null
}

interface FloatingTradeRow extends OpenTradeRow {
  current_balance: string
  starting_balance: string
  peak_balance: string
  max_drawdown_pct: string
  account_type: string
  profit_target: string | null
  account_size: string
  acc_starting: string
  eod_peak_equity: NumericInput
  eod_trailing_floor: NumericInput
  challenge_model_slug: string | null
  daily_drawdown_pct: string | null
}

interface SettlementTrade {
  id?: string
  direction: string
  open_price: NumericInput
  lot_size: NumericInput
  instrument: string
  commission: NumericInput
}

interface AutoCloseTradeRow extends QueryResultRow, SettlementTrade {
  id: string
  account_id: string
  status: string
}

interface Settlement {
  closePrice: number
  pnl: number
  priceless: boolean
}

interface BulkSettlement {
  id: string
  closePrice: number
  pnl: number
}

interface SlTpCandidate {
  trade: TradeEntry
  closePrice: number
  reason: string
  deferred?: boolean
  level?: number
  demoPnl?: number
}

interface TrailingBreachCandidate {
  account: AccountEntry
  equity: number
  floor: number
  maxDrawdownPct: number
  kind: 'trailing'
}

interface DailyBreachCandidate {
  account: AccountEntry
  equity: number
  dailyLossPct: number
  dailyDrawdownPct: number
  kind: 'daily'
}

type BreachCandidate = TrailingBreachCandidate | DailyBreachCandidate

interface PassCandidate {
  account: AccountEntry
  equity: number
  profitTarget: number
}

interface EquitySnapshot {
  accountId: string
  userId: string | null
  equity: number
  floatingPnl: number
  currentBalance: number
  floor: number
  startingBalance: number
  profitTarget: number
  accountType: string
  dailyLossPct: number
  dailyDrawdownPct: number | null
}

interface TickResult {
  scanned: number
  accounts: number
  closures: number
  equity: EquitySnapshot[]
  durationMs: number
}

interface Confirmation {
  acc: EngineAccount
  equity: Decimal
  floatingPnl: Decimal
  startingBalance: number
}

interface DirtyPeak {
  peak: number | null
  lockedFloor: number | null
}

interface FundedModelSettings {
  funded_max_drawdown_pct: number
  funded_daily_drawdown_pct: number
  funded_drawdown_locks_at_pct: number | null
}

const { fetchStepModelBySlug } = require('../utils/stepModels') as StepModelsApi
const { createPendingPromotionReview } = require('./progressionService') as ProgressionApi
const { recordEngineTick } = require('../utils/prometheusMetrics') as MetricsApi
const {
  ensureTradeExperienceInfrastructure,
  getTradingRules,
  getLivePriceMap,
  getMarketStatus,
  safeRecordViolation,
  safeRecordEnforcement
} = tradeShared

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/**
 * Trade Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns every background trading decision: SL/TP triggers, pending-order fills,
 * trailing-drawdown breaches, daily-loss breaches and profit-target passes.
 *
 * Extracted from routes/trades.js, where these lived alongside the HTTP
 * handlers despite never being HTTP handlers themselves.
 *
 * ── Two paths, one set of rules ──
 *
 *   onPriceTick()          Event-driven. Runs on every price tick, scans only
 *                          the trades on instruments that actually moved, and
 *                          reacts in ~50-80ms.
 *
 *   checkSLTP()            The original interval loops. Under ENGINE_MODE=event
 *   checkPendingOrders()   they stay registered at a slow cadence as a safety
 *   checkFloatingDrawdown()net, so anything the fast path misses still gets
 *                          caught. Under ENGINE_MODE=interval they are the
 *                          engine, at their original cadence.
 *
 * Both paths end in the *same* closure functions (autoCloseAndFail,
 * autoCloseAndPass, the SL/TP close transaction), so there is exactly one
 * implementation of what happens when a rule fires.
 *
 * ── Float detects, Decimal confirms ──
 *
 * The fast path scans with native floats (utils/fastPnL.js) because Decimal.js
 * at 100K trades costs ~500ms of CPU per pass. But floats never decide anything
 * on their own: every candidate the float scan produces is recomputed with
 * Decimal (utils/pnlCalculator.js) before an account is failed or passed, or a
 * PnL is written. A float rounding error can cause a redundant re-check; it
 * cannot cause a wrong balance.
 */

// ─────────────────────────────────────────────────────────────────────────────
// FIX: Concurrency guards for background engine functions.
// setInterval fires every 500ms, but each function makes DB queries that can
// take longer than 500ms under load. Without guards, multiple invocations pile
// up, issuing redundant queries and exhausting the connection pool.
// ─────────────────────────────────────────────────────────────────────────────
let _checkSLTPRunning = false
let _checkPendingOrdersRunning = false
let _checkFloatingDrawdownRunning = false

// ─────────────────────────────────────────────────────────────────────────────
// checkSLTP — SL/TP background checker
//
// FIX: Previously ran trade close + balance update as two independent queries
// with no transaction. If the balance update failed after the trade was already
// marked closed, the account balance would be permanently wrong.
//
// Fix: each triggered SL/TP now runs inside its own BEGIN/COMMIT block with a
// FOR UPDATE SKIP LOCKED lock on the trade row, preventing the floating
// drawdown checker from racing on the same trade simultaneously.
// ─────────────────────────────────────────────────────────────────────────────
async function checkSLTP(io: TypedServer | null): Promise<void> {
  if (_checkSLTPRunning) return
  _checkSLTPRunning = true
  try {
    await ensureTradeExperienceInfrastructure()
    const openTrades = await pool.query<OpenTradeRow>(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              t.commission,
              t.pending_close_price, t.pending_close_reason,
              a.user_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
         -- checkFloatingDrawdown has always filtered on this and checkSLTP did
         -- not, so this pass walked open trades belonging to failed and passed
         -- accounts too. Those are settled by autoCloseAndFail/Pass inside a
         -- transaction, so acting on one here is at best wasted work on rows
         -- that are about to be closed anyway.
         AND a.status = 'active'
         AND (
           t.stop_loss IS NOT NULL
           OR t.take_profit IS NOT NULL
           -- A crossing recorded inside the hold window (migration 044) must
           -- still fill once the window expires even if the trader has since
           -- cleared the level, so it cannot depend on the level still being set.
           OR t.pending_close_price IS NOT NULL
         )`
    )

    const priceMap = await getLivePriceMap()
    const rules = await getTradingRules()

    for (const trade of openTrades.rows) {
      const price = priceMap[trade.instrument]
      if (!price) continue

      // BUY trades close at BID. SELL trades close at ASK.
      const currentPrice = trade.direction === 'buy'
        ? parseFloat(String(price.bid))
        : parseFloat(String(price.ask))

      const withinHoldWindow = trade.open_time
        ? ((Date.now() - new Date(trade.open_time).getTime()) / 1000) < rules.minHoldSeconds
        : false

      let triggered   = false
      let closeReason = ''
      let levelPrice  = null            // the SL/TP level itself, for a deferred fill
      let fillPrice   = currentPrice    // what a live crossing fills at: the market

      // A level crossed inside the hold window is recorded rather than
      // discarded (see the recording branch below). Once the window expires it
      // fills AT THE LEVEL, regardless of where price has gone since — including
      // all the way back through it. That is the whole point: the stop a trader
      // set is the stop they get. Checked before the live levels so a recorded
      // crossing always wins.
      if (!withinHoldWindow && trade.pending_close_price != null) {
        triggered   = true
        closeReason = trade.pending_close_reason || 'Stop Loss'
        fillPrice   = parseFloat(String(trade.pending_close_price))
      }

      if (!triggered && trade.stop_loss) {
        const sl = parseFloat(trade.stop_loss)
        if (trade.direction === 'buy'  && currentPrice <= sl) { triggered = true; closeReason = 'Stop Loss'; levelPrice = sl }
        if (trade.direction === 'sell' && currentPrice >= sl) { triggered = true; closeReason = 'Stop Loss'; levelPrice = sl }
      }

      if (!triggered && trade.take_profit) {
        const tp = parseFloat(trade.take_profit)
        if (trade.direction === 'buy'  && currentPrice >= tp) { triggered = true; closeReason = 'Take Profit'; levelPrice = tp }
        if (trade.direction === 'sell' && currentPrice <= tp) { triggered = true; closeReason = 'Take Profit'; levelPrice = tp }
      }

      if (!triggered) continue

      // M-06 resolved by behaviour change (migration 044). This used to be a
      // bare `continue`: a level crossed inside the admin-configurable hold
      // window was discarded, so a stop touched at second 10 either filled at
      // whatever the price happened to be at second 61 or — if price had come
      // back — never filled at all. Stop loss did not mean stop loss for the
      // first minHoldSeconds, and the published rules had to say so.
      //
      // Now the crossing is recorded and honoured at the level once the window
      // expires. The window still prevents a position being CLOSED inside it,
      // which is the anti-scalping rule it exists for; it no longer means the
      // protective order is absent.
      //
      // First crossing wins — the `pending_close_price IS NULL` guard makes the
      // write a no-op when a trigger is already recorded, so a stop touched at
      // second 10 is not overwritten by a take profit touched at second 40.
      if (withinHoldWindow) {
        if (levelPrice != null) {
          try {
            await pool.query(
              `UPDATE trades
                  SET pending_close_price  = $2,
                      pending_close_reason = $3,
                      pending_close_at     = NOW()
                WHERE id = $1
                  AND status = 'open'
                  AND pending_close_price IS NULL`,
              [trade.id, levelPrice, closeReason]
            )
          } catch (err) {
            logger.error(`checkSLTP: could not record deferred ${closeReason} for trade ${trade.id}:`, { error: errorMessage(err) })
          }
        }
        continue
      }

      // FIX: wrap close + balance update in a transaction with row-level lock
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Lock the trade row — skip if already being processed elsewhere
        const lockResult = await client.query<IdRow>(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (lockResult.rows.length === 0) {
          await client.query('ROLLBACK')
          continue
        }

        // fillPrice is the market for a live crossing and the RECORDED LEVEL
        // for one deferred out of the hold window — see the trigger block above.
        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          fillPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(String(trade.commission || 0))
        )

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3,
             pending_close_price  = NULL,
             pending_close_reason = NULL,
             pending_close_at     = NULL
           WHERE id = $4`,
          [fillPrice, demo_pnl, closeReason, trade.id]
        )

        await client.query(
          `UPDATE accounts SET
             current_balance = current_balance + $1,
             peak_balance    = GREATEST(peak_balance, current_balance + $1)
           WHERE id = $2`,
          [demo_pnl, trade.account_id]
        )

        await client.query('COMMIT')

        tradeIndex.removeTrade(trade.id)
        tradeIndex.applyRealizedPnl(trade.account_id, demo_pnl)

        if (io) {
          io.to(String(trade.user_id)).emit('account_update', {
            message: `${closeReason} triggered on ${trade.instrument}`,
            pnl: demo_pnl
          })
        }
      } catch (err: unknown) {
        // FIX (M-07): .catch() because a dead connection makes ROLLBACK itself
        // throw, and that escapes the handler and aborts the rest of the engine
        // pass. fillPendingOrder already guarded this; these did not.
        await client.query('ROLLBACK').catch(() => {})
        logger.error(`checkSLTP: transaction failed for trade ${trade.id}:`, { error: errorMessage(err) })
      } finally {
        client.release()
      }
    }
  } catch (error: unknown) {
    logger.error('SL/TP check error:', { error: errorMessage(error) })
  } finally {
    _checkSLTPRunning = false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending orders background checker
// ─────────────────────────────────────────────────────────────────────────────
async function cancelPendingOrder(orderId: string, reason: string): Promise<void> {
  await pool.query(
    `UPDATE trades SET
       status = 'cancelled',
       close_time = NOW(),
       close_reason = $1
     WHERE id = $2`,
    [reason, orderId]
  )
  tradeIndex.removePending(orderId)
}

// `livePrices` is no longer read: it existed to value open positions for the
// margin check, which is gone now that leverage is unlimited. Kept in the
// signature because checkPendingOrders passes it positionally and will need it
// again if any price-dependent trigger validation is added.
 
async function validatePendingTrigger(
  client: PoolClient,
  order: PendingOrderRow,
  rules: TradingRules,
  _livePrices: LivePriceMap | CachedPriceMap
): Promise<string | null> {
  const lotsNum = parseFloat(String(order.lot_size))
  if (isNaN(lotsNum) || lotsNum <= 0) {
    return 'Invalid lot size on pending order'
  }

  // Existence check only. This used to also read current_balance for the margin
  // check; the balance itself is no longer needed, but an order whose account
  // vanished between placement and trigger must still not fill.
  const accountResult = await client.query<IdRow>(
    `SELECT 1 FROM accounts WHERE id = $1`,
    [order.account_id]
  )
  if (accountResult.rows.length === 0) {
    return 'Account not found during pending order trigger'
  }

  const maxOpenTrades = rules.maxOpenPositions
  const openTradeCountResult = await client.query<CountRow>(
    `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status IN ('open', 'pending') AND id <> $2`,
    [order.account_id, order.id]
  )
  const currentOpenCount = parseInt(String(openTradeCountResult.rows[0]?.count || 0), 10)
  if ((currentOpenCount + 1) > maxOpenTrades) {
    return `Pending order exceeds max open trades (${maxOpenTrades})`
  }

  // No margin check at trigger. Leverage is unlimited, so calculateMargin()
  // returns 0 and an "insufficient equity" refusal could never fire — keeping
  // the walk over open positions purely to compute an equity figure nothing
  // then compares against would be dead work on the hot fill path.
  //
  // The per-$1k exposure caps that used to sit above are gone for the same
  // reason they are gone from POST /open: with no margin requirement, a limit
  // expressed in lots-per-$1k describes nothing a trader can act on. Refusing a
  // fill on a cap the placement path no longer applies would also mean an order
  // accepted at placement silently dying at trigger, which is the worst
  // possible shape for a pending order.

  return null
}

async function checkPendingOrders(io: TypedServer | null): Promise<void> {
  if (_checkPendingOrdersRunning) return
  _checkPendingOrdersRunning = true
  try {
    await ensureTradeExperienceInfrastructure()
    const pendingOrders = await pool.query<PendingOrderRow>(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.order_type,
              t.pending_price, t.status, a.user_id, a.current_balance, a.peak_balance,
              a.status as account_status, a.account_size, a.phase_end_date,
              a.account_type, a.scaling_multiplier, t.oco_group_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'pending'`
    )

    const priceMap = await getLivePriceMap()
    const rules = await getTradingRules()

    for (const order of pendingOrders.rows) {
      if (order.account_status !== 'active') {
        await cancelPendingOrder(order.id, 'Account inactive')
        continue
      }

      if (order.phase_end_date && new Date(order.phase_end_date) <= new Date()) {
        await cancelPendingOrder(order.id, 'Challenge phase expired')
        continue
      }

      const pendingMarketStatus = getMarketStatus(order.instrument, { purpose: 'open' })
      if (!pendingMarketStatus.open) {
        continue
      }

      const price = priceMap[order.instrument]
      if (!price) continue

      const bid           = parseFloat(String(price.bid))
      const ask           = parseFloat(String(price.ask))
      const pending_price = parseFloat(String(order.pending_price))

      let triggered = false

      if (order.order_type === 'buy_limit'  && ask <= pending_price) triggered = true
      if (order.order_type === 'sell_limit' && bid >= pending_price) triggered = true
      if (order.order_type === 'buy_stop'   && ask >= pending_price) triggered = true
      if (order.order_type === 'sell_stop'  && bid <= pending_price) triggered = true

      if (triggered) {
        await fillPendingOrder(io, order, rules, priceMap, { bid, ask })
      }
    }
  } catch (error: unknown) {
    logger.error('Pending orders check error:', { error: errorMessage(error) })
  } finally {
    _checkPendingOrdersRunning = false
  }
}

/**
 * Fill a pending order whose trigger price has been reached.
 *
 * Shared by both engine paths. The event-driven path only moves the *price*
 * comparison onto the tick — every validation below (exposure caps, open-trade
 * count, margin) still runs here inside the transaction, exactly as before.
 *
 * FIX (Bug 4): Wrap activation in a transaction with row lock to prevent
 * double-triggering and concurrent limit violations.
 */
async function fillPendingOrder(
  io: TypedServer | null,
  order: PendingOrderRow,
  rules: TradingRules,
  priceMap: LivePriceMap | CachedPriceMap,
  prices: { bid: number; ask: number }
): Promise<void> {
  const { bid, ask } = prices
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let cancelledSiblingRows: IdRow[] = []

    // Lock the order row — skip if already being processed elsewhere
    const lockResult = await client.query<IdRow>(
      `SELECT id FROM trades WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
      [order.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const limitError = await validatePendingTrigger(client, order, rules, priceMap)
    if (limitError) {
      await client.query(
        `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = $1 WHERE id = $2`,
        [limitError, order.id]
      )
      await client.query('COMMIT')
      tradeIndex.removePending(order.id)
      return
    }

    const open_price = order.direction === 'buy' ? ask : bid

    const activatedResult = await client.query<TradeIndexRow>(
      `UPDATE trades SET
         status = 'open',
         open_price = $1,
         open_time = NOW(),
         close_reason = NULL
       WHERE id = $2
       RETURNING id, account_id, instrument, direction, lot_size, open_price,
                 stop_loss, take_profit, commission, open_time`,
      [open_price, order.id]
    )

    if (order.oco_group_id) {
      const siblingCancelResult = await client.query<IdRow>(
        `UPDATE trades
         SET status = 'cancelled',
             close_time = NOW(),
             close_reason = 'OCO sibling triggered'
         WHERE oco_group_id = $1
           AND id <> $2
           AND status = 'pending'
         RETURNING id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit, status, close_reason`,
        [order.oco_group_id, order.id]
      )
      cancelledSiblingRows = siblingCancelResult.rows
    }

    await client.query('COMMIT')

    // Index sync — the order stops being pending and becomes an open trade.
    tradeIndex.removePending(order.id)
    for (const sibling of cancelledSiblingRows) {
      tradeIndex.removePending(sibling.id)
    }
    if (activatedResult.rows[0]) {
      addOpenTradeToIndex(activatedResult.rows[0])
    }

    if (io) {
      io.to(String(order.user_id)).emit('account_update', {
        message: `${order.order_type.replace(/_/g, ' ').toUpperCase()} triggered on ${order.instrument} at ${open_price}`,
        pnl: null
      })
    }

    logger.info(`Pending order ${order.id} triggered: ${order.order_type} ${order.instrument} at ${open_price}`)
  } catch (txErr: unknown) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`checkPendingOrders: transaction error for order ${order.id}:`, { error: errorMessage(txErr) })
  } finally {
    client.release()
  }
}

/**
 * Close price and PnL for one position being force-settled.
 *
 * ── Why this is shared rather than written twice ──
 *
 * M-04 was exactly this logic drifting apart: autoCloseAndFail settled a trade
 * with no live price flat at the open price and carried on, while
 * autoCloseAndPass threw and aborted the whole promotion. A feed outage could
 * therefore fail an account but never pass one — a house-favouring asymmetry
 * that stranded traders who had legitimately hit their target.
 *
 * The two paths were then fixed to agree, and the agreement was guarded by a
 * regex over both function bodies. One function is a better guarantee than two
 * copies and a pattern match: there is now a single decision, so they cannot
 * drift again.
 *
 * A priceless trade settles at `open_price` for zero PnL — flat, so the outcome
 * never depends on which rule fired.
 *
 * @param {object} trade    row with direction, open_price, lot_size, instrument, commission
 * @param {object|null} priceData  live bid/ask, or null/undefined when unavailable
 * @returns {{ closePrice: number, pnl: number, priceless: boolean }}
 */
function settlementFor(trade: SettlementTrade, priceData: { bid: NumericInput; ask: NumericInput } | null | undefined): Settlement {
  const openPrice = parseFloat(String(trade.open_price))

  if (!priceData) {
    return { closePrice: openPrice, pnl: 0, priceless: true }
  }

  // BUY closes at BID, SELL closes at ASK.
  const closePrice = trade.direction === 'buy'
    ? parseFloat(String(priceData.bid))
    : parseFloat(String(priceData.ask))

  return {
    closePrice,
    pnl: calculatePnL(
      trade.direction,
      openPrice,
      closePrice,
      parseFloat(String(trade.lot_size)),
      trade.instrument,
      parseFloat(String(trade.commission || 0))
    ),
    priceless: false
  }
}

/**
 * Close a set of positions in ONE statement.
 *
 * Both auto-close paths used to issue an UPDATE per trade inside their
 * transaction, holding the account row lock and every trade's FOR UPDATE lock
 * across N sequential round-trips. That is the mass-breach path — the moment
 * when the engine is least able to afford N of anything — and closeTriggeredTrades
 * already had the bulk shape. This gives the other two the same one.
 */
async function bulkCloseTrades(
  client: PoolClient,
  settlements: readonly BulkSettlement[],
  closeReason: string
): Promise<void> {
  if (settlements.length === 0) return
  await client.query(
    `UPDATE trades SET
       status = 'closed',
       close_price = v.close_price,
       close_time = NOW(),
       demo_pnl = v.pnl,
       close_reason = $4
     FROM (
       SELECT unnest($1::uuid[])    AS id,
              unnest($2::numeric[]) AS close_price,
              unnest($3::numeric[]) AS pnl
     ) v
     WHERE trades.id = v.id`,
    [
      settlements.map((s) => s.id),
      settlements.map((s) => s.closePrice),
      settlements.map((s) => s.pnl),
      closeReason
    ]
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// autoCloseAndFail — balance update race condition resolved.
// Collects all trade PnLs first, then applies a single summed balance UPDATE
// after all trades are closed inside the same transaction.
// ─────────────────────────────────────────────────────────────────────────────
async function autoCloseAndFail(
  acc: EngineAccount,
  reason: string,
  io: TypedServer | null,
  sharedPriceMap: TenantPriceMap | null = null
): Promise<void> {
  // Fetched before BEGIN on purpose. getCurrentPricesForTenant() runs
  // `SELECT * FROM price_feed` (plus a settings lookup) on a *separate* pool
  // connection; issuing it mid-transaction held this account's row lock and the
  // FOR UPDATE locks on every one of its open trades for the duration of an
  // unrelated round-trip. Prices are a read-only snapshot either way, so
  // hoisting changes nothing about the close arithmetic.
  //
  // sharedPriceMap lets a caller settling MANY accounts fetch it once instead of
  // once per account — see settleAccountOutcomes. A market gap that breaches 500
  // accounts issued 500 identical price queries. Same snapshot, same arithmetic.
  const priceMap = sharedPriceMap || await getCurrentPricesForTenant()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query<IdRow>(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const openTrades = await client.query<AutoCloseTradeRow>(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status, commission
       FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [acc.id]
    )

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)
    const settlements: BulkSettlement[] = []

    for (const trade of openTrades.rows) {
      // FIX (M-03): this loop used to wrap each trade in its own try/catch and
      // log-and-continue on error. That could not work: in Postgres any
      // statement error aborts the whole transaction, so every subsequent query
      // fails too and the COMMIT below throws anyway. The catch only created
      // the appearance of resilience while deferring the failure — and because
      // totalPnlDec is accumulated BEFORE the UPDATE, a swallowed error left
      // the running total crediting a trade that was never closed.
      //
      // Now errors propagate to the outer handler, the transaction rolls back
      // cleanly, and the next engine pass retries the whole account.
      //
      // The loop no longer issues statements at all — it computes, and
      // bulkCloseTrades writes every row in one. See settlementFor for the
      // priceless case, which both auto-close paths now share.
      const settlement = settlementFor(trade, priceMap[trade.instrument])
      if (settlement.priceless) {
        logger.warn(`autoCloseAndFail: no live price for ${trade.instrument} — closing trade ${trade.id} flat`, {
          accountId: acc.id, tradeId: trade.id
        })
      }
      totalPnlDec = totalPnlDec.plus(settlement.pnl)
      settlements.push({ id: trade.id, closePrice: settlement.closePrice, pnl: settlement.pnl })
    }

    // FIX (BUG-C001): Convert Decimal accumulator to number — was previously
    // referencing undefined `totalPnl` instead of `totalPnlDec`.
    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()

    await bulkCloseTrades(client, settlements, 'Account Failed')

    // Single balance update after all trades are closed — no race condition
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [totalPnl, acc.id]
      )
    }

    const cancelledPendingResult = await client.query<IdRow>(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = 'Account Failed'
       WHERE account_id = $1 AND status = 'pending'
       RETURNING id, account_id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit`,
      [acc.id]
    )

    await client.query(`UPDATE accounts SET status = 'failed' WHERE id = $1`, [acc.id])

    await client.query(
      `INSERT INTO bbook_pnl (date, accounts_failed)
       VALUES (CURRENT_DATE, 1)
       ON CONFLICT (date) DO UPDATE
       SET accounts_failed = bbook_pnl.accounts_failed + 1`
    )

    await client.query('COMMIT')

    // The account is no longer active, so it and all of its trades leave the
    // index entirely — including the pendings cancelled above.
    for (const cancelled of cancelledPendingResult.rows) {
      tradeIndex.removePending(cancelled.id)
    }
    tradeIndex.removeAccount(acc.id)

    await safeRecordViolation({
      violationType: 'floating_drawdown_breach',
      severity: 'critical',
      accountId: acc.id,
      userId: acc.user_id,
      source: 'trades_engine',
      message: reason,
      payload: {
        auto_status: 'failed',
        total_closed_pnl: totalPnl
      }
    })

    await safeRecordEnforcement({
      accountId: acc.id,
      userId: acc.user_id,
      action: 'auto_fail_account',
      status: 'applied',
      message: `Account failed automatically: ${reason}`,
      payload: {
        source: 'floating_drawdown',
        total_closed_pnl: totalPnl
      }
    })

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: `❌ Account FAILED — ${reason}. All trades closed automatically.`,
        pnl: totalPnl,
        account_id: acc.id,
        event: 'account_failed'
      })
    }

    logger.info(`Account ${acc.id} FAILED via floating drawdown — ${reason}`)

  } catch (err: unknown) {
    // FIX (M-07): see note above — an unguarded ROLLBACK on a dead connection
    // takes down the remainder of the engine pass.
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`autoCloseAndFail error for account ${acc.id}:`, { error: errorMessage(err) })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// autoCloseAndPass — same single-update pattern as autoCloseAndFail
// ─────────────────────────────────────────────────────────────────────────────
async function autoCloseAndPass(
  acc: EngineAccount,
  io: TypedServer | null,
  sharedPriceMap: TenantPriceMap | null = null
): Promise<void> {
  // Hoisted above BEGIN for the same reason as autoCloseAndFail: this is a read
  // on a separate pool connection, and running it inside the transaction held
  // the account and trade row locks across an unrelated round-trip.
  // sharedPriceMap serves the same batching purpose as it does there.
  const priceMap = sharedPriceMap || await getCurrentPricesForTenant()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query<IdRow>(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    // Floating pass closes open trades inside this transaction before promotion.
    // This makes the open-trade check and the promotion atomic — eliminating the
    // TOCTOU race where two concurrent engine cycles both saw 0 open trades and
    // both tried to promote the same account.
    const openTrades = await client.query<AutoCloseTradeRow>(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status, commission
       FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [acc.id]
    )

    const closeReason = acc.account_type === 'phase1' ? 'Phase 1 Passed' : 'Phase 2 Passed'
    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)
    const settlements: BulkSettlement[] = []

    for (const trade of openTrades.rows) {
      // FIX (M-04): the priceless case used to throw here, aborting the entire
      // promotion, while autoCloseAndFail closed the same trade at open_price
      // with zero PnL and carried on. A feed outage therefore failed accounts
      // but could never pass them — a house-favouring asymmetry that stranded a
      // trader who had legitimately hit their target.
      //
      // settlementFor is now the single decision for both paths, so the two
      // cannot drift apart again.
      const settlement = settlementFor(trade, priceMap[trade.instrument])
      if (settlement.priceless) {
        logger.warn(`autoCloseAndPass: no live price for ${trade.instrument} — closing trade ${trade.id} flat`, {
          accountId: acc.id, tradeId: trade.id
        })
      }
      totalPnlDec = totalPnlDec.plus(settlement.pnl)
      settlements.push({ id: trade.id, closePrice: settlement.closePrice, pnl: settlement.pnl })
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()

    await bulkCloseTrades(client, settlements, closeReason)

    // Single balance update AND status update after all trades are closed
    await client.query(
      `UPDATE accounts SET
         current_balance = current_balance + $1,
         peak_balance    = GREATEST(peak_balance, current_balance + $1),
         status          = 'passed'
       WHERE id = $2`,
      [totalPnl, acc.id]
    )

    const cancelledPendingResult = await client.query<IdRow>(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = $1
       WHERE account_id = $2 AND status = 'pending'
       RETURNING id, account_id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit`,
      [closeReason, acc.id]
    )

    // Passing raises a promotion review rather than creating the next account
    // outright — an admin approves it from /admin/promotion-reviews. Mirrors
    // challengeEngine.js's passAccount; both are auto-pass paths.
    const review = await createPendingPromotionReview(client, acc, {
      triggeredBy: 'auto_pass',
      reason: 'Floating profit target reached',
      payload: { source: 'tradeEngine', account_type: acc.account_type, account_size: acc.account_size }
    })
    if (!review) {
      throw new Error('Failed to raise promotion review for passed account')
    }

    await client.query('COMMIT')

    for (const cancelled of cancelledPendingResult.rows) {
      tradeIndex.removePending(cancelled.id)
    }
    tradeIndex.removeAccount(acc.id)

    // Was a phase1/phase2 ternary, which mislabelled a passed phase3 account as
    // Phase 2. The target comes off the review row, so it is right for any
    // step model.
    const phaseLabel = /^phase(\d+)$/.test(acc.account_type)
      ? `Phase ${acc.account_type.slice(5)}`
      : acc.account_type
    const passMsg =
      `🏆 ${phaseLabel} PASSED! Floating profit target hit. All trades closed. ` +
      `Your ${review.target_account_type === 'funded' ? 'funded account' : review.target_account_type} is awaiting admin approval.`

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: passMsg,
        pnl: totalPnl,
        account_id: acc.id,
        review_id: review.id,
        target_account_type: review.target_account_type,
        event: 'promotion_pending_review'
      })
    }

    logger.info(
      `Account ${acc.id} PASSED via floating equity (${acc.account_type}) — ` +
      `promotion review #${review.id} raised for ${review.target_account_type}`
    )

  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`autoCloseAndPass error for account ${acc.id}:`, { error: errorMessage(err), auto_pass_aborted: true })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkFloatingDrawdown
//
// FIX 1 (BUG 3): Funded accounts now use funded_max_drawdown_pct from
// platform_settings instead of the stored max_drawdown_pct column, which
// could be stale or accidentally 0 (which would instantly fail any account).
//
// FIX 2 (N+1 query): Previously fetched open trades per-account in a loop
// (N accounts × 1 query each). Now fetches ALL open trades and ALL prices
// in two queries up front and groups in JS — O(2) queries regardless of
// how many active accounts exist.
// ─────────────────────────────────────────────────────────────────────────────
async function checkFloatingDrawdown(io: TypedServer | null): Promise<void> {
  if (_checkFloatingDrawdownRunning) return
  _checkFloatingDrawdownRunning = true
  try {
    // ── Feed circuit breaker (FIX F-23) ────────────────────────────────────
    //
    // The trading routes already refuse to open or close on a quote older than
    // feedHealth.STALE_THRESHOLD_MS. This pass had no equivalent guard, so a
    // feed stall left traders unable to close while the engine kept failing
    // accounts on a frozen mark — and then, on resume, on a gap they never had
    // a chance to react to.
    //
    // Both sides now use the same threshold, so the moment a trader can no
    // longer act is the moment the platform can no longer fail them.
    const feedHealth = await checkFeedHealthWithAlerting()
    if (!feedHealth.healthy) return
    // FIX: single query for all open trades across all active accounts
    const tradesResult = await pool.query<FloatingTradeRow>(
      // FIX (H-01): t.commission was missing from this SELECT while the
      // floating-PnL loop below reads `trade.commission || 0` — so commission
      // silently evaluated to 0 on every open position. Floating equity was
      // overstated by the total open commission, which made accounts fail late
      // and pass early, and made this interval path disagree with the
      // event path (tradeIndex carries commission) on the same account.
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              t.commission,
              a.user_id, a.current_balance, a.starting_balance, a.peak_balance,
              a.max_drawdown_pct, a.account_type, a.profit_target, a.account_size,
              a.starting_balance as acc_starting,
              a.eod_peak_equity, a.eod_trailing_floor, a.challenge_model_slug, a.daily_drawdown_pct
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
         AND a.status = 'active'`
    )

    if (tradesResult.rows.length === 0) return

    const priceMap = await getLivePriceMap()
    const fundedModelSettingsCache = new Map<string, FundedModelSettings>()
    const missingFundedModels = new Set<string>()

    // Group trades by account_id in JS — no extra queries
    const accountTrades: Record<string, FloatingTradeRow[]> = {}
    const accountMeta: Record<string, EngineAccount> = {}

    for (const row of tradesResult.rows) {
      const aid = row.account_id
      if (!accountTrades[aid]) {
        accountTrades[aid] = []
        accountMeta[aid] = {
          id:                    aid,
          user_id:               row.user_id,
          current_balance:       parseFloat(String(row.current_balance)),
          starting_balance:      parseFloat(String(row.acc_starting)),
          peak_balance:          parseFloat(String(row.peak_balance)),
          max_drawdown_pct:      parseFloat(String(row.max_drawdown_pct)),
          account_type:          row.account_type,
          account_size:          parseFloat(String(row.account_size)),
          profit_target:         parseFloat(String(row.profit_target || 0)),
          eod_peak_equity:       row.eod_peak_equity,
          eod_trailing_floor:    row.eod_trailing_floor,
          challenge_model_slug:  row.challenge_model_slug,
          daily_drawdown_pct:    row.daily_drawdown_pct != null ? parseFloat(String(row.daily_drawdown_pct)) : null,
        }
      }
      accountTrades[aid].push(row)
    }

    const todayRealizedMap = await tradingDaysService.getTodayRealizedPnl(pool, Object.keys(accountTrades))

    // FIX (C-01) + perf: resolve each instrument's USD rate ONCE for the whole
    // pass. This loop runs every 1000ms over every open trade on the platform,
    // so letting calculatePnL look the rate up per call would turn a ~0.8µs
    // lookup into the dominant cost of the pass (~470ms at 100K open trades).
    // An unavailable rate leaves the instrument out of the floating total for
    // this pass rather than valuing it at the wrong rate; the next pass retries.
    const usdRates = new Map<string, number>()
    for (const instrument of new Set(tradesResult.rows.map((row) => row.instrument))) {
      try {
        usdRates.set(instrument, getUsdRateForInstrument(instrument))
      } catch (error: unknown) {
        logger.warn('[checkFloatingDrawdown] no USD rate for instrument:', {
          instrument, error: errorMessage(error)
        })
      }
    }

    // Anchor writes accumulated across the pass and flushed as one statement
    // below, rather than up to two UPDATEs per account inside the loop.
    const pendingAnchorUpdates: Array<{ accountId: string; peak: number | null; lockedFloor: number | null }> = []

    for (const [aid, trades] of Object.entries(accountTrades)) {
      const acc = accountMeta[aid]
      if (!acc) continue

      let floatingPnl = new Decimal(0)
      for (const trade of trades) {
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

        const usdRate = usdRates.get(trade.instrument)
        if (usdRate === undefined) continue

        const currentPrice = trade.direction === 'buy'
          ? parseFloat(String(priceData.bid))
          : parseFloat(String(priceData.ask))

        floatingPnl = floatingPnl.plus(calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(String(trade.commission || 0)),
          usdRate
        ))
      }

      const equity = new Decimal(acc.current_balance).plus(floatingPnl)
      let max_drawdown_pct = acc.max_drawdown_pct
      let daily_drawdown_pct = acc.daily_drawdown_pct
      let drawdownLocksAtPct: number | null = null

      if (acc.account_type === 'funded' && acc.challenge_model_slug) {
        let modelSettings = fundedModelSettingsCache.get(acc.challenge_model_slug)
        if (!modelSettings && !missingFundedModels.has(acc.challenge_model_slug)) {
          const model = await fetchStepModelBySlug(acc.challenge_model_slug)
          if (model) {
            modelSettings = {
              funded_max_drawdown_pct: parseFloat(String(model.funded_max_drawdown_pct)),
              funded_daily_drawdown_pct: parseFloat(String(model.funded_daily_drawdown_pct)),
              funded_drawdown_locks_at_pct: model.funded_drawdown_locks_at_pct != null ? parseFloat(String(model.funded_drawdown_locks_at_pct)) : null
            }
            fundedModelSettingsCache.set(acc.challenge_model_slug, modelSettings)
          } else {
            missingFundedModels.add(acc.challenge_model_slug)
          }
        }
        if (modelSettings && Number.isFinite(modelSettings.funded_max_drawdown_pct)) {
          max_drawdown_pct = modelSettings.funded_max_drawdown_pct
          daily_drawdown_pct = modelSettings.funded_daily_drawdown_pct
          drawdownLocksAtPct = modelSettings.funded_drawdown_locks_at_pct
        }
      }

      if (!(max_drawdown_pct > 0)) continue

      // resolveEffectiveFloor is the pure half of getEffectiveDrawdownFloor; the
      // wrapper's other half is up to two UPDATEs per account, awaited inside
      // this loop. That made the pass O(accounts) round trips just to persist
      // anchors that only ever ratchet upwards — and it is the same work the
      // event engine already batches into one bulk statement on a 1s timer.
      //
      // The floor used for the breach decision is unchanged: it comes from the
      // same pure resolver either way. Only the WRITE is deferred, and deferring
      // it is safe because flushPeakEquityUpdates' guards only ever raise an
      // anchor, so a flush racing another writer cannot walk a floor backwards.
      const resolved = drawdownService.resolveEffectiveFloor(acc, {
        equity: equity.toNumber(),
        maxDrawdownPct: max_drawdown_pct,
        drawdownLocksAtPct
      })
      const floor = resolved.floor
      if (resolved.peakChanged || resolved.lockedFloorChanged) {
        pendingAnchorUpdates.push({
          accountId: acc.id,
          peak: resolved.peakChanged ? resolved.nextPeak : null,
          lockedFloor: resolved.lockedFloorChanged ? resolved.nextLockedFloor : null
        })
      }

      // FIX (F-15): boundary semantics. This was `lt(floor)` while the daily-loss
      // check below used `gte(limit)` — so on the same pass, over the same
      // account, a trader exactly ON the daily limit was failed and a trader
      // exactly ON the drawdown floor survived. Neither convention is wrong on
      // its own; disagreeing is indefensible in a dispute, and neither was
      // documented. Both are now inclusive: reaching the limit is a breach.
      if (equity.lte(floor)) {
        const drawdownPctUsed = new Decimal(acc.starting_balance).minus(equity).div(acc.starting_balance).times(100)
        const reason = `Trailing drawdown breach — equity $${equity.toFixed(2)} fell below the $${floor.toFixed(2)} floor (${drawdownPctUsed.toFixed(2)}% of a ${max_drawdown_pct}% limit)`
        logger.info(`Account ${aid} DRAWDOWN BREACH: ${reason}`)
        await autoCloseAndFail(acc, reason, io)
        continue
      }

      if (daily_drawdown_pct != null && Number.isFinite(daily_drawdown_pct) && daily_drawdown_pct > 0 && acc.starting_balance > 0) {
        const todayRealized = todayRealizedMap.get(aid) || 0
        const todayTotalPnl = new Decimal(todayRealized).plus(floatingPnl)
        const todayLossPct = todayTotalPnl.isNegative()
          ? todayTotalPnl.abs().div(acc.starting_balance).times(100)
          : new Decimal(0)
        if (todayLossPct.gte(daily_drawdown_pct)) {
          const reason = `Daily loss limit breach — today's loss ${todayLossPct.toFixed(2)}% reached the ${daily_drawdown_pct}% daily limit`
          logger.info(`Account ${aid} DAILY LOSS BREACH: ${reason}`)
          await autoCloseAndFail(acc, reason, io)
          continue
        }
      }

      // Competition accounts have no profit-target auto-pass — they run for a
      // fixed window and are settled by competitionEngine.js at end_at instead.
      if (acc.account_type === 'funded' || acc.account_type === 'competition') continue

      let profit_target = acc.profit_target
      if (profit_target <= 0) {
        profit_target = acc.starting_balance * 0.10
        logger.warn(`Account ${aid} had no profit_target set — defaulting to 10% = $${profit_target.toFixed(2)}`)
      }

      const equity_profit = equity.minus(acc.starting_balance)
      if (equity_profit.gte(profit_target)) {
        // FIX (BUG-9): Open-trade COUNT was outside the transaction so two concurrent
        // engine cycles (floating-drawdown + challenge engine) could both read 0 and
        // both attempt promotion simultaneously. The COUNT is now moved INSIDE
        // autoCloseAndPass, after the FOR UPDATE lock, so only one promotion wins.
        await autoCloseAndPass(acc, io)
      }
    }

    // One statement regardless of how many accounts moved their anchors.
    // Deliberately last and deliberately non-fatal: these are cached values that
    // only ratchet upward, so a failed flush costs a recomputation on the next
    // pass and nothing else. It must never be the reason a breach went
    // unenforced, which is why it sits after every decision above.
    if (pendingAnchorUpdates.length > 0) {
      try {
        await drawdownService.flushPeakEquityUpdates(pool, pendingAnchorUpdates)
      } catch (flushErr: unknown) {
        logger.error('Floating drawdown anchor flush failed; anchors recompute next pass:', {
          error: errorMessage(flushErr), pending: pendingAnchorUpdates.length
        })
      }
    }

  } catch (error: unknown) {
    logger.error('Floating drawdown check error:', { error: errorMessage(error) })
  } finally {
    _checkFloatingDrawdownRunning = false
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EVENT-DRIVEN PATH
// ═════════════════════════════════════════════════════════════════════════════

let _tickRunning = false
let _tickCoalesced: Set<string> | null = null   // Set of instruments that arrived while a tick ran
let _dirtyPeaks = new Map<string, DirtyPeak>() // accountId → { peak, lockedFloor }

// Scratch structures, reused across ticks. At 100K trades, allocating fresh maps
// per tick turns into GC pressure that shows up as latency jitter the
// microbenchmarks never see.
const _touchedAccounts = new Set<string>()
const _slTpCandidates: SlTpCandidate[] = []
const _pendingCandidates: PendingEntry[] = []

/**
 * The event-driven engine tick.
 *
 * @param {import('socket.io').Server} io
 * @param {string[]} changedInstruments Instruments whose bid/ask moved
 * @returns {Promise<{
 *   scanned: number, accounts: number, closures: number,
 *   equity: Array<object>, durationMs: number
 * }|null>}
 */
async function onPriceTick(
  io: TypedServer | null,
  changedInstruments: readonly string[]
): Promise<TickResult | null> {
  // Until the index has been built from the database, the interval fallbacks are
  // the only correct path — acting on a half-populated index would mean judging
  // accounts on trades we cannot see.
  if (!tradeIndex.isReady()) return null
  if (!changedInstruments || changedInstruments.length === 0) return null

  if (_tickRunning) {
    // Coalesce rather than queue: what matters is the latest price, and running
    // two overlapping ticks would double-count floating PnL deltas.
    if (!_tickCoalesced) _tickCoalesced = new Set()
    for (const instrument of changedInstruments) _tickCoalesced.add(instrument)
    return null
  }

  _tickRunning = true
  try {
    let result = await runTick(io, changedInstruments)
    recordEngineTick('price_tick', result?.durationMs)
    while (_tickCoalesced && _tickCoalesced.size > 0) {
      const next = Array.from(_tickCoalesced)
      _tickCoalesced = null
      result = await runTick(io, next)
      recordEngineTick('price_tick', result?.durationMs)
    }
    return result
  } catch (error: unknown) {
    logger.error('[tradeEngine] tick failed:', { error: errorMessage(error) })
    return null
  } finally {
    _tickRunning = false
    _tickCoalesced = null
  }
}

async function runTick(io: TypedServer | null, changedInstruments: readonly string[]): Promise<TickResult> {
  // hrtime, not Date.now(): a scan of a few thousand trades finishes well inside
  // one millisecond, which Date.now() cannot resolve at all.
  const startedAt = process.hrtime.bigint()
  const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6

  _touchedAccounts.clear()
  _slTpCandidates.length = 0
  _pendingCandidates.length = 0

  let scanned = 0

  // ── Phase A: scan (native float, synchronous, no I/O) ──────────────────────
  for (const instrument of changedInstruments) {
    const price = priceCache.getPrice(instrument)
    if (!price) continue

    // FIX (C-01): PnL comes out in the instrument's quote currency, so it needs
    // a USD multiplier. Resolved once here, per instrument, rather than inside
    // the per-trade loop below — the scan stays O(instruments) on rate lookups.
    //
    // Skipping the instrument on an unavailable rate mirrors the `!price`
    // guard above: the interval fallbacks still cover it, and it is the only
    // safe option since the alternative is valuing the position at the wrong
    // rate. Rate sources are themselves subscribed instruments, so this can
    // only really fire while the feed is still warming.
    let usdRate
    try {
      usdRate = getUsdRateForInstrument(instrument)
    } catch (error: unknown) {
      logger.warn('[tradeEngine] skipping instrument — no USD rate:', {
        instrument, error: errorMessage(error)
      })
      continue
    }

    const trades = tradeIndex.getTradesByInstrument(instrument)
    for (const trade of trades.values()) {
      scanned++

      const closePrice = closePriceFor(trade.sign, price)

      // Floating PnL is maintained incrementally: an account's total is the sum
      // over ALL its trades, but only the ones on instruments that moved need
      // recomputing. Storing each trade's last contribution makes the update a
      // delta rather than a full re-sum — which is what keeps the tick O(moved)
      // instead of O(open trades).
      const pnl = fastPnL(
        trade.sign,
        trade.openPrice,
        closePrice,
        trade.lots,
        trade.contractSize,
        trade.commission,
        usdRate
      )
      tradeIndex.applyTradePnl(trade, pnl)
      _touchedAccounts.add(trade.accountId)

      // A crossing recorded inside the minimum-hold window (migration 044) is
      // filled AT THE LEVEL, not at the market, and it outranks a live crossing
      // — first crossing wins. closeTriggeredTrades applies the hold window
      // itself, so a still-young trade with a recorded trigger simply waits.
      if (trade.pendingClosePrice != null) {
        _slTpCandidates.push({
          trade,
          closePrice: trade.pendingClosePrice,
          reason: trade.pendingCloseReason || 'Stop Loss',
          deferred: true
        })
      } else if (trade.stopLoss != null && isSLTriggered(trade.sign, trade.stopLoss, closePrice)) {
        _slTpCandidates.push({ trade, closePrice, reason: 'Stop Loss', level: trade.stopLoss })
      } else if (trade.takeProfit != null && isTPTriggered(trade.sign, trade.takeProfit, closePrice)) {
        _slTpCandidates.push({ trade, closePrice, reason: 'Take Profit', level: trade.takeProfit })
      }
    }

    const pendings = tradeIndex.getPendingByInstrument(instrument)
    for (const order of pendings.values()) {
      if (isPendingTriggered(order.orderType, order.triggerPrice, price)) {
        _pendingCandidates.push(order)
      }
    }
  }

  if (_touchedAccounts.size === 0 && _pendingCandidates.length === 0) {
    return { scanned, accounts: 0, closures: 0, equity: [], durationMs: elapsedMs() }
  }

  // ── Phase B: evaluate accounts (native float) ──────────────────────────────
  const breachCandidates: BreachCandidate[] = []
  const passCandidates: PassCandidate[] = []
  const equitySnapshots: EquitySnapshot[] = []

  for (const accountId of _touchedAccounts) {
    const account = tradeIndex.getAccountEntry(accountId)
    if (!account || account.status !== 'active') continue

    const equity = account.currentBalance + account.floatingPnl
    const maxDrawdownPct = account.maxDrawdownPct

    if (maxDrawdownPct == null || !(maxDrawdownPct > 0)) continue

    const resolved = drawdownService.resolveEffectiveFloor(
      {
        starting_balance: account.startingBalance,
        eod_peak_equity: account.eodPeakEquity,
        eod_trailing_floor: account.eodTrailingFloor,
        account_type: account.accountType
      },
      {
        equity,
        maxDrawdownPct,
        drawdownLocksAtPct: account.drawdownLocksAtPct
      }
    )

    // Peak equity is persisted in bulk on a timer rather than per account per
    // tick — see drawdownService.flushPeakEquityUpdates. Keeping it in memory
    // here means the floor stays correct for subsequent ticks either way.
    if (resolved.peakChanged || resolved.lockedFloorChanged) {
      tradeIndex.setPeakEquity(accountId, resolved.nextPeak, resolved.nextLockedFloor)
      _dirtyPeaks.set(accountId, {
        peak: resolved.peakChanged ? resolved.nextPeak : null,
        lockedFloor: resolved.lockedFloorChanged ? resolved.nextLockedFloor : null
      })
    }

    const dailyPct = account.dailyDrawdownPct
    const todayRealized = tradeIndex.getTodayRealizedPnl(accountId)
    const todayTotal = todayRealized + account.floatingPnl
    const dailyLossPct = account.startingBalance > 0 && todayTotal < 0
      ? (Math.abs(todayTotal) / account.startingBalance) * 100
      : 0

    equitySnapshots.push({
      accountId,
      userId: account.userId,
      equity,
      floatingPnl: account.floatingPnl,
      currentBalance: account.currentBalance,
      floor: resolved.floor,
      startingBalance: account.startingBalance,
      profitTarget: account.profitTarget,
      accountType: account.accountType,
      dailyLossPct,
      dailyDrawdownPct: dailyPct
    })

    // Inclusive, matching the Decimal path above — see FIX (F-15).
    if (equity <= resolved.floor) {
      breachCandidates.push({ account, equity, floor: resolved.floor, maxDrawdownPct, kind: 'trailing' })
      continue
    }

    if (dailyPct != null && Number.isFinite(dailyPct) && dailyPct > 0 && account.startingBalance > 0 && dailyLossPct >= dailyPct) {
      breachCandidates.push({ account, equity, dailyLossPct, dailyDrawdownPct: dailyPct, kind: 'daily' })
      continue
    }

    // Competition accounts have no profit-target auto-pass — they run for a
    // fixed window and are settled by competitionEngine.js at end_at instead.
    if (account.accountType === 'funded' || account.accountType === 'competition') continue

    const profitTarget = account.profitTarget > 0
      ? account.profitTarget
      : account.startingBalance * 0.10
    if (equity - account.startingBalance >= profitTarget) {
      passCandidates.push({ account, equity, profitTarget })
    }
  }

  // ── Phase C + D: confirm with Decimal, then act ────────────────────────────
  let closures = 0

  if (_slTpCandidates.length > 0) {
    closures += await closeTriggeredTrades(io, _slTpCandidates)
  }

  if (breachCandidates.length > 0 || passCandidates.length > 0) {
    closures += await settleAccountOutcomes(io, breachCandidates, passCandidates)
  }

  if (_pendingCandidates.length > 0) {
    await fillTriggeredPendingOrders(io, _pendingCandidates)
  }

  return {
    scanned,
    accounts: _touchedAccounts.size,
    closures,
    equity: equitySnapshots,
    durationMs: elapsedMs()
  }
}

/**
 * Record stop/take levels crossed inside the minimum-hold window.
 *
 * The event path's counterpart to the recording branch in checkSLTP. One bulk
 * statement regardless of how many trades a spike caught, and the
 * `pending_close_price IS NULL` guard makes it idempotent — a level that stays
 * crossed across many ticks records once, and the FIRST crossing is the one
 * that fills.
 *
 * The in-memory entry is updated to match so the very next tick sees the
 * trigger without waiting for a reconcile; if the write fails the entry is left
 * alone, and the interval checkSLTP still catches the crossing from the row.
 */
async function recordDeferredTriggers(candidates: readonly SlTpCandidate[]): Promise<number> {
  const ids: string[] = []
  const prices: Array<number | undefined> = []
  const reasons: string[] = []
  for (const { trade, level, reason } of candidates) {
    ids.push(trade.id)
    prices.push(level)
    reasons.push(reason)
  }

  try {
    const result = await pool.query<IdRow>(
      `UPDATE trades SET
         pending_close_price  = v.level,
         pending_close_reason = v.reason,
         pending_close_at     = NOW()
       FROM (
         SELECT unnest($1::uuid[])    AS id,
                unnest($2::numeric[]) AS level,
                unnest($3::text[])    AS reason
       ) v
       WHERE trades.id = v.id
         AND trades.status = 'open'
         AND trades.pending_close_price IS NULL
       RETURNING trades.id`,
      [ids, prices, reasons]
    )
    const written = new Set(result.rows.map((row) => row.id))
    for (const { trade, level, reason } of candidates) {
      if (!written.has(trade.id)) continue
      if (level === undefined) continue
      trade.pendingClosePrice = level
      trade.pendingCloseReason = reason
    }
    return written.size
  } catch (error: unknown) {
    logger.error('[tradeEngine] could not record deferred SL/TP triggers:', {
      error: errorMessage(error), count: ids.length
    })
    return 0
  }
}

/**
 * Close SL/TP-triggered trades.
 *
 * Phase C (confirm) and Phase D (act) for trade-level triggers. Two things are
 * deliberately preserved from the interval path: the admin-configurable minimum
 * hold time, and the FOR UPDATE SKIP LOCKED guard — without the latter, a
 * straggler interval pass running concurrently could close the same trade twice.
 *
 * The bulk shape matters at scale: a mass stop-out that would previously have
 * been N transactions is four statements regardless of N.
 */
async function closeTriggeredTrades(
  io: TypedServer | null,
  candidates: readonly SlTpCandidate[]
): Promise<number> {
  const rules = await getTradingRules()
  const now = Date.now()

  // Min hold time — mirrors checkSLTP. A trade still inside the window is no
  // longer discarded: its crossing is recorded so it fills AT THE LEVEL once
  // the window expires (migration 044). See checkSLTP for the full rationale.
  const eligible: SlTpCandidate[] = []
  const toDefer: SlTpCandidate[] = []
  for (const candidate of candidates) {
    const { trade } = candidate
    const pastWindow = !trade.openTimeMs || ((now - trade.openTimeMs) / 1000) >= rules.minHoldSeconds
    if (pastWindow) eligible.push(candidate)
    else if (!candidate.deferred && candidate.level != null) toDefer.push(candidate)
  }

  if (toDefer.length > 0) await recordDeferredTriggers(toDefer)
  if (eligible.length === 0) return 0

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const ids = eligible.map((c) => c.trade.id)
    const lockResult = await client.query<IdRow>(
      `SELECT id FROM trades WHERE id = ANY($1::uuid[]) AND status = 'open' FOR UPDATE SKIP LOCKED`,
      [ids]
    )
    const owned = new Set(lockResult.rows.map((row) => row.id))
    if (owned.size === 0) {
      await client.query('ROLLBACK')
      return 0
    }

    // Phase C — recompute every survivor with Decimal. This is the number that
    // gets written; the float value only decided which trades to look at.
    const closeIds: string[] = []
    const closePrices: number[] = []
    const pnls: number[] = []
    const reasons: string[] = []
    const perAccount = new Map<string, { total: Decimal; userId: string | null }>()

    for (const candidate of eligible) {
      const { trade, closePrice, reason } = candidate
      if (!owned.has(trade.id)) continue

      const demoPnl = calculatePnL(
        trade.direction,
        trade.openPrice,
        closePrice,
        trade.lots,
        trade.instrument,
        trade.commission
      )

      closeIds.push(trade.id)
      closePrices.push(closePrice)
      pnls.push(demoPnl)
      reasons.push(reason)

      const running = perAccount.get(trade.accountId) || { total: new Decimal(0), userId: null }
      running.total = running.total.plus(demoPnl)
      perAccount.set(trade.accountId, running)
      candidate.demoPnl = demoPnl
    }

    if (closeIds.length === 0) {
      await client.query('ROLLBACK')
      return 0
    }

    await client.query(
      `UPDATE trades SET
         status = 'closed',
         close_price = v.close_price,
         close_time = NOW(),
         demo_pnl = v.pnl,
         close_reason = v.reason,
         pending_close_price  = NULL,
         pending_close_reason = NULL,
         pending_close_at     = NULL
       FROM (
         SELECT unnest($1::uuid[])    AS id,
                unnest($2::numeric[]) AS close_price,
                unnest($3::numeric[]) AS pnl,
                unnest($4::text[])    AS reason
       ) v
       WHERE trades.id = v.id AND trades.status = 'open'`,
      [closeIds, closePrices, pnls, reasons]
    )

    const accountIds = []
    const accountPnls = []
    for (const [accountId, running] of perAccount) {
      accountIds.push(accountId)
      accountPnls.push(running.total.toDecimalPlaces(2).toNumber())
    }

    await client.query(
      `UPDATE accounts a SET
         current_balance = a.current_balance + v.pnl,
         peak_balance    = GREATEST(a.peak_balance, a.current_balance + v.pnl)
       FROM (
         SELECT unnest($1::uuid[])    AS id,
                unnest($2::numeric[]) AS pnl
       ) v
       WHERE a.id = v.id`,
      [accountIds, accountPnls]
    )

    await client.query('COMMIT')

    // Index sync — mirror what the database now says.
    for (const candidate of eligible) {
      if (!owned.has(candidate.trade.id)) continue
      tradeIndex.removeTrade(candidate.trade.id)
      if (candidate.demoPnl !== undefined) {
        tradeIndex.applyRealizedPnl(candidate.trade.accountId, candidate.demoPnl)
      }
    }
    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i]
      const accountPnl = accountPnls[i]
      if (accountId === undefined || accountPnl === undefined) continue
      const account = tradeIndex.getAccountEntry(accountId)
      if (account) tradeIndex.updateAccountBalance(accountId, account.currentBalance + accountPnl)
    }

    if (io) {
      for (const candidate of eligible) {
        if (!owned.has(candidate.trade.id)) continue
        const account = tradeIndex.getAccountEntry(candidate.trade.accountId)
        if (!account) continue
        if (candidate.demoPnl === undefined) continue
        io.to(String(account.userId)).emit('account_update', {
          message: `${candidate.reason} triggered on ${candidate.trade.instrument}`,
          pnl: candidate.demoPnl
        })
      }
    }

    return closeIds.length
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('[tradeEngine] bulk SL/TP closure failed:', { error: errorMessage(error) })
    return 0
  } finally {
    client.release()
  }
}

/**
 * Confirm and act on account-level outcomes (drawdown breach, daily loss, pass).
 *
 * Phase C matters most here: failing an account is irreversible for the trader's
 * challenge, so the float equity that flagged it is thrown away and recomputed
 * from the database with Decimal. If the precise number no longer breaches, we
 * do nothing and let the next tick re-check.
 */
async function settleAccountOutcomes(
  io: TypedServer | null,
  breachCandidates: readonly BreachCandidate[],
  passCandidates: readonly PassCandidate[]
): Promise<number> {
  let handled = 0
  if (breachCandidates.length === 0 && passCandidates.length === 0) return handled

  // ── Everything the whole batch needs, resolved once ──
  //
  // Three separate N+1s used to live in this function: a two-query confirmation
  // per candidate, a getTodayRealizedPnl call per daily candidate against an API
  // that already takes an array, and a price-map query per account inside each
  // autoClose. On a gap that breaches 500 accounts that was well over a thousand
  // sequential round-trips with the tick held open.
  const confirmed = await confirmAccountEquityBatch([
    ...breachCandidates.map((candidate) => candidate.account.id),
    ...passCandidates.map((candidate) => candidate.account.id)
  ])
  if (confirmed.size === 0) return handled

  // Only the daily-loss candidates need today's realised PnL, and only the ones
  // that survived confirmation.
  const dailyAccountIds = breachCandidates
    .filter((candidate) => candidate.kind !== 'trailing' && confirmed.has(candidate.account.id))
    .map((candidate) => candidate.account.id)
  const realizedMap = dailyAccountIds.length > 0
    ? await tradingDaysService.getTodayRealizedPnl(pool, dailyAccountIds)
    : new Map<string, number>()

  // One snapshot for every close below. Prices are a read-only snapshot, so
  // sharing it changes nothing about the arithmetic — see autoCloseAndFail.
  const priceMap = await getCurrentPricesForTenant()

  for (const candidate of breachCandidates) {
    const { account } = candidate
    const confirmation = confirmed.get(account.id)
    if (!confirmation) continue

    if (candidate.kind === 'trailing') {
      const floorDec = new Decimal(candidate.floor)
      if (confirmation.equity.gte(floorDec)) continue // float was optimistic — stand down

      const drawdownPctUsed = new Decimal(confirmation.startingBalance)
        .minus(confirmation.equity)
        .div(confirmation.startingBalance)
        .times(100)
      const reason = `Trailing drawdown breach — equity $${confirmation.equity.toFixed(2)} fell below the $${floorDec.toFixed(2)} floor (${drawdownPctUsed.toFixed(2)}% of a ${candidate.maxDrawdownPct}% limit)`
      logger.info(`Account ${account.id} DRAWDOWN BREACH: ${reason}`)
      await autoCloseAndFail(confirmation.acc, reason, io, priceMap)
      handled++
      continue
    }

    // Daily loss — uses today's realised PnL read from the database rather than
    // the cached running total.
    const todayRealized = realizedMap.get(account.id) || 0
    const todayTotal = new Decimal(todayRealized).plus(confirmation.floatingPnl)
    const todayLossPct = todayTotal.isNegative()
      ? todayTotal.abs().div(confirmation.startingBalance).times(100)
      : new Decimal(0)
    if (!todayLossPct.gte(candidate.dailyDrawdownPct)) continue

    const reason = `Daily loss limit breach — today's loss ${todayLossPct.toFixed(2)}% reached the ${candidate.dailyDrawdownPct}% daily limit`
    logger.info(`Account ${account.id} DAILY LOSS BREACH: ${reason}`)
    await autoCloseAndFail(confirmation.acc, reason, io, priceMap)
    handled++
  }

  for (const candidate of passCandidates) {
    const { account, profitTarget } = candidate
    const confirmation = confirmed.get(account.id)
    if (!confirmation) continue

    const equityProfit = confirmation.equity.minus(confirmation.startingBalance)
    if (!equityProfit.gte(profitTarget)) continue

    await autoCloseAndPass(confirmation.acc, io, priceMap)
    handled++
  }

  return handled
}

/**
 * Recompute MANY accounts' equity from the database with Decimal precision.
 *
 * This is the confirm half of "float detects, Decimal confirms" — it re-reads
 * the account rows and their open trades rather than trusting the in-memory
 * index, so a stale index entry cannot fail an account either.
 *
 * ── Why this is batched ──
 *
 * The per-account version was called in a loop from settleAccountOutcomes, so a
 * market gap that breached 500 accounts issued 1,000 sequential queries plus 500
 * price-map resolutions — all inside the tick, with _tickRunning held, so every
 * incoming price was coalesced away and the engine was frozen for the duration.
 * A mass breach is the worst possible moment for the engine to stop reacting.
 *
 * Two queries and one price map now serve the whole batch.
 *
 * @param {string[]} accountIds
 * @returns {Promise<Map<string, {acc:object, equity:Decimal, floatingPnl:Decimal, startingBalance:number}>>}
 *   Accounts that are missing or no longer active are simply absent from the map.
 */
async function confirmAccountEquityBatch(accountIds: readonly string[]): Promise<Map<string, Confirmation>> {
  const confirmed = new Map<string, Confirmation>()
  if (!accountIds || accountIds.length === 0) return confirmed

  const ids = Array.from(new Set(accountIds.map(String)))

  const accountResult = await pool.query<AccountIndexRow>(
    `SELECT id, user_id, current_balance, starting_balance, peak_balance,
            max_drawdown_pct, account_type, profit_target, account_size,
            eod_peak_equity, eod_trailing_floor, challenge_model_slug,
            daily_drawdown_pct, status
       FROM accounts WHERE id = ANY($1::uuid[]) AND status = 'active'`,
    [ids]
  )
  if (accountResult.rows.length === 0) return confirmed

  const tradesResult = await pool.query<TradeIndexRow>(
    `SELECT account_id, direction, open_price, lot_size, instrument, commission
       FROM trades WHERE account_id = ANY($1::uuid[]) AND status = 'open'`,
    [ids]
  )

  const tradesByAccount = new Map<string, TradeIndexRow[]>()
  for (const trade of tradesResult.rows) {
    const list = tradesByAccount.get(trade.account_id)
    if (list) list.push(trade)
    else tradesByAccount.set(trade.account_id, [trade])
  }

  const priceMap = await getLivePriceMap()

  for (const row of accountResult.rows) {
    let floatingPnl = new Decimal(0)
    for (const trade of tradesByAccount.get(row.id) || []) {
      const priceData = priceMap[trade.instrument]
      if (!priceData) continue
      const currentPrice = trade.direction === 'buy'
        ? parseFloat(String(priceData.bid))
        : parseFloat(String(priceData.ask))
      // calculatePnL throws FxRateUnavailableError when the instrument's
      // QUOTE/USD rate source is not in the price cache. Skipping that trade
      // matches what the `!priceData` guard above and checkFloatingDrawdown
      // already do, and it matters more here: unguarded, one instrument with a
      // dark rate source would throw out of the batch and abort the whole tick
      // — remaining breaches, pass checks and pending fills included.
      //
      // Skipping understates floating loss, so the confirmation fails CLOSED
      // (no breach) and the next tick retries with a complete picture. That is
      // the safe direction: it never fails an account on partial data.
      try {
        floatingPnl = floatingPnl.plus(calculatePnL(
          trade.direction,
          parseFloat(String(trade.open_price)),
          currentPrice,
          parseFloat(String(trade.lot_size)),
          trade.instrument,
          parseFloat(String(trade.commission || 0))
        ))
      } catch (error: unknown) {
        logger.warn('[tradeEngine] confirm skipped a trade with no USD rate:', {
          accountId: row.id, instrument: trade.instrument, error: errorMessage(error)
        })
      }
    }

    const startingBalance = parseFloat(String(row.starting_balance))
    const acc: EngineAccount = {
      id: row.id,
      user_id: row.user_id,
      current_balance: parseFloat(String(row.current_balance)),
      starting_balance: startingBalance,
      peak_balance: parseFloat(String(row.peak_balance)),
      max_drawdown_pct: parseFloat(String(row.max_drawdown_pct)),
      account_type: row.account_type,
      account_size: parseFloat(String(row.account_size)),
      profit_target: parseFloat(String(row.profit_target || 0)),
      eod_peak_equity: row.eod_peak_equity,
      eod_trailing_floor: row.eod_trailing_floor,
      challenge_model_slug: row.challenge_model_slug,
      daily_drawdown_pct: row.daily_drawdown_pct != null ? parseFloat(String(row.daily_drawdown_pct)) : null
    }

    confirmed.set(row.id, {
      acc,
      equity: new Decimal(acc.current_balance).plus(floatingPnl),
      floatingPnl,
      startingBalance
    })
  }

  return confirmed
}

/**
 * Single-account confirmation. Kept as the exported entry point; the engine's
 * own settlement path uses the batch form directly.
 *
 * @returns {Promise<{acc:object, equity:Decimal, floatingPnl:Decimal, startingBalance:number}|null>}
 */
async function confirmAccountEquity(accountId: string): Promise<Confirmation | null> {
  const confirmed = await confirmAccountEquityBatch([accountId])
  return confirmed.get(String(accountId)) || null
}

/**
 * Fill pending orders whose trigger price was reached on this tick.
 *
 * Only the price comparison moved to the fast path. Everything expensive —
 * account status, phase expiry, market hours, and the full validatePendingTrigger
 * suite — still runs here, per order, inside its transaction.
 */
async function fillTriggeredPendingOrders(io: TypedServer | null, candidates: readonly PendingEntry[]): Promise<void> {
  const rules = await getTradingRules()
  const priceMap = priceCache.getAllPrices()

  for (const candidate of candidates) {
    const account = tradeIndex.getAccountEntry(candidate.accountId)
    if (!account) continue

    if (account.status !== 'active') {
      await cancelPendingOrder(candidate.id, 'Account inactive')
      continue
    }
    if (account.phaseEndDate && account.phaseEndDate <= Date.now()) {
      await cancelPendingOrder(candidate.id, 'Challenge phase expired')
      continue
    }
    if (!getMarketStatus(candidate.instrument, { purpose: 'open' }).open) continue

    const price = priceMap[candidate.instrument]
    if (!price) continue

    const order = {
      id: candidate.id,
      account_id: candidate.accountId,
      instrument: candidate.instrument,
      direction: candidate.direction,
      lot_size: candidate.lots,
      order_type: candidate.orderType,
      pending_price: candidate.triggerPrice,
      oco_group_id: candidate.ocoGroupId,
      user_id: account.userId,
      account_size: account.accountSize,
      account_type: account.accountType,
      scaling_multiplier: account.scalingMultiplier
    }

    await fillPendingOrder(io, order, rules, priceMap, {
      bid: parseFloat(String(price.bid)),
      ask: parseFloat(String(price.ask))
    })
  }
}

// ─── Index maintenance ────────────────────────────────────────────────────────

/**
 * Add a freshly-opened trade to the index and seed its floating PnL from the
 * current price, so the account's total is correct before the trade's instrument
 * next moves.
 */
function addOpenTradeToIndex(tradeRow: TradeIndexRow, accountRow: AccountIndexRow | null = null): TradeEntry | null {
  const entry = tradeIndex.addTrade(tradeRow, accountRow)
  if (!entry) return null
  const price = priceCache.getPrice(entry.instrument)
  if (price) {
    // A missing rate here means the seed is skipped, not that the trade is
    // valued at rate 1 — the next tick on this instrument recomputes it.
    let usdRate = null
    try {
      usdRate = getUsdRateForInstrument(entry.instrument)
    } catch (error: unknown) {
      logger.warn('[tradeEngine] could not seed floating PnL — no USD rate:', {
        instrument: entry.instrument, error: errorMessage(error)
      })
    }
    if (usdRate != null) {
      tradeIndex.applyTradePnl(entry, fastPnL(
        entry.sign,
        entry.openPrice,
        closePriceFor(entry.sign, price),
        entry.lots,
        entry.contractSize,
        entry.commission,
        usdRate
      ))
    }
  }
  return entry
}

/**
 * Index-sync entry points for the HTTP layer.
 *
 * These are what keep the index correct between the 30s reconciliations. They
 * never throw: an index that has fallen behind is a performance problem the
 * reconcile will fix, whereas a rejected trade-open response is a user-visible
 * failure. Errors are logged and swallowed.
 */
async function syncOpenedTrade(tradeRow: TradeIndexRow): Promise<TradeEntry | null> {
  try {
    await tradeIndex.ensureAccountLoaded(tradeRow.account_id)
    return addOpenTradeToIndex(tradeRow)
  } catch (error: unknown) {
    logger.error('[tradeEngine] syncOpenedTrade failed:', { error: errorMessage(error), tradeId: tradeRow.id })
    return null
  }
}

async function syncPendingOrder(orderRow: PendingIndexRow): Promise<PendingEntry | null> {
  try {
    await tradeIndex.ensureAccountLoaded(orderRow.account_id)
    return tradeIndex.addPending(orderRow)
  } catch (error: unknown) {
    logger.error('[tradeEngine] syncPendingOrder failed:', { error: errorMessage(error), orderId: orderRow.id })
    return null
  }
}

/**
 * A trade left the open set (manual close, partial close, cancel, batch action).
 * @param {string} tradeId
 * @param {string|null} accountId
 * @param {number|null} realizedPnl Folded into the cached daily total when given
 */
function syncClosedTrade(tradeId: string, accountId: string | null = null, realizedPnl: number | null = null): void {
  const entry = tradeIndex.getTrade(tradeId)
  const resolvedAccountId = accountId || entry?.accountId || null
  tradeIndex.removeTrade(tradeId)
  tradeIndex.removePending(tradeId)
  if (resolvedAccountId && realizedPnl != null) {
    tradeIndex.applyRealizedPnl(resolvedAccountId, realizedPnl)
  }
}

/**
 * Recompute every trade's floating PnL contribution against the current prices.
 *
 * Runs after each reconciliation. Besides seeding trades the index has just
 * learned about, this re-derives the per-account running totals from scratch, so
 * any accumulated drift in the incremental deltas is corrected every 30s rather
 * than compounding.
 */
function reseedFloatingPnl(): number {
  tradeIndex.resetFloatingPnl()
  const prices = priceCache.getAllPrices()
  let seeded = 0

  for (const instrument in prices) {
    const price = prices[instrument]
    if (!price) continue
    // Resolved per instrument, same as the tick scan — see runTick.
    let usdRate
    try {
      usdRate = getUsdRateForInstrument(instrument)
    } catch (error: unknown) {
      logger.warn('[tradeEngine] skipping instrument during reseed — no USD rate:', {
        instrument, error: errorMessage(error)
      })
      continue
    }
    const trades = tradeIndex.getTradesByInstrument(instrument)
    for (const trade of trades.values()) {
      tradeIndex.applyTradePnl(trade, fastPnL(
        trade.sign,
        trade.openPrice,
        closePriceFor(trade.sign, price),
        trade.lots,
        trade.contractSize,
        trade.commission,
        usdRate
      ))
      seeded++
    }
  }
  return seeded
}

/** Boot-time index build. Must complete before the event path is armed. */
async function initializeEngine(): Promise<Awaited<ReturnType<typeof tradeIndex.fullReconcileFromDB>>> {
  const summary = await tradeIndex.fullReconcileFromDB()
  reseedFloatingPnl()
  return summary
}

async function reconcileIndex(): Promise<Awaited<ReturnType<typeof tradeIndex.fullReconcileFromDB>>> {
  const summary = await tradeIndex.fullReconcileFromDB()
  reseedFloatingPnl()
  return summary
}

/**
 * Highest of two peak/floor values, where null means "this field did not change"
 * rather than zero.
 *
 * Written out rather than done with `??  0` and `|| null`: a locked floor is an
 * account balance and may legitimately be 0 or negative, and coercing through
 * zero would both invent a raise that never happened and turn a real 0 back into
 * null on the way out.
 */
function higherPeakValue(a: number | null, b: number | null): number | null {
  if (a == null) return b == null ? null : b
  if (b == null) return a
  return a > b ? a : b
}

/**
 * Persist peak equity / locked floors accumulated since the last flush.
 *
 * The interval engine wrote these one UPDATE per account per tick. Driven off
 * price ticks that would be the single heaviest thing the engine does, so the
 * writes are batched behind a timer instead.
 *
 * ── Why a failed flush is re-queued rather than logged ──
 *
 * These are the trailing-drawdown floors. Dropping them leaves the raise in
 * memory only: the index keeps serving the new floor, the database keeps the old
 * one, and after the next restart the index reloads the STALE, LOWER floor. An
 * account that should have breached then does not, and nothing anywhere reports
 * it — the only trace is one log line from a transient error minutes earlier.
 *
 * So the batch goes back into _dirtyPeaks on failure. Ticks that ran during the
 * flush may already have written a newer value for the same account, hence the
 * max rather than a plain overwrite; the underlying statement only ever raises
 * these columns, so re-applying a stale entry is a no-op rather than a
 * regression.
 */
async function flushDirtyPeaks(): Promise<number> {
  if (_dirtyPeaks.size === 0) return 0
  const updates: Array<{ accountId: string; peak: number | null; lockedFloor: number | null }> = []
  for (const [accountId, value] of _dirtyPeaks) {
    updates.push({ accountId, peak: value.peak, lockedFloor: value.lockedFloor })
  }
  _dirtyPeaks = new Map<string, DirtyPeak>()

  try {
    return await drawdownService.flushPeakEquityUpdates(pool, updates)
  } catch (error: unknown) {
    for (const update of updates) {
      const pending = _dirtyPeaks.get(update.accountId)
      _dirtyPeaks.set(update.accountId, {
        peak: higherPeakValue(pending?.peak ?? null, update.peak),
        lockedFloor: higherPeakValue(pending?.lockedFloor ?? null, update.lockedFloor)
      })
    }
    logger.error('[tradeEngine] peak equity flush failed — re-queued for the next flush:', {
      error: errorMessage(error),
      requeued: updates.length
    })
    return 0
  }
}

function getEngineStats(): {
  trades: number
  pending: number
  accounts: number
  ready: boolean
  lastReconcileAt: number
  dirtyPeaks: number
  priceCacheAgeMs: number | null
} {
  return {
    trades: tradeIndex.getTradeCount(),
    pending: tradeIndex.getPendingCount(),
    accounts: tradeIndex.getAccountCount(),
    ready: tradeIndex.isReady(),
    lastReconcileAt: tradeIndex.getLastReconcileAt(),
    dirtyPeaks: _dirtyPeaks.size,
    priceCacheAgeMs: priceCache.getPriceCacheAgeMs()
  }
}

const tradeEngine = {
  // Interval engine (also the ENGINE_MODE=event safety net)
  checkSLTP,
  checkPendingOrders,
  checkFloatingDrawdown,
  cancelPendingOrder,
  validatePendingTrigger,
  autoCloseAndFail,
  autoCloseAndPass,
  // Event-driven engine
  onPriceTick,
  initializeEngine,
  reconcileIndex,
  reseedFloatingPnl,
  flushDirtyPeaks,
  addOpenTradeToIndex,
  syncOpenedTrade,
  syncPendingOrder,
  syncClosedTrade,
  confirmAccountEquity,
  confirmAccountEquityBatch,
  settlementFor,
  getEngineStats,
  DIRECTION_BUY
}

export = tradeEngine
