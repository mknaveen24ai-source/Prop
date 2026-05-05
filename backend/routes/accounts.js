const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')
const { CONTRACT_SIZES } = require('../constants')
const {
  VALID_ACCOUNT_SIZES,
  buildAvailabilityPeriodMeta,
  buildAccountAvailability,
  countUsedQuotaSlots,
  parseQuotaSetting,
  quotaKey
} = require('../utils/accountAvailability')
const {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} = require('../utils/idempotency')
const {
  DEFAULT_TENANT_SETTINGS,
  ensureTenantSettingsInfrastructure,
  getTenantSettingsMap,
  parseBooleanSetting: parseTenantBoolean
} = require('../utils/tenantSettings')
const { createChallengePaymentSession } = require('./billing')

const createAccountLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,     // 1 hour
  max: 1,                        // FIX (H3): Reduced from 20 to 1 per hour (was abuse vector)
  message: { error: 'You can create only 1 account per hour. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    return req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req)
  }
})

function parseBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true'
}

function buildPublicAvailabilityFallback(settings = DEFAULT_TENANT_SETTINGS) {
  const periodMeta = buildAvailabilityPeriodMeta(settings)
  return VALID_ACCOUNT_SIZES.map((size) => {
    const quota = parseQuotaSetting(settings, size)
    const unlimited = quota >= 999999

    return {
      size,
      quota: unlimited ? 999999 : quota,
      configured_quota: unlimited ? null : quota,
      used: 0,
      remaining: unlimited ? null : quota,
      locked: quota === 0,
      is_unlimited: unlimited,
      reason: quota === 0 ? 'This account size is currently unavailable.' : null,
      ...periodMeta
    }
  })
}

async function loadTenantAvailability(tenantId) {
  const settings = await loadTenantSettings(tenantId)
  const sizes = await buildAccountAvailability(pool, tenantId, settings)
  return {
    settings,
    sizes
  }
}

async function loadTenantSettings(tenantId, keys = []) {
  await ensureTenantSettingsInfrastructure()
  return getTenantSettingsMap(tenantId, keys)
}

async function ensureChallengeOrderInfrastructure() {
  await ensureTenantSettingsInfrastructure()
}

function calculateOpenTradePnl(trade) {
  const contractSize = CONTRACT_SIZES[trade.instrument] || 100000
  const openPrice = parseFloat(trade.open_price || 0)
  const lots = parseFloat(trade.lot_size || 0)
  const commission = parseFloat(trade.commission || 0)
  const currentPrice = trade.direction === 'buy'
    ? parseFloat(trade.bid || 0)
    : parseFloat(trade.ask || 0)
  const priceDiff = trade.direction === 'buy'
    ? currentPrice - openPrice
    : openPrice - currentPrice
  return parseFloat(((priceDiff * lots * contractSize) - commission).toFixed(2))
}

function getUtcDayBounds() {
  const start = new Date()
  start.setUTCHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 1)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function computeDaysRemaining(phaseEndDate) {
  if (!phaseEndDate) return null
  const nowMs = Date.now()
  const endMs = new Date(phaseEndDate).getTime()
  return Math.max(0, Math.ceil((endMs - nowMs) / (1000 * 60 * 60 * 24)))
}

