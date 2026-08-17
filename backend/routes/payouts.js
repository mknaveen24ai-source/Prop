const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const { createLimiter } = require('../utils/security')
const { ipKeyGenerator } = require('express-rate-limit')
const logger = require('../utils/logger')
const { getTenantSettings } = require('../services/tenantPolicyService')
const { enqueuePayoutRequestedEmail } = require('../utils/emailQueue')
const tradingDaysService = require('../services/tradingDaysService')
const { fetchStepModelBySlug } = require('../utils/stepModels')
const { isValidUUID } = require('../utils/validation')
const {
  recordSignals,
  normalizePayoutDestination,
  SIGNAL_TYPES
} = require('../services/identitySignals')
const {
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} = require('../utils/idempotency')

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// FIX (H3): Withdrawal rate limiting - prevent spam of payout requests
const payoutRequestLimiter = createLimiter('payout-request', {
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours
  max: 1,                          // 1 request per 24 hours per user
  message: { error: 'You can submit one payout request per 24 hours. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req.ip)
  }
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
router.post('/request', authenticateToken, payoutRequestLimiter, async function(req, res) {
  try {
    const { account_id, amount_requested, payment_method, payment_details } = req.body

    if (!account_id || !amount_requested || !payment_method || !payment_details) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    // Must match the options actually offered in the payout request form.
    const ALLOWED_PAYMENT_METHODS = ['usdt_trc20', 'usdt_bep20', 'usdt_erc20', 'usdt_polygon', 'btc', 'ltc']
    if (!ALLOWED_PAYMENT_METHODS.includes(String(payment_method))) {
      return res.status(400).json({ error: `Invalid payment method. Must be one of: ${ALLOWED_PAYMENT_METHODS.join(', ')}` })
    }

    // Account ids are UUIDs — the earlier numeric guard here rejected any id
    // starting with a letter, so payout requests on those accounts 400'd.
    const accountIdStr = String(account_id || '').trim()
    if (!isValidUUID(accountIdStr)) {
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

    // Resolved BEFORE the transaction opens. getTenantSettings() is usually a
    // cache hit, but on a miss it queries on a SEPARATE pool connection — and
    // doing that while holding a transaction that has FOR UPDATE on the account
    // row is the pool-deadlock shape described at beginIdempotentRequest below.
    // These are platform settings with no dependency on the locked row, so
    // reading them early changes nothing but the connection accounting.
    //
    // FIX (L-04): this used to issue its own `SELECT value FROM
    // platform_settings WHERE key = 'profit_share_pct'` and then immediately
    // discard the result -- getTenantSettings() already resolves the same key,
    // and its value won. One wasted round-trip per payout request, and two
    // apparent sources of truth for the same number.
    const payoutSettings = await getTenantSettings(['profit_share_pct'])
    const rawProfitShare = parseFloat(payoutSettings.profit_share_pct)
    if (!Number.isFinite(rawProfitShare) || rawProfitShare <= 0) {
      logger.warn('[PAYOUTS] profit_share_pct missing or invalid - defaulting to 80%.')
    }
    const effectiveProfitSharePct = (Number.isFinite(rawProfitShare) && rawProfitShare > 0 ? rawProfitShare : 80) / 100
    const amount_payable = parseFloat((amountNum * effectiveProfitSharePct).toFixed(2))

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
                peak_balance, status, created_at, challenge_model_slug
         FROM accounts
         WHERE id = $1
           AND user_id = $2
         FOR UPDATE`,
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

      const userProfile = await client.query(
        `SELECT email, full_name
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [req.user.userId]
      )
      const payoutEmail = userProfile.rows[0]?.email || null
      const payoutName = userProfile.rows[0]?.full_name || 'Trader'

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

      // ── Funded-stage eligibility gates (min trading days, min net profit, consistency) ──
      if (acc.challenge_model_slug) {
        const fundedModel = await fetchStepModelBySlug(acc.challenge_model_slug)
        if (fundedModel) {
          const minTradingDaysForPayout = parseInt(fundedModel.funded_min_trading_days_for_payout || 0, 10)
          if (minTradingDaysForPayout > 0) {
            const tradingDays = await tradingDaysService.countTradingDays(client, accountIdStr)
            if (tradingDays < minTradingDaysForPayout) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `You need to trade on at least ${minTradingDaysForPayout} distinct days before requesting a payout. You've traded on ${tradingDays} so far.`
              })
            }
          }

          const payoutMinNetProfitPct = parseFloat(fundedModel.funded_payout_min_net_profit_pct || 0)
          if (payoutMinNetProfitPct > 0) {
            const minProfitRequired = parseFloat(acc.starting_balance) * (payoutMinNetProfitPct / 100)
            if (realizedProfit < minProfitRequired) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Your account needs at least ${payoutMinNetProfitPct}% net profit ($${minProfitRequired.toFixed(2)}) before requesting a payout. Current profit: $${realizedProfit.toFixed(2)}.`
              })
            }
          }

          const consistencyPct = parseFloat(fundedModel.funded_consistency_max_day_pct || 0)
          if (consistencyPct > 0) {
            const consistency = await tradingDaysService.checkConsistencyRule(client, accountIdStr, realizedProfit, consistencyPct)
            if (!consistency.ok) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Your best single trading day represents ${consistency.bestDayPct.toFixed(1)}% of your total profit, exceeding this model's ${consistencyPct}% consistency limit. Keep trading to bring that ratio down, then request your payout.`
              })
            }
          }
        }
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

      // profit_share_pct and amount_payable are resolved before BEGIN — see the
      // note above pool.connect().

      // Ã¢â€â‚¬Ã¢â€â‚¬ Flag checks Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      let is_flagged = false
      const flagReasons = []

      try {
        // FIX (HIGH #9): Add cumulative payout tracking to prevent bypass by splitting withdrawals
        const flagResult = await client.query(
          `SELECT
             EXTRACT(EPOCH FROM (NOW() - a.created_at))/86400  AS account_age_days,
             COUNT(t.id) FILTER (WHERE t.status = 'closed')                   AS total_closed_trades,
             COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)  AS winning_trades,
             COALESCE(MAX(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)     AS max_single_trade_pnl,
             COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)     AS total_realised_pnl,
             COALESCE(SUM(p.amount_requested) FILTER (WHERE p.status IN ('pending', 'approved', 'paid')), 0) AS total_payouts_requested
           FROM accounts a
           LEFT JOIN trades t ON t.account_id = a.id
           LEFT JOIN payouts p ON p.account_id = a.id
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
        const totalPayoutsRequested = parseFloat(fd.total_payouts_requested || 0)
        const accountSize     = parseFloat(acc.account_size)

        // FIX (HIGH #9): Cumulative payout check prevents splitting withdrawal bypass
        if (totalPayoutsRequested + amountNum > accountSize * 0.80 && accountAgeDays < 30) {
          is_flagged = true
          flagReasons.push(`Cumulative payouts ($${(totalPayoutsRequested + amountNum).toFixed(2)}) exceed 80% of account size within 30 days`)
        }

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

      // `client`, not `pool` — two separate reasons, both load-bearing.
      //
      // DEADLOCK: this runs while `client` holds an open transaction with
      // FOR UPDATE on the account row. Asking the same pool for a SECOND
      // connection here means each in-flight payout holds one connection and
      // waits for another. At DB_POOL_MAX concurrent requests every connection
      // is held by a request waiting for one that will never be freed;
      // connectionTimeoutMillis turns the deadlock into a 5s stall and a 500
      // rather than a hang, but the endpoint still collapses under load.
      //
      // ATOMICITY: inside the transaction, the claim commits with the payout and
      // rolls back with it. That removes the window where a crash between COMMIT
      // and completeIdempotentRequest left a claim stuck in 'started' forever —
      // permanently 409-ing every retry of that key, i.e. a trader who can never
      // resubmit their withdrawal.
      const idempotencyResult = await beginIdempotentRequest(client, {
        scope: 'payouts:request',
        actorId: req.user.userId,
        idempotencyKey: getIdempotencyKey(req)
      })
      // FIX (H-03): a missing Idempotency-Key used to disable replay protection
      // entirely on this endpoint. A replayed POST is a duplicate withdrawal.
      if (idempotencyResult.required) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: idempotencyResult.error })
      }
      if (idempotencyResult.replay) {
        await client.query('ROLLBACK')
        return res.status(idempotencyResult.responseStatus).json(idempotencyResult.responseBody)
      }
      if (idempotencyResult.inProgress) {
        await client.query('ROLLBACK')
        return res.status(409).json({ error: 'This payout request is already being processed.' })
      }
      // Scoped to the transaction that owns it, now that the claim lives and
      // dies with that transaction rather than outliving the handler.
      const idempotencyClaim = idempotencyResult.claimId || null

      const payout = await client.query(
        `INSERT INTO payouts
         (user_id, account_id, amount_requested, amount_payable, payment_method, payment_details, status, is_flagged, flag_reason)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
         RETURNING *`,
        [req.user.userId, accountIdStr, amountNum, amount_payable, payment_method, paymentDetailsStr, is_flagged, flagReasons.join(' | ') || null]
      )

      const responseBody = {
        message: 'Payout request submitted successfully',
        payout: payout.rows[0]
      }
      // Completed BEFORE the commit, so the claim and the payout land together.
      if (idempotencyClaim) {
        await completeIdempotentRequest(client, idempotencyClaim, 201, responseBody)
      }

      await client.query('COMMIT')

      // Payout destination is the hardest signal for a passing service to evade:
      // however many accounts they run, they have to be paid somewhere. Hashed,
      // never stored in plaintext here — see services/identitySignals.js.
      const destinationSignal = normalizePayoutDestination(paymentDetailsStr)
      if (destinationSignal) {
        recordSignals(
          req.user.userId,
          [{ type: SIGNAL_TYPES.PAYOUT_DEST, value: destinationSignal }],
          'payout'
        )
      }

      if (payoutEmail) {
        try {
          await enqueuePayoutRequestedEmail(
            payoutEmail,
            payoutName,
            amountNum,
            amount_payable,
            payment_method,
            {
              userId: req.user.userId
            }
          )
        } catch (emailErr) {
          logger.error('[payouts] Failed to enqueue payout requested email', {
            error: emailErr.message,
            userId: req.user.userId,
            payoutId: payout.rows[0]?.id || null
          })
        }
      }

      res.status(201).json(responseBody)
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

  } catch (error) {
    // No abandonIdempotentRequest here any more: the claim is created on
    // `client` inside the transaction, so any path that reaches this handler has
    // already rolled it back. An explicit DELETE would target a row that no
    // longer exists — harmless, but it would imply the claim outlives the
    // transaction, which is exactly the confusion this restructuring removes.
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

router.get('/statement', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT p.id, p.account_id, p.amount_requested, p.amount_payable,
              p.payment_method, p.status, p.requested_at, p.paid_at,
              p.transaction_id, a.account_uid, a.account_size
       FROM payouts p
       JOIN accounts a ON p.account_id = a.id
       WHERE p.user_id = $1
       ORDER BY p.requested_at DESC`,
      [req.user.userId]
    )

    const rows = result.rows
    const totalRequested = rows.reduce((sum, row) => sum + (parseFloat(row.amount_requested) || 0), 0)
    const totalPaid = rows.reduce((sum, row) => {
      if (row.status !== 'paid') return sum
      return sum + (parseFloat(row.amount_payable) || 0)
    }, 0)
    const formatDateTime = value => {
      if (!value) return '-'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '-'
      return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    }

    const rowHtml = rows.length > 0
      ? rows.map(row => `
          <tr>
            <td>PAY-${String(row.id).padStart(5, '0')}</td>
            <td>${escapeHtml(row.account_uid || row.account_id)}</td>
            <td>$${(parseFloat(row.amount_requested) || 0).toFixed(2)}</td>
            <td>$${(parseFloat(row.amount_payable) || 0).toFixed(2)}</td>
            <td>${escapeHtml(String(row.payment_method || 'N/A').replace(/_/g, ' '))}</td>
            <td>${escapeHtml(row.status || 'unknown')}</td>
            <td>${escapeHtml(formatDateTime(row.requested_at))}</td>
            <td>${escapeHtml(formatDateTime(row.paid_at))}</td>
            <td>${escapeHtml(row.transaction_id || '-')}</td>
          </tr>
        `).join('')
      : `
        <tr>
          <td colspan="9" class="empty">No payout records found.</td>
        </tr>
      `

    res.set('Cache-Control', 'no-store')
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Payout Statement</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111827; margin: 32px; }
    h1 { margin: 0 0 8px; }
    p { margin: 0; color: #4b5563; }
    .summary { display: flex; gap: 16px; margin: 24px 0; }
    .card { border: 1px solid #d1d5db; border-radius: 10px; padding: 16px; min-width: 200px; }
    .label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; }
    .value { font-size: 28px; font-weight: 700; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { border-bottom: 1px solid #e5e7eb; text-align: left; padding: 12px; font-size: 14px; }
    th { color: #374151; background: #f9fafb; }
    .empty { text-align: center; color: #6b7280; padding: 32px 12px; }
    @media print { body { margin: 0; } .summary { break-inside: avoid; } }
  </style>
</head>
<body>
  <h1>Payout Statement</h1>
  <p>Generated ${escapeHtml(formatDateTime(new Date()))}</p>
  <div class="summary">
    <div class="card">
      <div class="label">Total Requested</div>
      <div class="value">$${totalRequested.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="label">Total Paid</div>
      <div class="value">$${totalPaid.toFixed(2)}</div>
    </div>
    <div class="card">
      <div class="label">Records</div>
      <div class="value">${rows.length}</div>
    </div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Request</th>
        <th>Account</th>
        <th>Requested</th>
        <th>Payable</th>
        <th>Method</th>
        <th>Status</th>
        <th>Requested At</th>
        <th>Paid At</th>
        <th>Transaction</th>
      </tr>
    </thead>
    <tbody>${rowHtml}</tbody>
  </table>
</body>
</html>`)
  } catch (error) {
    logger.error('Payout statement error:', { error: error.message })
    res.status(500).send('Could not generate payout statement')
  }
})

// GET /api/payouts/settings
router.get('/settings', authenticateToken, async function(req, res) {
  try {
    const settings = await getTenantSettings(['profit_share_pct'])
    const profit_share_pct = parseFloat(settings.profit_share_pct || 80)
    res.json({ profit_share_pct })
  } catch (error) {
    logger.error('Payout settings error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch payout settings' })
  }
})

module.exports = router
