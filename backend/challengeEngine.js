// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
const pool = require('./db')
const Decimal = require('decimal.js')
const logger = require('./utils/logger')
const { CONTRACT_SIZES } = require('./constants')
require('./loadEnv')
const { getCurrentPricesForTenant } = require('./priceFeed')
const { fetchProgressionSettings, promotePassedAccount } = require('./services/progressionService')
const { sendPhasePassedEmail, sendAccountFailedEmail, sendAccountExpiredEmail } = require('./mailer')
const { getTenantById } = require('./utils/tenants')
const { getTenantSettings } = require('./services/tenantPolicyService')
const {
  applyAccountEnforcement,
  recordEnforcementEvent,
  recordViolation
} = require('./services/violationEngine')

let reviewFlagColumnsReady = false

// FIX (AUDIT): Per-account warning level cache to prevent flooding the client
// socket with duplicate drawdown_warning events on every engine cycle.
// Key: accountId (string), Value: last emitted warningLevel (number)
const _lastDrawdownWarningLevel = new Map()

async function safeRecordViolation(payload) {
  try {
    await recordViolation(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record violation:', { error: err.message, type: payload?.violationType })
  }
}

async function safeRecordEnforcement(payload) {
  try {
    await recordEnforcementEvent(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record enforcement event:', { error: err.message, action: payload?.action })
  }
}

async function fetchChallengeAutomationSettings(tenantId = null) {
  const settings = await getTenantSettings(tenantId, ['inactivity_auto_fail_enabled', 'inactivity_fail_days'])
  return {
    inactivity_auto_fail_enabled: settings.inactivity_auto_fail_enabled !== 'false',
    inactivity_fail_days: parseInt(settings.inactivity_fail_days || '30', 10)
  }
}

async function getLastTradeActivityAt(accountId, fallbackDate) {
  const result = await pool.query(
    `SELECT NULLIF(MAX(GREATEST(COALESCE(open_time, '-infinity'::timestamptz), COALESCE(close_time, '-infinity'::timestamptz))), '-infinity'::timestamptz) AS last_activity_at
     FROM trades
     WHERE account_id = $1`,
    [accountId]
  )
  return result.rows[0]?.last_activity_at || fallbackDate || null
}

async function getLivePrice(instrument) {
  const result = await pool.query(
    'SELECT bid, ask FROM price_feed WHERE instrument = $1',
    [instrument]
  )
  if (result.rows.length === 0) return null
  return result.rows[0]
}

async function incrementBbookMetric(client, tenantId, column) {
  const safeColumn = ['accounts_expired', 'accounts_failed', 'accounts_passed', 'new_funded'].includes(column)
    ? column
    : null
  if (!safeColumn) {
    throw new Error(`Unsupported bbook metric: ${column}`)
  }

  await client.query(
    `INSERT INTO bbook_pnl (tenant_id, date, ${safeColumn})
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (tenant_id, date) DO UPDATE
     SET ${safeColumn} = bbook_pnl.${safeColumn} + 1`,
    [tenantId || 1]
  )
}

function calculatePnL(direction, open_price, close_price, lots, instrument, commission = 0) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy' 
    ? new Decimal(close_price).minus(open_price) 
    : new Decimal(open_price).minus(close_price)
  return priceDiff.times(lots).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

// ─────────────────────────────────────────────────────────────────────────────
// expireAccount — marks account expired, force-closes all open trades.
// FIX: Now wrapped in a transaction with FOR UPDATE SKIP LOCKED to prevent
// data inconsistency if the server crashes mid-operation.
// ─────────────────────────────────────────────────────────────────────────────
async function expireAccount(acc, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    await client.query(`UPDATE accounts SET status = 'expired' WHERE id = $1`, [acc.id])

    const openTrades = await client.query(
      `SELECT * FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )

    const priceMap = await getCurrentPricesForTenant(acc.tenant_id || 1)

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (priceData) {
          const close_price = trade.direction === 'buy'
            ? parseFloat(priceData.bid)
            : parseFloat(priceData.ask)

          const demo_pnl = calculatePnL(
            trade.direction, parseFloat(trade.open_price),
            close_price, parseFloat(trade.lot_size), trade.instrument,
            parseFloat(trade.commission || 0)
          )
          totalPnlDec = totalPnlDec.plus(demo_pnl)

          await client.query(
            `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(),
               demo_pnl = $2, close_reason = 'Account Expired' WHERE id = $3`,
            [close_price, demo_pnl, trade.id]
          )
        } else {
          await client.query(
            `UPDATE trades SET status = 'closed', close_time = NOW(),
               demo_pnl = 0, close_reason = 'Account Expired' WHERE id = $1`,
            [trade.id]
          )
        }
      } catch (tradeError) {
        logger.error(`Error closing trade ${trade.id} on expiry:`, { error: tradeError.message })
      }
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET current_balance = current_balance + $1,
           peak_balance = GREATEST(peak_balance, current_balance + $1) WHERE id = $2`,
        [totalPnl, acc.id]
      )
    }

    await client.query(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(),
         close_reason = 'Account Expired' WHERE account_id = $1 AND status = 'pending'`,
      [acc.id]
    )

    await incrementBbookMetric(client, acc.tenant_id, 'accounts_expired')

    await client.query('COMMIT')

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event: 'account_expired',
        account_id: acc.id,
        message: `⏰ Challenge EXPIRED — the time limit was reached before the profit target. All trades have been closed.`,
      })
    }

    try {
      const userResult = await pool.query('SELECT email, full_name, tenant_id FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name, tenant_id } = userResult.rows[0]
        const tenant = await getTenantById(tenant_id)
        sendAccountExpiredEmail(email, full_name, acc.account_type, acc.account_size, { tenant }).catch(() => {})
      }
    } catch (emailErr) {
      logger.error('[mail] expireAccount email lookup failed:', { error: emailErr.message })
    }

    logger.info(`Account ${acc.id} EXPIRED — phase_end_date reached`)
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`expireAccount error for account ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// failAccount — marks account failed, force-closes all open trades at live
// prices, and cancels all pending orders.
// Uses FOR UPDATE SKIP LOCKED to prevent double-processing with the floating
// drawdown checker in trades.js.
// ─────────────────────────────────────────────────────────────────────────────
async function failAccount(acc, reason, io, platformSettings = null, options = {}) {
  const client = await pool.connect()
  try {
    const closeReason = options.closeReason || 'Account Failed'
    const skipDrawdownCheck = !!options.skipDrawdownCheck
    const violationType = options.violationType || 'drawdown_breach'
    const enforcementAction = options.enforcementAction || 'auto_fail_account'
    const socketEvent = options.socketEvent || 'account_failed'
    const extraPayload = options.payload || {}

    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT * FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }


    acc = lockResult.rows[0]
    const drawdownBase = new Decimal(acc.starting_balance)
    const currentBalance = new Decimal(acc.current_balance)
    const maxDrawdownPct = acc.account_type === 'funded' && platformSettings
      ? new Decimal(platformSettings.funded_max_drawdown_pct)
      : new Decimal(acc.max_drawdown_pct)
    let realisedDrawdownPct = new Decimal(0)
    if (!skipDrawdownCheck) {
      if (drawdownBase.lte(0)) {
        await client.query('ROLLBACK')
        return
      }
      realisedDrawdownPct = drawdownBase.minus(currentBalance).div(drawdownBase).times(100)
      if (realisedDrawdownPct.lt(maxDrawdownPct)) {
        await client.query('ROLLBACK')
        return
      }
    }

    const openTrades = await client.query(
      `SELECT * FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )

    const priceMap = await getCurrentPricesForTenant(acc.tenant_id || 1)

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (!priceData) {
          await client.query(
            `UPDATE trades SET
               status = 'closed',
               close_price = open_price,
               close_time = NOW(),
               demo_pnl = 0,
               close_reason = $2
             WHERE id = $1`,
            [trade.id, closeReason]
          )
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

        totalPnlDec = totalPnlDec.plus(demo_pnl)

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
          [close_price, demo_pnl, closeReason, trade.id]
        )
      } catch (tradeErr) {
        logger.error(`failAccount: error closing trade ${trade.id}:`, { error: tradeErr.message })
      }
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [totalPnl, acc.id]
      )
    }

    await client.query(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = $2
       WHERE account_id = $1 AND status = 'pending'`,
      [acc.id, closeReason]
    )

    await client.query(`UPDATE accounts SET status = 'failed' WHERE id = $1`, [acc.id])

    await incrementBbookMetric(client, acc.tenant_id, 'accounts_failed')

    await client.query('COMMIT')

    await safeRecordViolation({
      tenantId: acc.tenant_id,
      violationType,
      severity: 'critical',
      accountId: acc.id,
      userId: acc.user_id,
      source: 'challenge_engine',
      message: reason,
      payload: {
        account_type: acc.account_type,
        realised_drawdown_pct: parseFloat(realisedDrawdownPct.toFixed(2)),
        max_drawdown_pct: parseFloat(maxDrawdownPct.toFixed(2)),
        auto_status: 'failed',
        ...extraPayload
      }
    })

    await safeRecordEnforcement({
      tenantId: acc.tenant_id,
      accountId: acc.id,
      userId: acc.user_id,
      action: enforcementAction,
      status: 'applied',
      message: `Account failed automatically: ${reason}`,
      payload: {
        account_type: acc.account_type,
        realised_drawdown_pct: parseFloat(realisedDrawdownPct.toFixed(2)),
        max_drawdown_pct: parseFloat(maxDrawdownPct.toFixed(2)),
        ...extraPayload
      }
    })

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event:      socketEvent,
        account_id: acc.id,
        message:    `❌ Account FAILED — ${reason}. All trades have been closed.`
      })
    }

    try {
      const userResult = await pool.query('SELECT email, full_name, tenant_id FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name, tenant_id } = userResult.rows[0]
        const tenant = await getTenantById(tenant_id)
        sendAccountFailedEmail(email, full_name, acc.account_type, reason, acc.account_size, { tenant }).catch(() => {})
      }
    } catch (emailErr) {
      logger.error('[mail] failAccount email lookup failed:', { error: emailErr.message })
    }

    logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}. ${openTrades.rows.length} trade(s) force-closed.`)
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`failAccount error for ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// passAccount — marks account passed and creates next phase account.
// Uses FOR UPDATE SKIP LOCKED to prevent double-processing.
// ─────────────────────────────────────────────────────────────────────────────
async function passAccount(acc, platformSettings, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT * FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    acc = lockResult.rows[0]

    const startingBalance = new Decimal(acc.starting_balance)
    let profitTarget = new Decimal(acc.profit_target || 0)
    if (profitTarget.lte(0)) {
      profitTarget = startingBalance.times(0.10)
    }
    const realisedProfit = new Decimal(acc.current_balance).minus(startingBalance)
    if (realisedProfit.lt(profitTarget)) {
      await client.query('ROLLBACK')
      return
    }

    const openTradesResult = await client.query(
      `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )
    if (parseInt(openTradesResult.rows[0].count) > 0) {
      await client.query('ROLLBACK')
      return
    }

    await client.query(
      `UPDATE accounts SET status = 'passed' WHERE id = $1`,
      [acc.id]
    )

    const promoted = await promotePassedAccount(client, acc, platformSettings)
    if (!promoted) {
      throw new Error('Failed to create promoted account')
    }

    await client.query('COMMIT')

    if (io && promoted) {
      const passMsg = acc.account_type === 'phase1'
        ? `🏆 Phase 1 PASSED! Profit target reached. Phase 2 is now active.`
        : `🎉 Phase 2 PASSED! You are now a Funded Trader. Welcome to the team!`

      io.to(String(acc.user_id)).emit('account_update', {
        event:          promoted.event,
        account_id:     acc.id,
        new_account_id: promoted.new_account_id,
        message:        passMsg
      })
    }

    logger.info(`Challenge engine: account ${acc.id} PASSED (${acc.account_type})`)

    try {
      const userResult = await pool.query('SELECT email, full_name, tenant_id FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name, tenant_id } = userResult.rows[0]
        const tenant = await getTenantById(tenant_id)
        sendPhasePassedEmail(email, full_name, acc.account_type, acc.account_size, { tenant }).catch(() => {})
      }
    } catch (emailErr) {
      logger.error('[mail] passAccount email lookup failed:', { error: emailErr.message })
    }
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`passAccount error for ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// processAccount — handles drawdown checks, expiry, and profit target.
// Funded accounts use funded_max_drawdown_pct from platform settings.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: For financial calculations, use Decimal to avoid floating point errors:
//   const pnl = new Decimal(priceDiff).times(lots).times(contractSize)
//   const balance = new Decimal(oldBalance).plus(pnl)
// Always convert back with .toNumber() or .toFixed(2) for storage

async function processAccount(acc, platformSettings, io) {
  const now = new Date()

  // Only phase1/phase2 have time limits — funded accounts have no expiry
  if (acc.account_type !== 'funded' && acc.phase_end_date && new Date(acc.phase_end_date) <= now) {
    logger.info(`Challenge engine: account ${acc.id} has expired (phase_end_date: ${acc.phase_end_date})`)
    await expireAccount(acc, io)
    return
  }

  if (
    acc.account_type !== 'funded' &&
    platformSettings.inactivity_auto_fail_enabled &&
    platformSettings.inactivity_fail_days > 0
  ) {
    const fallbackDate = acc.phase_start_date || acc.created_at || now
    const lastActivityAt = await getLastTradeActivityAt(acc.id, fallbackDate)
    if (lastActivityAt) {
      const inactiveForMs = now.getTime() - new Date(lastActivityAt).getTime()
      const inactivityLimitMs = platformSettings.inactivity_fail_days * 24 * 60 * 60 * 1000
      if (inactiveForMs >= inactivityLimitMs) {
        const reason = `no trade activity for ${platformSettings.inactivity_fail_days} days`
        logger.info(`Challenge engine: account ${acc.id} FAILED â€” ${reason}`)
        await failAccount(acc, reason, io, platformSettings, {
          skipDrawdownCheck: true,
          closeReason: 'Inactivity Auto-Fail',
          violationType: 'inactivity_auto_fail',
          enforcementAction: 'auto_fail_inactive_account',
          payload: {
            inactivity_fail_days: platformSettings.inactivity_fail_days,
            last_activity_at: new Date(lastActivityAt).toISOString()
          }
        })
        return
      }
    }
  }

  const current_balance  = new Decimal(acc.current_balance)
  const starting_balance = new Decimal(acc.starting_balance)

  const max_drawdown_pct = new Decimal(acc.account_type === 'funded'
    ? platformSettings.funded_max_drawdown_pct
    : acc.max_drawdown_pct)

  const drawdownBase = starting_balance

  if (drawdownBase.gt(0)) {
    const realised_drawdown_pct = drawdownBase.minus(current_balance).div(drawdownBase).times(100)

    if (io && realised_drawdown_pct.gt(0)) {
      const pctOfLimit = realised_drawdown_pct.div(max_drawdown_pct).times(100).toNumber()
      let warningLevel = null

      // More granular warning levels: 25%, 50%, 75%, 90%
      if (pctOfLimit >= 90 && pctOfLimit < 100) warningLevel = 90
      else if (pctOfLimit >= 75 && pctOfLimit < 90) warningLevel = 75
      else if (pctOfLimit >= 50 && pctOfLimit < 75) warningLevel = 50
      else if (pctOfLimit >= 25 && pctOfLimit < 50) warningLevel = 25

      // FIX (AUDIT): Only emit when warningLevel changes — prevents flooding
      // the client with thousands of identical events per hour.
      const prevLevel = _lastDrawdownWarningLevel.get(String(acc.id))
      if (warningLevel && warningLevel !== prevLevel) {
        _lastDrawdownWarningLevel.set(String(acc.id), warningLevel)
        io.to(String(acc.user_id)).emit('drawdown_warning', {
          account_id:            acc.id,
          warning_level:         warningLevel,
          realised_drawdown_pct: parseFloat(realised_drawdown_pct.toFixed(2)),
          max_drawdown_pct: max_drawdown_pct.toNumber(),
          message: warningLevel === 90
            ? `🚨 CRITICAL: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Account will fail if drawdown reaches ${max_drawdown_pct.toFixed(2)}%.`
            : warningLevel === 75
            ? `⚠️ WARNING: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Reduce your exposure.`
            : warningLevel === 50
            ? `📊 NOTICE: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Consider reducing position sizes.`
            : `ℹ️  INFO: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Monitor your positions.`
        })
      }
    }

    if (realised_drawdown_pct.gte(max_drawdown_pct)) {
      const reason = `max drawdown ${realised_drawdown_pct.toFixed(2)}% reached ${max_drawdown_pct.toFixed(2)}% limit`
      logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}`)
      await failAccount(acc, reason, io, platformSettings)
      return
    }
  }

  // Funded accounts have no profit target to pass — only drawdown to fail on
  if (acc.account_type === 'funded') return

  let profit_target = new Decimal(acc.profit_target || 0)
  if (profit_target.lte(0)) {
    profit_target = starting_balance.times(0.10)
  }

  const realised_profit = current_balance.minus(starting_balance)
  if (realised_profit.gte(profit_target)) {
    const openTradesResult = await pool.query(
      `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )
    const openCount = parseInt(openTradesResult.rows[0].count)

    if (openCount === 0) {
      logger.info(`Challenge engine: account ${acc.id} hit profit target (${realised_profit.toFixed(2)}) — passing`)
      await passAccount(acc, platformSettings, io)
    }
  }
}

async function runChallengeEngine(io) {
  try {
    const activeAccounts = await pool.query(
      `SELECT * FROM accounts
       WHERE status = 'active'
       AND account_type IN ('phase1', 'phase2', 'funded')`
    )

    if (activeAccounts.rows.length === 0) return

    const settingsCache = new Map()

    for (const acc of activeAccounts.rows) {
      try {
        const tenantKey = String(acc.tenant_id || 1)
        if (!settingsCache.has(tenantKey)) {
          const [progressionSettings, automationSettings] = await Promise.all([
            fetchProgressionSettings(pool, acc.tenant_id),
            fetchChallengeAutomationSettings(acc.tenant_id)
          ])
          settingsCache.set(tenantKey, { ...progressionSettings, ...automationSettings })
        }
        const platformSettings = settingsCache.get(tenantKey)
        await processAccount(acc, platformSettings, io)
      } catch (accErr) {
        logger.error(`Challenge engine error for account ${acc.id}:`, { error: accErr.message })
      }
    }

    // FIX (BUG-6): detectRapidOpposingTrades must run BEFORE detectOpposingTrades.
    // detectOpposingTrades sets matching accounts to status='locked'. The rapid
    // check queries WHERE status='active' — running it afterwards always found 0
    // results because the accounts were already locked. Swapping the order ensures
    // both functions operate on still-active accounts.

    // ── Rapid opposing trade detection (must run first — needs active accounts) ─
    try {
      await detectRapidOpposingTradesGlobal()
    } catch (rapidErr) {
      logger.error('[rapid_opposing] Detection error:', { error: rapidErr.message })
    }

    // ── Cross-account opposing trade detection (locks accounts) ────────────────
    try {
      await detectOpposingTrades(io)
    } catch (oppErr) {
      logger.error('[opposing_trades] Detection error:', { error: oppErr.message })
    }

    // ── IP-based multi-account detection ───────────────────────────────────────
    try {
      await detectIPMultiAccounts()
    } catch (ipErr) {
      logger.error('[ip_detection] Detection error:', { error: ipErr.message })
    }

  } catch (error) {
    logger.error('runChallengeEngine error:', { error: error.message })
  }
}

// ── Cross-account opposing trade detector ──────────────────────────────────────
// FIX (LOOPHOLE 3): Now auto-locks flagged accounts instead of just flagging.

// Detect rapid open/close opposing trades (gaming the system)
async function detectRapidOpposingTrades(userId, instrument, accountIds, io) {
  try {
    // FIX (BUG-H5): Corrected three wrong column names:
    //  1. `t.user_id`     → `a.user_id`  (user_id is on accounts, not trades)
    //  2. `t.closed_at`   → `t.close_time` (actual column name in trades table)
    //  3. `buy.opened_at` / `sell.opened_at` → `buy.open_time` / `sell.open_time`
    const recentTrades = await pool.query(`
      SELECT t.*, a.user_id, a.id as acc_id
      FROM trades t
      JOIN accounts a ON t.account_id = a.id
      WHERE a.user_id = $1
        AND t.instrument = $2
        AND t.status = 'closed'
        AND t.close_time > NOW() - INTERVAL '24 hours'
      ORDER BY t.close_time DESC
      LIMIT 50
    `, [userId, instrument])

    if (recentTrades.rows.length < 4) return // Need enough trades to analyze

    // Check for opposing directions in recent trades
    const hasBuy = recentTrades.rows.some(t => t.direction === 'buy')
    const hasSell = recentTrades.rows.some(t => t.direction === 'sell')
    
    if (hasBuy && hasSell) {
      // Calculate time between opposing trades using correct column name
      const buys = recentTrades.rows.filter(t => t.direction === 'buy')
      const sells = recentTrades.rows.filter(t => t.direction === 'sell')
      
      let rapidCount = 0
      for (const buy of buys) {
        for (const sell of sells) {
          const timeDiff = Math.abs(new Date(buy.open_time) - new Date(sell.open_time))
          if (timeDiff < 5 * 60 * 1000) { // Within 5 minutes
            rapidCount++
          }
        }
      }
      
      if (rapidCount >= 2) {
        logger.warn(`[rapid_opposing] User ${userId}: ${rapidCount} rapid opposing trades on ${instrument}`)
        const reason = `Rapid opposing trades detected on ${instrument}`
        for (const accountId of accountIds) {
          await safeRecordViolation({
            violationType: 'rapid_opposing_trades',
            severity: 'high',
            accountId,
            userId,
            instrument,
            source: 'challenge_engine',
            message: `${reason} (${rapidCount} rapid matches in 24h)`,
            payload: { rapid_count: rapidCount }
          })

          try {
            await applyAccountEnforcement({
              accountId,
              action: 'flag_for_review',
              reason,
              payload: { instrument, rapid_count: rapidCount }
            })
          } catch (_) {}
        }
      }
    }
  } catch (err) {
    logger.error('[rapid_opposing] Detection error:', { error: err.message })
  }
}

// FIX (BUG-6): Global entry point for rapid opposing trade detection.
// Scans all active users who have recent closed trades in both directions
// on the same instrument, then delegates to the per-user checker.
// Must be called BEFORE detectOpposingTrades so accounts are still 'active'.
async function detectRapidOpposingTradesGlobal() {
  try {
    const result = await pool.query(`
      SELECT a.user_id, t.instrument,
             array_agg(DISTINCT a.id) AS account_ids
      FROM trades t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.status = 'closed'
        AND t.close_time > NOW() - INTERVAL '24 hours'
        AND a.status = 'active'
      GROUP BY a.user_id, t.instrument
      HAVING
        COUNT(t.id) FILTER (WHERE t.direction = 'buy')  > 0
        AND COUNT(t.id) FILTER (WHERE t.direction = 'sell') > 0
    `)
    for (const row of result.rows) {
      await detectRapidOpposingTrades(row.user_id, row.instrument, row.account_ids, null)
    }
  } catch (err) {
    logger.error('[rapid_opposing_global] Scan error:', { error: err.message })
  }
}

async function detectOpposingTrades(io) {
  if (!reviewFlagColumnsReady) {
    try {
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flag_reason TEXT`)
      reviewFlagColumnsReady = true
    } catch (_) {
      return
    }
  }

  const result = await pool.query(`
    SELECT
      a.user_id,
      MIN(a.tenant_id)                                                     AS tenant_id,
      t.instrument,
      COUNT(DISTINCT t.account_id)                                          AS account_count,
      COUNT(t.id) FILTER (WHERE t.direction = 'buy')                       AS buy_count,
      COUNT(t.id) FILTER (WHERE t.direction = 'sell')                      AS sell_count,
      array_agg(DISTINCT a.id)                                             AS account_ids,
      SUM(t.lot_size) FILTER (WHERE t.direction = 'buy')                   AS total_buy_lots,
      SUM(t.lot_size) FILTER (WHERE t.direction = 'sell')                  AS total_sell_lots
    FROM trades t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.status = 'open'
      AND a.status = 'active'
    GROUP BY a.user_id, t.instrument
    HAVING
      COUNT(DISTINCT t.account_id) > 1
      AND COUNT(t.id) FILTER (WHERE t.direction = 'buy') > 0
      AND COUNT(t.id) FILTER (WHERE t.direction = 'sell') > 0
  `)

  if (result.rows.length === 0) return

  for (const row of result.rows) {
    const { user_id, instrument, account_ids, tenant_id } = row

    let alreadyFlagged = false
    try {
      const existing = await pool.query(
        `SELECT id FROM accounts
         WHERE id = ANY($1::uuid[])
           AND review_flagged = true
           AND review_flag_reason ILIKE '%opposing%'`,
        [account_ids]
      )
      alreadyFlagged = existing.rows.length > 0
    } catch (_) {}

    if (alreadyFlagged) continue

    const flagReason = `Cross-account opposing trade detected on ${instrument} — BUY and SELL open simultaneously across ${account_ids.length} accounts`
    for (const accountId of account_ids) {
      await safeRecordViolation({
        tenantId: tenant_id,
        violationType: 'cross_account_opposing_trades',
        severity: 'critical',
        accountId,
        userId: user_id,
        instrument,
        source: 'challenge_engine',
        message: flagReason,
        payload: {
          account_ids,
          buy_lots: parseFloat(row.total_buy_lots || 0),
          sell_lots: parseFloat(row.total_sell_lots || 0)
        }
      })

      try {
        await applyAccountEnforcement({
          accountId,
          action: 'lock_account',
          reason: flagReason,
          payload: {
            instrument,
            account_ids,
            buy_lots: parseFloat(row.total_buy_lots || 0),
            sell_lots: parseFloat(row.total_sell_lots || 0)
          }
        })
      } catch (_) {}
    }

    logger.warn(
      `[opposing_trades] User ${user_id} AUTO-LOCKED: ${instrument} opposing across accounts ${account_ids.join(', ')}`
    )

    // Also check for rapid open/close opposing trades (gaming detection)
    // This catches users who open and close opposing trades quickly to manipulate stats
    await detectRapidOpposingTrades(user_id, instrument, account_ids, io)

    if (io) {
      io.to('admin').emit('opposing_trade_detected', {
        user_id, instrument,
        account_ids,
        buy_lots:  parseFloat(row.total_buy_lots  || 0),
        sell_lots: parseFloat(row.total_sell_lots || 0),
        action: 'auto_locked',
        detected_at: new Date().toISOString()
      })
      if (tenant_id) {
        io.to(`admin:tenant:${tenant_id}`).emit('opposing_trade_detected', {
          user_id, instrument,
          account_ids,
          buy_lots: parseFloat(row.total_buy_lots || 0),
          sell_lots: parseFloat(row.total_sell_lots || 0),
          action: 'auto_locked',
          detected_at: new Date().toISOString()
        })
      }

      io.to(String(user_id)).emit('account_update', {
        event: 'account_locked',
        account_ids,
        message: `⚠️ Your accounts have been locked for review due to opposing trades detected on ${instrument}. Please contact support.`
      })
    }
  }
}

// ── IP-based multi-account detection (LOOPHOLE 4 FIX) ─────────────────────────
// Detects different users trading from the same IP address and flags them.
async function detectIPMultiAccounts() {
  try {
    // Find IPs that have been used by multiple users for trading within last 24h
    const result = await pool.query(`
      SELECT tenant_id,
             ip_address,
             array_agg(DISTINCT user_id) AS user_ids,
             COUNT(DISTINCT user_id) AS user_count
      FROM trade_logs
      WHERE logged_at > NOW() - INTERVAL '24 hours'
        AND ip_address IS NOT NULL
        AND ip_address <> 'unknown'
      GROUP BY tenant_id, ip_address
      HAVING COUNT(DISTINCT user_id) > 1
    `)

    if (result.rows.length === 0) return

    for (const row of result.rows) {
      const { ip_address, user_ids, tenant_id } = row

      // Flag all accounts belonging to these users
      const accountsResult = await pool.query(
        `SELECT id, user_id FROM accounts
         WHERE user_id = ANY($1::uuid[])
           AND tenant_id = $2
           AND status = 'active'
           AND review_flagged = false`,
        [user_ids, tenant_id || 1]
      )

      if (accountsResult.rows.length === 0) continue

      const accountIds = accountsResult.rows.map(r => r.id)
      const reason = `IP-based multi-account detected: users ${user_ids.join(', ')} trading from same IP ${ip_address} within 24h`
      for (const account of accountsResult.rows) {
        await safeRecordViolation({
          tenantId: tenant_id,
          violationType: 'ip_multi_account_detection',
          severity: 'high',
          accountId: account.id,
          userId: account.user_id,
          instrument: '',
          source: 'challenge_engine',
          message: reason,
          payload: { ip_address, user_ids }
        })

        try {
          await applyAccountEnforcement({
            accountId: account.id,
            action: 'flag_for_review',
            reason,
            payload: { ip_address, user_ids }
          })
        } catch (_) {}
      }

      logger.warn(`[ip_detection] Multiple users (${user_ids.join(', ')}) detected trading from IP ${ip_address}`)
    }
  } catch (err) {
    logger.error('[ip_detection] Error:', { error: err.message })
  }
}

module.exports = { runChallengeEngine }
