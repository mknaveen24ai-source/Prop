'use strict'
/**
 * Weekend Force-Close Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from server.js (lines ~1578–1720).
 * Every Friday 21:00–21:09 UTC, flattens open positions and cancels pending
 * orders when `weekendHoldingEnabled === false`.
 *
 * Usage:
 *   const { weekendForceCloseByTenant, setIo } = require('./services/weekendCloseService')
 */

const logger = require('../utils/logger')
const pool = require('../db')
const { getCurrentPricesForTenant } = require('../priceFeed')
const { getTradingRules } = require('../routes/trades')
const { calculatePnL } = require('../utils/pnlCalculator')

// ─── Module-level state ───────────────────────────────────────────────────────
let weekendCloseExecutedDate = ''
let _io = null

/**
 * Inject the Socket.IO instance so we can emit events.
 * @param {import('socket.io').Server} io
 */
function setIo(io) {
  _io = io
}

// ─── Main job ─────────────────────────────────────────────────────────────────
async function weekendForceCloseByTenant() {
  try {
    const now = new Date()
    const dayUTC = now.getUTCDay()
    const hourUTC = now.getUTCHours()
    const minuteUTC = now.getUTCMinutes()

    if (dayUTC !== 5) return
    const inWindow = hourUTC === 21 && minuteUTC < 10
    if (!inWindow) return

    const todayKey = now.toISOString().slice(0, 10)
    if (weekendCloseExecutedDate === todayKey) return

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.status = 'open'`
    )
    const pendingOrders = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.order_type, a.user_id
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.status = 'pending'`
    )
    if (openTrades.rows.length === 0 && pendingOrders.rows.length === 0) return

    const rules = await getTradingRules()

    if (rules?.weekendHoldingEnabled !== false) return

    const filteredOpenTrades = openTrades.rows
    const filteredPendingOrders = pendingOrders.rows
    if (filteredOpenTrades.length === 0 && filteredPendingOrders.length === 0) return

    logger.info(`[weekend_close] Friday 21:00-21:09 UTC - flattening ${filteredOpenTrades.length} open trade(s) and cancelling ${filteredPendingOrders.length} pending order(s)`)

    let priceMap = null
    let closeErrors = 0

    for (const trade of filteredOpenTrades) {
      try {
        if (!priceMap) {
          priceMap = await getCurrentPricesForTenant()
        }
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

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

        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const locked = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
            [trade.id]
          )
          if (locked.rows.length === 0) { await client.query('ROLLBACK'); continue }

          await client.query(
            `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(),
             demo_pnl = $2, close_reason = 'Weekend Close' WHERE id = $3`,
            [close_price, demo_pnl, trade.id]
          )
          await client.query(
            `UPDATE accounts SET
               current_balance = current_balance + $1,
               peak_balance = GREATEST(peak_balance, current_balance + $1)
             WHERE id = $2`,
            [demo_pnl, trade.account_id]
          )
          await client.query('COMMIT')
        } catch (txErr) {
          await client.query('ROLLBACK')
          logger.error(`[weekend_close] Trade ${trade.id} error:`, { error: txErr.message })
        } finally {
          client.release()
        }
      } catch (tradeErr) {
        closeErrors += 1
        logger.error(`[weekend_close] Error on trade ${trade.id}:`, { error: tradeErr.message })
      }
    }

    for (const order of filteredPendingOrders) {
      try {
        await pool.query(
          `UPDATE trades
              SET status = 'cancelled',
                  close_time = NOW(),
                  close_reason = 'Weekend holding disabled'
            WHERE id = $1 AND status = 'pending'`,
          [order.id]
        )
      } catch (orderErr) {
        closeErrors += 1
        logger.error(`[weekend_close] Error on pending order ${order.id}:`, { error: orderErr.message })
      }
    }

    if (_io) {
      const uniqueUsers = [...new Set([
        ...filteredOpenTrades.map((trade) => trade.user_id),
        ...filteredPendingOrders.map((order) => order.user_id)
      ])]
      for (const userId of uniqueUsers) {
        _io.to(String(userId)).emit('account_update', {
          event: 'weekend_close',
          message: 'Weekend holding is disabled. Open positions were closed and pending orders were cancelled before the weekend.'
        })
      }
    }

    logger.info('[weekend_close] Completed:', {
      tradesClosed: filteredOpenTrades.length,
      pendingCancelled: filteredPendingOrders.length
    })
    if (closeErrors === 0) weekendCloseExecutedDate = todayKey
  } catch (error) {
    logger.error('[weekend_close] Error:', { error: error.message })
  }
}

module.exports = { weekendForceCloseByTenant, setIo }
