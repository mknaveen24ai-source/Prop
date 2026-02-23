const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const { v4: uuidv4 } = require('uuid')

const CONTRACT_SIZES = {
  EURUSD: 100000,
  GBPUSD: 100000,
  XAUUSD: 100,
  XAGUSD: 5000
}

const LEVERAGE = {
  EURUSD: 30,
  GBPUSD: 30,
  XAUUSD: 10,
  XAGUSD: 10
}

const MAX_LOTS = {
  EURUSD: 1.00,
  GBPUSD: 1.00,
  XAUUSD: 0.50,
  XAGUSD: 0.50
}

async function getLivePrice(instrument) {
  const result = await pool.query(
    'SELECT bid, ask FROM price_feed WHERE instrument = $1',
    [instrument]
  )
  if (result.rows.length === 0) throw new Error('Price not available')
  return result.rows[0]
}

function calculatePnL(direction, open_price, current_price, lots, instrument) {
  const contractSize = CONTRACT_SIZES[instrument]
  let priceDiff
  if (direction === 'buy') {
    priceDiff = current_price - open_price
  } else {
    priceDiff = open_price - current_price
  }
  return parseFloat((priceDiff * lots * contractSize).toFixed(2))
}

function calculateMargin(instrument, lots) {
  const contractSize = CONTRACT_SIZES[instrument]
  const leverage = LEVERAGE[instrument]
  return parseFloat(((lots * contractSize) / leverage).toFixed(2))
}

router.post('/open', authenticateToken, async function(req, res) {
  try {
    const { account_id, instrument, direction, lots } = req.body

    if (!account_id || !instrument || !direction || !lots) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    if (!CONTRACT_SIZES[instrument]) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    if (!['buy', 'sell'].includes(direction)) {
      return res.status(400).json({ error: 'Direction must be buy or sell' })
    }

    if (lots > MAX_LOTS[instrument]) {
      return res.status(400).json({ error: `Maximum lot size is ${MAX_LOTS[instrument]}` })
    }

    if (lots < 0.01) {
      return res.status(400).json({ error: 'Minimum lot size is 0.01' })
    }

    const account = await pool.query(
      `SELECT * FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )

    if (account.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const acc = account.rows[0]

    if (acc.status !== 'active') {
      return res.status(403).json({ error: 'Account is not active' })
    }

    const openTrades = await pool.query(
      `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status = 'open'`,
      [account_id]
    )

    if (parseInt(openTrades.rows[0].count) >= 5) {
      return res.status(400).json({ error: 'Maximum 5 open trades allowed' })
    }

    const todayTrades = await pool.query(
      `SELECT COUNT(*) FROM trades 
       WHERE account_id = $1 AND DATE(open_time) = CURRENT_DATE`,
      [account_id]
    )

    if (parseInt(todayTrades.rows[0].count) >= 20) {
      return res.status(400).json({ error: 'Maximum 20 trades per day reached' })
    }

    const margin = calculateMargin(instrument, lots)
    if (margin > acc.current_balance * 0.5) {
      return res.status(400).json({ error: 'Insufficient margin' })
    }

    const price = await getLivePrice(instrument)
    const open_price = direction === 'buy' ? price.ask : price.bid
    const demo_trade_id = uuidv4()

    const newTrade = await pool.query(
      `INSERT INTO trades
       (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'open')
       RETURNING *`,
      [account_id, demo_trade_id, instrument, direction, lots, open_price]
    )

    res.status(201).json({
      message: 'Trade opened successfully',
      trade: newTrade.rows[0]
    })

  } catch (error) {
    console.error('Open trade error:', error.message)
    res.status(500).json({ error: 'Could not open trade' })
  }
})

router.post('/close', authenticateToken, async function(req, res) {
  try {
    const { trade_id } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
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

    const trade = tradeResult.rows[0]

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
    if (secondsOpen < 60) {
      return res.status(400).json({
        error: `Minimum trade duration is 60 seconds. Wait ${Math.ceil(60 - secondsOpen)} more seconds.`
      })
    }

    const price = await getLivePrice(trade.instrument)
    const close_price = trade.direction === 'buy' ? price.bid : price.ask
    const demo_pnl = calculatePnL(
      trade.direction,
      parseFloat(trade.open_price),
      close_price,
      parseFloat(trade.lot_size),
      trade.instrument
    )

    const closedTrade = await pool.query(
      `UPDATE trades SET
       status = 'closed',
       close_price = $1,
       close_time = NOW(),
       demo_pnl = $2
       WHERE id = $3
       RETURNING *`,
      [close_price, demo_pnl, trade_id]
    )

    const account = await pool.query(
      'SELECT * FROM accounts WHERE id = $1',
      [trade.account_id]
    )

    const acc = account.rows[0]
    const new_balance = parseFloat(acc.current_balance) + demo_pnl
    const new_peak = Math.max(parseFloat(acc.peak_balance), new_balance)

    await pool.query(
      `UPDATE accounts SET
       current_balance = $1,
       peak_balance = $2
       WHERE id = $3`,
      [new_balance, new_peak, trade.account_id]
    )

    res.json({
      message: 'Trade closed successfully',
      trade: closedTrade.rows[0],
      pnl: demo_pnl,
      new_balance: new_balance
    })

  } catch (error) {
    console.error('Close trade error:', error.message)
    res.status(500).json({ error: 'Could not close trade' })
  }
})

router.get('/open/:account_id', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.params

    const trades = await pool.query(
      `SELECT t.* FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.account_id = $1 
       AND t.status = 'open'
       AND a.user_id = $2
       ORDER BY t.open_time DESC`,
      [account_id, req.user.userId]
    )

    const prices = await pool.query('SELECT * FROM price_feed')
    const priceMap = {}
    prices.rows.forEach(function(p) {
      priceMap[p.instrument] = p
    })

    const tradesWithPnl = trades.rows.map(function(trade) {
      const currentPrice = trade.direction === 'buy'
        ? parseFloat(priceMap[trade.instrument].bid)
        : parseFloat(priceMap[trade.instrument].ask)

      const floating_pnl = calculatePnL(
        trade.direction,
        parseFloat(trade.open_price),
        currentPrice,
        parseFloat(trade.lot_size),
        trade.instrument
      )

      return { ...trade, floating_pnl, current_price: currentPrice }
    })

    res.json(tradesWithPnl)

  } catch (error) {
    console.error('Get open trades error:', error.message)
    res.status(500).json({ error: 'Could not fetch trades' })
  }
})

router.get('/history/:account_id', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.params

    const trades = await pool.query(
      `SELECT t.* FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.account_id = $1
       AND t.status = 'closed'
       AND a.user_id = $2
       ORDER BY t.close_time DESC`,
      [account_id, req.user.userId]
    )

    res.json(trades.rows)

  } catch (error) {
    console.error('Trade history error:', error.message)
    res.status(500).json({ error: 'Could not fetch trade history' })
  }
})

module.exports = router
