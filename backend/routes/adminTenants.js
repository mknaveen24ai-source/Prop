const express = require('express')
const router = express.Router()
const bcrypt = require('bcrypt')
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const {
  ensureTenantInfrastructure,
  normalizeTenantSlug,
  extractHostname,
  listTenantDomainRecords,
  upsertTenantDomainRecords
} = require('../utils/tenants')
const { getTenantSettingsMap, upsertTenantSettings } = require('../utils/tenantSettings')
const { getTenantPriceFeedConfig, upsertTenantPriceFeedConfig } = require('../utils/tenantFeeds')
const { clearTenantPolicyCache } = require('../services/tenantPolicyService')
const { getFeedHealthForTenant } = require('../utils/launchReadiness')

function hasOwn(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key)
}

function parseBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function sanitizeReadSettings(settings = {}) {
  const {
    payment_provider_secret_key,
    payment_provider_webhook_secret,
    ...safeSettings
  } = settings

  return {
    ...safeSettings,
    has_payment_provider_secret_key: !!String(payment_provider_secret_key || '').trim(),
    has_payment_provider_webhook_secret: !!String(payment_provider_webhook_secret || '').trim()
  }
}

function sanitizePriceFeedConfig(feedConfig = {}) {
  const { dwx_path, ...safeConfig } = feedConfig || {}
  return {
    ...safeConfig,
    has_dwx_path: !!String(dwx_path || '').trim()
  }
}

function summarizeDomainRecords(domainRecords = []) {
  const rows = Array.isArray(domainRecords) ? domainRecords : []
  const verifiedCount = rows.filter((row) => ['verified', 'platform_managed'].includes(String(row?.verification_status || '').toLowerCase())).length
  const activeSslCount = rows.filter((row) => String(row?.ssl_status || '').toLowerCase() === 'active').length
  const primaryRecord = rows.find((row) => row?.is_primary) || null

  return {
    total: rows.length,
    verified_count: verifiedCount,
    active_ssl_count: activeSslCount,
    primary_hostname: primaryRecord?.hostname || null,
    primary_verification_status: primaryRecord?.verification_status || null,
    primary_ssl_status: primaryRecord?.ssl_status || null
  }
}

