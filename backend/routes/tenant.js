const express = require('express')
const router = express.Router()
const pool = require('../db')
const { getTenantSettingsMap } = require('../utils/tenantSettings')
const { listTenantDomainRecords } = require('../utils/tenants')
const { getFeedHealthForTenant } = require('../utils/launchReadiness')

async function buildTenantConfigPayload(req) {
  let tenant = req.tenant || null
  if (tenant?.id) {
    const settings = await getTenantSettingsMap(tenant.id, [
      'requires_payment',
      'challenge_checkout_mode',
      'challenge_fee_amount',
      'challenge_fee_currency',
      'challenge_fee_label',
      'marketing_mode',
      'max_accounts_per_user',
      'payment_provider',
      'payment_provider_public_key',
      'subscription_plan_code',
      'revenue_share_enabled',
      'revenue_share_pct',
      'shared_price_feed_enabled',
      'use_shared_feed_only',
      'allow_custom_mt5_feed'
    ])
    const subscriptionResult = await pool.query(
      `SELECT status, grace_until, current_period_end, plan_code, plan_name, amount, currency
         FROM tenant_subscriptions
        WHERE tenant_id = $1
        LIMIT 1`,
      [tenant.id]
    )
    const subscription = subscriptionResult.rows[0] || null
    const paymentProvider = String(settings.payment_provider || '').trim().toLowerCase()
    const domains = await listTenantDomainRecords(tenant.id)
    const feedHealth = await getFeedHealthForTenant(tenant.id)
    tenant = {
      ...tenant,
      settings: {
        ...(tenant.settings || {}),
        ...settings
      },
      payment_available: paymentProvider === 'stripe' && !!String(settings.payment_provider_public_key || '').trim(),
      feed_health: {
        healthy: feedHealth.healthy,
        launch_ready: feedHealth.launch_ready,
        status: feedHealth.status,
        message: feedHealth.message,
        feed_mode: feedHealth.feed_mode,
        effective_feed_mode: feedHealth.effective_feed_mode,
        fallback_active: feedHealth.fallback_active,
        supported_instruments: feedHealth.supported_instruments,
        required_launch_instruments: feedHealth.required_launch_instruments,
        missing_launch_instruments: feedHealth.missing_launch_instruments
      },
      supported_instruments: feedHealth.supported_instruments,
      subscription: subscription
        ? {
            status: subscription.status,
            grace_until: subscription.grace_until,
            current_period_end: subscription.current_period_end,
            plan_code: subscription.plan_code,
            plan_name: subscription.plan_name,
            amount: subscription.amount,
            currency: subscription.currency
          }
        : {
            status: tenant.subscription_status || null,
            grace_until: tenant.subscription_grace_until || null
          },
      domains,
      features: {
        paid_challenges: String(settings.challenge_checkout_mode || 'free').trim().toLowerCase() === 'paid'
          || String(settings.requires_payment || 'false').trim().toLowerCase() === 'true',
        custom_domains: true,
        tenant_billing: true,
        shared_price_feed_enabled: String(settings.shared_price_feed_enabled || 'true').trim().toLowerCase() !== 'false',
        allow_custom_mt5_feed: String(settings.allow_custom_mt5_feed || 'false').trim().toLowerCase() === 'true'
      }
    }
  }
  return { tenant }
}

router.get('/branding', async function(req, res) {
  const payload = await buildTenantConfigPayload(req)
  res.set('Cache-Control', 'no-store')
  res.json(payload)
})

router.get('/config', async function(req, res) {
  res.set('Cache-Control', 'no-store')
  res.json(await buildTenantConfigPayload(req))
})

module.exports = router
