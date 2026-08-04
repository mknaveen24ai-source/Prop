'use strict'
/**
 * News Force-Close Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted from server.js (lines ~1468–1573).
 * Closes all open trades when a high-impact USD news event is within 3 minutes.
 *
 * Usage:
 *   const { checkNewsForceClose, startNewsService, stopNewsService } = require('./services/newsCloseService')
 */

const logger = require('../utils/logger')
const pool = require('../db')
const newsService = require('./newsService')
const { getCurrentPricesForTenant } = require('../priceFeed')
const { calculatePnL } = require('../utils/pnlCalculator')

// ─── Module-level state ───────────────────────────────────────────────────────
let lastClosedNewsId = ''
let _io = null

/**
 * Inject the Socket.IO instance so we can emit events.
 * Called by server.js after io is created.
 * @param {import('socket.io').Server} io
 */
function setIo(io) {
  _io = io
}

// ─── Main job ─────────────────────────────────────────────────────────────────
async function checkNewsForceClose() {
  // FIX (BUG-1 + BUG-7): client declared outside try so finally always releases it.
  let client
  try {
    // 3 minute window as per strict rules
    const activeNews = newsService.getActiveNewsEvent(3)
    if (!activeNews) {
      lastClosedNewsId = ''
      return
    }

    // Only close trades once per news event window
    const newsId = `${activeNews.title}_${activeNews.timestamp}`
    if (lastClosedNewsId === newsId) return

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'`
    )
    if (openTrades.rows.length === 0) return

    logger.info(`[news_close] Active USD High Impact: ${activeNews.title} — force-closing ${openTrades.rows.length} trades`)

    client = await pool.connect()
    let closeErrors = 0
    let priceMap = null

    for (const trade of openTrades.rows) {
      try {
        if (!priceMap) {
          priceMap = await getCurrentPricesForTenant()
        }
        const priceData = priceMap[trade.instrument]
        if (!priceData) {
          closeErrors += 1
          logger.warn(`[news_close] Missing live price for ${trade.instrument}; trade ${trade.id} left open for retry`)
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

        await client.query('BEGIN')
        const locked = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (locked.rows.length === 0) { await client.query('ROLLBACK'); continue }

        await client.query(
          `UPDATE trades SET status='closed', close_price=$1, close_time=NOW(), demo_pnl=$2, close_reason='News Force Close' WHERE id=$3`,
          [close_price, demo_pnl, trade.id]
        )

        // FIX (BUG-1): Balance was NEVER updated after news force-close.
        await client.query(
          `UPDATE accounts SET
             current_balance = current_balance + $1,
             peak_balance    = GREATEST(peak_balance, current_balance + $1),
             updated_at      = NOW()
           WHERE id = $2`,
          [demo_pnl, trade.account_id]
        )

        await client.query('COMMIT')

        if (_io) {
          _io.to(String(trade.user_id)).emit('trade_closed', { trade_id: trade.id, reason: 'News Force Close', pnl: demo_pnl })
        }
      } catch (err) {
        closeErrors += 1
        await client.query('ROLLBACK').catch(() => {})
        logger.error(`[news_close] Error closing trade ${trade.id}:`, { error: err.message })
      }
    }

    if (closeErrors === 0) lastClosedNewsId = newsId
    else lastClosedNewsId = ''
  } catch (error) {
    logger.error('[news_close] Force-close check error:', { error: error.message })
    lastClosedNewsId = '' // Reset to allow retry on next interval
  } finally {
    // FIX (BUG-7): Guaranteed release — prevents pool exhaustion under any code path.
    if (client) client.release()
  }
}

function startNewsService() {
  newsService.start()
  logger.info('[newsCloseService] News service started')
}

function stopNewsService() {
  newsService.stop?.()
}

module.exports = {
  checkNewsForceClose,
  startNewsService,
  stopNewsService,
  setIo
}
