const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const rateLimit = require('express-rate-limit')
const logger = require('../utils/logger')
const Decimal = require('decimal.js')

// Contract sizes for floating PnL calculation
const CONTRACT_SIZES = {
  EURUSD: 100000, GBPUSD: 100000, USDJPY: 100000, USDCHF: 100000,
  AUDUSD: 100000, USDCAD: 100000, XAUUSD: 100, XAGUSD: 5000
}

const payoutRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many payout requests. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
})
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// POST /api/payouts/request Ã¢â‚¬â€ funded traders only
//
// FIX 1: Floating P&L is now factored into profit eligibility. Previously a
// trader with a large open losing position could have current_balance >
// starting_balance but negative real equity, and still pass the profit check.
// Now we fetch open trades + live prices and subtract floating losses from
// the available profit before accepting the payout request.
//
// FIX 2: All four flag-check queries are now batched into a single SQL query
// instead of four sequential round-trips.
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
router.post('/request', payoutRequestLimiter, authenticateToken, async function(req, res) {
  try {
    const { account_id, amount_requested, payment_method, payment_details } = req.body

    if (!account_id || !amount_requested || !payment_method || !payment_details) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    const accountIdStr = String(account_id || '').trim()
    if (!accountIdStr || false) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const amountNum = parseFloat(amount_requested)
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: 'Invalid amount requested' })
    }

    const paymentDetailsStr = typeof payment_details === 'object'
      ? JSON.stringify(payment_details)
      : String(payment_details).trim()

    if (!paymentDetailsStr) {
      return res.status(400).json({ error: 'Payment details are required' })
    }

    if (amountNum < 50) {
      return res.status(400).json({ error: 'Minimum payout request is $50' })
    }

    // FIX (Bug 3): Wrap the entire payout request in a transaction with
    // FOR UPDATE on the account row to prevent double-payout race condition.
    // Two concurrent requests will serialise at the lock Ã¢â‚¬â€ the second will
    // see the first's INSERT when it runs its pending-payout check.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Lock the account row for this transaction
      const account = await client.query(
        `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
                peak_balance, status, created_at
         FROM accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [accountIdStr, req.user.userId]
      )

      if (account.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Account not found' })
      }

      const acc = account.rows[0]

      if (acc.account_type !== 'funded') {
        await client.query('ROLLBACK')
        return res.status(403).json({ error: 'Payouts are only available for funded accounts' })
      }

      // FIX: KYC must be approved before payout
      const userKyc = await client.query(
        `SELECT kyc_status FROM users WHERE id = $1`,
        [req.user.userId]
      )
      if (userKyc.rows.length === 0 || userKyc.rows[0].kyc_status !== 'approved') {
        await client.query('ROLLBACK')
        return res.status(403).json({ error: 'Your identity verification (KYC) must be approved before requesting a payout. Please complete verification first.' })
      }

      if (acc.status !== 'active') {
        await client.query('ROLLBACK')
        return res.status(403).json({ error: 'Account is not active' })
      }

      // FIX (BUG-H4): The old code calculated floatingPnl in a loop but then
      // immediately did ROLLBACK + early-return if ANY open trades existed.
      // That meant floatingPnl was ALWAYS 0 when used below — dead code.
      // Simplified: just count open/pending trades and error out immediately.
      // Profit is purely realized (current_balance - starting_balance) since
      // all trades must be closed before a payout can be requested.
      const openTradeCount = await client.query(
        `SELECT COUNT(*) FROM trades
         WHERE account_id = $1 AND status IN ('open', 'pending')`,
        [accountIdStr]
      )
      if (parseInt(openTradeCount.rows[0].count) > 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'You must close all open trades and cancel pending orders before requesting a payout.' })
      }

      const realizedProfit = parseFloat(acc.current_balance) - parseFloat(acc.starting_balance)

      if (realizedProfit <= 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'No profit available to withdraw' })
      }

      if (amountNum > realizedProfit) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Maximum withdrawable amount is $${realizedProfit.toFixed(2)}`
        })
      }

      // Check no pending payout already exists (inside transaction Ã¢â‚¬â€ serialised)
      const existing = await client.query(
        `SELECT id FROM payouts WHERE account_id = $1 AND status = 'pending'`,
        [accountIdStr]
      )

      if (existing.rows.length > 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'You already have a pending payout request' })
      }

      const settingsResult = await client.query(
        `SELECT value FROM platform_settings WHERE key = 'profit_share_pct'`
      )
      if (settingsResult.rows.length === 0) {
        logger.warn('[PAYOUTS] profit_share_pct not found in platform_settings â€" defaulting to 80%.')
      }
      const profitSharePct = settingsResult.rows.length > 0
        ? parseFloat(settingsResult.rows[0].value) / 100
        : 0.80

      const amount_payable = parseFloat((amountNum * profitSharePct).toFixed(2))

      // Ã¢â€â‚¬Ã¢â€â‚¬ Flag checks Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      let is_flagged = false
      const flagReasons = []

      try {
        const flagResult = await client.query(
          `SELECT
             EXTRACT(EPOCH FROM (NOW() - a.created_at))/86400  AS account_age_days,
             COUNT(t.id) FILTER (WHERE t.status = 'closed')                   AS total_closed_trades,
             COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)  AS winning_trades,
             COALESCE(MAX(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)     AS max_single_trade_pnl,
             COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)     AS total_realised_pnl
           FROM accounts a
           LEFT JOIN trades t ON t.account_id = a.id
           WHERE a.id = $1
           GROUP BY a.id, a.created_at`,
          [accountIdStr]
        )

        const fd = flagResult.rows[0]
        const accountAgeDays  = parseFloat(fd.account_age_days || 999)
        const winningTrades   = parseInt(fd.winning_trades || 0)
        const totalClosedTrades = parseInt(fd.total_closed_trades || 0)
        const maxTradePnl     = parseFloat(fd.max_single_trade_pnl || 0)
        const totalRealisedPnl = parseFloat(fd.total_realised_pnl || 0)
        const accountSize     = parseFloat(acc.account_size)

        // Enhanced flag detection - harder to game
        if (accountAgeDays < 5) {
          is_flagged = true
          flagReasons.push(`Funded account only ${accountAgeDays.toFixed(1)} days old (min 5 days)`)
        }
        if (winningTrades < 5) {
          is_flagged = true
          flagReasons.push(`Only ${winningTrades} winning trade(s) on this account (min 5)`)
        }
        if (amountNum > accountSize * 0.40) {
          is_flagged = true
          flagReasons.push(`Payout ${amountNum} is >40% of account size ${accountSize}`)
        }
        if (maxTradePnl > 0 && totalRealisedPnl > 0 && (maxTradePnl / totalRealisedPnl) > 0.50) {
          is_flagged = true
          flagReasons.push(`Single trade (${maxTradePnl.toFixed(2)}) made up ${((maxTradePnl / totalRealisedPnl) * 100).toFixed(0)}% of total profit (>50%)`)
        }
        // Additional flag: check for consistent profitability
        const avgWinningTradePnl = winningTrades > 0 ? (totalRealisedPnl / winningTrades) : 0
        if (winningTrades >= 3 && avgWinningTradePnl > accountSize * 0.15) {
          is_flagged = true
          flagReasons.push(`Average winning trade ${avgWinningTradePnl.toFixed(2)} exceeds 15% of account size`)
        }
        // Additional flag: check for high win rate with small sample
        if (totalClosedTrades > 0 && totalClosedTrades < 10 && winningTrades / totalClosedTrades > 0.85) {
          is_flagged = true
          flagReasons.push(`Win rate >85% with <10 trades may indicate lucky/gaming behavior`)
        }

        if (is_flagged) {
          logger.warn(`[payouts] Flagged payout from user ${req.user.userId}: ${flagReasons.join(' | ')}`)
        }
      } catch (flagErr) {
        logger.error('[payouts] Flag check error:', { error: flagErr.message })
      }

      const payout = await client.query(
        `INSERT INTO payouts
         (user_id, account_id, amount_requested, amount_payable, payment_method, payment_details, status, is_flagged, flag_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING *`,
        [req.user.userId, accountIdStr, amountNum, amount_payable, payment_method, paymentDetailsStr, is_flagged, flagReasons.join(' | ') || null]
      )

      await client.query('COMMIT')

      res.status(201).json({
        message: 'Payout request submitted successfully',
        payout: payout.rows[0]
      })
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

  } catch (error) {
    logger.error('Payout request error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit payout request' })
  }
})

// GET /api/payouts/my-payouts
router.get('/my-payouts', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT p.*, a.account_type, a.account_size, a.account_uid
       FROM payouts p
       JOIN accounts a ON p.account_id = a.id
       WHERE p.user_id = $1
       ORDER BY p.requested_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Get payouts error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch payouts' })
  }
})

// GET /api/payouts/settings
router.get('/settings', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT key, value FROM platform_settings WHERE key = 'profit_share_pct'`
    )
    const profit_share_pct = result.rows.length > 0
      ? parseFloat(result.rows[0].value)
      : 80
    res.json({ profit_share_pct })
  } catch (error) {
    logger.error('Payout settings error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch payout settings' })
  }
})

module.exports = router
