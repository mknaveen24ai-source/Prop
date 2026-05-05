const { URL } = require('url')
const pool = require('../db')
const logger = require('./logger')
const { runWithSystemDbContext } = require('./dbContext')
const {
  DEFAULT_TENANT_SETTINGS,
  ensureTenantSettingsInfrastructure,
} = require('./tenantSettings')

const DEFAULT_TENANT_SLUG = 'default'
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

let tenantInfrastructurePromise = null

function safeJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function normalizeTenantSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function extractHostname(input) {
  if (!input) return ''
  const raw = String(input).trim()
  if (!raw) return ''

  try {
    const parsed = raw.includes('://')
      ? new URL(raw)
      : new URL(`http://${raw}`)
    return String(parsed.hostname || '').trim().toLowerCase()
  } catch {
    return raw.split(':')[0].trim().toLowerCase()
  }
}

function isLocalHostname(hostname) {
  return LOCAL_HOSTS.has(String(hostname || '').trim().toLowerCase())
}

function getPrimaryDomainFromEnv() {
  return extractHostname(process.env.FRONTEND_URL || '')
}

function getDefaultBranding(name = process.env.PLATFORM_NAME || 'PropFirm') {
  return {
    short_name: name,
    logo_text: name,
    tagline: 'Free funded trading accounts with transparent rules.',
    hero_title: `${name} | Free Funded Trading Accounts`,
    hero_subtitle: 'Transparent rules, real progression, and white-label-ready infrastructure.',
    primary_color: '#2563eb',
    accent_color: '#0ea5e9'
  }
}

function normalizeSettingValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function buildTenantContext(row) {
  const baseName = row?.name || process.env.PLATFORM_NAME || 'PropFirm'
  const brand = {
    ...getDefaultBranding(baseName),
    ...safeJson(row?.brand_json, {})
  }
  return {
    id: row?.id || null,
    slug: row?.slug || DEFAULT_TENANT_SLUG,
    name: baseName,
    status: row?.status || 'active',
    primary_domain: row?.primary_domain || null,
    support_email: row?.support_email || null,
    email_from_name: row?.email_from_name || baseName,
    logo_url: row?.logo_url || null,
    logo_text: row?.logo_text || brand.logo_text || baseName,
    brand,
    settings: safeJson(row?.settings_json, {}),
    subscription_status: safeJson(row?.settings_json, {}).subscription_status || null,
    subscription_grace_until: safeJson(row?.settings_json, {}).subscription_grace_until || null
  }
}

function getRequestedTenantSlug(req) {
  return normalizeTenantSlug(req?.headers?.['x-tenant-slug'] || req?.query?.tenant || '')
}

function getRequestHostname(req) {
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0]
  return extractHostname(forwardedHost || req?.headers?.host || '')
}

