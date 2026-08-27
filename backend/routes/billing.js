const express = require('express')
const crypto = require('crypto')
const axios = require('axios')
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateToken } = require('./middleware')
const {
  ensureTenantSettingsInfrastructure,
  getTenantSettingsMap,
  parseBooleanSetting
} = require('../utils/tenantSettings')
const { computeEffectiveTier, clawbackCommissionForOrder } = require('../utils/affiliates')
const { enqueueAffiliateCommissionEarnedEmail } = require('../utils/emailQueue')
const { issueGiftVoucherForOrder } = require('../utils/giftVouchers')

const router = express.Router()

let billingInfrastructurePromise = null

function toMinorUnits(amount, currency = 'usd') {
  const normalizedCurrency = String(currency || 'usd').toLowerCase()
  const zeroDecimalCurrencies = new Set(['jpy', 'krw'])
  const multiplier = zeroDecimalCurrencies.has(normalizedCurrency) ? 1 : 100
  return Math.round((parseFloat(amount || 0) || 0) * multiplier)
}

function buildAbsoluteUrl(req, path) {
  const origin = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host') || 'localhost:3000'}`
  return new URL(path, origin).toString()
}

const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60

// FIX (SECURITY AUDIT): No replay-window check — a captured valid
// payload+signature could be replayed indefinitely. Stripe's own guidance is
// to reject anything older than ~5 minutes.
function verifyStripeWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false
  const parts = String(signatureHeader).split(',').map((part) => part.trim())
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2)
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3))
  if (!timestamp || signatures.length === 0) return false

  const timestampSeconds = parseInt(timestamp, 10)
  if (!Number.isFinite(timestampSeconds)) return false
  const ageSeconds = Math.abs(Date.now() / 1000 - timestampSeconds)
  if (ageSeconds > STRIPE_WEBHOOK_TOLERANCE_SECONDS) return false

  const payload = `${timestamp}.${rawBody.toString('utf8')}`
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return signatures.some((signature) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    } catch {
      return false
    }
  })
}

async function stripePost(endpoint, secretKey, formData = {}, stripeAccount = null) {
  const body = new URLSearchParams()
  Object.entries(formData).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    body.append(key, String(value))
  })

  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
  if (stripeAccount) headers['Stripe-Account'] = stripeAccount

  const response = await axios.post(`https://api.stripe.com/v1${endpoint}`, body.toString(), { headers, timeout: 15000 })
  return response.data
}

