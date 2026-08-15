const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const { createLimiter } = require('../utils/security')
const { ipKeyGenerator } = require('express-rate-limit')
const logger = require('../utils/logger')
const { calculatePnL } = require('../utils/pnlCalculator')
const {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} = require('../utils/idempotency')
const {
  ensureTenantSettingsInfrastructure,
  getTenantSettingsMap,
  parseBooleanSetting: parseTenantBoolean
} = require('../utils/tenantSettings')
const { createChallengePaymentSession } = require('./billing')
const tradingDaysService = require('../services/tradingDaysService')
const {
  ACCOUNT_SIZES: STEP_MODEL_ACCOUNT_SIZES,
  ensureStepModelInfrastructure,
  fetchStepModels,
  fetchStepModelBySlug,
  fetchStepModelPrice,
  assertSlotAvailable
} = require('../utils/stepModels')
const { validateCouponForCheckout, recordCouponRedemption } = require('../utils/coupons')
const { generateAccountUid } = require('../utils/accountIds')
const { issueGiftVoucherForOrder, redeemGiftVoucher } = require('../utils/giftVouchers')
const { isValidEmail } = require('../utils/validation')

const createAccountLimiter = createLimiter('create-account', {
  windowMs: 60 * 60 * 1000,     // 1 hour
  max: 1,                        // FIX (H3): Reduced from 20 to 1 per hour (was abuse vector)
  message: { error: 'You can create only 1 account per hour. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: function(req) {
    return req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req.ip)
  }
})

function parseBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  return value === true || value === 'true'
}

async function loadTenantSettings(keys = []) {
  await ensureTenantSettingsInfrastructure()
  return getTenantSettingsMap(keys)
}

async function ensureChallengeOrderInfrastructure() {
  await ensureTenantSettingsInfrastructure()
}

