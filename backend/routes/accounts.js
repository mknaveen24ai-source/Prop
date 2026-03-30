const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')

const VALID_SIZES = [1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000, 200000]

function quotaKey(size) {
  return `quota_${size}`
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/available-sizes
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/available-sizes', async function(req, res) {
  try {
    const settingsResult = await pool.query('SELECT key, value FROM platform_settings')
    const settings = {}
    settingsResult.rows.forEach(row => { settings[row.key] = row.value })

    const periodStart = settings.max_accounts_period_start
    const periodEnd   = settings.max_accounts_period_end

    const sizes = await Promise.all(VALID_SIZES.map(async (size) => {
      const key   = quotaKey(size)
      const quota = settings[key] !== undefined ? parseInt(settings[key]) : null

      if (quota === null || quota === 0) {
        return { size, quota: 0, used: 0, remaining: 0, locked: true, reason: 'This account size is currently unavailable.' }
      }

      let used = 0
      if (periodStart && periodEnd) {
        const r = await pool.query(
          `SELECT COUNT(*) FROM accounts
           WHERE account_size = $1
             AND created_at >= $2::date
             AND created_at < ($3::date + INTERVAL '1 day')`,
          [size, periodStart, periodEnd]
        )
        used = parseInt(r.rows[0].count)
      } else {
        const r = await pool.query(
          `SELECT COUNT(*) FROM accounts
           WHERE account_size = $1
             AND status IN ('active', 'passed', 'funded')`,
          [size]
        )
        used = parseInt(r.rows[0].count)
      }

      const unlimited = quota >= 999999
      const remaining = unlimited ? null : Math.max(0, quota - used)
      const locked    = !unlimited && remaining === 0

      return {
        size,
        quota:     unlimited ? null : quota,
        used,
        remaining,
        locked,
        reason: locked ? `All ${quota} slots for the $${size.toLocaleString()} account are filled for this period.` : null
      }
    }))

    res.json(sizes)
  } catch (error) {
    logger.error('Available sizes error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch available sizes' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/platform-rules
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/platform-rules', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT key, value FROM platform_settings
       WHERE key IN (
         'phase1_profit_target_pct', 'phase1_max_drawdown_pct', 'phase1_day_limit',
         'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
         'funded_max_drawdown_pct', 'profit_share_pct'
       )`
    )
    const rules = {}
    result.rows.forEach(row => { rules[row.key] = parseFloat(row.value) })
    res.json(rules)
  } catch (error) {
    logger.error('Platform rules error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch platform rules' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/accounts/create
//
// FIX: The quota check and active-account check were two separate queries with
// no lock between them. Two simultaneous requests could both pass both checks
// and both insert â€” a classic TOCTOU race. Fixed by wrapping the entire
// creation flow in a transaction with an advisory lock keyed on (user_id, size)
// so concurrent requests for the same user+size are serialised.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/create', authenticateToken, async function(req, res) {
  const client = await pool.connect()
  try {
    const account_size = parseInt(req.body.account_size)

    if (isNaN(account_size) || !VALID_SIZES.includes(account_size)) {
      return res.status(400).json({
        error: `Invalid account size. Choose one of: $${VALID_SIZES.map(s => s.toLocaleString()).join(', $')}`
      })
    }

    await client.query('BEGIN')

    // FIX (BUG-H6): The original single-key advisory lock used JavaScript bitwise
    // shift (<<) which operates on 32-bit signed integers. For user IDs > 2047
    // (2^11), `userId << 20` overflows and wraps around, causing two different
    // users to potentially share the same lock key.
    // Use two-argument pg_advisory_xact_lock(int4, int4): user_id and account_size
    // are passed as separate parameters. Both fit safely in int4 (max 2,147,483,647).
    await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [
      parseInt(req.user.userId),
      account_size
    ])

    // All reads happen inside the transaction after the lock, so no other
    // request for this user can read-then-insert between our checks.

    const userResult = await client.query(
      'SELECT id, kyc_status FROM users WHERE id = $1',
      [req.user.userId]
    )
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }
    if (userResult.rows[0].kyc_status !== 'approved') {
      await client.query('ROLLBACK')
      return res.status(403).json({ error: 'KYC approval required before starting a challenge' })
    }

    const settingsResult = await client.query('SELECT key, value FROM platform_settings')
    const settings = {}
    settingsResult.rows.forEach(row => { settings[row.key] = row.value })

    const maxPerUser            = parseInt(settings.max_accounts_per_user     || '999999')
    const phase1ProfitTargetPct = parseFloat(settings.phase1_profit_target_pct || '10')
    const phase1MaxDrawdownPct  = parseFloat(settings.phase1_max_drawdown_pct  || '10')
    const phase1DayLimit        = parseInt(settings.phase1_day_limit           || '30')

    if (isNaN(phase1ProfitTargetPct) || isNaN(phase1MaxDrawdownPct) || isNaN(phase1DayLimit)) {
      await client.query('ROLLBACK')
      logger.error('Platform configuration error - invalid settings')
      return res.status(500).json({ error: 'Platform configuration error. Contact support.' })
    }

    // â”€â”€ Quota check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const key   = quotaKey(account_size)
    const quota = settings[key] !== undefined ? parseInt(settings[key]) : null

    if (quota === null || quota === 0) {
      await client.query('ROLLBACK')
      return res.status(403).json({
        error: `The $${account_size.toLocaleString()} account size is currently locked by the administrator.`,
        locked: true
      })
    }

    if (quota < 999999) {
      const periodStart = settings.max_accounts_period_start
      const periodEnd   = settings.max_accounts_period_end
      let usedCount = 0

      if (periodStart && periodEnd) {
        const r = await client.query(
          `SELECT COUNT(*) FROM accounts
           WHERE account_size = $1
             AND created_at >= $2::date
             AND created_at < ($3::date + INTERVAL '1 day')`,
          [account_size, periodStart, periodEnd]
        )
        usedCount = parseInt(r.rows[0].count)
      } else {
        const r = await client.query(
          `SELECT COUNT(*) FROM accounts
           WHERE account_size = $1
             AND status IN ('active', 'passed', 'funded')`,
          [account_size]
        )
        usedCount = parseInt(r.rows[0].count)
      }

      if (usedCount >= quota) {
        await client.query('ROLLBACK')
        const nextMonth = new Date()
        nextMonth.setDate(1)
        nextMonth.setMonth(nextMonth.getMonth() + 1)
        const nextMonthStr = nextMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })

        return res.status(403).json({
          error: `All ${quota} slots for the $${account_size.toLocaleString()} account are filled for this period. New slots open ${nextMonthStr}.`,
          quota_full: true,
          next_open:  nextMonth.toISOString().split('T')[0]
        })
      }
    }

    // â”€â”€ Per-user active account limit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // This check is now inside the transaction + advisory lock, so two
    // simultaneous requests cannot both pass it and both insert.
    const userActiveResult = await client.query(
      `SELECT COUNT(*) FROM accounts
       WHERE user_id = $1
         AND status = 'active'
         AND account_type IN ('phase1', 'phase2', 'funded')`,
      [req.user.userId]
    )
    if (parseInt(userActiveResult.rows[0].count) >= maxPerUser) {
      await client.query('ROLLBACK')
      return res.status(403).json({
        error: 'You already have an active challenge running. Complete or wait for it to finish before starting a new one.'
      })
    }

    // â”€â”€ Create the account â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const profit_target  = account_size * (phase1ProfitTargetPct / 100)
    const account_uid    = uuidv4()

    // Phase end date in UTC to avoid timezone off-by-one
    const phase_end_date = new Date()
    phase_end_date.setUTCDate(phase_end_date.getUTCDate() + phase1DayLimit)
    phase_end_date.setUTCHours(23, 59, 59, 999)

    const newAccount = await client.query(
      `INSERT INTO accounts
       (user_id, account_type, account_size, current_balance, starting_balance, peak_balance,
        profit_target, max_drawdown_pct, status, phase_start_date, phase_end_date, account_uid)
       VALUES ($1, 'phase1', $2, $2, $2, $2, $3, $4, 'active', NOW(), $5, $6)
       RETURNING *`,
      [req.user.userId, account_size, profit_target, phase1MaxDrawdownPct, phase_end_date, account_uid]
    )

    await client.query('COMMIT')

    logger.info(
      `Phase 1 created for user ${req.user.userId}: $${account_size} ` +
      `| target: ${phase1ProfitTargetPct}% ($${profit_target}) ` +
      `| max DD: ${phase1MaxDrawdownPct}% | days: ${phase1DayLimit}`
    )

    const account = newAccount.rows[0]
    res.status(201).json({
      message: 'Phase 1 challenge account created successfully',
      account_id:  account.id,
      account_uid: account.account_uid,
      account
    })

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Create account error:', { error: error.message })
    res.status(500).json({ error: 'Could not create account' })
  } finally {
    client.release()
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/my-accounts
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/my-accounts', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, created_at,
              phase_start_date, phase_end_date, account_uid, updated_at
       FROM accounts WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Fetch accounts error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch accounts' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/history
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/history', authenticateToken, async function(req, res) {
  try {
    const accountsResult = await pool.query(
      `SELECT a.*,
         COUNT(t.id) FILTER (WHERE t.status = 'closed') as total_trades,
         COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0) as total_pnl,
         COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0) as winning_trades
       FROM accounts a
       LEFT JOIN trades t ON t.account_id = a.id
       WHERE a.user_id = $1
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
      [req.user.userId]
    )
    res.json(accountsResult.rows)
  } catch (error) {
    logger.error('Account history error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch account history' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/stats/:account_id
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/stats/:account_id', authenticateToken, async function(req, res) {
  try {
    const account_id = req.params.account_id

    const accountIdStr = String(account_id || '').trim()
    if (!accountIdStr || false) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const result = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, phase_end_date
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountIdStr, req.user.userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const account  = result.rows[0]
    const starting = parseFloat(account.starting_balance)
    const current  = parseFloat(account.current_balance)
    const peak     = parseFloat(account.peak_balance)

    const profit_pct   = starting > 0
      ? parseFloat(((current - starting) / starting * 100).toFixed(2))
      : 0

    const drawdown_pct = peak > 0
      ? parseFloat(((peak - current) / peak * 100).toFixed(2))
      : 0

    // UTC-based days remaining â€” consistent across all timezones
    let days_remaining = null
    if (account.phase_end_date) {
      const nowMs  = Date.now()
      const endMs  = new Date(account.phase_end_date).getTime()
      days_remaining = Math.max(0, Math.ceil((endMs - nowMs) / (1000 * 60 * 60 * 24)))
    }

    res.json({
      account,
      stats: {
        profit_pct,
        drawdown_pct: Math.max(0, drawdown_pct),
        days_remaining
      }
    })

  } catch (error) {
    logger.error('Stats error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch stats' })
  }
})

module.exports = router