async function ensureBillingInfrastructure() {
  if (billingInfrastructurePromise) return billingInfrastructurePromise

  billingInfrastructurePromise = (async () => {
    await ensureTenantSettingsInfrastructure()

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_checkout_sessions (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES challenge_orders(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'stripe',
        checkout_session_id TEXT NOT NULL UNIQUE,
        checkout_url TEXT,
        provider_customer_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenge_checkout_sessions_order ON challenge_checkout_sessions(order_id, status)`)

    // Mirrors migration 043. Kept here as well because the webhook's replay
    // protection depends on this table existing, and a webhook that arrives
    // before the migration has run must not silently double-process.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id     TEXT PRIMARY KEY,
        event_type   TEXT NOT NULL,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `)
    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`)
    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ`)
    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC`)
  })().catch((error) => {
    billingInfrastructurePromise = null
    logger.error('[billing] Failed to ensure infrastructure:', { error: error.message })
    throw error
  })

  return billingInfrastructurePromise
}

async function createStripeCheckoutSession({
  secretKey,
  stripeAccount = null,
  mode,
  successUrl,
  cancelUrl,
  name,
  amount,
  currency,
  interval = 'month',
  metadata = {}
}) {
  const form = {
    mode,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][product_data][name]': name,
    'line_items[0][price_data][unit_amount]': toMinorUnits(amount, currency)
  }

  if (mode === 'subscription') {
    form['line_items[0][price_data][recurring][interval]'] = interval
  }

  Object.entries(metadata).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    form[`metadata[${key}]`] = String(value)
  })

  return stripePost('/checkout/sessions', secretKey, form, stripeAccount)
}

async function createChallengePaymentSession({ req, orderId, userId = null }) {
  await ensureBillingInfrastructure()
  const settings = await getTenantSettingsMap([
    'payment_provider',
    'payment_provider_secret_key',
    'payment_provider_account_id'
  ])
  const provider = String(settings.payment_provider || '').trim().toLowerCase()
  const secretKey = String(settings.payment_provider_secret_key || '').trim()
  const stripeAccount = String(settings.payment_provider_account_id || '').trim() || null
  if (provider !== 'stripe' || !secretKey) {
    return { configured: false, checkout_url: null }
  }

  // challenge_orders.user_id is TEXT holding a uuid, while id is bigint. Casting
  // $2 to bigint in the null-guard pinned the parameter's type for the whole
  // statement, so the ownership comparison became `text = bigint` and Postgres
  // refused to plan it -- every challenge checkout returned 500, ownership check
  // included. The cast goes on the PARAMETER, never the column, so any index on
  // user_id still applies.
  const orderResult = await pool.query(
    `SELECT id, user_id, amount, currency, account_size, status
       FROM challenge_orders
      WHERE id = $1
        AND ($2::text IS NULL OR user_id = $2::text)
      LIMIT 1`,
    [orderId, userId]
  )
  if (orderResult.rows.length === 0) {
    throw new Error('Challenge order not found')
  }
  const order = orderResult.rows[0]
  if (order.status === 'paid') {
    return { configured: true, checkout_url: null, already_paid: true }
  }

  const session = await createStripeCheckoutSession({
    secretKey,
    stripeAccount,
    mode: 'payment',
    successUrl: buildAbsoluteUrl(req, `/dashboard?checkout=success&order_id=${order.id}`),
    cancelUrl: buildAbsoluteUrl(req, `/dashboard?checkout=cancelled&order_id=${order.id}`),
    name: `$${parseFloat(order.account_size || 0).toLocaleString()} Challenge`,
    amount: parseFloat(order.amount || 0),
    currency: String(order.currency || 'usd').toLowerCase(),
    metadata: {
      flow: 'challenge_checkout',
      order_id: order.id,
      user_id: order.user_id
    }
  })

  await pool.query(
    `INSERT INTO challenge_checkout_sessions (
       order_id, provider, checkout_session_id, checkout_url, provider_customer_id, status, metadata_json, expires_at, updated_at
     ) VALUES (
       $1, 'stripe', $2, $3, $4, 'pending', $5::jsonb, to_timestamp($6), NOW()
     )
     ON CONFLICT (checkout_session_id) DO UPDATE SET
       checkout_url = EXCLUDED.checkout_url,
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, challenge_checkout_sessions.provider_customer_id),
       status = EXCLUDED.status,
       metadata_json = EXCLUDED.metadata_json,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [
      order.id,
      session.id,
      session.url || null,
      session.customer || null,
      JSON.stringify(session),
      session.expires_at || Math.floor(Date.now() / 1000) + 1800
    ]
  )

  await pool.query(
    `UPDATE challenge_orders
        SET provider_reference = $2,
            payment_provider = 'stripe',
            updated_at = NOW()
      WHERE id = $1`,
    [order.id, session.id]
  )

  return {
    configured: true,
    checkout_url: session.url,
    checkout_session_id: session.id
  }
}