function normalizeTenantPayload(body = {}) {
  const rawDomainRecords = Array.isArray(body.domain_records)
    ? body.domain_records
    : Array.isArray(body.domains)
      ? body.domains
      : String(body.domains || '')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean)

  const rawDomains = Array.isArray(body.domains)
    ? body.domains
    : String(body.domains || '')
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)

  const payload = {
    slug: normalizeTenantSlug(body.slug || ''),
    name: String(body.name || '').trim(),
    status: String(body.status || 'active').trim().toLowerCase() || 'active',
    primary_domain: extractHostname(body.primary_domain || ''),
    logo_text: String(body.logo_text || '').trim(),
    logo_url: String(body.logo_url || '').trim(),
    support_email: String(body.support_email || '').trim(),
    email_from_name: String(body.email_from_name || '').trim(),
    brand: {
      short_name: String(body.short_name || '').trim(),
      tagline: String(body.tagline || '').trim(),
      hero_title: String(body.hero_title || '').trim(),
      hero_subtitle: String(body.hero_subtitle || '').trim(),
      primary_color: String(body.primary_color || '').trim(),
      accent_color: String(body.accent_color || '').trim()
    },
    settings: {
      requires_payment: String(body.requires_payment || 'false').trim() || 'false',
      challenge_checkout_mode: String(body.challenge_checkout_mode || 'free').trim() || 'free',
      challenge_fee_amount: String(body.challenge_fee_amount || '0').trim() || '0',
      challenge_fee_currency: String(body.challenge_fee_currency || 'USD').trim() || 'USD',
      challenge_fee_label: String(body.challenge_fee_label || 'FREE').trim() || 'FREE',
      marketing_mode: String(body.marketing_mode || 'free').trim() || 'free',
      shared_price_feed_enabled: String(body.shared_price_feed_enabled || 'true').trim() || 'true',
      use_shared_feed_only: String(body.use_shared_feed_only || 'true').trim() || 'true',
      allow_custom_mt5_feed: String(body.allow_custom_mt5_feed || 'false').trim() || 'false',
      payment_provider: String(body.payment_provider || '').trim(),
      payment_provider_public_key: String(body.payment_provider_public_key || '').trim(),
      payment_provider_secret_key: String(body.payment_provider_secret_key || '').trim(),
      payment_provider_webhook_secret: String(body.payment_provider_webhook_secret || '').trim(),
      payment_provider_account_id: String(body.payment_provider_account_id || '').trim(),
      billing_email: String(body.billing_email || '').trim(),
      subscription_plan_code: String(body.subscription_plan_code || 'starter').trim() || 'starter',
      revenue_share_enabled: String(body.revenue_share_enabled || 'false').trim() || 'false',
      revenue_share_pct: String(body.revenue_share_pct || '0').trim() || '0'
    },
    feed: {
      feed_name: String(body.feed_name || 'default').trim() || 'default',
      feed_mode: String(body.feed_mode || 'shared').trim() || 'shared',
      source_key: String(body.feed_source_key || '').trim().toLowerCase(),
      source_name: String(body.feed_source_name || '').trim(),
      dwx_path: String(body.feed_dwx_path || '').trim(),
      fallback_to_shared: String(body.feed_fallback_to_shared || 'true').trim().toLowerCase() !== 'false'
    },
    admin: {
      email: String(body.admin_email || '').trim(),
      password: String(body.admin_password || '').trim(),
      full_name: String(body.admin_full_name || '').trim()
    },
    domain_records: rawDomainRecords
      .map((entry) => {
        if (typeof entry === 'string') {
          return { hostname: extractHostname(entry) }
        }
        return {
          hostname: extractHostname(entry?.hostname || ''),
          domain_type: String(entry?.domain_type || 'custom_domain').trim().toLowerCase() || 'custom_domain',
          verification_status: String(entry?.verification_status || 'pending').trim().toLowerCase() || 'pending',
          ssl_status: String(entry?.ssl_status || 'pending').trim().toLowerCase() || 'pending',
          certificate_path: String(entry?.certificate_path || '').trim(),
          certificate_metadata: entry?.certificate_metadata || entry?.certificate_metadata_json || {},
          verification_token: String(entry?.verification_token || '').trim()
        }
      })
      .filter((entry) => !!entry.hostname),
    domains: rawDomains
      .map((value) => extractHostname(value))
      .filter(Boolean)
  }

  if (hasOwn(body, 'payment_provider_secret_key')) {
    payload.settings.payment_provider_secret_key = String(body.payment_provider_secret_key || '').trim()
  } else {
    delete payload.settings.payment_provider_secret_key
  }

  if (hasOwn(body, 'payment_provider_webhook_secret')) {
    payload.settings.payment_provider_webhook_secret = String(body.payment_provider_webhook_secret || '').trim()
  } else {
    delete payload.settings.payment_provider_webhook_secret
  }

  if (parseBooleanFlag(body.clear_payment_provider_secret_key)) {
    payload.settings.payment_provider_secret_key = ''
  }
  if (parseBooleanFlag(body.clear_payment_provider_webhook_secret)) {
    payload.settings.payment_provider_webhook_secret = ''
  }

  if (hasOwn(body, 'feed_dwx_path')) {
    payload.feed.dwx_path = String(body.feed_dwx_path || '').trim()
  } else {
    delete payload.feed.dwx_path
  }
  if (parseBooleanFlag(body.clear_feed_dwx_path)) {
    payload.feed.dwx_path = ''
  }

  return payload
}

