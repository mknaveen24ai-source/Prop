const express = require('express')
const crypto = require('crypto')
const axios = require('axios')
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateToken } = require('./middleware')
const {
  ensureTenantSettingsInfrastructure,
  getTenantSettingsMap
} = require('../utils/tenantSettings')

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

  const orderResult = await pool.query(
    `SELECT id, user_id, amount, currency, account_size, status
       FROM challenge_orders
      WHERE id = $1
        AND ($2::bigint IS NULL OR user_id = $2)
      LIMIT 1`,
    [orderId, userId]
  )
  if (orderResult.rows.length === 0) {
    throw new Error('Challenge order not found')
  }
  const order = orderResult.rows[0]

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
  const orderResult = await client.query(
    `UPDATE challenge_orders
        SET status = 'paid',
            paid_via = COALESCE(paid_via, 'stripe_checkout'),
            paid_at = COALESCE(paid_at, NOW()),
            provider_reference = COALESCE($2, provider_reference),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [orderId, providerPaymentId || null]
  )
  if (orderResult.rows.length === 0) return null
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

  return order
}

async function processStripeWebhookEvent(event) {
  return (async () => {
    await ensureBillingInfrastructure()
    const type = String(event?.type || '')
    const dataObject = event?.data?.object || {}
    const metadata = dataObject.metadata || {}

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      if (type === 'checkout.session.completed') {
        if (metadata.flow === 'challenge_checkout' && metadata.order_id) {
          await markChallengeOrderPaid(client, {
            orderId: parseInt(metadata.order_id, 10),
            providerPaymentId: dataObject.payment_intent || dataObject.id,
            payload: event
          })
        }
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
