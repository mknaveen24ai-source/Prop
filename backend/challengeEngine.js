// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
const pool = require('./db')
const Decimal = require('decimal.js')
const logger = require('./utils/logger')
const { calculatePnL } = require('./utils/pnlCalculator')
require('./loadEnv')
const { getCurrentPricesForTenant } = require('./priceFeed')
const { fetchProgressionSettings, promotePassedAccount } = require('./services/progressionService')
const {
  enqueuePhasePassedEmail,
  enqueueAccountFailedEmail,
  enqueueAccountExpiredEmail
} = require('./utils/emailQueue')
const { getTenantSettings } = require('./services/tenantPolicyService')
const {
  applyAccountEnforcement,
  recordEnforcementEvent,
  recordViolation
} = require('./services/violationEngine')
const drawdownService = require('./services/drawdownService')
const tradingDaysService = require('./services/tradingDaysService')
const { fetchStepModelBySlug } = require('./utils/stepModels')

let reviewFlagColumnsReady = false

// FIX (AUDIT): Per-account warning level cache to prevent flooding the client
// socket with duplicate drawdown_warning events on every engine cycle.
// Key: accountId (string), Value: last emitted warningLevel (number)
const _lastDrawdownWarningLevel = new Map()
const _lastConsistencyWarningLevel = new Map()

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