router.get('/tenants', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    await ensureTenantInfrastructure()

    const result = await pool.query(
      `SELECT
         t.*,
         COALESCE(
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT d.hostname), NULL),
           ARRAY[]::text[]
         ) AS domains,
         COUNT(DISTINCT u.id) AS user_count,
         COUNT(DISTINCT a.id) AS account_count
       FROM tenants t
       LEFT JOIN tenant_domains d ON d.tenant_id = t.id
       LEFT JOIN users u ON u.tenant_id = t.id
       LEFT JOIN accounts a ON a.tenant_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at ASC`
    )

    const rows = await Promise.all(result.rows.map(async (row) => {
      const settings = await getTenantSettingsMap(row.id, [
        'requires_payment',
        'challenge_checkout_mode',
        'challenge_fee_amount',
        'challenge_fee_currency',
        'challenge_fee_label',
        'marketing_mode',
        'payment_provider',
        'payment_provider_public_key',
        'payment_provider_secret_key',
        'payment_provider_webhook_secret',
        'payment_provider_account_id',
        'billing_email',
        'subscription_plan_code',
        'revenue_share_enabled',
        'revenue_share_pct'
      ])
      const adminResult = await pool.query(
        `SELECT email, full_name
           FROM tenant_admins
          WHERE tenant_id = $1
            AND status = 'active'
          ORDER BY id ASC
          LIMIT 1`,
        [row.id]
      )
      const subscriptionResult = await pool.query(
        `SELECT status, grace_until, current_period_end, plan_code, plan_name, amount, currency
           FROM tenant_subscriptions
          WHERE tenant_id = $1
          LIMIT 1`,
        [row.id]
      )
      const domainRecords = await listTenantDomainRecords(row.id)
      const feedHealth = await getFeedHealthForTenant(row.id)
      return {
        ...row,
        brand_json: row.brand_json || {},
        settings_json: row.settings_json || {},
        settings: sanitizeReadSettings(settings),
        has_payment_provider_secret_key: !!String(settings.payment_provider_secret_key || '').trim(),
        has_payment_provider_webhook_secret: !!String(settings.payment_provider_webhook_secret || '').trim(),
        price_feed: sanitizePriceFeedConfig(await getTenantPriceFeedConfig(row.id)),
        subscription: subscriptionResult.rows[0] || null,
        operational_state: {
          payment_provider_configured: String(settings.payment_provider || '').trim().toLowerCase() === 'stripe'
            && !!String(settings.payment_provider_public_key || '').trim(),
          subscription_status: subscriptionResult.rows[0]?.status || row.status || null,
          grace_until: subscriptionResult.rows[0]?.grace_until || null,
          feed_health: {
            healthy: feedHealth.healthy,
            launch_ready: feedHealth.launch_ready,
            status: feedHealth.status,
            message: feedHealth.message,
            feed_mode: feedHealth.feed_mode,
            effective_feed_mode: feedHealth.effective_feed_mode,
            fallback_active: feedHealth.fallback_active,
            source_key: feedHealth.source_key,
            source_status: feedHealth.source_status,
            symbol_count: feedHealth.symbol_count,
            healthy_symbol_count: feedHealth.healthy_symbol_count,
            missing_launch_instruments: feedHealth.missing_launch_instruments
          },
          domain_summary: summarizeDomainRecords(domainRecords)
        },
        admin_email: adminResult.rows[0]?.email || null,
        admin_full_name: adminResult.rows[0]?.full_name || null,
        domains: row.domains || [],
        domain_records: domainRecords
      }
    }))

    res.json(rows)
  } catch (error) {
    logger.error('[admin/tenants] list error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch tenants' })
  }
})

router.post('/tenants', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  const payload = normalizeTenantPayload(req.body)
  if (!payload.slug || !payload.name) {
    return res.status(400).json({ error: 'Tenant slug and name are required' })
  }

  const client = await pool.connect()
  try {
    await ensureTenantInfrastructure()
    await client.query('BEGIN')

    const insertResult = await client.query(
      `INSERT INTO tenants
        (slug, name, status, primary_domain, logo_text, logo_url, support_email, email_from_name, brand_json, settings_json, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, '{}'::jsonb, NOW())
       RETURNING *`,
      [
        payload.slug,
        payload.name,
        payload.status,
        payload.primary_domain || null,
        payload.logo_text || payload.name,
        payload.logo_url || null,
        payload.support_email || null,
        payload.email_from_name || payload.name,
        JSON.stringify(payload.brand)
      ]
    )

    const tenant = insertResult.rows[0]
    await upsertTenantDomainRecords(
      client,
      tenant.id,
      payload.domain_records.length > 0 ? payload.domain_records : payload.domains,
      payload.primary_domain
    )

    await upsertTenantSettings(client, tenant.id, payload.settings)
    await upsertTenantPriceFeedConfig(client, tenant.id, payload.feed)
    if (payload.admin.email && payload.admin.password) {
      const passwordHash = await bcrypt.hash(payload.admin.password, 12)
      await client.query(
        `INSERT INTO tenant_admins (tenant_id, email, password_hash, full_name, role, status)
         VALUES ($1, LOWER($2), $3, $4, 'tenant_admin', 'active')
         ON CONFLICT (tenant_id, email)
         DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), tenant_admins.full_name),
           status = 'active',
           updated_at = NOW()`,
        [tenant.id, payload.admin.email, passwordHash, payload.admin.full_name || payload.name]
      )
    }

    await client.query('COMMIT')
    clearTenantPolicyCache(tenant.id)
    res.status(201).json(tenant)
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { })
    logger.error('[admin/tenants] create error:', { error: error.message })
    res.status(500).json({ error: 'Could not create tenant' })
  } finally {
    client.release()
  }
})