async function markChallengeOrderPaid(client, { orderId, providerPaymentId, payload = {} }) {
  // The status guard is load-bearing. Without it a Stripe redelivery of
  // checkout.session.completed — which can arrive days later, and always
  // arrives after a manual dashboard refund — flipped a refunded or disputed
  // order straight back to 'paid', at which point POST /accounts/create would
  // happily issue the account it had just been refunded for.
  const orderResult = await client.query(
    `UPDATE challenge_orders
        SET status = 'paid',
            paid_via = COALESCE(paid_via, 'stripe_checkout'),
            paid_at = COALESCE(paid_at, NOW()),
            provider_reference = COALESCE($2, provider_reference),
            updated_at = NOW()
      WHERE id = $1
        AND status NOT IN ('refunded', 'disputed', 'cancelled')
      RETURNING *`,
    [orderId, providerPaymentId || null]
  )
  if (orderResult.rows.length === 0) {
    logger.warn('[billing] Ignoring paid webhook for an order that is not payable', { orderId: String(orderId) })
    return null
  }
  const order = orderResult.rows[0]

  const amount = parseFloat(order.amount || 0)

  await client.query(
    `INSERT INTO challenge_payments (
       order_id, provider, provider_payment_id, amount, currency, status, payload_json, updated_at
     ) VALUES (
       $1, 'stripe', $2, $3, $4, 'paid', $5::jsonb, NOW()
     )
     ON CONFLICT (order_id) DO NOTHING`,
    [
      order.id,
      providerPaymentId || null,
      amount,
      order.currency || 'USD',
      JSON.stringify(payload)
    ]
  )

  await client.query(
    `UPDATE challenge_checkout_sessions
        SET status = 'paid',
            updated_at = NOW(),
            metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb
      WHERE order_id = $1`,
    [order.id, JSON.stringify({ paid_at: new Date().toISOString() })]
  )

  // Gift-a-challenge: a paid gift order never gets its account created by the
  // buyer (accounts.js's post-checkout poll checks order.is_gift and skips
  // POST /accounts/create for it) — instead it issues a redeemable voucher
  // for the recipient. Free ($0) gift orders are handled synchronously in
  // accounts.js POST /orders since they never reach this webhook at all.
  if (order.is_gift) {
    await issueGiftVoucherForOrder(client, order)
  }

  // Affiliate commission — fires on EVERY paid order from a referred user, for
  // the lifetime of the referral relationship, not just their first purchase
  // (that first-purchase-only rule applies to the referred user's own discount,
  // applied earlier in accounts.js, and is intentionally independent of this).
  // The referrer's own email must be confirmed before commission accrues.
  // Paid checkout already requires the BUYER to be verified (requireVerifiedEmail
  // on POST /accounts/orders), so this closes the other half: an unverified
  // account cannot be used as a commission sink for self-referred orders.
  const referralResult = await client.query(
    `SELECT r.id, r.referrer_user_id, u.email_verified AS referrer_email_verified
       FROM affiliate_referrals r
       JOIN users u ON u.id = r.referrer_user_id
      WHERE r.referred_user_id = $1::uuid`,
    [order.user_id]
  )
  const referral = referralResult.rows[0]
  if (referral && referral.referrer_email_verified !== true) {
    logger.warn('[billing] Skipping affiliate commission — referrer email not verified', {
      referrer_user_id: String(referral.referrer_user_id), order_id: String(order.id)
    })
  }
  if (referral && referral.referrer_email_verified === true) {
    // Advisory-locked per referrer so concurrent webhook deliveries for two
    // different orders from the same referred user can't race on tier computation.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('affiliate_commission'), hashtext($1))`, [String(referral.referrer_user_id)])
    const affiliateSettings = await getTenantSettingsMap(['affiliate_program_enabled', 'affiliate_default_commission_pct'])
    if (parseBooleanSetting(affiliateSettings.affiliate_program_enabled, true)) {
      const { tier_rank, commission_pct } = await computeEffectiveTier(client, referral.referrer_user_id, order.user_id)
      const commissionAmount = Math.round(amount * (commission_pct / 100) * 100) / 100
      const commissionInsert = await client.query(
        `INSERT INTO affiliate_commissions
           (referral_id, referrer_user_id, referred_user_id, order_id, tier_rank, commission_rate_pct, order_amount, commission_amount, status)
         VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, 'available')
         ON CONFLICT (order_id) WHERE order_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [referral.id, referral.referrer_user_id, order.user_id, order.id, tier_rank, commission_pct, amount, commissionAmount]
      )
      // Non-fatal — a notification failure must never roll back a payment.
      // Only fires when a new row was actually inserted (not on webhook redelivery).
      if (commissionInsert.rows.length > 0) {
        try {
          const referrerResult = await client.query(`SELECT email, full_name FROM users WHERE id = $1`, [referral.referrer_user_id])
          const referredResult = await client.query(`SELECT full_name FROM users WHERE id = $1::uuid`, [order.user_id])
          const referrerUser = referrerResult.rows[0]
          if (referrerUser?.email) {
            await enqueueAffiliateCommissionEarnedEmail(
              referrerUser.email,
              referrerUser.full_name,
              commissionAmount,
              referredResult.rows[0]?.full_name || 'a trader you referred',
              { userId: referral.referrer_user_id }
            )
          }
        } catch (emailErr) {
          logger.warn('[billing] Failed to enqueue affiliate commission earned email:', { error: emailErr.message })
        }
      }
    }
  }

  return order
}

/**
 * Locate the challenge order a charge-level event refers to.
 *
 * Charge and dispute events carry no metadata of ours — that only rides on the
 * checkout session — so the payment intent recorded at capture time is the link
 * back. markChallengeOrderPaid stores it in provider_reference, and migration
 * 043 added the partial index that keeps this lookup off a sequential scan.
 *
 * Falls back to metadata when it is present (some flows do echo it) so a manual
 * refund raised against the session rather than the charge still resolves.
 */
async function findOrderForChargeEvent(client, dataObject) {
  const metadata = dataObject.metadata || {}
  if (metadata.flow === 'challenge_checkout' && metadata.order_id) {
    const byMetadata = await client.query(
      `SELECT * FROM challenge_orders WHERE id = $1`,
      [parseInt(metadata.order_id, 10)]
    )
    if (byMetadata.rows.length > 0) return byMetadata.rows[0]
  }

  const reference = dataObject.payment_intent || dataObject.charge || dataObject.id
  if (!reference) return null

  const byReference = await client.query(
    `SELECT * FROM challenge_orders WHERE provider_reference = $1 ORDER BY id DESC LIMIT 1`,
    [String(reference)]
  )
  return byReference.rows[0] || null
}

/**
 * Freeze every account issued from an order whose money has gone away.
 *
 * 'locked' rather than a new 'disputed' status, deliberately: it already exists
 * in the accounts status CHECK (migration 017), already blocks opening a trade
 * (routes/trades/open.js requires 'active'), and is already refused by
 * evaluatePayoutEligibility's NOT_ACTIVE blocker — so the freeze stops both
 * trading and withdrawal with no new state for the engine, the analytics and
 * every admin list filter to learn.
 *
 * Passed and failed accounts are left alone: the evaluation is over, and
 * reopening a settled outcome on a payment event would be worse than the
 * chargeback. Only a live account can still cost the firm money.
 */
async function freezeAccountsForOrder(client, order, reason) {
  // There is no accounts.challenge_order_id — the link runs the other way, from
  // the order's metadata_json, stamped by POST /accounts/create once the account
  // exists. An order whose account was never created has nothing to freeze,
  // which is the ordinary case for a refund before activation.
  const metadata = order.metadata_json || {}
  const accountId = metadata.account_id ? String(metadata.account_id) : null
  if (!accountId) return 0

  const result = await client.query(
    `UPDATE accounts
        SET status = 'locked', updated_at = NOW()
      WHERE id = $1::uuid
        AND status = 'active'
      RETURNING id`,
    [accountId]
  )
  if (result.rows.length > 0) {
    logger.warn('[billing] Froze account on a reversed order', {
      orderId: String(order.id), accountId, reason
    })
  }
  return result.rows.length
}

async function handleChargeReversal(client, event, { status, timestampColumn, reason }) {
  const dataObject = event?.data?.object || {}
  const order = await findOrderForChargeEvent(client, dataObject)
  if (!order) {
    logger.warn('[billing] Reversal event did not resolve to a challenge order', {
      type: event?.type, reference: dataObject.payment_intent || dataObject.id || null
    })
    return
  }

  // Terminal states stay terminal — a refund on an order already disputed must
  // not downgrade it, and neither should overwrite the timestamp already set.
  const updated = await client.query(
    `UPDATE challenge_orders
        SET status = $2,
            ${timestampColumn} = COALESCE(${timestampColumn}, NOW()),
            refund_amount = COALESCE($3, refund_amount),
            updated_at = NOW()
      WHERE id = $1
        AND status NOT IN ('refunded', 'disputed')
      RETURNING id`,
    [
      order.id,
      status,
      dataObject.amount_refunded != null
        ? Math.round(Number(dataObject.amount_refunded)) / 100
        : null
    ]
  )
  if (updated.rows.length === 0) {
    logger.info('[billing] Reversal already recorded for this order', { orderId: String(order.id), status })
    return
  }

  await client.query(
    `UPDATE challenge_payments SET status = $2, updated_at = NOW() WHERE order_id = $1`,
    [order.id, status]
  )

  await freezeAccountsForOrder(client, order, reason)

  const clawedBack = await clawbackCommissionForOrder(client, order.id, reason)
  if (clawedBack > 0) {
    logger.warn('[billing] Clawed back affiliate commission on a reversed order', {
      orderId: String(order.id), amount: clawedBack
    })
  }

  logger.warn(`[billing] Order ${status}`, { orderId: String(order.id), reason, type: event?.type })
}

async function handleSessionAbandoned(client, event) {
  const dataObject = event?.data?.object || {}
  const metadata = dataObject.metadata || {}
  if (metadata.flow !== 'challenge_checkout' || !metadata.order_id) return

  const orderId = parseInt(metadata.order_id, 10)

  // Only an order that never got paid can be abandoned. The guard matters for
  // async_payment_failed in particular: the session can complete, the order be
  // paid and the account created, and only then can the payment method fail.
  await client.query(
    `UPDATE challenge_orders
        SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1
        AND status IN ('pending', 'processing')`,
    [orderId]
  )
  await client.query(
    `UPDATE challenge_checkout_sessions
        SET status = 'expired', updated_at = NOW()
      WHERE order_id = $1 AND status NOT IN ('paid')`,
    [orderId]
  )
}

/**
 * Stripe webhook fan-out.
 *
 * ── Why the event id is claimed first ──
 *
 * Replay protection used to ride entirely on `ON CONFLICT DO NOTHING` in
 * whichever downstream INSERT happened to run. That worked for the single event
 * type this handled, but it was a property of each statement rather than of the
 * handler, so every new event type was a fresh opportunity to double-process.
 *
 * The claim is the first statement inside the transaction, so it commits with
 * the work and rolls back with it: a handler that throws leaves no claim behind
 * and Stripe's retry is processed normally, while a handler that succeeds can
 * never run twice. See migration 043.
 */
async function processStripeWebhookEvent(event) {
  return (async () => {
    await ensureBillingInfrastructure()
    const type = String(event?.type || '')
    const eventId = String(event?.id || '')
    const dataObject = event?.data?.object || {}
    const metadata = dataObject.metadata || {}

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      if (eventId) {
        const claim = await client.query(
          `INSERT INTO stripe_events (event_id, event_type, payload_json)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (event_id) DO NOTHING
           RETURNING event_id`,
          [eventId, type, JSON.stringify(event)]
        )
        if (claim.rows.length === 0) {
          logger.info('[billing] Ignoring replayed Stripe event', { eventId, type })
          await client.query('COMMIT')
          return
        }
      }

      if (type === 'checkout.session.completed') {
        if (metadata.flow === 'challenge_checkout' && metadata.order_id) {
          await markChallengeOrderPaid(client, {
            orderId: parseInt(metadata.order_id, 10),
            providerPaymentId: dataObject.payment_intent || dataObject.id,
            payload: event
          })
        }
      } else if (type === 'charge.refunded') {
        await handleChargeReversal(client, event, {
          status: 'refunded',
          timestampColumn: 'refunded_at',
          reason: 'Payment refunded'
        })
      } else if (type === 'charge.dispute.created' || type === 'charge.dispute.funds_withdrawn') {
        await handleChargeReversal(client, event, {
          status: 'disputed',
          timestampColumn: 'disputed_at',
          reason: 'Payment disputed by the cardholder'
        })
      } else if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
        await handleSessionAbandoned(client, event)
      } else {
        logger.debug('[billing] Unhandled Stripe event type', { eventId, type })
      }

      if (eventId) {
        await client.query(
          `UPDATE stripe_events SET processed_at = NOW() WHERE event_id = $1`,
          [eventId]
        )
      }

      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  })()
}

async function billingWebhookHandler(req, res) {
  try {
    await (async () => {
      await ensureBillingInfrastructure()
      const rawBody = req.body
      const signature = req.headers['stripe-signature']

      const platformSecrets = [
        process.env.STRIPE_WEBHOOK_SECRET || '',
        process.env.PLATFORM_STRIPE_WEBHOOK_SECRET || ''
      ].filter(Boolean)

      let valid = platformSecrets.some((secret) => verifyStripeWebhookSignature(rawBody, signature, secret))

      if (!valid) {
        const settings = await getTenantSettingsMap(['payment_provider_webhook_secret'])
        const configuredSecret = String(settings.payment_provider_webhook_secret || '').trim()
        if (configuredSecret && verifyStripeWebhookSignature(rawBody, signature, configuredSecret)) {
          valid = true
        }
      }

      if (!valid) {
        res.status(400).json({ error: 'Invalid webhook signature' })
        return
      }

      const event = JSON.parse(rawBody.toString('utf8'))
      await processStripeWebhookEvent(event)
      res.json({ received: true })
    })()
  } catch (error) {
    logger.error('[billing] Webhook processing failed:', { error: error.message })
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}

router.post('/challenge/checkout-session', authenticateToken, async function(req, res) {
  try {
    await ensureBillingInfrastructure()
    const orderId = parseInt(req.body?.order_id, 10)
    if (!Number.isFinite(orderId)) {
      return res.status(400).json({ error: 'order_id is required' })
    }

    const result = await createChallengePaymentSession({ req, orderId, userId: req.user?.userId || null })
    res.json(result)
  } catch (error) {
    logger.error('[billing] challenge checkout session failed:', { error: error.message })
    res.status(500).json({ error: 'Could not create challenge checkout session' })
  }
})

module.exports = {
  billingWebhookHandler,
  ensureBillingInfrastructure,
  processStripeWebhookEvent,
  router,
  createChallengePaymentSession
}
