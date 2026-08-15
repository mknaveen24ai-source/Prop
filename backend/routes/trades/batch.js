// POST /api/trades/batch-action — bulk close / breakeven.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.
//
// Its own module rather than part of close.js so it keeps its original
// registration position (12th) and the route manifest diff stays empty.

const express = require('express')
const pool = require('../../db')
const logger = require('../../utils/logger')
const newsService = require('../../services/newsService')
const tradeIndex = require('../../utils/tradeIndex')
const { authenticateToken } = require('../middleware')
const { tradingLimiter } = require('../../utils/security')
const { calculatePnL } = require('../../utils/pnlCalculator')
const { getTradingRules, getLivePrice, getMarketStatus } = require('../../services/tradeShared')
const { engine } = require('./shared')

const router = express.Router()

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/batch-action
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/batch-action', authenticateToken, tradingLimiter, async function(req, res) {
  try {
    const { action, account_id } = req.body
    if (!['close_winning', 'close_losing', 'breakeven_winning'].includes(action) || !account_id) {
      return res.status(400).json({ error: 'Invalid batch action or account ID' })
    }

    const openTradesResult = await pool.query(
      `SELECT t.* FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1 AND t.account_id = $2 AND t.status = 'open'`,
      [req.user.userId, account_id]
    )

    if (openTradesResult.rows.length === 0) {
      return res.json({ message: 'No open trades to process', affected: 0 })
    }

    // FIX: Check news protection before any batch close (same rule as manual close)
    const activeNews = newsService.getActiveNewsEvent(3)
    if (activeNews && action !== 'breakeven_winning') {
      return res.status(400).json({ error: `Cannot close trades. USD High-impact news event '${activeNews.title}' is active.` })
    }

    // Block batch closes on weekends / daily rollover (same rule as manual close)
    if (action !== 'breakeven_winning') {
      const batchMarketStatus = getMarketStatus('EURUSD', { purpose: 'close' }) // instrument-agnostic; same schedule for all
      if (!batchMarketStatus.open) {
        return res.status(400).json({ error: `Cannot close trades: ${batchMarketStatus.reason}` })
      }
    }

    const rules = await getTradingRules()
    let affectedCount = 0
    const skipped = {
      min_hold: 0,
      price_unavailable: 0,
      no_match: 0,
      locked: 0,
      error: 0
    }

    const client = await pool.connect()
    try {
      for (const trade of openTradesResult.rows) {
        // FIX: Enforce minimum hold time on batch closes (same rule as individual close)
        if (action !== 'breakeven_winning') {
          const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
          if (secondsOpen < rules.minHoldSeconds) {
            skipped.min_hold++
            continue
          }
        }

        let currentPrice
        try {
          const priceObj = await getLivePrice(trade.instrument)
          currentPrice = trade.direction === 'buy' ? parseFloat(priceObj.bid) : parseFloat(priceObj.ask)
        } catch {
          skipped.price_unavailable++
          continue
        } // Skip if price feed down for this instrument

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        let shouldProcess = false
        if (action === 'close_winning' && demo_pnl > 0) shouldProcess = true
        if (action === 'close_losing' && demo_pnl < 0) shouldProcess = true
        if (action === 'breakeven_winning' && demo_pnl > 0) shouldProcess = true

        if (!shouldProcess) {
          skipped.no_match++
          continue
        }

        try {
          await client.query('BEGIN')
          // Lock trade row
          const lock = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
            [trade.id]
          )
          if (lock.rows.length === 0) {
            skipped.locked++
            await client.query('ROLLBACK')
            continue
          }

          if (action === 'breakeven_winning') {
            await client.query(
              `UPDATE trades SET stop_loss = $1 WHERE id = $2`,
              [trade.open_price, trade.id]
            )
            await client.query('COMMIT')
            // Re-index at the moved stop so the engine watches the new level.
            await engine().syncOpenedTrade({ ...trade, stop_loss: trade.open_price })
            affectedCount++
          } else {
            // Close trade logic
            await client.query(
              `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(), demo_pnl = $2, close_reason = 'Batch Close' WHERE id = $3`,
              [currentPrice, demo_pnl, trade.id]
            )
            await client.query(
              `UPDATE accounts SET current_balance = current_balance + $1, peak_balance = GREATEST(peak_balance, current_balance + $1) WHERE id = $2`,
              [demo_pnl, trade.account_id]
            )
            await client.query('COMMIT')
            engine().syncClosedTrade(trade.id, trade.account_id, demo_pnl)
            const batchAccount = tradeIndex.getAccountEntry(trade.account_id)
            if (batchAccount) {
              tradeIndex.updateAccountBalance(trade.account_id, batchAccount.currentBalance + demo_pnl)
            }
            affectedCount++
          }
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {})
          logger.error('Batch action trade error:', { tradeId: trade.id, error: txErr.message })
          skipped.error++
        }
      }
    } finally {
       client.release()
    }

    const attempted = openTradesResult.rows.length
    const skippedCount = Object.values(skipped).reduce((sum, value) => sum + value, 0)
    const actionLabel = action.replace(/_/g, ' ')
    let message = `Batch ${actionLabel} completed successfully`

    if (affectedCount === 0) {
      if (skipped.min_hold > 0) {
        message = `No trades closed yet. ${skipped.min_hold} trade(s) are still inside the minimum hold time.`
      } else if (skipped.no_match > 0) {
        if (action === 'close_winning') {
          message = 'No winning trades are available to close right now.'
        } else if (action === 'close_losing') {
          message = 'No losing trades are available to close right now.'
        } else {
          message = 'No profitable trades are available to move to breakeven right now.'
        }
      } else if (skipped.price_unavailable > 0) {
        message = 'Live price data is unavailable for the selected trade(s). Please try again in a moment.'
      } else {
        message = `No trades were updated for batch ${actionLabel}.`
      }
    } else if (skippedCount > 0) {
      message = `Batch ${actionLabel} completed. ${affectedCount} trade(s) updated, ${skippedCount} skipped.`
    }

    res.json({
      message,
      affected: affectedCount,
      attempted,
      skipped,
      minHoldSeconds: rules.minHoldSeconds
    })
  } catch (error) {
    logger.error('Batch action error:', { error: error.message })
    res.status(500).json({ error: 'Could not process batch action' })
  }
})

module.exports = router