async function ensureTenantInfrastructure() {
  if (tenantInfrastructurePromise) return tenantInfrastructurePromise

  tenantInfrastructurePromise = runWithSystemDbContext(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id BIGSERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        primary_domain TEXT,
        logo_text TEXT,
        logo_url TEXT,
        support_email TEXT,
        email_from_name TEXT,
        brand_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        settings_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenants_status_slug ON tenants(status, slug)`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_primary_domain_unique ON tenants((LOWER(primary_domain))) WHERE primary_domain IS NOT NULL`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_domains (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        hostname TEXT NOT NULL UNIQUE,
        domain_type TEXT NOT NULL DEFAULT 'custom_domain',
        is_primary BOOLEAN NOT NULL DEFAULT FALSE,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        ssl_status TEXT NOT NULL DEFAULT 'pending',
        certificate_path TEXT,
        certificate_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        verification_token TEXT,
        verified_at TIMESTAMPTZ,
        ssl_updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant_id ON tenant_domains(tenant_id)`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS domain_type TEXT NOT NULL DEFAULT 'custom_domain'`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending'`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS ssl_status TEXT NOT NULL DEFAULT 'pending'`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS certificate_path TEXT`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS certificate_metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS verification_token TEXT`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS ssl_updated_at TIMESTAMPTZ`)
    await pool.query(`ALTER TABLE tenant_domains ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_domains_tenant_verification ON tenant_domains(tenant_id, verification_status, ssl_status)`)

    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
    await pool.query(`ALTER TABLE IF EXISTS trades ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
    await pool.query(`ALTER TABLE IF EXISTS payouts ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_tenant_id ON accounts(tenant_id)`)
    await pool.query(`
      DO $$
      BEGIN
        IF to_regclass('public.trades') IS NOT NULL THEN
          EXECUTE 'CREATE INDEX IF NOT EXISTS idx_trades_tenant_id ON trades(tenant_id)';
        END IF;
        IF to_regclass('public.payouts') IS NOT NULL THEN
          EXECUTE 'CREATE INDEX IF NOT EXISTS idx_payouts_tenant_id ON payouts(tenant_id)';
        END IF;
      END
      $$;
    `)

    const defaultBranding = getDefaultBranding()
    const defaultDomain = getPrimaryDomainFromEnv()
    const tenantResult = await pool.query(
      `INSERT INTO tenants
        (slug, name, status, primary_domain, logo_text, support_email, email_from_name, brand_json, settings_json)
       VALUES ($1, $2, 'active', $3, $4, $5, $6, $7::jsonb, '{}'::jsonb)
       ON CONFLICT (slug)
       DO UPDATE SET
         primary_domain = COALESCE(tenants.primary_domain, EXCLUDED.primary_domain),
         logo_text = COALESCE(tenants.logo_text, EXCLUDED.logo_text),
         support_email = COALESCE(tenants.support_email, EXCLUDED.support_email),
         email_from_name = COALESCE(tenants.email_from_name, EXCLUDED.email_from_name),
         brand_json = CASE
           WHEN tenants.brand_json IS NULL OR tenants.brand_json = '{}'::jsonb THEN EXCLUDED.brand_json
           ELSE tenants.brand_json
         END
       RETURNING *`,
      [
        DEFAULT_TENANT_SLUG,
        process.env.PLATFORM_NAME || 'PropFirm',
        defaultDomain || null,
        defaultBranding.logo_text,
        process.env.SUPPORT_EMAIL || null,
        process.env.FIRM_NAME || process.env.PLATFORM_NAME || 'PropFirm',
        JSON.stringify(defaultBranding)
      ]
    )

    const defaultTenantId = tenantResult.rows[0].id
    await ensureTenantSettingsInfrastructure()

    if (defaultDomain && !isLocalHostname(defaultDomain)) {
      await pool.query(
        `INSERT INTO tenant_domains
          (tenant_id, hostname, domain_type, is_primary, verification_status, ssl_status, verified_at, ssl_updated_at, updated_at)
         VALUES ($1, LOWER($2), 'platform_subdomain', TRUE, 'verified', 'active', NOW(), NOW(), NOW())
         ON CONFLICT (hostname)
         DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           domain_type = EXCLUDED.domain_type,
           is_primary = TRUE,
           verification_status = 'verified',
           ssl_status = 'active',
           verified_at = COALESCE(tenant_domains.verified_at, NOW()),
           ssl_updated_at = NOW(),
           updated_at = NOW()`,
        [defaultTenantId, defaultDomain]
      )
    }

    await pool.query(`UPDATE users SET tenant_id = $1 WHERE tenant_id IS NULL`, [defaultTenantId])
    await pool.query(
      `UPDATE accounts a
          SET tenant_id = COALESCE(a.tenant_id, u.tenant_id, $1)
         FROM users u
        WHERE a.user_id = u.id
          AND (a.tenant_id IS NULL OR u.tenant_id IS NULL)`,
      [defaultTenantId]
    )
    await pool.query(`UPDATE accounts SET tenant_id = $1 WHERE tenant_id IS NULL`, [defaultTenantId])
    await pool.query(
      `UPDATE trades t
          SET tenant_id = COALESCE(t.tenant_id, a.tenant_id, u.tenant_id, $1)
         FROM accounts a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE t.account_id = a.id
          AND (t.tenant_id IS NULL OR a.tenant_id IS NULL OR u.tenant_id IS NULL)`,
      [defaultTenantId]
    )
    await pool.query(`UPDATE trades SET tenant_id = $1 WHERE tenant_id IS NULL`, [defaultTenantId])
    await pool.query(
      `WITH resolved_payout_tenants AS (
         SELECT p.id,
                COALESCE(p.tenant_id, a.tenant_id, u.tenant_id, $1) AS resolved_tenant_id
           FROM payouts p
           LEFT JOIN users u ON u.id = p.user_id
           LEFT JOIN accounts a ON a.id = p.account_id
          WHERE p.tenant_id IS NULL
             OR u.tenant_id IS NULL
             OR a.tenant_id IS NULL
       )
       UPDATE payouts p
          SET tenant_id = r.resolved_tenant_id
         FROM resolved_payout_tenants r
        WHERE p.id = r.id`,
      [defaultTenantId]
    )

    await pool.query(`UPDATE payouts SET tenant_id = $1 WHERE tenant_id IS NULL`, [defaultTenantId])
    for (const [key, value] of Object.entries(DEFAULT_TENANT_SETTINGS)) {
      await pool.query(
        `DELETE FROM tenant_settings
          WHERE tenant_id = $1
            AND key = $2
            AND value = $3`,
        [defaultTenantId, key, normalizeSettingValue(value)]
      )
    }
  }).catch((error) => {
    tenantInfrastructurePromise = null
    logger.error('[tenants] Failed to ensure tenant infrastructure:', { error: error.message })
    throw error
  })

  return tenantInfrastructurePromise
}

async function resolveTenant({ slug, hostname }) {
  await ensureTenantInfrastructure()

  const normalizedSlug = normalizeTenantSlug(slug)
  const normalizedHost = extractHostname(hostname)

  if (normalizedSlug) {
    const bySlug = await pool.query(
      `SELECT * FROM tenants WHERE slug = $1 AND status = 'active' LIMIT 1`,
      [normalizedSlug]
    )
    if (bySlug.rows.length > 0) return buildTenantContext(bySlug.rows[0])
  }

  if (normalizedHost && !isLocalHostname(normalizedHost)) {
    const byHost = await pool.query(
      `SELECT t.*
         FROM tenants t
         LEFT JOIN tenant_domains d ON d.tenant_id = t.id
        WHERE t.status = 'active'
          AND (
            LOWER(COALESCE(t.primary_domain, '')) = LOWER($1)
            OR (
              LOWER(COALESCE(d.hostname, '')) = LOWER($1)
              AND d.verification_status IN ('verified', 'platform_managed')
            )
          )
        ORDER BY d.is_primary DESC NULLS LAST, t.id ASC
        LIMIT 1`,
      [normalizedHost]
    )
    if (byHost.rows.length > 0) return buildTenantContext(byHost.rows[0])
  }

  const fallback = await pool.query(
    `SELECT * FROM tenants WHERE slug = $1 LIMIT 1`,
    [DEFAULT_TENANT_SLUG]
  )
  return buildTenantContext(fallback.rows[0] || null)
}

async function getTenantById(id) {
  await ensureTenantInfrastructure()
  const tenantId = parseInt(id, 10)
  if (!Number.isFinite(tenantId) || tenantId <= 0) return null

  const result = await pool.query(
    `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  )
  if (result.rows.length === 0) return null
  return buildTenantContext(result.rows[0])
}

async function attachTenantContext(req, res, next) {
  try {
    req.tenant = await resolveTenant({
      slug: getRequestedTenantSlug(req),
      hostname: getRequestHostname(req)
    })
    res.locals.tenant = req.tenant
    next()
  } catch (error) {
    logger.error('[tenants] Failed to resolve tenant for request:', { error: error.message })
    res.status(503).json({ error: 'Tenant resolution unavailable' })
  }
}

async function isAllowedOrigin(origin) {
  if (!origin) return true
  const hostname = extractHostname(origin)
  if (!hostname || isLocalHostname(hostname)) return true

  try {
    await ensureTenantInfrastructure()
    const result = await pool.query(
      `SELECT 1
         FROM tenants t
         LEFT JOIN tenant_domains d ON d.tenant_id = t.id
        WHERE t.status = 'active'
          AND (
            LOWER(COALESCE(t.primary_domain, '')) = LOWER($1)
            OR (
              LOWER(COALESCE(d.hostname, '')) = LOWER($1)
              AND d.verification_status IN ('verified', 'platform_managed')
            )
          )
        LIMIT 1`,
      [hostname]
    )
    return result.rows.length > 0
  } catch (error) {
    logger.warn('[tenants] Origin allow-check failed:', { error: error.message, origin })
    return false
  }
}

function buildTenantDomainRecord(row) {
  return {
    id: row?.id || null,
    tenant_id: row?.tenant_id || null,
    hostname: row?.hostname || null,
    domain_type: row?.domain_type || 'custom_domain',
    is_primary: row?.is_primary === true,
    verification_status: row?.verification_status || 'pending',
    ssl_status: row?.ssl_status || 'pending',
    certificate_path: row?.certificate_path || null,
    certificate_metadata: safeJson(row?.certificate_metadata_json, {}),
    verification_token: row?.verification_token || null,
    verified_at: row?.verified_at || null,
    ssl_updated_at: row?.ssl_updated_at || null,
    created_at: row?.created_at || null,
    updated_at: row?.updated_at || null
  }
}

async function listTenantDomainRecords(tenantId) {
  await ensureTenantInfrastructure()
  const normalizedTenantId = parseInt(tenantId, 10)
  if (!Number.isFinite(normalizedTenantId) || normalizedTenantId <= 0) return []
  const result = await pool.query(
    `SELECT *
       FROM tenant_domains
      WHERE tenant_id = $1
      ORDER BY is_primary DESC, hostname ASC`,
    [normalizedTenantId]
  )
  return result.rows.map(buildTenantDomainRecord)
}

async function upsertTenantDomainRecords(clientOrPool, tenantId, domains = [], primaryDomain = null) {
  await ensureTenantInfrastructure()
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const normalizedTenantId = parseInt(tenantId, 10)
  if (!Number.isFinite(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new Error('Valid tenant id is required for tenant domains')
  }

  const normalizedPrimaryDomain = extractHostname(primaryDomain || '')
  const incoming = Array.isArray(domains) ? domains : []
  const normalizedRows = incoming
    .map((entry) => {
      if (typeof entry === 'string') {
        return {
          hostname: extractHostname(entry),
          domain_type: 'custom_domain',
          verification_status: 'pending',
          ssl_status: 'pending',
          certificate_path: null,
          certificate_metadata_json: {},
          verification_token: null
        }
      }

      return {
        hostname: extractHostname(entry?.hostname || ''),
        domain_type: String(entry?.domain_type || 'custom_domain').trim().toLowerCase() || 'custom_domain',
        verification_status: String(entry?.verification_status || 'pending').trim().toLowerCase() || 'pending',
        ssl_status: String(entry?.ssl_status || 'pending').trim().toLowerCase() || 'pending',
        certificate_path: String(entry?.certificate_path || '').trim() || null,
        certificate_metadata_json: safeJson(entry?.certificate_metadata_json || entry?.certificate_metadata || {}, {}),
        verification_token: String(entry?.verification_token || '').trim() || null
      }
    })
    .filter((entry) => !!entry.hostname)

  if (normalizedPrimaryDomain) {
    const existingPrimary = normalizedRows.find((entry) => entry.hostname === normalizedPrimaryDomain)
    if (!existingPrimary) {
      normalizedRows.push({
        hostname: normalizedPrimaryDomain,
        domain_type: 'platform_subdomain',
        verification_status: 'verified',
        ssl_status: 'active',
        certificate_path: null,
        certificate_metadata_json: {},
        verification_token: null
      })
    }
  }

  const seenHosts = new Set()
  const uniqueRows = normalizedRows.filter((entry) => {
    if (seenHosts.has(entry.hostname)) return false
    seenHosts.add(entry.hostname)
    return true
  })

  await db.query(`DELETE FROM tenant_domains WHERE tenant_id = $1`, [normalizedTenantId])

  for (const entry of uniqueRows) {
    const isPrimary = entry.hostname === normalizedPrimaryDomain
    await db.query(
      `INSERT INTO tenant_domains (
         tenant_id, hostname, domain_type, is_primary, verification_status, ssl_status,
         certificate_path, certificate_metadata_json, verification_token, verified_at, ssl_updated_at, updated_at
       ) VALUES (
         $1, LOWER($2), $3, $4, $5, $6,
         $7, $8::jsonb, $9,
         CASE WHEN $5 IN ('verified', 'platform_managed') THEN NOW() ELSE NULL END,
         CASE WHEN $6 = 'active' THEN NOW() ELSE NULL END,
         NOW()
       )
       ON CONFLICT (hostname)
       DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         domain_type = EXCLUDED.domain_type,
         is_primary = EXCLUDED.is_primary,
         verification_status = EXCLUDED.verification_status,
         ssl_status = EXCLUDED.ssl_status,
         certificate_path = EXCLUDED.certificate_path,
         certificate_metadata_json = EXCLUDED.certificate_metadata_json,
         verification_token = EXCLUDED.verification_token,
         verified_at = CASE
           WHEN EXCLUDED.verification_status IN ('verified', 'platform_managed') THEN COALESCE(tenant_domains.verified_at, NOW())
           ELSE tenant_domains.verified_at
         END,
         ssl_updated_at = CASE
           WHEN EXCLUDED.ssl_status = 'active' THEN NOW()
           ELSE tenant_domains.ssl_updated_at
         END,
         updated_at = NOW()`,
      [
        normalizedTenantId,
        entry.hostname,
        entry.domain_type,
        isPrimary,
        entry.verification_status,
        entry.ssl_status,
        entry.certificate_path,
        JSON.stringify(entry.certificate_metadata_json || {}),
        entry.verification_token
      ]
    )
  }
}

module.exports = {
  DEFAULT_TENANT_SLUG,
  buildTenantContext,
  buildTenantDomainRecord,
  ensureTenantInfrastructure,
  extractHostname,
  getRequestHostname,
  getRequestedTenantSlug,
  isAllowedOrigin,
  isLocalHostname,
  listTenantDomainRecords,
  normalizeTenantSlug,
  getTenantById,
  resolveTenant,
  attachTenantContext,
  upsertTenantDomainRecords
}