async function fetchChallengeAutomationSettings() {
  const settings = await getTenantSettings(['inactivity_auto_fail_enabled', 'inactivity_fail_days'])
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

async function incrementBbookMetric(client, column) {
  const safeColumn = ['accounts_expired', 'accounts_failed', 'accounts_passed', 'new_funded'].includes(column)
    ? column
    : null
  if (!safeColumn) {
    throw new Error(`Unsupported bbook metric: ${column}`)
  }

  await client.query(
    `INSERT INTO bbook_pnl (date, ${safeColumn})
     VALUES (CURRENT_DATE, 1)
     ON CONFLICT (date) DO UPDATE
     SET ${safeColumn} = bbook_pnl.${safeColumn} + 1`
  )
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

    const priceMap = await getCurrentPricesForTenant()

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

    await incrementBbookMetric(client, 'accounts_expired')

    await client.query('COMMIT')

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event: 'account_expired',
        account_id: acc.id,
        message: `⏰ Challenge EXPIRED — the time limit was reached before the profit target. All trades have been closed.`,
      })
    }

    try {
      const userResult = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name } = userResult.rows[0]
        enqueueAccountExpiredEmail(email, full_name, acc.account_type, acc.account_size, {
          userId: acc.user_id
        }).catch(() => {})
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
    const currentBalance = new Decimal(acc.current_balance)
    let maxDrawdownPct = new Decimal(acc.max_drawdown_pct || 0)
    let drawdownLocksAtPct = null
    if (acc.account_type === 'funded' && acc.challenge_model_slug) {
      const model = await fetchStepModelBySlug(acc.challenge_model_slug)
      if (model) {
        maxDrawdownPct = new Decimal(model.funded_max_drawdown_pct)
        drawdownLocksAtPct = model.funded_drawdown_locks_at_pct != null ? parseFloat(model.funded_drawdown_locks_at_pct) : null
      }
    }
    let realisedDrawdownPct = new Decimal(0)
    if (!skipDrawdownCheck) {
      if (maxDrawdownPct.lte(0)) {
        await client.query('ROLLBACK')
        return
      }
      const floor = await drawdownService.getEffectiveDrawdownFloor(client, acc, {
        equity: currentBalance.toNumber(),
        maxDrawdownPct: maxDrawdownPct.toNumber(),
        drawdownLocksAtPct
      })
      if (currentBalance.gte(floor)) {
        await client.query('ROLLBACK')
        return
      }
      realisedDrawdownPct = new Decimal(acc.starting_balance).minus(currentBalance).div(acc.starting_balance).times(100)
    }

    const openTrades = await client.query(
      `SELECT * FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )

    const priceMap = await getCurrentPricesForTenant()

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
        logger.error(`failAccount: failed to close trade ${trade.id}:`, { error: tradeErr.message })
        throw new Error(`Failed to close trade ${trade.id} while failing account`)
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

    await incrementBbookMetric(client, 'accounts_failed')

    await client.query('COMMIT')

    await safeRecordViolation({
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
      const userResult = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name } = userResult.rows[0]
        enqueueAccountFailedEmail(email, full_name, acc.account_type, reason, acc.account_size, {
          userId: acc.user_id
        }).catch(() => {})
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
      io.to(String(acc.user_id)).emit('account_update', {
        event:          promoted.event,
        account_id:     acc.id,
        new_account_id: promoted.new_account_id,
        message:        promoted.message || `Your ${acc.account_type} challenge passed!`
      })
    }

    logger.info(`Challenge engine: account ${acc.id} PASSED (${acc.account_type})`)

    try {
      const userResult = await pool.query('SELECT email, full_name FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name } = userResult.rows[0]
        enqueuePhasePassedEmail(email, full_name, acc.account_type, acc.account_size, {
          userId: acc.user_id
        }).catch(() => {})
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
// evaluateScalingPlan — funded accounts only. Every `scaling_target_pct` net
// profit milestone doubles (`scaling_multiplier`x) the account's risk-capacity
// multiplier, i.e. multiplier = scaling_multiplier ^ milestonesEarned, capped so
// starting_balance * multiplier never exceeds `scaling_max_account_size`.
// The multiplier is not currently wired into lot/exposure caps or the
// account's literal balance — it's computed and persisted for visibility only.
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateScalingPlan(acc, io) {
  if (!acc.challenge_model_slug) return
  try {
    const model = await fetchStepModelBySlug(acc.challenge_model_slug)
    if (!model || !model.scaling_enabled) return

    const startingBalance = parseFloat(acc.starting_balance)
    const currentBalance = parseFloat(acc.current_balance)
    if (!(startingBalance > 0)) return

    const milestonePct = parseFloat(model.scaling_target_pct)
    const doublingFactor = parseFloat(model.scaling_multiplier || 1)
    const maxAccountSize = parseFloat(model.scaling_max_account_size || 0)
    if (!(milestonePct > 0) || !(doublingFactor > 1)) return

    const netProfitPct = ((currentBalance - startingBalance) / startingBalance) * 100
    if (netProfitPct <= 0) return

    const milestonesEarned = Math.floor(netProfitPct / milestonePct)
    const prevMilestones = parseInt(acc.scaling_milestones_claimed || 0, 10)
    if (milestonesEarned <= prevMilestones) return

    const rawMultiplier = Math.pow(doublingFactor, milestonesEarned)
    const capMultiplier = maxAccountSize > 0 ? (maxAccountSize / startingBalance) : rawMultiplier
    const nextMultiplier = Math.min(rawMultiplier, capMultiplier)

    const result = await pool.query(
      `UPDATE accounts
          SET scaling_multiplier = $2, scaling_milestones_claimed = $3
        WHERE id = $1 AND scaling_milestones_claimed < $3
        RETURNING scaling_multiplier`,
      [acc.id, nextMultiplier, milestonesEarned]
    )
    if (result.rows.length === 0) return

    logger.info(`Challenge engine: account ${acc.id} scaling upgraded to ${nextMultiplier}x (milestone ${milestonesEarned})`)

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event: 'scaling_upgrade',
        account_id: acc.id,
        message: `🚀 Scaling milestone reached! Your risk allocation just increased to ${nextMultiplier.toFixed(2)}x.`
      })
    }
  } catch (err) {
    logger.error(`evaluateScalingPlan error for account ${acc.id}:`, { error: err.message })
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

  let max_drawdown_pct = new Decimal(acc.account_type === 'funded'
    ? platformSettings.funded_max_drawdown_pct
    : acc.max_drawdown_pct)
  let daily_drawdown_pct = acc.daily_drawdown_pct != null ? parseFloat(acc.daily_drawdown_pct) : null
  let drawdownLocksAtPct = null
  if (acc.account_type === 'funded' && acc.challenge_model_slug) {
    const model = await fetchStepModelBySlug(acc.challenge_model_slug)
    if (model) {
      max_drawdown_pct = new Decimal(model.funded_max_drawdown_pct)
      daily_drawdown_pct = parseFloat(model.funded_daily_drawdown_pct)
      drawdownLocksAtPct = model.funded_drawdown_locks_at_pct != null ? parseFloat(model.funded_drawdown_locks_at_pct) : null
    }
  }

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

    const floor = await drawdownService.getEffectiveDrawdownFloor(pool, acc, {
      equity: current_balance.toNumber(),
      maxDrawdownPct: max_drawdown_pct.toNumber(),
      drawdownLocksAtPct
    })
    if (current_balance.lt(floor)) {
      const reason = `trailing drawdown breach — balance $${current_balance.toFixed(2)} fell below the $${floor.toFixed(2)} floor`
      logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}`)
      await failAccount(acc, reason, io, platformSettings)
      return
    }
  }

  if (daily_drawdown_pct != null && daily_drawdown_pct > 0 && starting_balance.gt(0)) {
    const todayRealizedMap = await tradingDaysService.getTodayRealizedPnl(pool, [acc.id])
    const todayRealized = new Decimal(todayRealizedMap.get(acc.id) || 0)
    if (todayRealized.isNegative()) {
      const todayLossPct = todayRealized.abs().div(starting_balance).times(100)
      if (todayLossPct.gte(daily_drawdown_pct)) {
        const reason = `daily loss limit breach — today's loss ${todayLossPct.toFixed(2)}% reached the ${daily_drawdown_pct}% daily limit`
        logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}`)
        await failAccount(acc, reason, io, platformSettings, {
          closeReason: 'Daily Loss Limit Breach',
          violationType: 'daily_loss_limit_breach',
          enforcementAction: 'auto_fail_daily_loss_limit'
        })
        return
      }
    }
  }

  // Funded accounts have no profit target to pass — only drawdown/daily-loss to fail on,
  // plus the scaling plan (risk-capacity increases on profit milestones).
  if (acc.account_type === 'funded') {
    await evaluateScalingPlan(acc, io)
    return
  }

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
    if (openCount > 0) return

    const minTradingDays = acc.min_trading_days != null ? parseInt(acc.min_trading_days, 10) : 0
    if (minTradingDays > 0) {
      const tradingDays = await tradingDaysService.countQualifyingTradingDays(
        pool, acc.id, acc.starting_balance, acc.min_daily_profit_pct
      )
      if (tradingDays < minTradingDays) {
        return // profit target met, but hasn't traded enough qualifying days yet
      }
    }

    const consistencyPct = acc.consistency_max_day_pct != null ? parseFloat(acc.consistency_max_day_pct) : null
    if (consistencyPct != null && consistencyPct > 0) {
      const consistency = await tradingDaysService.checkConsistencyRule(pool, acc.id, realised_profit.toNumber(), consistencyPct)
      if (!consistency.ok) {
        const prevLevel = _lastConsistencyWarningLevel.get(String(acc.id))
        if (io && prevLevel !== true) {
          _lastConsistencyWarningLevel.set(String(acc.id), true)
          io.to(String(acc.user_id)).emit('account_update', {
            event: 'consistency_rule_hold',
            account_id: acc.id,
            message: `📊 Almost there — your best single day is ${consistency.bestDayPct.toFixed(1)}% of total profit, which exceeds this model's ${consistencyPct}% consistency limit. Keep trading to bring that ratio down and you'll pass automatically.`
          })
        }
        return // profit target met, but concentrated in too few days — soft hold, not a fail
      }
      _lastConsistencyWarningLevel.delete(String(acc.id))
    }

    logger.info(`Challenge engine: account ${acc.id} hit profit target (${realised_profit.toFixed(2)}) — passing`)
    await passAccount(acc, platformSettings, io)
  }
}

async function runChallengeEngine(io) {
  try {
    const activeAccounts = await pool.query(
      `SELECT * FROM accounts
       WHERE status = 'active'
       AND account_type IN ('phase1', 'phase2', 'phase3', 'funded')`
    )

    if (activeAccounts.rows.length === 0) return

    const [progressionSettings, automationSettings] = await Promise.all([
      fetchProgressionSettings(pool),
      fetchChallengeAutomationSettings()
    ])
    const platformSettings = { ...progressionSettings, ...automationSettings }

    for (const acc of activeAccounts.rows) {
      try {
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
          } catch (silentErr) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: silentErr.message }) }
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
    const { user_id, instrument, account_ids } = row

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
    } catch (silentErr) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: silentErr.message }) }

    if (alreadyFlagged) continue

    const flagReason = `Cross-account opposing trade detected on ${instrument} — BUY and SELL open simultaneously across ${account_ids.length} accounts`
    for (const accountId of account_ids) {
      await safeRecordViolation({
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
      } catch (silentErr) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: silentErr.message }) }
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
      SELECT ip_address,
             array_agg(DISTINCT user_id) AS user_ids,
             COUNT(DISTINCT user_id) AS user_count
      FROM trade_logs
      WHERE logged_at > NOW() - INTERVAL '24 hours'
        AND ip_address IS NOT NULL
        AND ip_address <> 'unknown'
      GROUP BY ip_address
      HAVING COUNT(DISTINCT user_id) > 1
    `)

    if (result.rows.length === 0) return

    for (const row of result.rows) {
      const { ip_address, user_ids } = row

      // Flag all accounts belonging to these users
      const accountsResult = await pool.query(
        `SELECT id, user_id FROM accounts
         WHERE user_id = ANY($1::uuid[])
           AND status = 'active'
           AND review_flagged = false`,
        [user_ids]
      )

      if (accountsResult.rows.length === 0) continue

      const accountIds = accountsResult.rows.map(r => r.id)
      const reason = `IP-based multi-account detected: users ${user_ids.join(', ')} trading from same IP ${ip_address} within 24h`
      for (const account of accountsResult.rows) {
        await safeRecordViolation({
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
        } catch (silentErr) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: silentErr.message }) }
      }

      logger.warn(`[ip_detection] Multiple users (${user_ids.join(', ')}) detected trading from IP ${ip_address}`)
    }
  } catch (err) {
    logger.error('[ip_detection] Error:', { error: err.message })
  }
}

module.exports = { runChallengeEngine }
