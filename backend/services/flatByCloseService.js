'use strict'
/**
 * Flat-By-Close Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Futures-style daily settlement: every day at 23:00–23:09 UTC, force-closes
 * open positions for accounts whose challenge model disallows overnight
 * holding (`challenge_models.allow_overnight = false`). Unlike weekend-close,
 * this does NOT cancel pending orders — a pending limit/stop order queued for
 * the next session is a deliberate trader decision, not a held position.
 *
 * Mirrors the shape of weekendCloseService.js.
 */

const logger = require('../utils/logger')
const pool = require('../db')
const { getCurrentPricesForTenant } = require('../priceFeed')
const { Decimal } = require('decimal.js')
const { CONTRACT_SIZES } = require('../constants')

function calculatePnL(direction, open_price, close_price, lots, instrument, commission = 0) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(close_price).minus(open_price)
    : new Decimal(open_price).minus(close_price)
  return priceDiff.times(lots).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

let flatCloseExecutedDate = ''
let _io = null

function setIo(io) {
  _io = io
}

async function flatByCloseForAccounts() {
  try {
    const now = new Date()
    const hourUTC = now.getUTCHours()
    const minuteUTC = now.getUTCMinutes()

    const inWindow = hourUTC === 23 && minuteUTC < 10
    if (!inWindow) return

    const todayKey = now.toISOString().slice(0, 10)
    if (flatCloseExecutedDate === todayKey) return

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
         JOIN challenge_models m ON m.slug = a.challenge_model_slug
        WHERE t.status = 'open'
          AND a.challenge_model_slug IS NOT NULL
          AND m.allow_overnight = FALSE`
    )
    if (openTrades.rows.length === 0) {
      flatCloseExecutedDate = todayKey
      return
    }

    logger.info(`[flat_by_close] 23:00-23:09 UTC - flattening ${openTrades.rows.length} open trade(s) held on no-overnight models`)

    let priceMap = null
    let closeErrors = 0

    for (const trade of openTrades.rows) {
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
             demo_pnl = $2, close_reason = 'Flat By Close' WHERE id = $3`,
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
          logger.error(`[flat_by_close] Trade ${trade.id} error:`, { error: txErr.message })
        } finally {
          client.release()
        }
      } catch (tradeErr) {
        closeErrors += 1
        logger.error(`[flat_by_close] Error on trade ${trade.id}:`, { error: tradeErr.message })
      }
    }

    if (_io) {
      const uniqueUsers = [...new Set(openTrades.rows.map((trade) => trade.user_id))]
      for (const userId of uniqueUsers) {
        _io.to(String(userId)).emit('account_update', {
          event: 'flat_by_close',
          message: 'Daily flat-by-close: your open positions were closed at 23:00 UTC — this model does not allow overnight holding.'
        })
      }
    }

    logger.info('[flat_by_close] Completed:', { tradesClosed: openTrades.rows.length })
    if (closeErrors === 0) flatCloseExecutedDate = todayKey
  } catch (error) {
    logger.error('[flat_by_close] Error:', { error: error.message })
  }
}

module.exports = { flatByCloseForAccounts, setIo }
