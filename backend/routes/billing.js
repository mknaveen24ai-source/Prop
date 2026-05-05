const express = require('express')
const crypto = require('crypto')
const axios = require('axios')
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateAdmin, authenticateToken } = require('./middleware')
const { ensureTenantInfrastructure, normalizeTenantSlug } = require('../utils/tenants')
const {
  ensureTenantSettingsInfrastructure,
  getTenantSettingsMap,
  parseBooleanSetting,
  upsertTenantSettings
} = require('../utils/tenantSettings')
const { runWithSystemDbContext } = require('../utils/dbContext')

const router = express.Router()

const PLATFORM_PLANS = {
  starter: {
    code: 'starter',
    name: 'Starter',
    amount: 199,
    currency: 'usd',
    interval: 'month',
    trader_limit: 100
  },
  growth: {
    code: 'growth',
    name: 'Growth',
    amount: 499,
    currency: 'usd',
    interval: 'month',
    trader_limit: 500
  },
  enterprise: {
    code: 'enterprise',
    name: 'Enterprise',
    amount: 999,
    currency: 'usd',
    interval: 'month',
    trader_limit: null
  }
}

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

function verifyStripeWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false
  const parts = String(signatureHeader).split(',').map((part) => part.trim())
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2)
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3))
  if (!timestamp || signatures.length === 0) return false

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

  billingInfrastructurePromise = runWithSystemDbContext(async () => {
    await ensureTenantInfrastructure()
    await ensureTenantSettingsInfrastructure()

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_subscriptions (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'stripe',
        provider_customer_id TEXT,
        provider_subscription_id TEXT,
        provider_price_id TEXT,
        checkout_session_id TEXT,
        plan_code TEXT NOT NULL DEFAULT 'starter',
        plan_name TEXT NOT NULL DEFAULT 'Starter',
        billing_interval TEXT NOT NULL DEFAULT 'month',
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'usd',
        status TEXT NOT NULL DEFAULT 'pending',
        grace_until TIMESTAMPTZ,
        current_period_start TIMESTAMPTZ,
        current_period_end TIMESTAMPTZ,
        cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id),
        UNIQUE (provider_subscription_id),
        UNIQUE (checkout_session_id)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_status_period ON tenant_subscriptions(status, current_period_end)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_customer ON tenant_subscriptions(provider_customer_id)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_subscription_events (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT REFERENCES tenants(id) ON DELETE SET NULL,
        tenant_subscription_id BIGINT REFERENCES tenant_subscriptions(id) ON DELETE SET NULL,
        provider TEXT NOT NULL DEFAULT 'stripe',
        event_type TEXT NOT NULL,
        provider_event_id TEXT,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (provider, provider_event_id)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_subscription_events_tenant_created ON tenant_subscription_events(tenant_id, created_at DESC)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_checkout_sessions (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
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
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenge_checkout_sessions_tenant_order ON challenge_checkout_sessions(tenant_id, order_id, status)`)
  }).catch((error) => {
    billingInfrastructurePromise = null
    logger.error('[billing] Failed to ensure infrastructure:', { error: error.message })
    throw error
  })

  return billingInfrastructurePromise
}

async function upsertTenantSubscription(clientOrPool, tenantId, values = {}) {
  await ensureBillingInfrastructure()
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const result = await db.query(
    `INSERT INTO tenant_subscriptions (
       tenant_id, provider, provider_customer_id, provider_subscription_id, provider_price_id,
       checkout_session_id, plan_code, plan_name, billing_interval, amount, currency, status,
       grace_until, current_period_start, current_period_end, cancel_at_period_end, metadata_json, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17::jsonb, NOW()
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       provider = EXCLUDED.provider,
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, tenant_subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, tenant_subscriptions.provider_subscription_id),
       provider_price_id = COALESCE(EXCLUDED.provider_price_id, tenant_subscriptions.provider_price_id),
       checkout_session_id = COALESCE(EXCLUDED.checkout_session_id, tenant_subscriptions.checkout_session_id),
       plan_code = COALESCE(EXCLUDED.plan_code, tenant_subscriptions.plan_code),
       plan_name = COALESCE(EXCLUDED.plan_name, tenant_subscriptions.plan_name),
       billing_interval = COALESCE(EXCLUDED.billing_interval, tenant_subscriptions.billing_interval),
       amount = COALESCE(EXCLUDED.amount, tenant_subscriptions.amount),
       currency = COALESCE(EXCLUDED.currency, tenant_subscriptions.currency),
       status = COALESCE(EXCLUDED.status, tenant_subscriptions.status),
       grace_until = EXCLUDED.grace_until,
       current_period_start = COALESCE(EXCLUDED.current_period_start, tenant_subscriptions.current_period_start),
       current_period_end = COALESCE(EXCLUDED.current_period_end, tenant_subscriptions.current_period_end),
       cancel_at_period_end = COALESCE(EXCLUDED.cancel_at_period_end, tenant_subscriptions.cancel_at_period_end),
       metadata_json = COALESCE(tenant_subscriptions.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
       updated_at = NOW()
     RETURNING *`,
    [
      tenantId,
      values.provider || 'stripe',
      values.provider_customer_id || null,
      values.provider_subscription_id || null,
      values.provider_price_id || null,
      values.checkout_session_id || null,
      values.plan_code || 'starter',
      values.plan_name || PLATFORM_PLANS[values.plan_code]?.name || 'Starter',
      values.billing_interval || 'month',
      values.amount ?? PLATFORM_PLANS[values.plan_code]?.amount ?? 0,
      values.currency || PLATFORM_PLANS[values.plan_code]?.currency || 'usd',
      values.status || 'pending',
      values.grace_until || null,
      values.current_period_start || null,
      values.current_period_end || null,
      values.cancel_at_period_end === true,
      JSON.stringify(values.metadata_json || {})
    ]
  )
  return result.rows[0]
}

async function recordSubscriptionEvent(clientOrPool, payload = {}) {
  await ensureBillingInfrastructure()
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  await db.query(
    `INSERT INTO tenant_subscription_events (
       tenant_id, tenant_subscription_id, provider, event_type, provider_event_id, payload_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6::jsonb
     )
     ON CONFLICT (provider, provider_event_id) DO NOTHING`,
    [
      payload.tenant_id || null,
      payload.tenant_subscription_id || null,
      payload.provider || 'stripe',
      String(payload.event_type || 'unknown'),
      payload.provider_event_id || null,
      JSON.stringify(payload.payload_json || {})
    ]
  )
}

async function setTenantOperationalState(clientOrPool, tenantId, subscriptionStatus, graceUntil = null) {
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const normalizedStatus = String(subscriptionStatus || '').toLowerCase()
  const tenantStatus = ['active', 'trialing', 'past_due'].includes(normalizedStatus)
    ? 'active'
    : normalizedStatus === 'pending'
      ? 'pending'
      : 'suspended'

  await db.query(
    `UPDATE tenants
        SET status = $2,
            updated_at = NOW(),
            settings_json = COALESCE(settings_json, '{}'::jsonb) || jsonb_build_object(
              'subscription_status', $3,
              'subscription_grace_until', $4
            )
      WHERE id = $1`,
    [tenantId, tenantStatus, normalizedStatus || 'pending', graceUntil]
  )
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

async function createTenantSignupSession(req, tenantPayload) {
  return runWithSystemDbContext(async () => {
    await ensureBillingInfrastructure()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const plan = PLATFORM_PLANS[tenantPayload.plan_code] || PLATFORM_PLANS.starter
      const tenantInsert = await client.query(
        `INSERT INTO tenants
          (slug, name, status, support_email, email_from_name, brand_json, settings_json, updated_at)
         VALUES ($1, $2, 'pending', $3, $4, '{}'::jsonb, '{}'::jsonb, NOW())
         RETURNING *`,
        [
          tenantPayload.slug,
          tenantPayload.name,
          tenantPayload.billing_email,
          tenantPayload.name
        ]
      )
      const tenant = tenantInsert.rows[0]

      await upsertTenantSettings(client, tenant.id, {
        billing_email: tenantPayload.billing_email,
        subscription_plan_code: plan.code,
        subscription_seats: '1'
      })

      if (tenantPayload.admin_email && tenantPayload.admin_password_hash) {
        await client.query(
          `INSERT INTO tenant_admins (tenant_id, email, password_hash, full_name, role, status)
           VALUES ($1, LOWER($2), $3, $4, 'tenant_admin', 'inactive')`,
          [tenant.id, tenantPayload.admin_email, tenantPayload.admin_password_hash, tenantPayload.admin_full_name || tenantPayload.name]
        )
      }

      const subscription = await upsertTenantSubscription(client, tenant.id, {
        provider: 'stripe',
        plan_code: plan.code,
        plan_name: plan.name,
        amount: plan.amount,
        currency: plan.currency,
        billing_interval: plan.interval,
        status: 'pending',
        metadata_json: {
          trader_limit: plan.trader_limit,
          signup_origin: 'public'
        }
      })

      const platformStripeKey = process.env.STRIPE_SECRET_KEY || ''
      if (!platformStripeKey) {
        await client.query('COMMIT')
        return {
          tenant,
          subscription,
          checkout_url: null,
          configured: false
        }
      }

      const session = await createStripeCheckoutSession({
        secretKey: platformStripeKey,
        mode: 'subscription',
        successUrl: buildAbsoluteUrl(req, `/billing/success?tenant=${tenant.slug}`),
        cancelUrl: buildAbsoluteUrl(req, `/billing/cancel?tenant=${tenant.slug}`),
        name: `${plan.name} SaaS Subscription`,
        amount: plan.amount,
        currency: plan.currency,
        interval: plan.interval,
        metadata: {
          flow: 'tenant_signup',
          tenant_id: tenant.id,
          tenant_slug: tenant.slug,
          subscription_id: subscription.id,
          plan_code: plan.code
        }
      })

      const updatedSubscription = await upsertTenantSubscription(client, tenant.id, {
        ...subscription,
        checkout_session_id: session.id
      })

      await client.query('COMMIT')

      return {
        tenant,
        subscription: updatedSubscription,
        checkout_url: session.url,
        configured: true
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  })
}

async function createChallengePaymentSession({ req, tenantId, orderId, userId = null }) {
  await ensureBillingInfrastructure()
  const settings = await getTenantSettingsMap(tenantId, [
    'payment_provider',
    'payment_provider_secret_key',
    'payment_provider_account_id',
    'challenge_fee_currency'
  ])
  const provider = String(settings.payment_provider || '').trim().toLowerCase()
  const secretKey = String(settings.payment_provider_secret_key || '').trim()
  const stripeAccount = String(settings.payment_provider_account_id || '').trim() || null
  if (provider !== 'stripe' || !secretKey) {
    return { configured: false, checkout_url: null }
  }

  const orderResult = await pool.query(
    `SELECT id, tenant_id, user_id, amount, currency, account_size, status
       FROM challenge_orders
      WHERE id = $1
        AND tenant_id = $2
        AND ($3::bigint IS NULL OR user_id = $3)
      LIMIT 1`,
    [orderId, tenantId, userId]
  )
  if (orderResult.rows.length === 0) {
    throw new Error('Challenge order not found')
  }
  const order = orderResult.rows[0]

  const session = await createStripeCheckoutSession({
    secretKey,
    stripeAccount,
    mode: 'payment',
    successUrl: buildAbsoluteUrl(req, '/dashboard?checkout=success'),
    cancelUrl: buildAbsoluteUrl(req, '/dashboard?checkout=cancelled'),
    name: `$${parseFloat(order.account_size || 0).toLocaleString()} Challenge`,
    amount: parseFloat(order.amount || 0),
    currency: String(order.currency || settings.challenge_fee_currency || 'usd').toLowerCase(),
    metadata: {
      flow: 'challenge_checkout',
      tenant_id: tenantId,
      order_id: order.id,
      user_id: order.user_id
    }
  })

  await pool.query(
    `INSERT INTO challenge_checkout_sessions (
       tenant_id, order_id, provider, checkout_session_id, checkout_url, provider_customer_id, status, metadata_json, expires_at, updated_at
     ) VALUES (
       $1, $2, 'stripe', $3, $4, $5, 'pending', $6::jsonb, to_timestamp($7), NOW()
     )
     ON CONFLICT (checkout_session_id) DO UPDATE SET
       checkout_url = EXCLUDED.checkout_url,
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, challenge_checkout_sessions.provider_customer_id),
       status = EXCLUDED.status,
       metadata_json = EXCLUDED.metadata_json,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [
      tenantId,
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

  const settings = await getTenantSettingsMap(order.tenant_id, ['revenue_share_enabled', 'revenue_share_pct'])
  const revenueShareEnabled = parseBooleanSetting(settings.revenue_share_enabled, false)
  const revenueSharePct = revenueShareEnabled ? parseFloat(settings.revenue_share_pct || 0) : 0
  const amount = parseFloat(order.amount || 0)
  const platformFeeAmount = parseFloat(((amount * revenueSharePct) / 100).toFixed(2))
  const tenantNetAmount = parseFloat((amount - platformFeeAmount).toFixed(2))

  await client.query(
    `INSERT INTO challenge_payments (
       tenant_id, order_id, provider, provider_payment_id, amount, platform_fee_amount, tenant_net_amount, currency, status, payload_json, updated_at
     ) VALUES (
       $1, $2, 'stripe', $3, $4, $5, $6, $7, 'paid', $8::jsonb, NOW()
     )
     ON CONFLICT DO NOTHING`,
    [
      order.tenant_id,
      order.id,
      providerPaymentId || null,
      amount,
      platformFeeAmount,
      tenantNetAmount,
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
  return runWithSystemDbContext(async () => {
    await ensureBillingInfrastructure()
    const type = String(event?.type || '')
    const dataObject = event?.data?.object || {}
    const metadata = dataObject.metadata || {}
    const tenantId = parseInt(metadata.tenant_id || 0, 10) || null

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      if (type === 'checkout.session.completed') {
        if (metadata.flow === 'tenant_signup' && tenantId) {
          const subscription = await upsertTenantSubscription(client, tenantId, {
            provider: 'stripe',
            provider_customer_id: dataObject.customer || null,
            provider_subscription_id: dataObject.subscription || null,
            checkout_session_id: dataObject.id,
            status: dataObject.mode === 'subscription' ? 'active' : 'paid',
            metadata_json: dataObject
          })
          await setTenantOperationalState(client, tenantId, 'active')
          await client.query(
            `UPDATE tenant_admins
                SET status = 'active', updated_at = NOW()
              WHERE tenant_id = $1`,
            [tenantId]
          )
          await recordSubscriptionEvent(client, {
            tenant_id: tenantId,
            tenant_subscription_id: subscription.id,
            provider: 'stripe',
            event_type: type,
            provider_event_id: event.id,
            payload_json: event
          })
        }

        if (metadata.flow === 'challenge_checkout' && metadata.order_id) {
          await markChallengeOrderPaid(client, {
            orderId: parseInt(metadata.order_id, 10),
            providerPaymentId: dataObject.payment_intent || dataObject.id,
            payload: event
          })
        }
      }

      if (type === 'customer.subscription.created' || type === 'customer.subscription.updated' || type === 'invoice.paid' || type === 'invoice.payment_failed' || type === 'customer.subscription.deleted') {
        const subscriptionId = dataObject.subscription || dataObject.id
        const subscriptionResult = await client.query(
          `SELECT * FROM tenant_subscriptions
            WHERE provider_subscription_id = $1
               OR checkout_session_id = $1
               OR provider_customer_id = $2
            LIMIT 1`,
          [subscriptionId || null, dataObject.customer || null]
        )
        if (subscriptionResult.rows.length > 0) {
          const subscription = subscriptionResult.rows[0]
          const graceUntil = type === 'invoice.payment_failed'
            ? new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
            : null
          const nextStatus = type === 'invoice.payment_failed'
            ? 'past_due'
            : type === 'customer.subscription.deleted'
              ? 'canceled'
              : (dataObject.status || 'active')
          const updatedSubscription = await upsertTenantSubscription(client, subscription.tenant_id, {
            ...subscription,
            provider_customer_id: dataObject.customer || subscription.provider_customer_id,
            provider_subscription_id: subscriptionId || subscription.provider_subscription_id,
            status: nextStatus,
            grace_until: graceUntil,
            current_period_start: dataObject.current_period_start ? new Date(dataObject.current_period_start * 1000).toISOString() : subscription.current_period_start,
            current_period_end: dataObject.current_period_end ? new Date(dataObject.current_period_end * 1000).toISOString() : subscription.current_period_end,
            cancel_at_period_end: !!dataObject.cancel_at_period_end,
            metadata_json: dataObject
          })
          await setTenantOperationalState(client, subscription.tenant_id, nextStatus, graceUntil)
          await recordSubscriptionEvent(client, {
            tenant_id: subscription.tenant_id,
            tenant_subscription_id: updatedSubscription.id,
            provider: 'stripe',
            event_type: type,
            provider_event_id: event.id,
            payload_json: event
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
  })
}

async function billingWebhookHandler(req, res) {
  try {
    await runWithSystemDbContext(async () => {
      await ensureBillingInfrastructure()
      const rawBody = req.body
      const signature = req.headers['stripe-signature']
      const candidateSecrets = [
        process.env.STRIPE_WEBHOOK_SECRET || '',
        process.env.PLATFORM_STRIPE_WEBHOOK_SECRET || ''
      ].filter(Boolean)

      const tenantWebhookSecrets = await pool.query(
        `SELECT DISTINCT value
           FROM tenant_settings
          WHERE key = 'payment_provider_webhook_secret'
            AND value <> ''`
      )
      tenantWebhookSecrets.rows.forEach((row) => {
        if (row.value) candidateSecrets.push(String(row.value))
      })

      const valid = candidateSecrets.some((secret) => verifyStripeWebhookSignature(rawBody, signature, secret))
      if (!valid) {
        res.status(400).json({ error: 'Invalid webhook signature' })
        return
      }

      const event = JSON.parse(rawBody.toString('utf8'))
      await processStripeWebhookEvent(event)
      res.json({ received: true })
    })
  } catch (error) {
    logger.error('[billing] Webhook processing failed:', { error: error.message })
    res.status(500).json({ error: 'Webhook processing failed' })
  }
}

router.post('/tenant-signup', async function(req, res) {
  try {
    await ensureBillingInfrastructure()
    const slug = normalizeTenantSlug(req.body?.slug || '')
    const name = String(req.body?.name || '').trim()
    const adminEmail = String(req.body?.admin_email || '').trim().toLowerCase()
    const adminPassword = String(req.body?.admin_password || '')
    const adminFullName = String(req.body?.admin_full_name || '').trim()
    const billingEmail = String(req.body?.billing_email || adminEmail).trim().toLowerCase()
    const planCode = String(req.body?.plan_code || 'starter').trim().toLowerCase()

    if (!slug || !name || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: 'slug, name, admin_email, and admin_password are required' })
    }
    if (!PLATFORM_PLANS[planCode]) {
      return res.status(400).json({ error: 'Invalid plan_code' })
    }

    const existing = await pool.query(`SELECT 1 FROM tenants WHERE slug = $1 LIMIT 1`, [slug])
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Tenant slug already exists' })
    }

    const bcrypt = require('bcrypt')
    const adminPasswordHash = await bcrypt.hash(adminPassword, 12)
    const result = await createTenantSignupSession(req, {
      slug,
      name,
      admin_email: adminEmail,
      admin_password_hash: adminPasswordHash,
      admin_full_name: adminFullName,
      billing_email: billingEmail,
      plan_code: planCode
    })

    res.status(201).json(result)
  } catch (error) {
    logger.error('[billing] tenant signup failed:', { error: error.message })
    res.status(500).json({ error: 'Could not start tenant signup' })
  }
})

router.get('/tenant/subscription', authenticateAdmin, async function(req, res) {
  try {
    await ensureBillingInfrastructure()
    const tenantId = req.admin?.tenantId || null
    if (!tenantId) {
      return res.status(403).json({ error: 'Tenant admin access required' })
    }
    const result = await pool.query(
      `SELECT * FROM tenant_subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    )
    res.json(result.rows[0] || null)
  } catch (error) {
    res.status(500).json({ error: 'Could not load tenant subscription' })
  }
})

router.post('/tenant/portal', authenticateAdmin, async function(req, res) {
  try {
    await ensureBillingInfrastructure()
    const tenantId = req.admin?.tenantId || null
    if (!tenantId) {
      return res.status(403).json({ error: 'Tenant admin access required' })
    }
    const subscriptionResult = await pool.query(
      `SELECT provider_customer_id FROM tenant_subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    )
    const customerId = subscriptionResult.rows[0]?.provider_customer_id
    const stripeKey = process.env.STRIPE_SECRET_KEY || ''
    if (!stripeKey || !customerId) {
      return res.status(400).json({ error: 'Billing portal is not configured for this tenant' })
    }

    const session = await stripePost('/billing_portal/sessions', stripeKey, {
      customer: customerId,
      return_url: buildAbsoluteUrl(req, '/admin/settings')
    })

    res.json({ url: session.url })
  } catch (error) {
    logger.error('[billing] tenant portal failed:', { error: error.message })
    res.status(500).json({ error: 'Could not create billing portal session' })
  }
})

router.post('/admin/tenants/:tenantId/subscription-checkout', authenticateAdmin, async function(req, res) {
  try {
    await ensureBillingInfrastructure()
    const tenantId = parseInt(req.params.tenantId, 10)
    if (!Number.isFinite(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenant id' })
    }
    if (req.admin?.tenantId && String(req.admin.tenantId) !== String(tenantId)) {
      return res.status(403).json({ error: 'Cannot manage another tenant subscription' })
    }

    const tenantResult = await pool.query(`SELECT id, slug, name FROM tenants WHERE id = $1 LIMIT 1`, [tenantId])
    if (tenantResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' })
    }
    const tenant = tenantResult.rows[0]
    const planCode = String(req.body?.plan_code || 'starter').trim().toLowerCase()
    const plan = PLATFORM_PLANS[planCode]
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan_code' })
    }

    const stripeKey = process.env.STRIPE_SECRET_KEY || ''
    if (!stripeKey) {
      return res.status(400).json({ error: 'Platform Stripe is not configured' })
    }

    const subscription = await upsertTenantSubscription(pool, tenant.id, {
      provider: 'stripe',
      plan_code: plan.code,
      plan_name: plan.name,
      amount: plan.amount,
      currency: plan.currency,
      billing_interval: plan.interval,
      status: 'pending',
      metadata_json: { trader_limit: plan.trader_limit }
    })

    const session = await createStripeCheckoutSession({
      secretKey: stripeKey,
      mode: 'subscription',
      successUrl: buildAbsoluteUrl(req, `/admin/settings?subscription=success`),
      cancelUrl: buildAbsoluteUrl(req, `/admin/settings?subscription=cancelled`),
      name: `${plan.name} SaaS Subscription`,
      amount: plan.amount,
      currency: plan.currency,
      interval: plan.interval,
      metadata: {
        flow: 'tenant_signup',
        tenant_id: tenant.id,
        tenant_slug: tenant.slug,
        subscription_id: subscription.id,
        plan_code: plan.code
      }
    })

    await upsertTenantSubscription(pool, tenant.id, {
      ...subscription,
      checkout_session_id: session.id
    })

    res.json({ url: session.url, session_id: session.id })
  } catch (error) {
    logger.error('[billing] subscription checkout failed:', { error: error.message })
    res.status(500).json({ error: 'Could not create subscription checkout session' })
  }
})

router.post('/challenge/checkout-session', authenticateToken, async function(req, res) {
  try {
    await ensureBillingInfrastructure()
    const tenantId = req.user?.tenantId || req.tenant?.id || parseInt(req.body?.tenant_id, 10)
    const orderId = parseInt(req.body?.order_id, 10)
    if (!Number.isFinite(tenantId) || !Number.isFinite(orderId)) {
      return res.status(400).json({ error: 'tenant_id and order_id are required' })
    }

    const result = await createChallengePaymentSession({ req, tenantId, orderId, userId: req.user?.userId || null })
    res.json(result)
  } catch (error) {
    logger.error('[billing] challenge checkout session failed:', { error: error.message })
    res.status(500).json({ error: 'Could not create challenge checkout session' })
  }
})

module.exports = {
  PLATFORM_PLANS,
  billingWebhookHandler,
  ensureBillingInfrastructure,
  processStripeWebhookEvent,
  router,
  createChallengePaymentSession,
  upsertTenantSubscription
}
