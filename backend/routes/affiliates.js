const express = require('express')
const router = express.Router()
const pool = require('../db')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const logger = require('../utils/logger')
const { authenticateToken } = require('./middleware')
const { getTenantSettingsMap, parseBooleanSetting } = require('../utils/tenantSettings')
const { enqueueAffiliatePayoutRequestedEmail } = require('../utils/emailQueue')
const {
  resolveAffiliateCode,
  fetchAffiliateSummary,
  fetchAffiliateReferrals,
  fetchAffiliateCommissions,
  fetchAffiliatePayouts,
  fetchAffiliateAnalytics
} = require('../utils/affiliates')

function buildReferralLink(req, affiliateCode) {
  if (!affiliateCode) return null
  const origin = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`
  return `${origin.replace(/\/$/, '')}/register?ref=${affiliateCode}`
}

function parsePagination(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20))
  return { page, pageSize }
}

// One request per 24h per user — mirrors payouts.js's payoutRequestLimiter.
const affiliatePayoutRequestLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 1,
  message: { error: 'You can submit one affiliate payout request per 24 hours. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req.ip))
})

// Whether the CURRENT (logged-in) user is eligible for the first-purchase
// referred-user discount — distinct from /me, which reports the user's own
// stats as a referrer, not their eligibility as someone else's referred buyer.
// Mirrors the eligibility check performed authoritatively in accounts.js's
// POST /orders; this is a preview only, shown before checkout.
router.get('/my-discount-eligibility', authenticateToken, async function(req, res) {
  try {
    const settings = await getTenantSettingsMap(['affiliate_program_enabled', 'affiliate_referred_discount_pct'])
    if (!parseBooleanSetting(settings.affiliate_program_enabled, true)) {
      return res.json({ eligible: false })
    }
    const referralResult = await pool.query(
      `SELECT 1 FROM affiliate_referrals WHERE referred_user_id = $1`,
      [req.user.userId]
    )
    if (referralResult.rows.length === 0) return res.json({ eligible: false })

    const priorPaidOrder = await pool.query(
      `SELECT 1 FROM challenge_orders WHERE user_id = $1 AND status = 'paid' LIMIT 1`,
      [req.user.userId]
    )
    const discountPct = parseFloat(settings.affiliate_referred_discount_pct || 0)
    const eligible = priorPaidOrder.rows.length === 0 && discountPct > 0
    res.json({ eligible, discount_pct: eligible ? discountPct : 0 })
  } catch (error) {
    logger.error('Affiliate discount eligibility error:', { error: error.message })
    res.status(500).json({ error: 'Could not check discount eligibility' })
  }
})

router.get('/me', authenticateToken, async function(req, res) {
  try {
    const summary = await fetchAffiliateSummary(req.user.userId)
    res.json({ ...summary, referral_link: buildReferralLink(req, summary.affiliate_code) })
  } catch (error) {
    logger.error('Affiliate summary error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch affiliate summary' })
  }
})

router.get('/referrals', authenticateToken, async function(req, res) {
  try {
    const { page, pageSize } = parsePagination(req)
    const result = await fetchAffiliateReferrals(req.user.userId, { page, pageSize })
    res.json(result)
  } catch (error) {
    logger.error('Affiliate referrals list error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch referrals' })
  }
})

router.get('/commissions', authenticateToken, async function(req, res) {
  try {
    const { page, pageSize } = parsePagination(req)
    const result = await fetchAffiliateCommissions(req.user.userId, { page, pageSize })
    res.json(result)
  } catch (error) {
    logger.error('Affiliate commissions list error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch commissions' })
  }
})

router.get('/analytics', authenticateToken, async function(req, res) {
  try {
    const result = await fetchAffiliateAnalytics(req.user.userId)
    res.json(result)
  } catch (error) {
    logger.error('Affiliate analytics error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch affiliate analytics' })
  }
})

router.get('/payouts', authenticateToken, async function(req, res) {
  try {
    const { page, pageSize } = parsePagination(req)
    const result = await fetchAffiliatePayouts(req.user.userId, { page, pageSize })
    res.json(result)
  } catch (error) {
    logger.error('Affiliate payouts list error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch payout history' })
  }
})

// Requests payout of a trader-chosen amount, up to their current available
// balance (v2: partial withdrawals allowed — settlement posts one negative
// ledger entry for the requested amount via settleAffiliatePayoutAmount,
// leaving any remainder available for a future request).
router.post('/payouts/request', authenticateToken, affiliatePayoutRequestLimiter, async function(req, res) {
  try {
    const { payment_method, payment_details, amount_requested } = req.body
    if (!payment_method || !payment_details) {
      return res.status(400).json({ error: 'Payment method and details are required' })
    }

    const requestedAmount = Math.round((parseFloat(amount_requested) || 0) * 100) / 100
    if (!(requestedAmount > 0)) {
      return res.status(400).json({ error: 'A valid payout amount is required' })
    }

    // Must match the options actually offered in the affiliate payout request form.
    const ALLOWED_PAYMENT_METHODS = ['usdt_trc20', 'usdt_bep20', 'usdt_erc20', 'usdt_polygon', 'btc', 'ltc']
    if (!ALLOWED_PAYMENT_METHODS.includes(String(payment_method))) {
      return res.status(400).json({ error: `Invalid payment method. Must be one of: ${ALLOWED_PAYMENT_METHODS.join(', ')}` })
    }

    const paymentDetailsStr = typeof payment_details === 'object'
      ? JSON.stringify(payment_details)
      : String(payment_details).trim()
    if (!paymentDetailsStr) {
      return res.status(400).json({ error: 'Payment details are required' })
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('affiliate_payout_request'), hashtext($1))`, [req.user.userId])

      const existingPending = await client.query(
        `SELECT id FROM affiliate_payout_requests WHERE affiliate_user_id = $1 AND status = 'pending'`,
        [req.user.userId]
      )
      if (existingPending.rows.length > 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'You already have a pending affiliate payout request' })
      }

      const balanceResult = await client.query(
        `SELECT COALESCE(SUM(commission_amount), 0) AS available_balance
           FROM affiliate_commissions
          WHERE referrer_user_id = $1 AND status IN ('available','adjusted')`,
        [req.user.userId]
      )
      const availableBalance = parseFloat(balanceResult.rows[0]?.available_balance || 0)

      const settings = await getTenantSettingsMap(['affiliate_min_payout_amount'])
      const minPayout = parseFloat(settings.affiliate_min_payout_amount || 50)

      if (availableBalance < minPayout) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Minimum payout amount is $${minPayout}. Your current available balance is $${availableBalance.toFixed(2)}.`
        })
      }
      if (requestedAmount < minPayout) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Minimum payout amount is $${minPayout}.` })
      }
      if (requestedAmount > availableBalance) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Requested amount exceeds your available balance of $${availableBalance.toFixed(2)}.` })
      }

      const insertResult = await client.query(
        `INSERT INTO affiliate_payout_requests (affiliate_user_id, amount_requested, payment_method, payment_details)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.user.userId, requestedAmount, String(payment_method).trim(), paymentDetailsStr]
      )

      await client.query('COMMIT')

      try {
        const userResult = await pool.query(`SELECT email, full_name FROM users WHERE id = $1`, [req.user.userId])
        const user = userResult.rows[0]
        if (user?.email) {
          await enqueueAffiliatePayoutRequestedEmail(user.email, user.full_name, requestedAmount, { userId: req.user.userId })
        }
      } catch (emailErr) {
        logger.warn('Failed to enqueue affiliate payout requested email:', { error: emailErr.message })
      }

      res.status(201).json({ payout_request: { ...insertResult.rows[0], amount_requested: parseFloat(insertResult.rows[0].amount_requested) } })
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  } catch (error) {
    logger.error('Affiliate payout request error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit payout request' })
  }
})

