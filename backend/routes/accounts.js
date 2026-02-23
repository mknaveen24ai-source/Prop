const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')

router.get('/my-accounts', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT * FROM accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) {
    console.error('Get accounts error:', error.message)
    res.status(500).json({ error: 'Could not fetch accounts' })
  }
})

router.post('/create', authenticateToken, async function(req, res) {
  try {
    const { account_size } = req.body

    const ALLOWED_SIZES = [1000, 2000, 5000, 10000]
    if (!ALLOWED_SIZES.includes(account_size)) {
      return res.status(400).json({ error: 'Invalid account size' })
    }

    const user = await pool.query(
      'SELECT kyc_status FROM users WHERE id = $1',
      [req.user.userId]
    )

    if (user.rows[0].kyc_status !== 'approved') {
      return res.status(403).json({ error: 'KYC approval required before creating an account' })
    }

    const existingActive = await pool.query(
      `SELECT id FROM accounts WHERE user_id = $1 AND status = 'active'`,
      [req.user.userId]
    )

    if (existingActive.rows.length > 0) {
      return res.status(400).json({ error: 'You already have an active challenge account' })
    }

    const profit_target = account_size * 0.10
    const max_drawdown_pct = 10.00
    const phase_end_date = new Date()
    phase_end_date.setDate(phase_end_date.getDate() + 30)

    const newAccount = await pool.query(
      `INSERT INTO accounts
       (user_id, account_type, account_size, current_balance, starting_balance,
        peak_balance, profit_target, max_drawdown_pct, status,
        phase_start_date, phase_end_date, bridge_mode)
       VALUES ($1, $2, $3, $3, $3, $3, $4, $5, 'active', NOW(), $6, 'reverse')
       RETURNING *`,
      [
        req.user.userId,
        'phase1',
        account_size,
        profit_target,
        max_drawdown_pct,
        phase_end_date
      ]
    )

    res.status(201).json({
      message: 'Phase 1 account created successfully',
      account: newAccount.rows[0]
    })

  } catch (error) {
    console.error('Create account error:', error.message)
    res.status(500).json({ error: 'Could not create account' })
  }
})

router.get('/stats/:accountId', authenticateToken, async function(req, res) {
  try {
    const { accountId } = req.params

    const account = await pool.query(
      `SELECT * FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountId, req.user.userId]
    )

    if (account.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const acc = account.rows[0]

    const trades = await pool.query(
      `SELECT * FROM trades WHERE account_id = $1 ORDER BY open_time DESC`,
      [accountId]
    )

    const profit_pct = ((acc.current_balance - acc.starting_balance) / acc.starting_balance) * 100
    const drawdown_pct = ((acc.peak_balance - acc.current_balance) / acc.peak_balance) * 100
    const days_elapsed = Math.floor((new Date() - new Date(acc.phase_start_date)) / (1000 * 60 * 60 * 24))
    const days_remaining = Math.max(0, 30 - days_elapsed)

    res.json({
      account: acc,
      stats: {
        profit_pct: parseFloat(profit_pct.toFixed(2)),
        drawdown_pct: parseFloat(drawdown_pct.toFixed(2)),
        days_elapsed,
        days_remaining,
        profit_target_pct: 10,
        max_drawdown_pct: acc.max_drawdown_pct
      },
      trades: trades.rows
    })

  } catch (error) {
    console.error('Stats error:', error.message)
    res.status(500).json({ error: 'Could not fetch stats' })
  }
})

module.exports = router