function buildResolvedRules(account, settings = {}) {
  const accountType = account?.account_type || 'phase1'
  const phaseKey = accountType === 'phase2'
    ? 'phase2'
    : accountType === 'funded'
      ? 'funded'
      : 'phase1'
  const startingBalance = parseFloat(account?.starting_balance || 0)
  const storedProfitTarget = parseFloat(account?.profit_target || 0)
  const storedMaxDrawdown = parseFloat(account?.max_drawdown_pct || 0)
  const inferredProfitPct = startingBalance > 0 && storedProfitTarget > 0
    ? (storedProfitTarget / startingBalance) * 100
    : null

  const profitTargetPct = accountType === 'funded'
    ? 0
    : parseFloat(inferredProfitPct || settings[`${phaseKey}_profit_target_pct`] || (phaseKey === 'phase2' ? 5 : 10))

  return {
    account_type: accountType,
    profit_target_pct: profitTargetPct,
    profit_target_amount: accountType === 'funded'
      ? 0
      : parseFloat((storedProfitTarget || (startingBalance * (profitTargetPct / 100))).toFixed(2)),
    max_drawdown_pct: parseFloat(
      (accountType === 'funded'
        ? (settings.funded_max_drawdown_pct || storedMaxDrawdown || 5)
        : (storedMaxDrawdown || settings[`${phaseKey}_max_drawdown_pct`] || 10))
    ),
    time_limit_days: accountType === 'funded'
      ? null
      : parseInt(settings[`${phaseKey}_day_limit`] || 30, 10),
    max_daily_trades: parseInt(settings.max_daily_trades || 20, 10),
    min_hold_seconds: parseInt(settings.min_hold_seconds || 60, 10),
    min_lot_size: parseFloat(settings.min_lot_size || 0.01),
    forex_lots_per_1k: parseFloat(settings.forex_lots_per_1k || 0.20),
    commodity_lots_per_1k: parseFloat(settings.commodity_lots_per_1k || 0.02),
    max_trades_per_1k: parseFloat(settings.max_trades_per_1k || 1),
    weekend_holding_enabled: parseBooleanSetting(settings.weekend_holding_enabled, true),
    profit_share_pct: parseFloat(settings.profit_share_pct || 80),
    inactivity_auto_fail_enabled: parseBooleanSetting(settings.inactivity_auto_fail_enabled, true),
    inactivity_fail_days: parseInt(settings.inactivity_fail_days || 30, 10),
    leverage: {
      forex: '1:30',
      commodities: '1:10'
    }
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/available-sizes
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FIX: Added authenticateToken — this endpoint reveals slot quotas, usage
// counts and lock status for all account sizes. Unauthenticated access lets
// competitors or bots scrape capacity data indefinitely.
router.get('/available-sizes', authenticateToken, async function(req, res) {
  try {
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const { sizes } = await loadTenantAvailability(tenantId)
    res.json(sizes)
  } catch (error) {
    logger.error('Available sizes error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch available sizes' })
  }
})

router.get('/rules/:account_id', authenticateToken, async function(req, res) {
  try {
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const accountIdStr = String(req.params.account_id || '').trim()
    if (!accountIdStr || isNaN(parseInt(accountIdStr))) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const accountResult = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, phase_start_date, phase_end_date, created_at
       FROM accounts
       WHERE id = $1 AND user_id = $2 AND COALESCE(tenant_id, $3) = $3`,
      [accountIdStr, req.user.userId, tenantId]
    )
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const settings = await loadTenantSettings(tenantId, [
      'phase1_profit_target_pct', 'phase1_max_drawdown_pct', 'phase1_day_limit',
      'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
      'funded_max_drawdown_pct', 'profit_share_pct',
      'max_daily_trades', 'min_hold_seconds', 'min_lot_size',
      'forex_lots_per_1k', 'commodity_lots_per_1k', 'max_trades_per_1k',
      'weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'inactivity_fail_days'
    ])

    const account = accountResult.rows[0]
    const rules = buildResolvedRules(account, settings)
    const lastTradeResult = await pool.query(
      `SELECT NULLIF(MAX(GREATEST(COALESCE(open_time, '-infinity'::timestamptz), COALESCE(close_time, '-infinity'::timestamptz))), '-infinity'::timestamptz) AS last_trade_at
       FROM trades
       WHERE account_id = $1`,
      [accountIdStr]
    )

    res.json({
      account,
      rules,
      meta: {
        days_remaining: computeDaysRemaining(account.phase_end_date),
        phase_end_date: account.phase_end_date,
        last_trade_at: lastTradeResult.rows[0].last_trade_at || null
      }
    })
  } catch (error) {
    logger.error('Account rules error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch account rules' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/accounts/platform-rules
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public quota view for landing (no auth).
// Returns live usage statistics to match the private endpoint.
router.get('/available-sizes-public', async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    const { sizes } = await loadTenantAvailability(tenantId)
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.json(sizes)
  } catch (error) {
    logger.error('Public available sizes error:', { error: error.message })
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.json(buildPublicAvailabilityFallback())
  }
})

router.get('/platform-rules', authenticateToken, async function(req, res) {
  try {
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const settings = await loadTenantSettings(tenantId, [
      'phase1_profit_target_pct', 'phase1_max_drawdown_pct', 'phase1_day_limit',
      'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
      'funded_max_drawdown_pct', 'profit_share_pct',
      'max_daily_trades', 'min_hold_seconds', 'min_lot_size',
      'forex_lots_per_1k', 'commodity_lots_per_1k', 'max_trades_per_1k',
      'weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'inactivity_fail_days',
      'requires_payment', 'challenge_checkout_mode', 'challenge_fee_amount',
      'challenge_fee_currency', 'challenge_fee_label', 'marketing_mode'
    ])
    const rules = {}
    Object.entries(settings).forEach(([key, value]) => {
      if (['weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'requires_payment'].includes(key)) {
        rules[key] = parseTenantBoolean(value)
      } else if (['challenge_checkout_mode', 'challenge_fee_currency', 'challenge_fee_label', 'marketing_mode'].includes(key)) {
        rules[key] = value
      } else {
        const parsed = parseFloat(value)
        rules[key] = Number.isFinite(parsed) ? parsed : value
      }
    })
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
router.post('/create', authenticateToken, createAccountLimiter, async function(req, res) {
  const client = await pool.connect()
  let idempotencyClaim = null
  try {
    await ensureChallengeOrderInfrastructure()
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const account_size = parseInt(req.body.account_size)
    const challengeOrderId = req.body.challenge_order_id ? parseInt(req.body.challenge_order_id, 10) : null
    const idempotencyResult = await beginIdempotentRequest(pool, {
      scope: 'accounts:create',
      tenantId,
      actorId: req.user.userId,
      idempotencyKey: getIdempotencyKey(req)
    })

    if (idempotencyResult.replay) {
      return res.status(idempotencyResult.responseStatus).json(idempotencyResult.responseBody)
    }
    if (idempotencyResult.inProgress) {
      return res.status(409).json({ error: 'This account creation request is already being processed.' })
    }
    idempotencyClaim = idempotencyResult.claimId || null

    if (isNaN(account_size) || !VALID_ACCOUNT_SIZES.includes(account_size)) {
      return res.status(400).json({
        error: `Invalid account size. Choose one of: $${VALID_ACCOUNT_SIZES.map(s => s.toLocaleString()).join(', $')}`
      })
    }

    await client.query('BEGIN')

    // UUID-based user IDs cannot be parsed as integers, so derive a deterministic
    // int4 lock key from the user ID text and pair it with account_size.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [
      String(req.user.userId),
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

    const settings = await loadTenantSettings(tenantId)

    const maxPerUser            = parseInt(settings.max_accounts_per_user     || '999999')
    const phase1ProfitTargetPct = parseFloat(settings.phase1_profit_target_pct || '10')
    const phase1MaxDrawdownPct  = parseFloat(settings.phase1_max_drawdown_pct  || '10')
    const phase1DayLimit        = parseInt(settings.phase1_day_limit           || '30')
    const requiresPayment       = parseTenantBoolean(settings.requires_payment, false)
    const checkoutMode          = String(settings.challenge_checkout_mode || 'free').trim().toLowerCase()

    if (isNaN(phase1ProfitTargetPct) || isNaN(phase1MaxDrawdownPct) || isNaN(phase1DayLimit)) {
      await client.query('ROLLBACK')
      logger.error('Platform configuration error - invalid settings')
      return res.status(500).json({ error: 'Platform configuration error. Contact support.' })
    }

    // ——— Quota check ——————————————————————————————————————————————————————————
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
      const usedCount = await countUsedQuotaSlots(client, tenantId, account_size, settings)

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
         AND COALESCE(tenant_id, $2) = $2
         AND status = 'active'
         AND account_type IN ('phase1', 'phase2', 'funded')`,
      [req.user.userId, tenantId]
    )
    if (parseInt(userActiveResult.rows[0].count) >= maxPerUser) {
      await client.query('ROLLBACK')
      return res.status(403).json({
        error: 'You already have an active challenge running. Complete or wait for it to finish before starting a new one.'
      })
    }

    let challengeOrder = null
    if (requiresPayment || checkoutMode === 'paid') {
      if (!Number.isFinite(challengeOrderId)) {
        await client.query('ROLLBACK')
        return res.status(402).json({
          error: 'A paid challenge order is required before creating this account.',
          requires_payment: true
        })
      }

      const challengeOrderResult = await client.query(
        `SELECT id, tenant_id, user_id, account_size, status, checkout_mode, paid_via, paid_at
           FROM challenge_orders
          WHERE id = $1
            AND tenant_id = $2
            AND user_id = $3
          FOR UPDATE`,
        [challengeOrderId, tenantId, req.user.userId]
      )
      if (challengeOrderResult.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Challenge order not found for this tenant.' })
      }

      challengeOrder = challengeOrderResult.rows[0]
      if (parseInt(challengeOrder.account_size, 10) !== account_size) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Challenge order account size does not match your selected size.' })
      }
      if (challengeOrder.status !== 'paid') {
        await client.query('ROLLBACK')
        return res.status(402).json({
          error: 'Challenge payment is not completed yet.',
          requires_payment: true,
          order_status: challengeOrder.status
        })
      }
    } else {
      const freeOrderResult = await client.query(
        `INSERT INTO challenge_orders (
           tenant_id, user_id, account_size, amount, currency, status, checkout_mode, paid_via, paid_at, metadata_json
         ) VALUES (
           $1, $2, $3, 0, $4, 'paid', 'free', 'internal_free_issue', NOW(), '{}'::jsonb
         )
         RETURNING *`,
        [tenantId, req.user.userId, account_size, String(settings.challenge_fee_currency || 'USD')]
      )
      challengeOrder = freeOrderResult.rows[0]
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
        profit_target, max_drawdown_pct, status, phase_start_date, phase_end_date, account_uid, tenant_id)
       VALUES ($1, 'phase1', $2, $2, $2, $2, $3, $4, 'active', NOW(), $5, $6, $7)
       RETURNING *`,
      [req.user.userId, account_size, profit_target, phase1MaxDrawdownPct, phase_end_date, account_uid, tenantId]
    )

    await client.query('COMMIT')

    logger.info(
      `Phase 1 created for user ${req.user.userId}: $${account_size} ` +
      `| target: ${phase1ProfitTargetPct}% ($${profit_target}) ` +
      `| max DD: ${phase1MaxDrawdownPct}% | days: ${phase1DayLimit}`
    )

    const account = newAccount.rows[0]
    // FIX (BUG-H003): This UPDATE ran on `client` after COMMIT — use pool.query
    // so a failure here doesn't affect the already-committed account creation.
    if (challengeOrder?.id) {
      try {
        await pool.query(
          `UPDATE challenge_orders
              SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || jsonb_build_object('account_id', $2, 'account_uid', $3),
                  updated_at = NOW()
            WHERE id = $1`,
          [challengeOrder.id, account.id, account.account_uid]
        )
      } catch (orderErr) {
        logger.error('Failed to update challenge order metadata:', { error: orderErr.message, orderId: challengeOrder.id })
      }
    }
    const responseBody = {
      message: 'Phase 1 challenge account created successfully',
      account_id:  account.id,
      account_uid: account.account_uid,
      order_id: challengeOrder?.id || null,
      account
    }
    await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
    res.status(201).json(responseBody)

  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    await abandonIdempotentRequest(pool, idempotencyClaim).catch(() => {})
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
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const result = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, created_at,
              phase_start_date, phase_end_date, account_uid, updated_at
       FROM accounts WHERE user_id = $1 AND COALESCE(tenant_id, $2) = $2 ORDER BY created_at DESC`,
      [req.user.userId, tenantId]
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
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const accountsResult = await pool.query(
      `SELECT a.*,
         COUNT(t.id) FILTER (WHERE t.status = 'closed') as total_trades,
         COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0) as total_pnl,
         COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0) as winning_trades
       FROM accounts a
       LEFT JOIN trades t ON t.account_id = a.id
       WHERE a.user_id = $1 AND COALESCE(a.tenant_id, $2) = $2
       GROUP BY a.id
       ORDER BY a.created_at DESC`,
      [req.user.userId, tenantId]
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
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const account_id = req.params.account_id

    const accountIdStr = String(account_id || '').trim()
    if (!accountIdStr || isNaN(parseInt(accountIdStr))) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const result = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, phase_end_date
       FROM accounts WHERE id = $1 AND user_id = $2 AND COALESCE(tenant_id, $3) = $3`,
      [accountIdStr, req.user.userId, tenantId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const account = result.rows[0]
    const settings = await loadTenantSettings(tenantId, [
      'phase1_profit_target_pct', 'phase1_max_drawdown_pct', 'phase1_day_limit',
      'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
      'funded_max_drawdown_pct', 'profit_share_pct',
      'max_daily_trades', 'min_hold_seconds', 'min_lot_size',
      'forex_lots_per_1k', 'commodity_lots_per_1k', 'max_trades_per_1k',
      'weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'inactivity_fail_days'
    ])

    const rules = buildResolvedRules(account, settings)
    const { startIso, endIso } = getUtcDayBounds()

    const openTradesResult = await pool.query(
      `SELECT t.direction, t.open_price, t.lot_size, t.instrument, t.commission, p.bid, p.ask
       FROM trades t
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       WHERE t.account_id = $1 AND t.status = 'open'`,
      [accountIdStr]
    )

    const tradesTodayResult = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM trade_logs
       WHERE account_id = $1
         AND logged_at >= $2
         AND logged_at < $3`,
      [accountIdStr, startIso, endIso]
    )

    const lastTradeResult = await pool.query(
      `SELECT NULLIF(MAX(GREATEST(COALESCE(open_time, '-infinity'::timestamptz), COALESCE(close_time, '-infinity'::timestamptz))), '-infinity'::timestamptz) AS last_trade_at
       FROM trades
       WHERE account_id = $1`,
      [accountIdStr]
    )

    const starting = parseFloat(account.starting_balance || 0)
    const current = parseFloat(account.current_balance || 0)
    const peak = parseFloat(account.peak_balance || 0)
    const floatingPnl = openTradesResult.rows.reduce((sum, trade) => {
      if (trade.bid == null || trade.ask == null || trade.open_price == null) return sum
      return sum + calculateOpenTradePnl(trade)
    }, 0)
    const equity = parseFloat((current + floatingPnl).toFixed(2))
    const profit_pct = starting > 0
      ? parseFloat((((current - starting) / starting) * 100).toFixed(2))
      : 0
    const equity_profit_pct = starting > 0
      ? parseFloat((((equity - starting) / starting) * 100).toFixed(2))
      : 0
    const drawdown_pct = peak > 0
      ? parseFloat((((peak - current) / peak) * 100).toFixed(2))
      : 0
    const total_drawdown_pct = starting > 0
      ? parseFloat((Math.max(0, ((starting - equity) / starting) * 100)).toFixed(2))
      : 0
    const total_drawdown_used_pct = rules.max_drawdown_pct > 0
      ? parseFloat(Math.min((total_drawdown_pct / rules.max_drawdown_pct) * 100, 100).toFixed(2))
      : 0
    const total_drawdown_remaining_pct = parseFloat(Math.max(0, rules.max_drawdown_pct - total_drawdown_pct).toFixed(2))
    const days_remaining = computeDaysRemaining(account.phase_end_date)
    const trades_today = parseInt(tradesTodayResult.rows[0].count || 0, 10)
    const last_trade_at = lastTradeResult.rows[0].last_trade_at || null

    res.json({
      account,
      rules,
      stats: {
        profit_pct,
        equity_profit_pct,
        drawdown_pct: Math.max(0, drawdown_pct),
        total_drawdown_pct,
        total_drawdown_used_pct,
        total_drawdown_remaining_pct,
        floating_pnl: parseFloat(floatingPnl.toFixed(2)),
        equity,
        days_remaining,
        trades_today,
        last_trade_at
      }
    })

  } catch (error) {
    logger.error('Stats error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch stats' })
  }
})

