// PATCH /api/trades/modify and /modify-pending — SL/TP and trigger edits.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.

const express = require('express')
const pool = require('../../db')
const rateLimit = require('express-rate-limit')
const logger = require('../../utils/logger')
const { authenticateToken } = require('../middleware')
const { getMinDistance, roundPrice } = require('../../constants')
const { validatePendingOrderPrice } = require('../../utils/pendingOrderValidation')
const {
  ensureTradeExperienceInfrastructure,
  getLivePriceMap
} = require('../../services/tradeShared')
const { engine } = require('./shared')

const router = express.Router()

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// PATCH /api/trades/modify  (update SL/TP on open trade)
// FIX: Added rate limiter â€” 60 modifications per minute per user is generous
// for legitimate use but prevents bot-level abuse that would hammer the DB.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tradeModifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many modify requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? String(req.user.userId) : 'anon'
})

// PATCH /api/trades/modify-pending  (adjust price/SL/TP on a pending order)
router.patch('/modify-pending', authenticateToken, tradeModifyLimiter, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { trade_id, pending_price, stop_loss, take_profit } = req.body

    if (!trade_id) return res.status(400).json({ error: 'Trade ID required' })

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.id = $1 AND t.status = 'pending'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pending order not found or already processed' })
    }

    const trade = tradeResult.rows[0]

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const prices = await getLivePriceMap()
    const price = prices[trade.instrument]
    const bid = price ? parseFloat(price.bid) : NaN
    const ask = price ? parseFloat(price.ask) : NaN

    const nextPendingPrice = pending_price != null ? parseFloat(pending_price) : parseFloat(trade.pending_price)
    const priceError = validatePendingOrderPrice(trade.order_type, nextPendingPrice, bid, ask)
    if (priceError) return res.status(400).json({ error: priceError })

    const updates = []
    const vals = []
    let idx = 1
    if (pending_price != null) { updates.push('pending_price = $' + idx++); vals.push(nextPendingPrice) }
    if (stop_loss != null)     { updates.push('stop_loss = $' + idx++);     vals.push(parseFloat(stop_loss)) }
    if (take_profit != null)   { updates.push('take_profit = $' + idx++);   vals.push(parseFloat(take_profit)) }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })
    updates.push('updated_at = NOW()')
    vals.push(trade_id)

    const updated = await pool.query(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${idx} AND status = 'pending' RETURNING *`,
      vals
    )
    if (updated.rowCount === 0) return res.status(409).json({ error: 'Trade was already processed' })
    const row = updated.rows[0]

    // Re-index at the new trigger price, or the engine keeps watching the old one.
    await engine().syncPendingOrder(row)

    res.json({ message: 'Pending order updated', trade: row })

  } catch (error) {
    logger.error('Modify pending order error:', { error: error.message })
    res.status(500).json({ error: 'Could not modify pending order' })
  }
})

router.patch('/modify', authenticateToken, tradeModifyLimiter, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()

    const {
      trade_id,
      stop_loss,
      take_profit,
      move_to_breakeven
    } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
    }

    if (
      stop_loss === undefined
      && take_profit === undefined
      && !move_to_breakeven
    ) {
      return res.status(400).json({ error: 'Provide at least one trade modification field' })
    }

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    const trade      = tradeResult.rows[0]
    const open_price = parseFloat(trade.open_price)

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    // FIX (BUG-M7): Added minimum distance enforcement for SL/TP modification.
    // Prevents setting SL/TP so close to entry that they trigger immediately or
    // are used to game the system. Distance now comes from per-instrument metadata
    // so JPY pairs and indices use the correct quote precision as well.
    const MIN_DISTANCE = getMinDistance(trade.instrument)

    if (stop_loss !== undefined && stop_loss !== '' && stop_loss !== null && !move_to_breakeven) {
      const sl = parseFloat(stop_loss)
      if (isNaN(sl)) return res.status(400).json({ error: 'Invalid stop loss value' })
      if (trade.direction === 'buy'  && sl >= open_price) return res.status(400).json({ error: 'Stop loss must be below entry price for BUY trades' })
      if (trade.direction === 'sell' && sl <= open_price) return res.status(400).json({ error: 'Stop loss must be above entry price for SELL trades' })
      if (Math.abs(open_price - sl) < MIN_DISTANCE) return res.status(400).json({ error: `Stop loss must be at least ${MIN_DISTANCE} away from entry price` })
    }

    if (take_profit !== undefined && take_profit !== '' && take_profit !== null) {
      const tp = parseFloat(take_profit)
      if (isNaN(tp)) return res.status(400).json({ error: 'Invalid take profit value' })
      if (trade.direction === 'buy'  && tp <= open_price) return res.status(400).json({ error: 'Take profit must be above entry price for BUY trades' })
      if (trade.direction === 'sell' && tp >= open_price) return res.status(400).json({ error: 'Take profit must be below entry price for SELL trades' })
      if (Math.abs(open_price - tp) < MIN_DISTANCE) return res.status(400).json({ error: `Take profit must be at least ${MIN_DISTANCE} away from entry price` })
    }

    const updates = []
    const values  = []
    let idx = 1

    if (move_to_breakeven) {
      updates.push(`stop_loss = $${idx++}`)
      values.push(roundPrice(open_price, trade.instrument))
    } else if (stop_loss !== undefined) {
      updates.push(`stop_loss = $${idx++}`)
      values.push(stop_loss === '' || stop_loss === null ? null : parseFloat(stop_loss))
    }

    if (take_profit !== undefined) {
      updates.push(`take_profit = $${idx++}`)
      values.push(take_profit === '' || take_profit === null ? null : parseFloat(take_profit))
    }

    values.push(trade_id)
    const modResult = await pool.query(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${idx} AND status = 'open'
       RETURNING id, account_id, instrument, direction, lot_size, open_price,
                 stop_loss, take_profit, commission, open_time`,
      values
    )
    if (modResult.rowCount === 0) {
      return res.status(409).json({ error: 'Trade was already processed' })
    }

    // Re-index against the new SL/TP levels — the engine compares against the
    // values it holds in memory, not the row.
    await engine().syncOpenedTrade(modResult.rows[0])

    res.json({ message: 'Trade modified successfully' })

  } catch (error) {
    logger.error('Modify trade error:', { error: error.message })
    res.status(500).json({ error: 'Could not modify trade' })
  }
})

module.exports = router