router.patch('/tenants/:tenantId', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  const tenantId = parseInt(req.params.tenantId, 10)
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenant id' })
  }

  const payload = normalizeTenantPayload(req.body)
  if (!payload.slug || !payload.name) {
    return res.status(400).json({ error: 'Tenant slug and name are required' })
  }

  const client = await pool.connect()
  try {
    await ensureTenantInfrastructure()
    await client.query('BEGIN')

    const updateResult = await client.query(
      `UPDATE tenants
          SET slug = $2,
              name = $3,
              status = $4,
              primary_domain = $5,
              logo_text = $6,
              logo_url = $7,
              support_email = $8,
              email_from_name = $9,
              brand_json = $10::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        tenantId,
        payload.slug,
        payload.name,
        payload.status,
        payload.primary_domain || null,
        payload.logo_text || payload.name,
        payload.logo_url || null,
        payload.support_email || null,
        payload.email_from_name || payload.name,
        JSON.stringify(payload.brand)
      ]
    )

    if (updateResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Tenant not found' })
    }

    await upsertTenantDomainRecords(
      client,
      tenantId,
      payload.domain_records.length > 0 ? payload.domain_records : payload.domains,
      payload.primary_domain
    )

    await upsertTenantSettings(client, tenantId, payload.settings)
    await upsertTenantPriceFeedConfig(client, tenantId, payload.feed)
    if (payload.admin.email && payload.admin.password) {
      const passwordHash = await bcrypt.hash(payload.admin.password, 12)
      await client.query(
        `INSERT INTO tenant_admins (tenant_id, email, password_hash, full_name, role, status)
         VALUES ($1, LOWER($2), $3, $4, 'tenant_admin', 'active')
         ON CONFLICT (tenant_id, email)
         DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), tenant_admins.full_name),
           status = 'active',
           updated_at = NOW()`,
        [tenantId, payload.admin.email, passwordHash, payload.admin.full_name || payload.name]
      )
    }

    await client.query('COMMIT')
    clearTenantPolicyCache(tenantId)
    res.json(updateResult.rows[0])
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { })
    logger.error('[admin/tenants] update error:', { error: error.message })
    res.status(500).json({ error: 'Could not update tenant' })
  } finally {
    client.release()
  }
})

router.get('/tenants/:tenantId/domains', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const tenantId = parseInt(req.params.tenantId, 10)
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      return res.status(400).json({ error: 'Invalid tenant id' })
    }
    await ensureTenantInfrastructure()
    res.json(await listTenantDomainRecords(tenantId))
  } catch (error) {
    logger.error('[admin/tenants] domain list error:', { error: error.message })
    res.status(500).json({ error: 'Could not load tenant domains' })
  }
})

router.post('/tenants/:tenantId/domains', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  const tenantId = parseInt(req.params.tenantId, 10)
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenant id' })
  }

  try {
    await ensureTenantInfrastructure()
    const currentDomains = await listTenantDomainRecords(tenantId)
    const incoming = {
      hostname: extractHostname(req.body?.hostname || ''),
      domain_type: String(req.body?.domain_type || 'custom_domain').trim().toLowerCase() || 'custom_domain',
      verification_status: String(req.body?.verification_status || 'pending').trim().toLowerCase() || 'pending',
      ssl_status: String(req.body?.ssl_status || 'pending').trim().toLowerCase() || 'pending',
      certificate_path: String(req.body?.certificate_path || '').trim() || null,
      certificate_metadata: req.body?.certificate_metadata || {},
      verification_token: String(req.body?.verification_token || '').trim() || null
    }

    if (!incoming.hostname) {
      return res.status(400).json({ error: 'hostname is required' })
    }

    const primaryDomain = parseBooleanFlag(req.body?.is_primary)
      ? incoming.hostname
      : (currentDomains.find((domain) => domain.is_primary)?.hostname || null)

    await upsertTenantDomainRecords(
      pool,
      tenantId,
      [
        ...currentDomains
          .filter((domain) => domain.hostname !== incoming.hostname)
          .map((domain) => ({
            ...domain,
            certificate_metadata: domain.certificate_metadata
          })),
        incoming
      ],
      primaryDomain
    )

    res.status(201).json(await listTenantDomainRecords(tenantId))
  } catch (error) {
    logger.error('[admin/tenants] domain create error:', { error: error.message })
    res.status(500).json({ error: 'Could not save tenant domain' })
  }
})

router.patch('/tenants/:tenantId/domains/:domainId', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  const tenantId = parseInt(req.params.tenantId, 10)
  const domainId = parseInt(req.params.domainId, 10)
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(domainId) || domainId <= 0) {
    return res.status(400).json({ error: 'Invalid tenant/domain id' })
  }

  try {
    const currentDomains = await listTenantDomainRecords(tenantId)
    const currentDomain = currentDomains.find((domain) => String(domain.id) === String(domainId))
    if (!currentDomain) {
      return res.status(404).json({ error: 'Tenant domain not found' })
    }

    const updatedDomain = {
      ...currentDomain,
      hostname: extractHostname(req.body?.hostname || currentDomain.hostname),
      domain_type: String(req.body?.domain_type || currentDomain.domain_type).trim().toLowerCase() || currentDomain.domain_type,
      verification_status: String(req.body?.verification_status || currentDomain.verification_status).trim().toLowerCase() || currentDomain.verification_status,
      ssl_status: String(req.body?.ssl_status || currentDomain.ssl_status).trim().toLowerCase() || currentDomain.ssl_status,
      certificate_path: String(req.body?.certificate_path || currentDomain.certificate_path || '').trim() || null,
      certificate_metadata: req.body?.certificate_metadata || currentDomain.certificate_metadata || {},
      verification_token: String(req.body?.verification_token || currentDomain.verification_token || '').trim() || null
    }

    const primaryDomain = parseBooleanFlag(req.body?.is_primary)
      ? updatedDomain.hostname
      : (currentDomains.find((domain) => domain.is_primary)?.hostname || null)

    await upsertTenantDomainRecords(
      pool,
      tenantId,
      currentDomains.map((domain) => (
        String(domain.id) === String(domainId)
          ? updatedDomain
          : {
              ...domain,
              certificate_metadata: domain.certificate_metadata
            }
      )),
      primaryDomain
    )

    res.json(await listTenantDomainRecords(tenantId))
  } catch (error) {
    logger.error('[admin/tenants] domain update error:', { error: error.message })
    res.status(500).json({ error: 'Could not update tenant domain' })
  }
})

router.delete('/tenants/:tenantId/domains/:domainId', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  const tenantId = parseInt(req.params.tenantId, 10)
  const domainId = parseInt(req.params.domainId, 10)
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(domainId) || domainId <= 0) {
    return res.status(400).json({ error: 'Invalid tenant/domain id' })
  }

  try {
    const currentDomains = await listTenantDomainRecords(tenantId)
    const remaining = currentDomains.filter((domain) => String(domain.id) !== String(domainId))
    const nextPrimaryDomain = remaining.find((domain) => domain.is_primary)?.hostname || null

    await upsertTenantDomainRecords(
      pool,
      tenantId,
      remaining.map((domain) => ({
        ...domain,
        certificate_metadata: domain.certificate_metadata
      })),
      nextPrimaryDomain
    )

    res.json(await listTenantDomainRecords(tenantId))
  } catch (error) {
    logger.error('[admin/tenants] domain delete error:', { error: error.message })
    res.status(500).json({ error: 'Could not delete tenant domain' })
  }
})

module.exports = router
