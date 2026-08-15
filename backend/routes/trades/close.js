// POST /api/trades/close and /cancel — exits and pending-order cancellation.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.

const express = require('express')
const pool = require('../../db')
const rateLimit = require('express-rate-limit')
const logger = require('../../utils/logger')
const Decimal = require('decimal.js')
const tradeIndex = require('../../utils/tradeIndex')
const { authenticateToken } = require('../middleware')
const { v4: uuidv4 } = require('uuid')
const { isValidLotSize } = require('../../utils/validation')
const { getPipSize, roundPrice } = require('../../constants')
const { resolveTieredInstrumentSetting } = require('../../utils/tenantSettings')
const { calculatePnL } = require('../../utils/pnlCalculator')
const {
  ensureTradeExperienceInfrastructure,
  getTradingRules,
  getLivePrice,
  getMarketStatus
} = require('../../services/tradeShared')
const { engine, isValidImageDataUrl, persistTradeScreenshot } = require('./shared')

const router = express.Router()

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/close
//
// FIX (Bug 1): Wrapped trade close + balance update in a single transaction
// with FOR UPDATE SKIP LOCKED on the trade row. This prevents:
// (a) balance corruption if one query succeeds but the other fails
// (b) double-close race with the background checkSLTP checker
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FIX (LOOPHOLE 1): Rate limit trade close to prevent DoS flooding
const tradeCloseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many close requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/close', authenticateToken, tradeCloseLimiter, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()

    const { trade_id, close_lots, screenshot_data_url } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
    }
    if (screenshot_data_url != null && !isValidImageDataUrl(screenshot_data_url)) {
      return res.status(400).json({ error: 'Invalid screenshot data' })
    }

    // Pre-flight check (outside transaction) for quick rejection
    const tradeResult = await pool.query(
      `SELECT t.*, t.original_commission, a.user_id, a.account_type FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    const trade = tradeResult.rows[0]

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
    const rules = await getTradingRules()
    const { minHoldSeconds } = rules
    if (secondsOpen < minHoldSeconds) {
      return res.status(400).json({
        error: `Minimum trade duration is ${minHoldSeconds} seconds. Please wait ${Math.ceil(minHoldSeconds - secondsOpen)} more seconds.`
      })
    }

    // ── Market hours check — block manual close on weekend / rollover ──────────
    const closeMarketStatus = getMarketStatus(trade.instrument, { purpose: 'close' })
    if (!closeMarketStatus.open) {
      return res.status(400).json({ error: `Cannot close trade: ${closeMarketStatus.reason}` })
    }

    const price = await getLivePrice(trade.instrument)
    const priceAgeMs = Date.now() - new Date(price.updated_at).getTime()
    // Allow up to 10 seconds for price age (more lenient for slower MT5 setups)
    if (priceAgeMs > 10000) {
      logger.warn('Price feed too old on close:', { instrument: trade.instrument, ageMs: priceAgeMs })
      return res.status(400).json({ error: 'Price feed is currently delayed. Close rejected due to volatility protection/latency.' })
    }
    
    // BUY closes at BID, SELL closes at ASK
    let close_price = trade.direction === 'buy'
      ? parseFloat(price.bid)
      : parseFloat(price.ask)

    const closeSlippageMaxPipsAdverse = resolveTieredInstrumentSetting(rules.slippageMaxPipsAdverseJson, trade.account_type, trade.instrument, rules.slippageMaxPipsAdverse)
    if (rules.slippageSimulatorEnabled && closeSlippageMaxPipsAdverse > 0) {
      const randPips = Math.random() * closeSlippageMaxPipsAdverse
      const slippageAmt = randPips * getPipSize(trade.instrument)

      close_price = trade.direction === 'buy' ? close_price - slippageAmt : close_price + slippageAmt
      close_price = roundPrice(close_price, trade.instrument)
    }

    let demo_pnl = 0
    let isPartial = false
    let remainingLotsNum = 0
    let closedTradeId = null
    // Captured inside the transaction, applied to the engine index after COMMIT.
    let indexSync = null
    const requestedCloseLots = close_lots == null ? null : parseFloat(close_lots)

    if (requestedCloseLots != null && !Number.isFinite(requestedCloseLots)) {
      return res.status(400).json({ error: 'Invalid close amount' })
    }

    // FIX (Bug 1): Transaction with row-level lock
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Lock the trade row â€” skip if already being processed by checkSLTP
      let lockResult = { rows: [] }
      for (let attempt = 0; attempt < 2; attempt++) {
        lockResult = await client.query(
          `SELECT id, account_id, instrument, direction, lot_size, open_price, open_time,
                  commission, original_commission
           FROM trades
           WHERE id = $1 AND status = 'open'
           FOR UPDATE SKIP LOCKED`,
          [trade_id]
        )
        if (lockResult.rows.length > 0) break
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 150))
        }
      }
      if (lockResult.rows.length === 0) {
        const currentTradeState = await client.query(
          `SELECT id, status FROM trades WHERE id = $1`,
          [trade_id]
        )
        await client.query('ROLLBACK')
        if (currentTradeState.rows.length > 0) {
          const currentStatus = currentTradeState.rows[0].status
          return res.status(409).json({
            error: currentStatus === 'open'
              ? 'Trade is already being updated. Please try again in a moment.'
              : 'Trade was already processed. Refreshing latest trade state.',
            code: currentStatus === 'open' ? 'TRADE_BUSY' : 'TRADE_ALREADY_PROCESSED'
          })
        }
        return res.status(404).json({ error: 'Trade not found or already closed' })
      }

      const lockedTrade = lockResult.rows[0]
      const currentLotSizeDec = new Decimal(lockedTrade.lot_size)
      const minLotSize = parseFloat(rules.minLotSize || 0.01)
      const closeLotsDec = requestedCloseLots == null
        ? currentLotSizeDec
        : new Decimal(requestedCloseLots)

      if (!closeLotsDec.isFinite() || closeLotsDec.lte(0) || closeLotsDec.gt(currentLotSizeDec)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Invalid close amount' })
      }

      const closeLotsNum = closeLotsDec.toNumber()
      if (!isValidLotSize(closeLotsNum)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Close amount must be in 0.01 lot steps' })
      }

      const remainingLotsDec = currentLotSizeDec.minus(closeLotsDec).toDecimalPlaces(2)
      remainingLotsNum = remainingLotsDec.toNumber()
      isPartial = remainingLotsNum > 0

      if (isPartial) {
        if (remainingLotsNum < minLotSize || !isValidLotSize(remainingLotsNum)) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Partial close must leave at least ${minLotSize.toFixed(2)} lots open`
          })
        }
      }

      const ratio = closeLotsDec.div(currentLotSizeDec)
      const originalCommissionDec = new Decimal(lockedTrade.commission ?? lockedTrade.original_commission ?? 0)
      const partialCommission = originalCommissionDec.times(ratio).toDecimalPlaces(2).toNumber()
      const remainingCommission = originalCommissionDec.minus(partialCommission).toDecimalPlaces(2).toNumber()

      demo_pnl = calculatePnL(
        lockedTrade.direction,
        parseFloat(lockedTrade.open_price),
        close_price,
        closeLotsNum,
        lockedTrade.instrument,
        partialCommission
      )

      if (isPartial) {
        const partialTradeDemoId = uuidv4()
        // Log child closed trade
        const partialCloseResult = await client.query(
          `INSERT INTO trades (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
           status, close_price, close_time, demo_pnl, close_reason, commission, original_commission, parent_trade_id, is_partial,
           close_screenshot_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'closed', $8, NOW(), $9, 'Manual Partial Close', $10, $10, $11, true, NULL)
           RETURNING id`,
          [
            lockedTrade.account_id,
            partialTradeDemoId,
            lockedTrade.instrument,
            lockedTrade.direction,
            closeLotsNum,
            lockedTrade.open_price,
            lockedTrade.open_time,
            close_price,
            demo_pnl,
            partialCommission,
            trade_id
          ]
        )
        closedTradeId = partialCloseResult.rows[0]?.id || null
        // Shrink the current open trade
        await client.query(
          `UPDATE trades SET lot_size = $1, commission = $2 WHERE id = $3`,
          [remainingLotsNum, remainingCommission, trade_id]
        )
      } else {
        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Manual Close'
           WHERE id = $3`,
          [close_price, demo_pnl, trade_id]
        )
        closedTradeId = trade_id
      }

      if (screenshot_data_url && closedTradeId) {
        const screenshotPath = await persistTradeScreenshot({
          tradeId: closedTradeId,
          userId: req.user.userId,
          kind: 'close',
          dataUrl: screenshot_data_url
        })
        if (screenshotPath) {
          await client.query(`UPDATE trades SET close_screenshot_path = $1 WHERE id = $2`, [screenshotPath, closedTradeId])
        }
      }

      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [demo_pnl, lockedTrade.account_id]
      )

      await client.query('COMMIT')

      indexSync = {
        accountId: lockedTrade.account_id,
        remainingTrade: isPartial
          ? { ...lockedTrade, lot_size: remainingLotsNum, commission: remainingCommission }
          : null
      }
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    // Index sync — a partial close shrinks the live position rather than ending
    // it, so the entry is refreshed (new lot size and commission) instead of
    // dropped. Either way the realised PnL feeds the cached daily-loss total.
    if (indexSync) {
      if (indexSync.remainingTrade) {
        await engine().syncOpenedTrade(indexSync.remainingTrade)
        tradeIndex.applyRealizedPnl(indexSync.accountId, demo_pnl)
      } else {
        engine().syncClosedTrade(trade_id, indexSync.accountId, demo_pnl)
      }
      const accountEntry = tradeIndex.getAccountEntry(indexSync.accountId)
      if (accountEntry) {
        tradeIndex.updateAccountBalance(indexSync.accountId, accountEntry.currentBalance + demo_pnl)
      }
    }

    if (req.app.get('io')) {
      req.app.get('io').to(String(trade.user_id)).emit('account_update', {
        message: `${isPartial ? 'Trade partially closed' : 'Trade closed'} on ${trade.instrument}: ${demo_pnl >= 0 ? '+' : ''}$${demo_pnl.toFixed(2)}`,
        pnl: demo_pnl
      })
    }

    res.json({
      message: isPartial ? 'Trade partially closed successfully' : 'Trade closed successfully',
      pnl: demo_pnl,
      close_price,
      is_partial: isPartial,
      remaining_lots: remainingLotsNum
    })

  } catch (error) {
    logger.error('Close trade error:', { error: error.message })
    res.status(500).json({ error: 'Could not close trade' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/cancel   (cancel a pending order)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/cancel', authenticateToken, tradeCloseLimiter, async function(req, res) {
  try {
    const { trade_id } = req.body

    if (!trade_id) return res.status(400).json({ error: 'Trade ID required' })

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'pending'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pending order not found' })
    }

    if (tradeResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    // Race-safe cancel: only cancel if still pending (prevents double-cancel)
    const cancelResult = await pool.query(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = 'Cancelled by trader'
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [trade_id]
    )

    if (cancelResult.rowCount === 0) {
      return res.status(409).json({ error: 'Pending order was already processed' })
    }

    tradeIndex.removePending(trade_id)

    res.json({ message: 'Order cancelled' })

  } catch (error) {
    logger.error('Cancel order error:', { error: error.message })
    res.status(500).json({ error: 'Could not cancel order' })
  }
})

module.exports = router
