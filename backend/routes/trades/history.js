// GET /api/trades/open, /pending, /history, /export — read-only listings.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.

const express = require('express')
const pool = require('../../db')
const logger = require('../../utils/logger')
const { authenticateToken } = require('../middleware')
const { formatPrice } = require('../../constants')
const {
  ensureTradeExperienceInfrastructure,
  computeRMultiple
} = require('../../services/tradeShared')

const router = express.Router()

function mapTradeRow(row) {
  if (!row || typeof row !== 'object') return row

  return {
    ...row,
    r_multiple: ['closed', 'cancelled'].includes(row.status) ? computeRMultiple(row) : null,
    open_screenshot_url: row.open_screenshot_path ? `/api/trades/${row.id}/screenshot/open` : null,
    close_screenshot_url: row.close_screenshot_path ? `/api/trades/${row.id}/screenshot/close` : null
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/open
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/open', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, stop_loss,
              take_profit, status, demo_pnl, open_time, close_time, close_reason, order_type,
              open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status = 'open' ORDER BY open_time DESC`,
      [account_id]
    )

    res.json(trades.rows.map(mapTradeRow))
  } catch (error) {
    logger.error('Open trades error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch open trades' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/pending
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/pending', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, pending_price, order_type,
              status, open_time, demo_trade_id, stop_loss, take_profit,
              oco_group_id, open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status = 'pending' ORDER BY open_time DESC`,
      [account_id]
    )

    res.json(trades.rows.map(mapTradeRow))
  } catch (error) {
    logger.error('Pending orders error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch pending orders' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/history
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/history', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type, pending_price, open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status NOT IN ('open', 'pending') ORDER BY close_time DESC`,
      [account_id]
    )

    res.json(trades.rows.map(mapTradeRow))
  } catch (error) {
    logger.error('Trade history error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trade history' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/export â€” download full trade history as CSV
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query
    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id, account_type, account_size FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const acc = accountCheck.rows[0]

    const tradesResult = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades
       WHERE account_id = $1
       AND status NOT IN ('open', 'pending')
       ORDER BY close_time DESC`,
      [account_id]
    )

    const trades = tradesResult.rows

    const headers = [
      'ID', 'Instrument', 'Direction', 'Lots',
      'Open Price', 'Close Price', 'Open Time', 'Close Time',
      'P&L', 'Close Reason', 'Order Type'
    ]

    const rows = trades.map(t => [
      t.id,
      t.instrument,
      t.direction,
      parseFloat(t.lot_size).toFixed(2),
      t.open_price  ? formatPrice(t.open_price, t.instrument)  : '',
      t.close_price ? formatPrice(t.close_price, t.instrument) : '',
      t.open_time   ? new Date(t.open_time).toISOString()  : '',
      t.close_time  ? new Date(t.close_time).toISOString() : '',
      t.demo_pnl    ? parseFloat(t.demo_pnl).toFixed(2)    : '0.00',
      t.close_reason || 'Manual',
      t.order_type  || 'market'
    ])

    // FIX (Bug 12): Sanitize CSV values to prevent formula injection
    function csvSafeValue(val) {
      let str = String(val).replace(/"/g, '""')
      // Prefix formula-triggering characters with a single quote
      if (/^[=+\-@\t\r]/.test(str)) str = "'" + str
      return `"${str}"`
    }

    const csvContent = [headers, ...rows]
      .map(row => row.map(v => csvSafeValue(v)).join(','))
      .join('\r\n')

    const filename = `trades_${acc.account_type}_${acc.account_size}_${new Date().toISOString().slice(0,10)}.csv`

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csvContent)

  } catch (error) {
    logger.error('Trade export error:', { error: error.message })
    res.status(500).json({ error: 'Could not export trades' })
  }
})

module.exports = router