// Resolves the price an open trade would close at and defers the arithmetic to
// the canonical Decimal implementation in utils/pnlCalculator.js. Closing a buy
// hits the bid, closing a sell hits the ask -- that side selection is the only
// thing specific to this call site; the maths is not duplicated here.
function calculateOpenTradePnl(trade) {
  const closePrice = trade.direction === 'buy' ? trade.bid : trade.ask
  return calculatePnL(
    trade.direction,
    trade.open_price || 0,
    closePrice || 0,
    trade.lot_size || 0,
    trade.instrument,
    trade.commission || 0
  )
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
  const phaseKey = accountType === 'funded'
    ? 'funded'
    : ['phase1', 'phase2', 'phase3'].includes(accountType)
      ? accountType
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

router.get('/rules/:account_id', authenticateToken, async function(req, res) {
  try {
    const accountIdStr = String(req.params.account_id || '').trim()
    if (!accountIdStr || isNaN(parseInt(accountIdStr))) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const accountResult = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, phase_start_date, phase_end_date, created_at,
              challenge_model_slug, step_number, daily_drawdown_pct
       FROM accounts
       WHERE id = $1 AND user_id = $2`,
      [accountIdStr, req.user.userId]
    )
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const settings = await loadTenantSettings([
      'phase1_profit_target_pct', 'phase1_max_drawdown_pct', 'phase1_day_limit',
      'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
      'funded_max_drawdown_pct', 'profit_share_pct',
      'max_daily_trades', 'min_hold_seconds', 'min_lot_size',
      'forex_lots_per_1k', 'commodity_lots_per_1k', 'max_trades_per_1k',
      'weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'inactivity_fail_days'
    ])

    const account = accountResult.rows[0]
    const rules = buildResolvedRules(account, settings)

    // Daily drawdown limit isn't in buildResolvedRules (that's shared with
    // /step-models pricing display) — resolve it the same way /stats does:
    // funded accounts pull from their step model, challenge accounts use
    // their own column.
    let resolvedDailyDrawdownPct = parseFloat(account.daily_drawdown_pct || 0)
    if (account.account_type === 'funded' && account.challenge_model_slug) {
      const fundedModel = await fetchStepModelBySlug(account.challenge_model_slug)
      if (fundedModel && Number.isFinite(parseFloat(fundedModel.funded_daily_drawdown_pct))) {
        resolvedDailyDrawdownPct = parseFloat(fundedModel.funded_daily_drawdown_pct)
      }
      if (fundedModel && fundedModel.scaling_enabled) {
        rules.scaling_target_pct = parseFloat(fundedModel.scaling_target_pct)
        rules.scaling_increase_per_milestone_pct = parseFloat(fundedModel.scaling_increase_per_milestone_pct || 0)
        rules.scaling_max_account_size = fundedModel.scaling_max_account_size != null ? parseFloat(fundedModel.scaling_max_account_size) : null
      }
    }
    rules.daily_drawdown_pct = resolvedDailyDrawdownPct

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

router.get('/platform-rules', authenticateToken, async function(req, res) {
  try {
    const settings = await loadTenantSettings([
      'profit_share_pct',
      'max_daily_trades', 'min_hold_seconds', 'min_lot_size',
      'forex_lots_per_1k', 'commodity_lots_per_1k', 'max_trades_per_1k',
      'weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'inactivity_fail_days'
    ])
    const rules = {}
    Object.entries(settings).forEach(([key, value]) => {
      if (['weekend_holding_enabled', 'inactivity_auto_fail_enabled'].includes(key)) {
        rules[key] = parseTenantBoolean(value)
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/step-models
// Public (authenticated trader) view of the 1-step/2-step/3-step challenge
// models: rules per phase, funded-stage terms, and per-size pricing. Only
// enabled models are returned — this is what the admin availability toggle
// controls.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/step-models', authenticateToken, async function(req, res) {
  try {
    const models = await fetchStepModels({ onlyEnabled: true })
    res.json({
      account_sizes: STEP_MODEL_ACCOUNT_SIZES,
      models: models.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
        steps: m.steps,
        profit_targets_pct: m.profit_targets_pct,
        daily_drawdown_pct: parseFloat(m.daily_drawdown_pct),
        max_drawdown_pct: parseFloat(m.max_drawdown_pct),
        time_limits_days: m.time_limits_days,
        min_trading_days: m.min_trading_days,
        min_daily_profit_pct: parseFloat(m.min_daily_profit_pct),
        consistency_max_day_pct_by_phase: m.consistency_max_day_pct_by_phase,
        profit_split_pct: parseFloat(m.profit_split_pct),
        funded_max_drawdown_pct: parseFloat(m.funded_max_drawdown_pct),
        funded_daily_drawdown_pct: parseFloat(m.funded_daily_drawdown_pct),
        funded_drawdown_locks_at_pct: m.funded_drawdown_locks_at_pct != null ? parseFloat(m.funded_drawdown_locks_at_pct) : null,
        funded_min_trading_days_for_payout: m.funded_min_trading_days_for_payout,
        funded_payout_min_net_profit_pct: m.funded_payout_min_net_profit_pct != null ? parseFloat(m.funded_payout_min_net_profit_pct) : null,
        funded_consistency_max_day_pct: m.funded_consistency_max_day_pct != null ? parseFloat(m.funded_consistency_max_day_pct) : null,
        scaling_target_pct: m.scaling_target_pct != null ? parseFloat(m.scaling_target_pct) : null,
        scaling_multiplier: m.scaling_multiplier != null ? parseFloat(m.scaling_multiplier) : null,
        scaling_max_account_size: m.scaling_max_account_size != null ? parseFloat(m.scaling_max_account_size) : null,
        pricing: m.pricing
      }))
    })
  } catch (error) {
    logger.error('Step models error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch challenge models' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/step-models-public
// Public (no auth) mirror of /step-models for the landing page's challenge
// selector. Same shape, same "only enabled models" filter — no order/checkout
// action is exposed here, this is read-only marketing data.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/step-models-public', async function(req, res) {
  try {
    const models = await fetchStepModels({ onlyEnabled: true })
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    res.json({
      account_sizes: STEP_MODEL_ACCOUNT_SIZES,
      models: models.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
        steps: m.steps,
        profit_targets_pct: m.profit_targets_pct,
        daily_drawdown_pct: parseFloat(m.daily_drawdown_pct),
        max_drawdown_pct: parseFloat(m.max_drawdown_pct),
        time_limits_days: m.time_limits_days,
        min_trading_days: m.min_trading_days,
        min_daily_profit_pct: parseFloat(m.min_daily_profit_pct),
        consistency_max_day_pct_by_phase: m.consistency_max_day_pct_by_phase,
        profit_split_pct: parseFloat(m.profit_split_pct),
        funded_max_drawdown_pct: parseFloat(m.funded_max_drawdown_pct),
        funded_daily_drawdown_pct: parseFloat(m.funded_daily_drawdown_pct),
        funded_drawdown_locks_at_pct: m.funded_drawdown_locks_at_pct != null ? parseFloat(m.funded_drawdown_locks_at_pct) : null,
        funded_min_trading_days_for_payout: m.funded_min_trading_days_for_payout,
        funded_payout_min_net_profit_pct: m.funded_payout_min_net_profit_pct != null ? parseFloat(m.funded_payout_min_net_profit_pct) : null,
        funded_consistency_max_day_pct: m.funded_consistency_max_day_pct != null ? parseFloat(m.funded_consistency_max_day_pct) : null,
        scaling_target_pct: m.scaling_target_pct != null ? parseFloat(m.scaling_target_pct) : null,
        scaling_multiplier: m.scaling_multiplier != null ? parseFloat(m.scaling_multiplier) : null,
        scaling_max_account_size: m.scaling_max_account_size != null ? parseFloat(m.scaling_max_account_size) : null,
        pricing: m.pricing
      }))
    })
  } catch (error) {
    logger.error('Public step models error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch challenge models' })
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
    const account_size = parseInt(req.body.account_size)
    const challengeOrderId = req.body.challenge_order_id ? parseInt(req.body.challenge_order_id, 10) : null
    const idempotencyResult = await beginIdempotentRequest(pool, {
      scope: 'accounts:create',
      actorId: req.user.userId,
      idempotencyKey: getIdempotencyKey(req)
    })

    // FIX (H-03): without the header this endpoint previously ran with no
    // replay protection, so a retried POST created a second paid account.
    if (idempotencyResult.required) {
      return res.status(400).json({ error: idempotencyResult.error })
    }
    if (idempotencyResult.replay) {
      return res.status(idempotencyResult.responseStatus).json(idempotencyResult.responseBody)
    }
    if (idempotencyResult.inProgress) {
      return res.status(409).json({ error: 'This account creation request is already being processed.' })
    }
    idempotencyClaim = idempotencyResult.claimId || null

    if (isNaN(account_size) || !STEP_MODEL_ACCOUNT_SIZES.includes(account_size)) {
      return res.status(400).json({
        error: `Invalid account size. Choose one of: $${STEP_MODEL_ACCOUNT_SIZES.map(s => s.toLocaleString()).join(', $')}`
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

    const settings = await loadTenantSettings()

    const maxPerUser = parseInt(settings.max_accounts_per_user || '999999')

    // â”€â”€ Per-user active account limit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // This check is now inside the transaction + advisory lock, so two
    // simultaneous requests cannot both pass it and both insert.
    const userActiveResult = await client.query(
      `SELECT COUNT(*) FROM accounts
       WHERE user_id = $1
         AND status = 'active'
         AND account_type IN ('phase1', 'phase2', 'phase3', 'funded')`,
      [req.user.userId]
    )
    if (parseInt(userActiveResult.rows[0].count) >= maxPerUser) {
      await client.query('ROLLBACK')
      return res.status(403).json({
        error: 'You already have an active challenge running. Complete or wait for it to finish before starting a new one.'
      })
    }

    if (!Number.isFinite(challengeOrderId)) {
      await client.query('ROLLBACK')
      return res.status(402).json({
        error: 'A paid challenge order is required before creating this account.',
        requires_payment: true
      })
    }

    const challengeOrderResult = await client.query(
      `SELECT id, user_id, account_size, status, challenge_model_id, challenge_model_slug, paid_at
         FROM challenge_orders
        WHERE id = $1
          AND user_id = $2
        FOR UPDATE`,
      [challengeOrderId, req.user.userId]
    )
    if (challengeOrderResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Challenge order not found.' })
    }

    const challengeOrder = challengeOrderResult.rows[0]
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
    if (!challengeOrder.challenge_model_slug) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'This order is missing its challenge model. Please start a new challenge order.' })
    }

    const stepModel = await fetchStepModelBySlug(challengeOrder.challenge_model_slug)
    if (!stepModel) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'The challenge model for this order is no longer available.' })
    }

    // â”€â”€ Slot quota â”€â”€ Fixed lifetime pool per (step model, account size), globally
    // lock-serialized so two users racing for the last slot can't both pass.
    const slotCheck = await assertSlotAvailable(client, stepModel.id, account_size)
    if (!slotCheck.ok) {
      await client.query('ROLLBACK')
      if (slotCheck.reason === 'full') {
        return res.status(403).json({
          error: `All ${slotCheck.limit} slots for the ${stepModel.name} $${account_size.toLocaleString()} account have been claimed.`,
          quota_full: true
        })
      }
      return res.status(403).json({
        error: `The $${account_size.toLocaleString()} ${stepModel.name} account size is currently locked by the administrator.`,
        locked: true
      })
    }

    // â”€â”€ Create the account â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const profitTargetPct = parseFloat(stepModel.profit_targets_pct[0])
    const dayLimit = parseInt(stepModel.time_limits_days[0], 10)
    const consistencyPct = Array.isArray(stepModel.consistency_max_day_pct_by_phase)
      ? parseFloat(stepModel.consistency_max_day_pct_by_phase[0])
      : parseFloat(stepModel.consistency_max_day_pct)
    const profit_target  = account_size * (profitTargetPct / 100)
    const account_uid    = await generateAccountUid(client, { accountType: 'phase1', challengeModelSlug: stepModel.slug })

    // Phase end date in UTC to avoid timezone off-by-one
    const phase_end_date = new Date()
    phase_end_date.setUTCDate(phase_end_date.getUTCDate() + dayLimit)
    phase_end_date.setUTCHours(23, 59, 59, 999)

    const newAccount = await client.query(
      `INSERT INTO accounts
       (user_id, account_type, account_size, current_balance, starting_balance, peak_balance,
        profit_target, max_drawdown_pct, status, phase_start_date, phase_end_date, account_uid,
        challenge_model_id, challenge_model_slug, step_number, daily_drawdown_pct, drawdown_type,
        consistency_max_day_pct, min_trading_days, min_daily_profit_pct, eod_peak_equity, qualifying_days_count)
       VALUES ($1, 'phase1', $2, $2, $2, $2, $3, $4, 'active', NOW(), $5, $6,
               $7, $8, 1, $9, $10, $11, $12, $13, $2, 0)
       RETURNING *`,
      [
        req.user.userId, account_size, profit_target, stepModel.max_drawdown_pct, phase_end_date, account_uid,
        stepModel.id, stepModel.slug, stepModel.daily_drawdown_pct, stepModel.drawdown_type,
        consistencyPct, stepModel.min_trading_days, stepModel.min_daily_profit_pct
      ]
    )

    await client.query('COMMIT')

    logger.info(
      `${stepModel.name} account created for user ${req.user.userId}: $${account_size} ` +
      `| target: ${profitTargetPct}% ($${profit_target}) ` +
      `| max DD: ${stepModel.max_drawdown_pct}% | days: ${dayLimit}`
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
      message: `${stepModel.name} challenge account created successfully`,
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
    const result = await pool.query(
      `SELECT a.id, a.user_id, a.account_type, a.account_size, a.current_balance, a.starting_balance,
              a.peak_balance, a.status, a.profit_target, a.max_drawdown_pct, a.created_at,
              a.phase_start_date, a.phase_end_date, a.account_uid, a.updated_at,
              a.challenge_model_slug, a.scaling_multiplier, a.scaling_milestones_claimed,
              c.title AS competition_title
         FROM accounts a
         LEFT JOIN competition_entries ce ON ce.account_id = a.id
         LEFT JOIN competitions c ON c.id = ce.competition_id
        WHERE a.user_id = $1
        ORDER BY a.created_at DESC`,
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
    if (!accountIdStr || isNaN(parseInt(accountIdStr))) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const result = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct, phase_end_date,
              consistency_max_day_pct, daily_drawdown_pct, challenge_model_slug, created_at,
              scaling_multiplier, scaling_milestones_claimed
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountIdStr, req.user.userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const account = result.rows[0]
    const settings = await loadTenantSettings([
      'phase1_profit_target_pct', 'phase1_max_drawdown_pct', 'phase1_day_limit',
      'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
      'funded_max_drawdown_pct', 'profit_share_pct',
      'max_daily_trades', 'min_hold_seconds', 'min_lot_size',
      'forex_lots_per_1k', 'commodity_lots_per_1k', 'max_trades_per_1k',
      'weekend_holding_enabled', 'inactivity_auto_fail_enabled', 'inactivity_fail_days',
      'payout_cycle_days'
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

    // Consistency score — same real "no single day's profit may exceed X% of
    // total profit" rule already enforced at payout time (payouts.js /
    // tradingDaysService.checkConsistencyRule), expressed here as a live 0-100
    // gauge instead of a pass/fail gate.
    const consistencyThresholdPct = parseFloat(account.consistency_max_day_pct || 0)
    const realizedProfit = Math.max(0, parseFloat((current - starting).toFixed(2)))
    let consistency = null
    if (consistencyThresholdPct > 0) {
      const bestDayProfit = realizedProfit > 0
        ? await tradingDaysService.getBestDayProfit(pool, accountIdStr)
        : 0
      const bestDayPct = realizedProfit > 0
        ? parseFloat(((bestDayProfit / realizedProfit) * 100).toFixed(2))
        : 0
      const score = realizedProfit > 0
        ? Math.max(0, Math.min(100, parseFloat((100 - (bestDayPct / consistencyThresholdPct) * 100).toFixed(1))))
        : null
      consistency = {
        score,
        best_day_pct: bestDayPct,
        best_day_profit: parseFloat(bestDayProfit.toFixed(2)),
        threshold_pct: consistencyThresholdPct,
        realized_profit: realizedProfit
      }
    }

    // Today's realized+floating P&L — used by both the daily-drawdown %
    // below and the Dashboard's "Today's P&L" KPI, so compute it once
    // regardless of whether a daily drawdown limit is even configured.
    const todayRealizedMap = await tradingDaysService.getTodayRealizedPnl(pool, [accountIdStr])
    const todayRealized = todayRealizedMap.get(accountIdStr) || todayRealizedMap.get(Number(accountIdStr)) || 0
    const today_pnl = parseFloat((todayRealized + floatingPnl).toFixed(2))
    const yesterdayEquity = parseFloat((equity - today_pnl).toFixed(2))
    const today_pnl_pct = yesterdayEquity > 0 ? parseFloat(((today_pnl / yesterdayEquity) * 100).toFixed(2)) : 0

    // Daily drawdown "% used" — mirrors the exact formula the live breach
    // monitor uses (trades.js periodic job): today's realized+floating loss
    // as a % of starting balance, divided by the daily limit %. Funded
    // accounts resolve their daily limit from the step model, same as the
    // breach job; challenge accounts use the account's own column.
    let resolvedDailyDrawdownPct = parseFloat(account.daily_drawdown_pct || 0)
    if (account.account_type === 'funded' && account.challenge_model_slug) {
      const fundedModel = await fetchStepModelBySlug(account.challenge_model_slug)
      if (fundedModel && Number.isFinite(parseFloat(fundedModel.funded_daily_drawdown_pct))) {
        resolvedDailyDrawdownPct = parseFloat(fundedModel.funded_daily_drawdown_pct)
      }
    }
    let daily_drawdown = null
    if (resolvedDailyDrawdownPct > 0 && starting > 0) {
      const todayLossAmount = today_pnl < 0 ? Math.abs(today_pnl) : 0
      const todayLossPct = parseFloat(((todayLossAmount / starting) * 100).toFixed(2))
      daily_drawdown = {
        used_pct: Math.min(parseFloat(((todayLossPct / resolvedDailyDrawdownPct) * 100).toFixed(1)), 100),
        limit_pct: resolvedDailyDrawdownPct,
        amount_used: parseFloat(todayLossAmount.toFixed(2)),
        limit_amount: parseFloat((starting * (resolvedDailyDrawdownPct / 100)).toFixed(2))
      }
    }

    // Payout cycle — informational only (doesn't gate payout requests, which
    // remain governed purely by the on-demand eligibility checks in
    // payouts.js). Cycle length is a platform setting; each account's own
    // cycle clock starts from when that funded account row was created.
    let payout_cycle = null
    if (account.account_type === 'funded') {
      const cycleDays = parseInt(settings.payout_cycle_days || 14, 10)
      const anchor = new Date(account.created_at).getTime()
      const msPerCycle = cycleDays * 24 * 60 * 60 * 1000
      const elapsed = Math.max(0, Date.now() - anchor)
      const cyclesElapsed = Math.floor(elapsed / msPerCycle) + 1
      const nextDate = new Date(anchor + cyclesElapsed * msPerCycle)
      const availableProfit = Math.max(0, current - starting)
      payout_cycle = {
        cycle_days: cycleDays,
        next_date: nextDate.toISOString(),
        estimated_share: parseFloat((availableProfit * (rules.profit_share_pct / 100)).toFixed(2))
      }
    }

    // Scaling-plan progress — mirrors challengeEngine.js's evaluateScalingPlan
    // milestone math exactly (net trading profit excludes past scaling
    // injections, see that function's header comment) so the dashboard shows
    // the same "% to next milestone" the engine itself uses to decide when to
    // grant the next one. Server-computed (not left to the client) so the
    // ledger-subtraction logic isn't duplicated/exposed on the frontend.
    let scaling = null
    if (account.account_type === 'funded' && account.challenge_model_slug) {
      const scalingModel = await fetchStepModelBySlug(account.challenge_model_slug)
      if (scalingModel && scalingModel.scaling_enabled) {
        const targetPct = parseFloat(scalingModel.scaling_target_pct)
        const increasePerMilestonePct = parseFloat(scalingModel.scaling_increase_per_milestone_pct || 0)
        const maxAccountSize = parseFloat(scalingModel.scaling_max_account_size || 0)
        if (targetPct > 0 && starting > 0) {
          const injectedResult = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) AS total FROM balance_adjustments
              WHERE account_id = $1 AND source = 'scaling_capital_increase'`,
            [accountIdStr]
          )
          const totalIncreased = parseFloat(injectedResult.rows[0].total || 0)
          const netTradingProfitPct = ((current - starting - totalIncreased) / starting) * 100
          const milestonesClaimed = parseInt(account.scaling_milestones_claimed || 0, 10)
          const progressWithinMilestonePct = Math.max(0, netTradingProfitPct - milestonesClaimed * targetPct)
          const headroomReached = maxAccountSize > 0 && (starting + totalIncreased + (starting * increasePerMilestonePct / 100)) > maxAccountSize

          scaling = {
            multiplier: parseFloat(account.scaling_multiplier || 1),
            milestones_claimed: milestonesClaimed,
            target_pct: targetPct,
            increase_per_milestone_pct: increasePerMilestonePct,
            per_milestone_amount: parseFloat((starting * increasePerMilestonePct / 100).toFixed(2)),
            max_account_size: maxAccountSize || null,
            total_increased: parseFloat(totalIncreased.toFixed(2)),
            progress_pct: headroomReached ? 100 : Math.max(0, Math.min(100, parseFloat(((progressWithinMilestonePct / targetPct) * 100).toFixed(1)))),
            headroom_reached: headroomReached
          }
        }
      }
    }

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
        daily_drawdown,
        today_pnl,
        today_pnl_pct,
        floating_pnl: parseFloat(floatingPnl.toFixed(2)),
        equity,
        days_remaining,
        trades_today,
        last_trade_at,
        consistency,
        payout_cycle,
        scaling
      }
    })

  } catch (error) {
    logger.error('Stats error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch stats' })
  }
})

