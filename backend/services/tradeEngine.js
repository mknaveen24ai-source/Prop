'use strict'
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

const pool = require('../db')
const Decimal = require('decimal.js')
const logger = require('../utils/logger')
const priceCache = require('../utils/priceCache')
const tradeIndex = require('../utils/tradeIndex')
const drawdownService = require('./drawdownService')
const tradingDaysService = require('./tradingDaysService')
const { calculatePnL } = require('../utils/pnlCalculator')
const { getUsdRateForInstrument } = require('../utils/fxRates')
const { fetchStepModelBySlug } = require('../utils/stepModels')
const { fetchProgressionSettings, promotePassedAccount } = require('./progressionService')
const { getCurrentPricesForTenant } = require('../priceFeed')
const { recordEngineTick, registerEngineStatsSource } = require('../utils/prometheusMetrics')
const {
  COMMODITY_INSTRUMENTS,
  FOREX_INSTRUMENTS
} = require('../constants')
const {
  ensureTradeExperienceInfrastructure,
  getTradingRules,
  getLivePriceMap,
  getMarketStatus,
  calculateMargin,
  calculateUsedMargin,
  safeRecordViolation,
  safeRecordEnforcement
} = require('./tradeShared')
const {
  fastPnL,
  closePriceFor,
  isSLTriggered,
  isTPTriggered,
  isPendingTriggered,
  DIRECTION_BUY
} = require('../utils/fastPnL')

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
async function checkSLTP(io) {
  if (_checkSLTPRunning) return
  _checkSLTPRunning = true
  try {
    await ensureTradeExperienceInfrastructure()
    const openTrades = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              t.commission,
              a.user_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
       AND (
         t.stop_loss IS NOT NULL
         OR t.take_profit IS NOT NULL
       )`
    )

    const priceMap = await getLivePriceMap()
    const rules = await getTradingRules()

    for (const trade of openTrades.rows) {
      const price = priceMap[trade.instrument]
      if (!price) continue

      // BUY trades close at BID. SELL trades close at ASK.
      const currentPrice = trade.direction === 'buy'
        ? parseFloat(price.bid)
        : parseFloat(price.ask)

      let triggered   = false
      let closeReason = ''

      if (trade.stop_loss) {
        const sl = parseFloat(trade.stop_loss)
        if (trade.direction === 'buy'  && currentPrice <= sl) { triggered = true; closeReason = 'Stop Loss' }
        if (trade.direction === 'sell' && currentPrice >= sl) { triggered = true; closeReason = 'Stop Loss' }
      }

      if (!triggered && trade.take_profit) {
        const tp = parseFloat(trade.take_profit)
        if (trade.direction === 'buy'  && currentPrice >= tp) { triggered = true; closeReason = 'Take Profit' }
        if (trade.direction === 'sell' && currentPrice <= tp) { triggered = true; closeReason = 'Take Profit' }
      }

      if (!triggered) continue

      // FIX (Bug 5): Use admin-configurable min hold time instead of hardcoded 60s
      //
      // M-06 (disclosure, not a code change): this suppresses SL/TP *entirely*
      // inside the hold window rather than deferring the fill to the level. A
      // stop hit at second 10 does not fill at second 60 at the stop price — it
      // fills whenever the price next crosses, at whatever the price is then.
      // If the market has moved back through, it does not fill at all.
      //
      // That is defensible as an anti-scalping rule, but it means "stop loss"
      // does not mean stop loss for the first minHoldSeconds. It MUST be stated
      // in the published trading rules; a trader discovering it from a fill is
      // a dispute the firm loses. See docs/TRADING_RULES_DISCLOSURES.md.
      if (trade.open_time) {
        const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
        if (secondsOpen < rules.minHoldSeconds) continue
      }

      // FIX: wrap close + balance update in a transaction with row-level lock
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Lock the trade row — skip if already being processed elsewhere
        const lockResult = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (lockResult.rows.length === 0) {
          await client.query('ROLLBACK')
          continue
        }

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
          [currentPrice, demo_pnl, closeReason, trade.id]
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
      } catch (err) {
        // FIX (M-07): .catch() because a dead connection makes ROLLBACK itself
        // throw, and that escapes the handler and aborts the rest of the engine
        // pass. fillPendingOrder already guarded this; these did not.
        await client.query('ROLLBACK').catch(() => {})
        logger.error(`checkSLTP: transaction failed for trade ${trade.id}:`, { error: err.message })
      } finally {
        client.release()
      }
    }
  } catch (error) {
    logger.error('SL/TP check error:', { error: error.message })
  } finally {
    _checkSLTPRunning = false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending orders background checker
// ─────────────────────────────────────────────────────────────────────────────
async function cancelPendingOrder(orderId, reason) {
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

async function validatePendingTrigger(client, order, rules, livePrices) {
  const lotsNum = parseFloat(order.lot_size)
  if (isNaN(lotsNum) || lotsNum <= 0) {
    return 'Invalid lot size on pending order'
  }

  // Fetch the fresh account balance inside the transaction (account_type/
  // scaling_multiplier come from the batch join in checkPendingOrders since
  // they don't change mid-tick the way balance can).
  const accountResult = await client.query(
    `SELECT current_balance FROM accounts WHERE id = $1`,
    [order.account_id]
  )
  if (accountResult.rows.length === 0) {
    return 'Account not found during pending order trigger'
  }
  const current_balance = parseFloat(accountResult.rows[0].current_balance)

  // Funded accounts' scaling-plan multiplier raises risk capacity (lot caps)
  // proportionally, matching the same check in POST /open.
  const scalingMultiplier = order.account_type === 'funded' && order.scaling_multiplier != null
    ? parseFloat(order.scaling_multiplier)
    : 1
  const accountSizeK = (parseFloat(order.account_size) / 1000) * (Number.isFinite(scalingMultiplier) ? scalingMultiplier : 1)

  if (COMMODITY_INSTRUMENTS.includes(order.instrument)) {
    const maxCommodityLots = parseFloat((accountSizeK * rules.commodityLotsPer1k).toFixed(4))
    const existingResult = await client.query(
      `SELECT COALESCE(SUM(lot_size), 0) as total_lots
       FROM trades
       WHERE account_id = $1
         AND instrument = ANY($2::text[])
         AND status IN ('open', 'pending')
         AND id <> $3`,
      [order.account_id, COMMODITY_INSTRUMENTS, order.id]
    )
    const currentLots = parseFloat(existingResult.rows[0].total_lots)
    if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxCommodityLots) {
      return `Pending order exceeds combined commodity exposure limit (${maxCommodityLots} lots)`
    }
  } else if (FOREX_INSTRUMENTS.includes(order.instrument)) {
    const maxForexLots = parseFloat((accountSizeK * rules.forexLotsPer1k).toFixed(4))
    const existingResult = await client.query(
      `SELECT COALESCE(SUM(lot_size), 0) as total_lots
       FROM trades
       WHERE account_id = $1
         AND instrument = ANY($2::text[])
         AND status IN ('open', 'pending')
         AND id <> $3`,
      [order.account_id, FOREX_INSTRUMENTS, order.id]
    )
    const currentLots = parseFloat(existingResult.rows[0].total_lots)
    if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxForexLots) {
      return `Pending order exceeds combined forex exposure limit (${maxForexLots} lots)`
    }
  }

  const maxOpenTrades = rules.maxOpenPositions
  const openTradeCountResult = await client.query(
    `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status IN ('open', 'pending') AND id <> $2`,
    [order.account_id, order.id]
  )
  const currentOpenCount = parseInt(openTradeCountResult.rows[0].count)
  if ((currentOpenCount + 1) > maxOpenTrades) {
    return `Pending order exceeds max open trades (${maxOpenTrades})`
  }

  const margin = calculateMargin(order.instrument, lotsNum)
  let floatingPnl = new Decimal(0)
  const openTradesResult = await client.query(
    `SELECT t.direction, t.open_price, t.lot_size, t.instrument, t.commission
     FROM trades t
     WHERE t.account_id = $1 AND t.status = 'open' AND t.id <> $2`,
    [order.account_id, order.id]
  )
  for (const t of openTradesResult.rows) {
    const livePrice = livePrices[t.instrument]
    if (!livePrice) continue
    const currentPrice = t.direction === 'buy' ? parseFloat(livePrice.bid) : parseFloat(livePrice.ask)
    floatingPnl = floatingPnl.plus(calculatePnL(t.direction, parseFloat(t.open_price), currentPrice, parseFloat(t.lot_size), t.instrument, parseFloat(t.commission || 0)))
  }
  const equity = new Decimal(current_balance).plus(floatingPnl)
  const requiredMargin = new Decimal(calculateUsedMargin(openTradesResult.rows)).plus(margin)
  if (requiredMargin.gt(equity)) {
    return `Insufficient equity at trigger. Required margin: $${requiredMargin.toFixed(2)}`
  }

  return null
}

async function checkPendingOrders(io) {
  if (_checkPendingOrdersRunning) return
  _checkPendingOrdersRunning = true
  try {
    await ensureTradeExperienceInfrastructure()
    const pendingOrders = await pool.query(
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

      const bid           = parseFloat(price.bid)
      const ask           = parseFloat(price.ask)
      const pending_price = parseFloat(order.pending_price)

      let triggered = false

      if (order.order_type === 'buy_limit'  && ask <= pending_price) triggered = true
      if (order.order_type === 'sell_limit' && bid >= pending_price) triggered = true
      if (order.order_type === 'buy_stop'   && ask >= pending_price) triggered = true
      if (order.order_type === 'sell_stop'  && bid <= pending_price) triggered = true

      if (triggered) {
        await fillPendingOrder(io, order, rules, priceMap, { bid, ask })
      }
    }
  } catch (error) {
    logger.error('Pending orders check error:', { error: error.message })
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
async function fillPendingOrder(io, order, rules, priceMap, prices) {
  const { bid, ask } = prices
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let cancelledSiblingRows = []

    // Lock the order row — skip if already being processed elsewhere
    const lockResult = await client.query(
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

    const activatedResult = await client.query(
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
      const siblingCancelResult = await client.query(
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
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`checkPendingOrders: transaction error for order ${order.id}:`, { error: txErr.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// autoCloseAndFail — balance update race condition resolved.
// Collects all trade PnLs first, then applies a single summed balance UPDATE
// after all trades are closed inside the same transaction.
// ─────────────────────────────────────────────────────────────────────────────
async function autoCloseAndFail(acc, reason, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const openTrades   = await client.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status, commission
       FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [acc.id]
    )
    const priceMap = await getCurrentPricesForTenant()

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

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
      {
        const priceData = priceMap[trade.instrument]
        if (!priceData) {
          await client.query(
            `UPDATE trades SET
               status = 'closed',
               close_price = open_price,
               close_time = NOW(),
               demo_pnl = 0,
               close_reason = 'Account Failed'
             WHERE id = $1`,
            [trade.id]
          )
          continue
        }

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        totalPnlDec = totalPnlDec.plus(demo_pnl)

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Account Failed'
           WHERE id = $3`,
           [close_price, demo_pnl, trade.id]
        )
      }
    }

    // FIX (BUG-C001): Convert Decimal accumulator to number — was previously
    // referencing undefined `totalPnl` instead of `totalPnlDec`.
    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()

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

    const cancelledPendingResult = await client.query(
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

  } catch (err) {
    // FIX (M-07): see note above — an unguarded ROLLBACK on a dead connection
    // takes down the remainder of the engine pass.
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`autoCloseAndFail error for account ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// autoCloseAndPass — same single-update pattern as autoCloseAndFail
// ─────────────────────────────────────────────────────────────────────────────
async function autoCloseAndPass(acc, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
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
    const openTrades   = await client.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status, commission
       FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [acc.id]
    )
    const priceMap = await getCurrentPricesForTenant()

    const closeReason = acc.account_type === 'phase1' ? 'Phase 1 Passed' : 'Phase 2 Passed'
    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      {
        const priceData = priceMap[trade.instrument]
        // FIX (M-04): this used to throw, aborting the entire promotion, while
        // autoCloseAndFail closed the same trade at open_price with zero PnL
        // and carried on. A feed outage therefore failed accounts but could
        // never pass them — a house-favouring asymmetry in an edge case, and
        // one that stranded a trader who had legitimately hit their target if
        // the instrument's feed stayed down.
        //
        // Both paths now settle a priceless trade the same way: flat, at the
        // open price, so the outcome does not depend on which rule fired.
        if (!priceData) {
          logger.warn(`autoCloseAndPass: no live price for ${trade.instrument} — closing trade ${trade.id} flat`, {
            accountId: acc.id, tradeId: trade.id
          })
          await client.query(
            `UPDATE trades SET
               status = 'closed',
               close_price = open_price,
               close_time = NOW(),
               demo_pnl = 0,
               close_reason = $1
             WHERE id = $2`,
            [closeReason, trade.id]
          )
          continue
        }

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        totalPnlDec = totalPnlDec.plus(demo_pnl)

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
           [close_price, demo_pnl, closeReason, trade.id]
        )
      }
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()

    // Single balance update AND status update after all trades are closed
    await client.query(
      `UPDATE accounts SET
         current_balance = current_balance + $1,
         peak_balance    = GREATEST(peak_balance, current_balance + $1),
         status          = 'passed'
       WHERE id = $2`,
      [totalPnl, acc.id]
    )

    const cancelledPendingResult = await client.query(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = $1
       WHERE account_id = $2 AND status = 'pending'
       RETURNING id, account_id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit`,
      [closeReason, acc.id]
    )

    const settings    = await fetchProgressionSettings(client)
    const promoted    = await promotePassedAccount(client, acc, settings)
    const newAccountId = promoted ? promoted.new_account_id : null

    await client.query('COMMIT')

    for (const cancelled of cancelledPendingResult.rows) {
      tradeIndex.removePending(cancelled.id)
    }
    tradeIndex.removeAccount(acc.id)

    const passMsg = acc.account_type === 'phase1'
      ? `🏆 Phase 1 PASSED! Floating profit target hit. All trades closed. Phase 2 activating shortly.`
      : `🎉 Phase 2 PASSED! Floating profit target hit. All trades closed. Funded account activating shortly.`

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: passMsg,
        pnl: totalPnl,
        account_id: acc.id,
        new_account_id: newAccountId,
        event: promoted?.event || (acc.account_type === 'phase1' ? 'phase1_passed' : 'phase2_passed')
      })
    }

    logger.info(`Account ${acc.id} PASSED via floating equity (${acc.account_type})`)

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`autoCloseAndPass error for account ${acc.id}:`, { error: err.message, auto_pass_aborted: true })
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
async function checkFloatingDrawdown(io) {
  if (_checkFloatingDrawdownRunning) return
  _checkFloatingDrawdownRunning = true
  try {
    // FIX: single query for all open trades across all active accounts
    const tradesResult = await pool.query(
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
    const fundedModelSettingsCache = new Map()

    // Group trades by account_id in JS — no extra queries
    const accountTrades = {}
    const accountMeta   = {}

    for (const row of tradesResult.rows) {
      const aid = row.account_id
      if (!accountTrades[aid]) {
        accountTrades[aid] = []
        accountMeta[aid] = {
          id:                    aid,
          user_id:               row.user_id,
          current_balance:       parseFloat(row.current_balance),
          starting_balance:      parseFloat(row.acc_starting),
          peak_balance:          parseFloat(row.peak_balance),
          max_drawdown_pct:      parseFloat(row.max_drawdown_pct),
          account_type:          row.account_type,
          account_size:          parseFloat(row.account_size),
          profit_target:         parseFloat(row.profit_target || 0),
          eod_peak_equity:       row.eod_peak_equity,
          eod_trailing_floor:    row.eod_trailing_floor,
          challenge_model_slug:  row.challenge_model_slug,
          daily_drawdown_pct:    row.daily_drawdown_pct != null ? parseFloat(row.daily_drawdown_pct) : null,
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
    const usdRates = new Map()
    for (const instrument of new Set(tradesResult.rows.map((row) => row.instrument))) {
      try {
        usdRates.set(instrument, getUsdRateForInstrument(instrument))
      } catch (error) {
        logger.warn('[checkFloatingDrawdown] no USD rate for instrument:', {
          instrument, error: error.message
        })
      }
    }

    for (const [aid, trades] of Object.entries(accountTrades)) {
      const acc = accountMeta[aid]

      let floatingPnl = new Decimal(0)
      for (const trade of trades) {
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

        const usdRate = usdRates.get(trade.instrument)
        if (usdRate === undefined) continue

        const currentPrice = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        floatingPnl = floatingPnl.plus(calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0),
          usdRate
        ))
      }

      const equity = new Decimal(acc.current_balance).plus(floatingPnl)
      let max_drawdown_pct = acc.max_drawdown_pct
      let daily_drawdown_pct = acc.daily_drawdown_pct
      let drawdownLocksAtPct = null

      if (acc.account_type === 'funded' && acc.challenge_model_slug) {
        let modelSettings = fundedModelSettingsCache.get(acc.challenge_model_slug)
        if (!modelSettings) {
          const model = await fetchStepModelBySlug(acc.challenge_model_slug)
          modelSettings = model
            ? {
                funded_max_drawdown_pct: parseFloat(model.funded_max_drawdown_pct),
                funded_daily_drawdown_pct: parseFloat(model.funded_daily_drawdown_pct),
                funded_drawdown_locks_at_pct: model.funded_drawdown_locks_at_pct != null ? parseFloat(model.funded_drawdown_locks_at_pct) : null
              }
            : null
          fundedModelSettingsCache.set(acc.challenge_model_slug, modelSettings || {})
        }
        if (modelSettings && Number.isFinite(modelSettings.funded_max_drawdown_pct)) {
          max_drawdown_pct = modelSettings.funded_max_drawdown_pct
          daily_drawdown_pct = modelSettings.funded_daily_drawdown_pct
          drawdownLocksAtPct = modelSettings.funded_drawdown_locks_at_pct
        }
      }

      if (!(max_drawdown_pct > 0)) continue

      const floor = await drawdownService.getEffectiveDrawdownFloor(pool, acc, {
        equity: equity.toNumber(),
        maxDrawdownPct: max_drawdown_pct,
        drawdownLocksAtPct
      })

      if (equity.lt(floor)) {
        const drawdownPctUsed = new Decimal(acc.starting_balance).minus(equity).div(acc.starting_balance).times(100)
        const reason = `Trailing drawdown breach — equity $${equity.toFixed(2)} fell below the $${floor.toFixed(2)} floor (${drawdownPctUsed.toFixed(2)}% of a ${max_drawdown_pct}% limit)`
        logger.info(`Account ${aid} DRAWDOWN BREACH: ${reason}`)
        await autoCloseAndFail(acc, reason, io)
        continue
      }

      if (Number.isFinite(daily_drawdown_pct) && daily_drawdown_pct > 0 && acc.starting_balance > 0) {
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

  } catch (error) {
    logger.error('Floating drawdown check error:', { error: error.message })
  } finally {
    _checkFloatingDrawdownRunning = false
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// EVENT-DRIVEN PATH
// ═════════════════════════════════════════════════════════════════════════════

let _tickRunning = false
let _tickCoalesced = null   // Set of instruments that arrived while a tick ran
let _dirtyPeaks = new Map() // accountId → { peak, lockedFloor }

// Scratch structures, reused across ticks. At 100K trades, allocating fresh maps
// per tick turns into GC pressure that shows up as latency jitter the
// microbenchmarks never see.
const _touchedAccounts = new Set()
const _slTpCandidates = []
const _pendingCandidates = []

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
async function onPriceTick(io, changedInstruments) {
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
  } catch (error) {
    logger.error('[tradeEngine] tick failed:', { error: error.message })
    return null
  } finally {
    _tickRunning = false
    _tickCoalesced = null
  }
}

async function runTick(io, changedInstruments) {
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
    } catch (error) {
      logger.warn('[tradeEngine] skipping instrument — no USD rate:', {
        instrument, error: error.message
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

      if (trade.stopLoss != null && isSLTriggered(trade.sign, trade.stopLoss, closePrice)) {
        _slTpCandidates.push({ trade, closePrice, reason: 'Stop Loss' })
      } else if (trade.takeProfit != null && isTPTriggered(trade.sign, trade.takeProfit, closePrice)) {
        _slTpCandidates.push({ trade, closePrice, reason: 'Take Profit' })
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
  const breachCandidates = []
  const passCandidates = []
  const equitySnapshots = []

  for (const accountId of _touchedAccounts) {
    const account = tradeIndex.getAccountEntry(accountId)
    if (!account || account.status !== 'active') continue

    const equity = account.currentBalance + account.floatingPnl
    const maxDrawdownPct = account.maxDrawdownPct

    if (!(maxDrawdownPct > 0)) continue

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

    if (equity < resolved.floor) {
      breachCandidates.push({ account, equity, floor: resolved.floor, maxDrawdownPct, kind: 'trailing' })
      continue
    }

    if (Number.isFinite(dailyPct) && dailyPct > 0 && account.startingBalance > 0 && dailyLossPct >= dailyPct) {
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
async function closeTriggeredTrades(io, candidates) {
  const rules = await getTradingRules()
  const now = Date.now()

  // Min hold time — mirrors checkSLTP.
  const eligible = candidates.filter(({ trade }) =>
    !trade.openTimeMs || ((now - trade.openTimeMs) / 1000) >= rules.minHoldSeconds
  )
  if (eligible.length === 0) return 0

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const ids = eligible.map((c) => c.trade.id)
    const lockResult = await client.query(
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
    const closeIds = []
    const closePrices = []
    const pnls = []
    const reasons = []
    const perAccount = new Map()

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
         close_reason = v.reason
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
      tradeIndex.applyRealizedPnl(candidate.trade.accountId, candidate.demoPnl)
    }
    for (let i = 0; i < accountIds.length; i++) {
      const account = tradeIndex.getAccountEntry(accountIds[i])
      if (account) tradeIndex.updateAccountBalance(accountIds[i], account.currentBalance + accountPnls[i])
    }

    if (io) {
      for (const candidate of eligible) {
        if (!owned.has(candidate.trade.id)) continue
        const account = tradeIndex.getAccountEntry(candidate.trade.accountId)
        if (!account) continue
        io.to(String(account.userId)).emit('account_update', {
          message: `${candidate.reason} triggered on ${candidate.trade.instrument}`,
          pnl: candidate.demoPnl
        })
      }
    }

    return closeIds.length
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('[tradeEngine] bulk SL/TP closure failed:', { error: error.message })
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
async function settleAccountOutcomes(io, breachCandidates, passCandidates) {
  let handled = 0

  for (const candidate of breachCandidates) {
    const { account } = candidate
    const confirmed = await confirmAccountEquity(account.id)
    if (!confirmed) continue

    if (candidate.kind === 'trailing') {
      const floorDec = new Decimal(candidate.floor)
      if (confirmed.equity.gte(floorDec)) continue // float was optimistic — stand down

      const drawdownPctUsed = new Decimal(confirmed.startingBalance)
        .minus(confirmed.equity)
        .div(confirmed.startingBalance)
        .times(100)
      const reason = `Trailing drawdown breach — equity $${confirmed.equity.toFixed(2)} fell below the $${floorDec.toFixed(2)} floor (${drawdownPctUsed.toFixed(2)}% of a ${candidate.maxDrawdownPct}% limit)`
      logger.info(`Account ${account.id} DRAWDOWN BREACH: ${reason}`)
      await autoCloseAndFail(confirmed.acc, reason, io)
      handled++
      continue
    }

    // Daily loss — recompute today's realised PnL from the database rather than
    // trusting the cached running total.
    const realizedMap = await tradingDaysService.getTodayRealizedPnl(pool, [account.id])
    const todayRealized = realizedMap.get(account.id) || 0
    const todayTotal = new Decimal(todayRealized).plus(confirmed.floatingPnl)
    const todayLossPct = todayTotal.isNegative()
      ? todayTotal.abs().div(confirmed.startingBalance).times(100)
      : new Decimal(0)
    if (!todayLossPct.gte(candidate.dailyDrawdownPct)) continue

    const reason = `Daily loss limit breach — today's loss ${todayLossPct.toFixed(2)}% reached the ${candidate.dailyDrawdownPct}% daily limit`
    logger.info(`Account ${account.id} DAILY LOSS BREACH: ${reason}`)
    await autoCloseAndFail(confirmed.acc, reason, io)
    handled++
  }

  for (const candidate of passCandidates) {
    const { account, profitTarget } = candidate
    const confirmed = await confirmAccountEquity(account.id)
    if (!confirmed) continue

    const equityProfit = confirmed.equity.minus(confirmed.startingBalance)
    if (!equityProfit.gte(profitTarget)) continue

    await autoCloseAndPass(confirmed.acc, io)
    handled++
  }

  return handled
}

/**
 * Recompute an account's equity from the database with Decimal precision.
 *
 * This is the confirm half of "float detects, Decimal confirms" — it re-reads
 * the account row and its open trades rather than trusting the in-memory index,
 * so a stale index entry cannot fail an account either.
 *
 * @returns {Promise<{acc:object, equity:Decimal, floatingPnl:Decimal, startingBalance:number}|null>}
 */
async function confirmAccountEquity(accountId) {
  const accountResult = await pool.query(
    `SELECT id, user_id, current_balance, starting_balance, peak_balance,
            max_drawdown_pct, account_type, profit_target, account_size,
            eod_peak_equity, eod_trailing_floor, challenge_model_slug,
            daily_drawdown_pct, status
       FROM accounts WHERE id = $1 AND status = 'active'`,
    [accountId]
  )
  if (accountResult.rows.length === 0) return null

  const row = accountResult.rows[0]
  const tradesResult = await pool.query(
    `SELECT direction, open_price, lot_size, instrument, commission
       FROM trades WHERE account_id = $1 AND status = 'open'`,
    [accountId]
  )

  const priceMap = await getLivePriceMap()
  let floatingPnl = new Decimal(0)
  for (const trade of tradesResult.rows) {
    const priceData = priceMap[trade.instrument]
    if (!priceData) continue
    const currentPrice = trade.direction === 'buy'
      ? parseFloat(priceData.bid)
      : parseFloat(priceData.ask)
    floatingPnl = floatingPnl.plus(calculatePnL(
      trade.direction,
      parseFloat(trade.open_price),
      currentPrice,
      parseFloat(trade.lot_size),
      trade.instrument,
      parseFloat(trade.commission || 0)
    ))
  }

  const startingBalance = parseFloat(row.starting_balance)
  const acc = {
    id: row.id,
    user_id: row.user_id,
    current_balance: parseFloat(row.current_balance),
    starting_balance: startingBalance,
    peak_balance: parseFloat(row.peak_balance),
    max_drawdown_pct: parseFloat(row.max_drawdown_pct),
    account_type: row.account_type,
    account_size: parseFloat(row.account_size),
    profit_target: parseFloat(row.profit_target || 0),
    eod_peak_equity: row.eod_peak_equity,
    eod_trailing_floor: row.eod_trailing_floor,
    challenge_model_slug: row.challenge_model_slug,
    daily_drawdown_pct: row.daily_drawdown_pct != null ? parseFloat(row.daily_drawdown_pct) : null
  }

  return {
    acc,
    equity: new Decimal(acc.current_balance).plus(floatingPnl),
    floatingPnl,
    startingBalance
  }
}

/**
 * Fill pending orders whose trigger price was reached on this tick.
 *
 * Only the price comparison moved to the fast path. Everything expensive —
 * account status, phase expiry, market hours, and the full validatePendingTrigger
 * suite — still runs here, per order, inside its transaction.
 */
async function fillTriggeredPendingOrders(io, candidates) {
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
      bid: parseFloat(price.bid),
      ask: parseFloat(price.ask)
    })
  }
}

// ─── Index maintenance ────────────────────────────────────────────────────────

/**
 * Add a freshly-opened trade to the index and seed its floating PnL from the
 * current price, so the account's total is correct before the trade's instrument
 * next moves.
 */
function addOpenTradeToIndex(tradeRow, accountRow = null) {
  const entry = tradeIndex.addTrade(tradeRow, accountRow)
  if (!entry) return null
  const price = priceCache.getPrice(entry.instrument)
  if (price) {
    // A missing rate here means the seed is skipped, not that the trade is
    // valued at rate 1 — the next tick on this instrument recomputes it.
    let usdRate = null
    try {
      usdRate = getUsdRateForInstrument(entry.instrument)
    } catch (error) {
      logger.warn('[tradeEngine] could not seed floating PnL — no USD rate:', {
        instrument: entry.instrument, error: error.message
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
async function syncOpenedTrade(tradeRow) {
  try {
    await tradeIndex.ensureAccountLoaded(tradeRow.account_id)
    return addOpenTradeToIndex(tradeRow)
  } catch (error) {
    logger.error('[tradeEngine] syncOpenedTrade failed:', { error: error.message, tradeId: tradeRow?.id })
    return null
  }
}

async function syncPendingOrder(orderRow) {
  try {
    await tradeIndex.ensureAccountLoaded(orderRow.account_id)
    return tradeIndex.addPending(orderRow)
  } catch (error) {
    logger.error('[tradeEngine] syncPendingOrder failed:', { error: error.message, orderId: orderRow?.id })
    return null
  }
}

/**
 * A trade left the open set (manual close, partial close, cancel, batch action).
 * @param {string} tradeId
 * @param {string|null} accountId
 * @param {number|null} realizedPnl Folded into the cached daily total when given
 */
function syncClosedTrade(tradeId, accountId = null, realizedPnl = null) {
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
function reseedFloatingPnl() {
  tradeIndex.resetFloatingPnl()
  const prices = priceCache.getAllPrices()
  let seeded = 0

  for (const instrument in prices) {
    const price = prices[instrument]
    // Resolved per instrument, same as the tick scan — see runTick.
    let usdRate
    try {
      usdRate = getUsdRateForInstrument(instrument)
    } catch (error) {
      logger.warn('[tradeEngine] skipping instrument during reseed — no USD rate:', {
        instrument, error: error.message
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
async function initializeEngine() {
  const summary = await tradeIndex.fullReconcileFromDB()
  reseedFloatingPnl()
  return summary
}

async function reconcileIndex() {
  const summary = await tradeIndex.fullReconcileFromDB()
  reseedFloatingPnl()
  return summary
}

/**
 * Persist peak equity / locked floors accumulated since the last flush.
 *
 * The interval engine wrote these one UPDATE per account per tick. Driven off
 * price ticks that would be the single heaviest thing the engine does, so the
 * writes are batched behind a timer instead.
 */
async function flushDirtyPeaks() {
  if (_dirtyPeaks.size === 0) return 0
  const updates = []
  for (const [accountId, value] of _dirtyPeaks) {
    updates.push({ accountId, peak: value.peak, lockedFloor: value.lockedFloor })
  }
  _dirtyPeaks = new Map()

  try {
    return await drawdownService.flushPeakEquityUpdates(pool, updates)
  } catch (error) {
    logger.error('[tradeEngine] peak equity flush failed:', { error: error.message })
    return 0
  }
}

function getEngineStats() {
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

module.exports = {
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
  getEngineStats,
  DIRECTION_BUY
}