// Public — returns only whether a code is valid + the discount it unlocks, never
// the referrer's identity, to avoid code-enumeration/PII leakage.
router.get('/validate-code/:code', async function(req, res) {
  try {
    const settings = await getTenantSettingsMap(['affiliate_program_enabled', 'affiliate_referred_discount_pct'])
    if (!parseBooleanSetting(settings.affiliate_program_enabled, true)) {
      return res.json({ valid: false })
    }
    const referrer = await resolveAffiliateCode(req.params.code)
    if (!referrer) return res.json({ valid: false })
    res.json({ valid: true, discount_pct: parseFloat(settings.affiliate_referred_discount_pct || 0) })
  } catch (error) {
    logger.error('Affiliate code validation error:', { error: error.message })
    res.status(500).json({ error: 'Could not validate code' })
  }
})

// Public — landing page / register page display only.
router.get('/settings-public', async function(req, res) {
  try {
    const settings = await getTenantSettingsMap(['affiliate_program_enabled', 'affiliate_referred_discount_pct'])
    res.json({
      program_enabled: parseBooleanSetting(settings.affiliate_program_enabled, true),
      referred_discount_pct: parseFloat(settings.affiliate_referred_discount_pct || 0)
    })
  } catch (error) {
    logger.error('Affiliate public settings error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch affiliate settings' })
  }
})

module.exports = router