// Shared by the competition-prize-voucher and referral-season-prize-voucher
// branches below (both are the same "code + user_id -> pre-paid order" shape;
// gift_vouchers is different enough — email-scoped, recipient may not have
// existed at issuance — that it stays its own function in utils/giftVouchers.js).
// Caller must already be inside an open transaction on `client`.
async function redeemUserScopedVoucherRow(client, { table, voucher, userId, paidVia, metadata }) {
  if (voucher.status === 'issued' && voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
    await client.query(`UPDATE ${table} SET status = 'expired', updated_at = NOW() WHERE id = $1`, [voucher.id])
    return { ok: false, status: 410, error: 'This voucher has expired' }
  }
  if (voucher.status !== 'issued') {
    return { ok: false, status: 409, error: 'This voucher has already been used or is no longer valid' }
  }

  const stepModel = await fetchStepModelBySlug(voucher.challenge_model_slug)
  if (!stepModel) {
    return { ok: false, status: 400, error: 'The challenge model for this voucher is no longer available. Please contact support.' }
  }

  const orderInsert = await client.query(
    `INSERT INTO challenge_orders (
       user_id, account_size, amount, currency, status, checkout_mode, payment_provider, paid_via, paid_at,
       challenge_model_id, challenge_model_slug, metadata_json
     ) VALUES (
       $1, $2, 0, 'USD', 'paid', 'voucher', NULL, $3, NOW(), $4, $5, $6::jsonb
     )
     RETURNING *`,
    [userId, voucher.account_size, paidVia, stepModel.id, voucher.challenge_model_slug, JSON.stringify(metadata)]
  )

  await client.query(
    `UPDATE ${table} SET status = 'redeemed', redeemed_at = NOW(), redeemed_order_id = $1, updated_at = NOW() WHERE id = $2`,
    [orderInsert.rows[0].id, voucher.id]
  )

  return { ok: true, order: orderInsert.rows[0] }
}