router.post('/orders', authenticateToken, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureChallengeOrderInfrastructure()
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const accountSize = parseInt(req.body.account_size, 10)
    if (!Number.isFinite(accountSize) || !VALID_ACCOUNT_SIZES.includes(accountSize)) {
      return res.status(400).json({ error: 'Invalid account size' })
    }

    const settings = await loadTenantSettings(tenantId, [
      'requires_payment',
      'challenge_checkout_mode',
      'challenge_fee_amount',
      'challenge_fee_currency',
      'payment_provider'
    ])

    const requiresPayment = parseTenantBoolean(settings.requires_payment, false)
    const checkoutMode = String(settings.challenge_checkout_mode || (requiresPayment ? 'paid' : 'free')).trim().toLowerCase()
    const currency = String(settings.challenge_fee_currency || 'USD').trim() || 'USD'
    const amount = parseFloat(settings.challenge_fee_amount || 0) || 0
    const paymentProvider = String(settings.payment_provider || '').trim()

    await client.query('BEGIN')

    const orderStatus = checkoutMode === 'paid' && requiresPayment ? 'pending' : 'paid'
    const paidVia = orderStatus === 'paid' ? 'internal_free_issue' : null
    const paidAt = orderStatus === 'paid' ? 'NOW()' : 'NULL'
    const orderInsert = await client.query(
      `INSERT INTO challenge_orders (
         tenant_id, user_id, account_size, amount, currency, status, checkout_mode, payment_provider, paid_via, paid_at, metadata_json
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, ${paidAt}, '{}'::jsonb
       )
       RETURNING *`,
      [
        tenantId,
        req.user.userId,
        accountSize,
        amount,
        currency,
        orderStatus,
        checkoutMode,
        paymentProvider || null,
        paidVia
      ]
    )

    await client.query('COMMIT')

    let checkout = null
    if (orderStatus === 'pending' && paymentProvider.toLowerCase() === 'stripe') {
      checkout = await createChallengePaymentSession({
        req,
        tenantId,
        orderId: orderInsert.rows[0].id,
        userId: req.user.userId
      })
    }

    res.status(201).json({
      order: orderInsert.rows[0],
      requires_payment: requiresPayment || checkoutMode === 'paid',
      payment_configured: !!paymentProvider,
      checkout_mode: checkoutMode,
      checkout_url: checkout?.checkout_url || null,
      checkout_session_id: checkout?.checkout_session_id || null
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Create challenge order error:', { error: error.message })
    res.status(500).json({ error: 'Could not create challenge order' })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/my-purchase-limit
// Returns the user's purchase count within the current rolling period and the
// date when the limit resets (i.e. when the oldest purchase exits the window).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-purchase-limit', authenticateToken, async function(req, res) {
  try {
    const tenantId = req.user.tenantId || req.tenant?.id || 1
    const settings = await loadTenantSettings(tenantId, ['max_accounts_per_user_per_period', 'user_purchase_period_days'])

    const max         = parseInt(settings.max_accounts_per_user_per_period || '0')
    const periodDays  = parseInt(settings.user_purchase_period_days || '30')

    if (!max || max <= 0) {
      return res.json({ limited: false, max: null, used: 0, period_days: periodDays, resets_at: null })
    }

    const periodStart = new Date()
    periodStart.setDate(periodStart.getDate() - periodDays)
    const r = await pool.query(
      `SELECT id, created_at FROM accounts
       WHERE user_id = $1 AND COALESCE(tenant_id, $3) = $3 AND created_at >= $2
       ORDER BY created_at ASC`,
      [req.user.userId, periodStart.toISOString(), tenantId]
    )
    const used = r.rows.length
    let resetsAt = null
    if (used > 0) {
      const oldest = new Date(r.rows[0].created_at)
      resetsAt = new Date(oldest)
      resetsAt.setDate(resetsAt.getDate() + periodDays)
    }

    res.json({
      limited: true,
      max,
      used,
      period_days: periodDays,
      resets_at: resetsAt ? resetsAt.toISOString() : null,
      limit_reached: used >= max
    })
  } catch (error) {
    logger.error('Purchase limit error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch purchase limit' })
  }
})

module.exports = router