router.post('/orders', authenticateToken, async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureChallengeOrderInfrastructure()
    await ensureStepModelInfrastructure()

    // ── Prize/gift voucher redemption ──────────────────────────────────────────
    // Bypasses pricing/Stripe entirely: turns the voucher directly into a
    // pre-paid challenge_orders row so the existing POST /accounts/create gate
    // (which only checks for a challenge_orders row belonging to this user with
    // matching account_size and status='paid') needs zero changes. Tries three
    // independently-owned voucher tables in turn — competition prizes
    // (competitionEngine.js), referral-season prizes (referralSeasonEngine.js),
    // then gift-a-challenge (utils/giftVouchers.js, email-scoped rather than
    // user_id-scoped since a gift's recipient may not exist yet at issuance).
    const voucherCode = String(req.body?.voucher_code || '').trim()
    if (voucherCode) {
      try {
        await client.query('BEGIN')
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('competition_voucher'), hashtext($1))`, [voucherCode])

        const competitionVoucherResult = await client.query(
          `SELECT * FROM competition_prize_vouchers WHERE code = $1 AND user_id = $2 FOR UPDATE`,
          [voucherCode, req.user.userId]
        )
        const seasonVoucherResult = competitionVoucherResult.rows[0] ? null : await client.query(
          `SELECT * FROM referral_season_prize_vouchers WHERE code = $1 AND user_id = $2 FOR UPDATE`,
          [voucherCode, req.user.userId]
        )

        let redemption
        if (competitionVoucherResult.rows[0]) {
          const voucher = competitionVoucherResult.rows[0]
          redemption = await redeemUserScopedVoucherRow(client, {
            table: 'competition_prize_vouchers',
            voucher,
            userId: req.user.userId,
            paidVia: 'competition_voucher',
            metadata: { voucher_code: voucher.code, competition_id: voucher.competition_id }
          })
        } else if (seasonVoucherResult.rows[0]) {
          const voucher = seasonVoucherResult.rows[0]
          redemption = await redeemUserScopedVoucherRow(client, {
            table: 'referral_season_prize_vouchers',
            voucher,
            userId: req.user.userId,
            paidVia: 'referral_season_voucher',
            metadata: { voucher_code: voucher.code, referral_season_id: voucher.season_id }
          })
        } else {
          redemption = await redeemGiftVoucher(client, {
            code: voucherCode,
            userEmail: req.user.email,
            userId: req.user.userId
          })
        }

        if (!redemption.ok) {
          await client.query(redemption.status === 410 ? 'COMMIT' : 'ROLLBACK')
          return res.status(redemption.status || 404).json({ error: redemption.error || 'Voucher not found' })
        }

        await client.query('COMMIT')
        return res.status(201).json({
          order: redemption.order,
          requires_payment: false,
          payment_configured: true,
          checkout_url: null,
          checkout_session_id: null,
          voucher_redeemed: true
        })
      } catch (voucherErr) {
        await client.query('ROLLBACK').catch(() => {})
        logger.error('Redeem voucher error:', { error: voucherErr.message })
        return res.status(500).json({ error: 'Could not redeem voucher' })
      }
    }

    const accountSize = parseInt(req.body.account_size, 10)
    const stepModelSlug = String(req.body.step_model || '').trim().toLowerCase()

    if (!Number.isFinite(accountSize) || !STEP_MODEL_ACCOUNT_SIZES.includes(accountSize)) {
      return res.status(400).json({ error: 'Invalid account size' })
    }

    // Gift-a-challenge: buyer pays as normal below, but the resulting paid
    // order issues a gift_vouchers row (see utils/giftVouchers.js) instead of
    // the buyer's own POST /accounts/create ever being called for it.
    const isGift = !!req.body?.is_gift
    const giftRecipientEmail = isGift ? String(req.body?.recipient_email || '').trim().toLowerCase() : null
    const giftMessage = isGift ? String(req.body?.gift_message || '').trim().slice(0, 500) : null
    if (isGift && !isValidEmail(giftRecipientEmail)) {
      return res.status(400).json({ error: 'A valid recipient email is required to send this as a gift' })
    }
    if (isGift && req.user.email && giftRecipientEmail === String(req.user.email).trim().toLowerCase()) {
      return res.status(400).json({ error: "You can't gift a challenge to your own email address" })
    }

    const stepModel = await fetchStepModelBySlug(stepModelSlug)
    if (!stepModel || !stepModel.is_active) {
      return res.status(400).json({ error: 'This challenge model is not available right now.' })
    }

    const priceRow = await fetchStepModelPrice(stepModelSlug, accountSize)
    if (!priceRow || !priceRow.is_active) {
      return res.status(400).json({ error: 'This account size is not available for the selected challenge model.' })
    }
    // Fail-fast UX guard only — not locking, not authoritative. The real,
    // race-safe gate is assertSlotAvailable() inside POST /create, which runs
    // right before the account is actually provisioned.
    if (priceRow.locked) {
      return res.status(400).json({
        error: `All slots for the ${stepModel.name} $${accountSize.toLocaleString()} challenge have been claimed.`,
        quota_full: true
      })
    }

    const settings = await loadTenantSettings([
      'payment_provider',
      'affiliate_program_enabled',
      'affiliate_referred_discount_pct'
    ])
    const paymentProvider = String(settings.payment_provider || '').trim()
    let amount = parseFloat(priceRow.price)
    const currency = 'USD'

    // Referred-user discount — first paid challenge purchase only. The affiliate's
    // own commission is a separate, lifetime concern handled in billing.js's
    // markChallengeOrderPaid (fires on every paid order, not just this one).
    let discountApplied = null
    if (parseBooleanSetting(settings.affiliate_program_enabled, true)) {
      const referralResult = await client.query(
        `SELECT 1 FROM affiliate_referrals WHERE referred_user_id = $1`,
        [req.user.userId]
      )
      if (referralResult.rows.length > 0) {
        const priorPaidOrder = await client.query(
          `SELECT 1 FROM challenge_orders WHERE user_id = $1 AND status = 'paid' LIMIT 1`,
          [req.user.userId]
        )
        const discountPct = parseFloat(settings.affiliate_referred_discount_pct || 0)
        if (priorPaidOrder.rows.length === 0 && discountPct > 0) {
          const originalAmount = amount
          const discountedAmount = Math.round(originalAmount * (1 - discountPct / 100) * 100) / 100
          discountApplied = { pct: discountPct, original_amount: originalAmount, discounted_amount: discountedAmount }
          amount = discountedAmount
        }
      }
    }
    await client.query('BEGIN')

    // Admin-created coupon code (routes/adminCoupons.js) — stacks on top of
    // the referral discount above. GET /coupons/validate/:code is a preview
    // only; this is the authoritative check, done under an advisory lock so
    // concurrent redemptions of a code near its max_redemptions can't both pass.
    let couponApplied = null
    const couponCode = String(req.body?.coupon_code || '').trim()
    if (couponCode) {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('coupon_code'), hashtext($1))`, [couponCode.toUpperCase()])
      const couponCheck = await validateCouponForCheckout(client, { code: couponCode, userId: req.user.userId, amount })
      if (!couponCheck.valid) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: couponCheck.error })
      }
      couponApplied = {
        coupon_id: couponCheck.coupon.id,
        code: couponCheck.coupon.code,
        discount_type: couponCheck.coupon.discount_type,
        discount_value: couponCheck.coupon.discount_value,
        discount_amount: couponCheck.discount_amount,
        original_amount: amount
      }
      amount = couponCheck.final_amount
    }

    const metadata = {}
    if (discountApplied) {
      metadata.affiliate_discount_applied = true
      metadata.affiliate_discount_pct = discountApplied.pct
      metadata.original_amount = discountApplied.original_amount
    }
    if (couponApplied) {
      metadata.coupon_code = couponApplied.code
      metadata.coupon_discount_amount = couponApplied.discount_amount
    }
    if (isGift && giftMessage) {
      metadata.gift_message = giftMessage
    }
    const metadataJson = JSON.stringify(metadata)

    // A referral discount and/or coupon can bring the price to $0 — treat that
    // exactly like a competition-voucher redemption (see above): the order is
    // already fully paid, so there's nothing for Stripe to charge. Creating a
    // $0 Checkout Session isn't just pointless, Stripe rejects it outright.
    const isFreeOrder = amount <= 0

    const orderInsert = await client.query(
      `INSERT INTO challenge_orders (
         user_id, account_size, amount, currency, status, checkout_mode, payment_provider, paid_via, paid_at,
         challenge_model_id, challenge_model_slug, metadata_json, is_gift, gift_recipient_email
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14
       )
       RETURNING *`,
      [
        req.user.userId,
        accountSize,
        amount,
        currency,
        isFreeOrder ? 'paid' : 'pending',
        isFreeOrder ? 'coupon' : 'paid',
        isFreeOrder ? null : (paymentProvider || null),
        isFreeOrder ? 'coupon' : null,
        isFreeOrder ? new Date() : null,
        stepModel.id,
        stepModelSlug,
        metadataJson,
        isGift,
        giftRecipientEmail
      ]
    )

    if (couponApplied) {
      await recordCouponRedemption(client, {
        couponId: couponApplied.coupon_id,
        userId: req.user.userId,
        orderId: orderInsert.rows[0].id,
        discountAmount: couponApplied.discount_amount
      })
    }

    // Free (fully discounted) gift orders are already "paid" — issue the
    // voucher now, inside the same transaction, instead of waiting on a
    // Stripe webhook that will never come for a $0 order. Paid gift orders
    // going through Stripe are handled in billing.js's markChallengeOrderPaid.
    if (isFreeOrder && isGift) {
      await issueGiftVoucherForOrder(client, orderInsert.rows[0])
    }

    await client.query('COMMIT')

    let checkout = null
    if (!isFreeOrder && paymentProvider.toLowerCase() === 'stripe') {
      checkout = await createChallengePaymentSession({
        req,
        orderId: orderInsert.rows[0].id,
        userId: req.user.userId
      })
    }

    res.status(201).json({
      order: orderInsert.rows[0],
      requires_payment: !isFreeOrder,
      payment_configured: isFreeOrder ? true : !!paymentProvider,
      checkout_url: checkout?.checkout_url || null,
      checkout_session_id: checkout?.checkout_session_id || null,
      discount_applied: discountApplied,
      coupon_applied: couponApplied
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
// GET /api/accounts/coupons/validate/:code
// Preview only — shown on the Checkout page before the order is created. The
// authoritative check happens again (with a row lock) inside POST /orders.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/coupons/validate/:code', authenticateToken, async function(req, res) {
  try {
    const accountSize = parseInt(req.query.account_size, 10)
    const stepModelSlug = String(req.query.step_model || '').trim().toLowerCase()
    if (!Number.isFinite(accountSize) || !stepModelSlug) {
      return res.status(400).json({ valid: false, error: 'account_size and step_model are required' })
    }

    const priceRow = await fetchStepModelPrice(stepModelSlug, accountSize)
    if (!priceRow || !priceRow.is_active) {
      return res.status(400).json({ valid: false, error: 'This account size is not available for the selected challenge model.' })
    }

    // base_amount lets the Checkout page preview against the price it's
    // already showing (which may include an active referral discount) —
    // purely cosmetic since POST /orders recomputes the real amount from
    // scratch, so it's fine to trust the caller here. Clamped to the real
    // price so a tampered value can't make a coupon look bigger than it is.
    const requestedBase = parseFloat(req.query.base_amount)
    const basePrice = parseFloat(priceRow.price)
    const amount = Number.isFinite(requestedBase) && requestedBase >= 0 && requestedBase <= basePrice
      ? requestedBase
      : basePrice

    const check = await validateCouponForCheckout(pool, {
      code: req.params.code,
      userId: req.user.userId,
      amount
    })
    if (!check.valid) return res.json({ valid: false, error: check.error })

    res.json({
      valid: true,
      code: check.coupon.code,
      discount_type: check.coupon.discount_type,
      discount_value: check.coupon.discount_value,
      discount_amount: check.discount_amount,
      final_amount: check.final_amount
    })
  } catch (error) {
    logger.error('Coupon validation error:', { error: error.message })
    res.status(500).json({ error: 'Could not validate coupon' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/gift-vouchers/:code/preview
// Public (no auth) — lets Register.jsx and Checkout.jsx show what a gift code
// is worth before the recipient logs in or creates an account.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/gift-vouchers/:code/preview', async function(req, res) {
  try {
    const code = String(req.params.code || '').trim().toUpperCase()
    if (!code) return res.status(400).json({ valid: false, error: 'Invalid code' })

    const result = await pool.query(
      `SELECT status, account_size, challenge_model_slug, expires_at, recipient_email
         FROM gift_vouchers WHERE code = $1`,
      [code]
    )
    const voucher = result.rows[0]
    if (!voucher) return res.json({ valid: false, error: 'Gift code not found' })
    if (voucher.status !== 'issued') return res.json({ valid: false, error: 'This gift has already been claimed or is no longer valid' })
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      return res.json({ valid: false, error: 'This gift has expired' })
    }

    res.json({
      valid: true,
      account_size: parseFloat(voucher.account_size),
      challenge_model_slug: voucher.challenge_model_slug,
      expires_at: voucher.expires_at,
      recipient_email: voucher.recipient_email
    })
  } catch (error) {
    logger.error('Gift voucher preview error:', { error: error.message })
    res.status(500).json({ valid: false, error: 'Could not check this gift code' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/orders/:id
// Lets the frontend poll an order's payment status after returning from Stripe
// checkout (webhook delivery can lag a few seconds behind the redirect).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/orders/:id', authenticateToken, async function(req, res) {
  try {
    const orderId = parseInt(req.params.id, 10)
    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ error: 'Invalid order id' })
    }
    const result = await pool.query(
      `SELECT id, account_size, amount, currency, status, challenge_model_slug, created_at, paid_at,
              is_gift, gift_recipient_email
         FROM challenge_orders
        WHERE id = $1 AND user_id = $2`,
      [orderId, req.user.userId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' })
    }
    res.json({ order: result.rows[0] })
  } catch (error) {
    logger.error('Fetch order error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch order' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/accounts/my-purchase-limit
// Returns the user's purchase count within the current rolling period and the
// date when the limit resets (i.e. when the oldest purchase exits the window).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-purchase-limit', authenticateToken, async function(req, res) {
  try {
    const settings = await loadTenantSettings(['max_accounts_per_user_per_period', 'user_purchase_period_days'])

    const max         = parseInt(settings.max_accounts_per_user_per_period || '0')
    const periodDays  = parseInt(settings.user_purchase_period_days || '30')

    if (!max || max <= 0) {
      return res.json({ limited: false, max: null, used: 0, period_days: periodDays, resets_at: null })
    }

    const periodStart = new Date()
    periodStart.setDate(periodStart.getDate() - periodDays)
    const r = await pool.query(
      `SELECT id, created_at FROM accounts
       WHERE user_id = $1 AND created_at >= $2
       ORDER BY created_at ASC`,
      [req.user.userId, periodStart.toISOString()]
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
