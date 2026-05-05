const pool = require('../db')
const logger = require('./logger')
const { runWithSystemDbContext } = require('./dbContext')

const DEFAULT_TENANT_SETTINGS = {
  phase1_profit_target_pct: '10',
  phase1_max_drawdown_pct: '10',
  phase1_day_limit: '30',
  phase2_profit_target_pct: '5',
  phase2_max_drawdown_pct: '5',
  phase2_day_limit: '30',
  funded_max_drawdown_pct: '5',
  profit_share_pct: '80',
  max_accounts_per_user: '5',
  max_daily_trades: '20',
  min_hold_seconds: '60',
  min_lot_size: '0.01',
  forex_lots_per_1k: '0.20',
  commodity_lots_per_1k: '0.02',
  max_trades_per_1k: '5',
  inactivity_auto_fail_enabled: 'true',
  inactivity_fail_days: '30',
  weekend_holding_enabled: 'true',
  requires_payment: 'false',
  challenge_checkout_mode: 'free',
  challenge_fee_amount: '0',
  challenge_fee_currency: 'USD',
  challenge_fee_label: 'FREE',
  shared_price_feed_enabled: 'true',
  use_shared_feed_only: 'true',
  spread_markup_points_json: '{}',
  allow_custom_mt5_feed: 'false',
  payment_provider: '',
  payment_provider_public_key: '',
  payment_provider_secret_key: '',
  payment_provider_webhook_secret: '',
  payment_provider_account_id: '',
  billing_email: '',
  subscription_plan_code: 'starter',
  subscription_seats: '1',
  revenue_share_enabled: 'false',
  revenue_share_pct: '0',
  support_mode: 'tenant',
  marketing_mode: 'free',
  quota_1000: '999999',
  quota_2000: '999999',
  quota_2500: '999999',
  quota_5000: '999999',
  quota_10000: '999999',
  quota_25000: '999999',
  quota_50000: '999999',
  quota_100000: '999999',
  quota_200000: '999999'
}

let tenantSettingsInfrastructurePromise = null

function normalizeSettingValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

async function ensureTenantSettingsInfrastructure() {
  if (tenantSettingsInfrastructurePromise) return tenantSettingsInfrastructurePromise

  tenantSettingsInfrastructurePromise = runWithSystemDbContext(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_settings (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, key)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_settings_tenant_key ON tenant_settings(tenant_id, key)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_admins (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        role TEXT NOT NULL DEFAULT 'tenant_admin',
        status TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 1,
        totp_secret TEXT,
        totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, email)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_admins_tenant_status ON tenant_admins(tenant_id, status)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_products (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        account_size NUMERIC(12,2) NOT NULL,
        display_name TEXT,
        challenge_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, account_size)
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_orders (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        account_size NUMERIC(12,2) NOT NULL,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_mode TEXT NOT NULL DEFAULT 'free',
        payment_provider TEXT,
        paid_via TEXT,
        provider_reference TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        expires_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // FIX: If an old deployment created challenge_orders with BIGINT user_id + FK,
    // drop that FK and convert the column to TEXT to match users.id (UUID) type.
    await pool.query(`
      DO $$
      DECLARE
        r RECORD;
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'challenge_orders') THEN
          FOR r IN
            SELECT con.conname
            FROM pg_constraint con
            JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = ANY(con.conkey)
            WHERE con.conrelid = 'challenge_orders'::regclass
              AND con.contype = 'f'
              AND attr.attname = 'user_id'
          LOOP
            EXECUTE format('ALTER TABLE challenge_orders DROP CONSTRAINT IF EXISTS %I', r.conname);
          END LOOP;
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'challenge_orders'
              AND column_name = 'user_id'
              AND data_type IN ('bigint','integer','smallint')
          ) THEN
            ALTER TABLE challenge_orders ALTER COLUMN user_id TYPE TEXT USING user_id::text;
          END IF;
        END IF;
      END$$;
    `).catch(() => {})

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenge_orders_tenant_user_status ON challenge_orders(tenant_id, user_id, status, created_at DESC)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_payments (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        order_id BIGINT NOT NULL REFERENCES challenge_orders(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_payment_id TEXT,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        platform_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        tenant_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE challenge_payments ADD COLUMN IF NOT EXISTS platform_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
    await pool.query(`ALTER TABLE challenge_payments ADD COLUMN IF NOT EXISTS tenant_net_amount NUMERIC(12,2) NOT NULL DEFAULT 0`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenge_payments_tenant_order ON challenge_payments(tenant_id, order_id, status)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_price_feeds (
        id BIGSERIAL PRIMARY KEY,
        tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        feed_name TEXT NOT NULL DEFAULT 'shared',
        feed_mode TEXT NOT NULL DEFAULT 'shared',
        dwx_path TEXT,
        mt5_host TEXT,
        mt5_port INTEGER,
        spread_markup_points_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, feed_name)
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tenant_price_feeds_tenant_mode ON tenant_price_feeds(tenant_id, feed_mode, is_active)`)
  }).catch((error) => {
    tenantSettingsInfrastructurePromise = null
    logger.error('[tenant-settings] Failed to ensure infrastructure:', { error: error.message })
    throw error
  })

  return tenantSettingsInfrastructurePromise
}

async function getTenantSettingsMap(tenantId, keys = []) {
  await ensureTenantSettingsInfrastructure()

  const normalizedTenantId = parseInt(tenantId, 10)
  const useKeyFilter = Array.isArray(keys) && keys.length > 0

  const [platformResult, tenantResult] = await Promise.all([
    useKeyFilter
      ? pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`, [keys])
      : pool.query(`SELECT key, value FROM platform_settings`),
    Number.isFinite(normalizedTenantId) && normalizedTenantId > 0
      ? (useKeyFilter
          ? pool.query(`SELECT key, value FROM tenant_settings WHERE tenant_id = $1 AND key = ANY($2::text[])`, [normalizedTenantId, keys])
          : pool.query(`SELECT key, value FROM tenant_settings WHERE tenant_id = $1`, [normalizedTenantId]))
      : Promise.resolve({ rows: [] })
  ])

  const settings = { ...DEFAULT_TENANT_SETTINGS }
  for (const row of platformResult.rows) settings[row.key] = row.value
  for (const row of tenantResult.rows) settings[row.key] = row.value
  return settings
}

async function getTenantSettingValue(tenantId, key, fallback = null) {
  const settings = await getTenantSettingsMap(tenantId, [key])
  return settings[key] !== undefined ? settings[key] : fallback
}

async function upsertTenantSettings(clientOrPool, tenantId, settings = {}) {
  await ensureTenantSettingsInfrastructure()

  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const normalizedTenantId = parseInt(tenantId, 10)
  if (!Number.isFinite(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new Error('Valid tenant_id is required for tenant settings')
  }

  const entries = Object.entries(settings).filter(([key]) => !!key)
  for (const [key, value] of entries) {
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [normalizedTenantId, key, normalizeSettingValue(value)]
    )
  }
}

async function ensureTenantSettingDefaults(clientOrPool, tenantId, defaults = DEFAULT_TENANT_SETTINGS) {
  await ensureTenantSettingsInfrastructure()

  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const normalizedTenantId = parseInt(tenantId, 10)
  if (!Number.isFinite(normalizedTenantId) || normalizedTenantId <= 0) {
    throw new Error('Valid tenant_id is required for tenant settings')
  }

  const entries = Object.entries(defaults).filter(([key]) => !!key)
  for (const [key, value] of entries) {
    await db.query(
      `INSERT INTO tenant_settings (tenant_id, key, value, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, key)
       DO NOTHING`,
      [normalizedTenantId, key, normalizeSettingValue(value)]
    )
  }
}

function parseBooleanSetting(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const normalized = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true
  if (['false', '0', 'no', 'off'].includes(normalized)) return false
  return fallback
}

function parseSpreadMarkupMap(rawValue) {
  if (!rawValue) return {}
  if (typeof rawValue === 'object') return rawValue
  try {
    const parsed = JSON.parse(rawValue)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getInstrumentSpreadMarkup(settings, instrument) {
  const spreadMap = parseSpreadMarkupMap(settings?.spread_markup_points_json)
  const specific = Number(spreadMap?.[instrument])
  if (Number.isFinite(specific)) return specific
  const wildcard = Number(spreadMap?.['*'])
  return Number.isFinite(wildcard) ? wildcard : 0
}

module.exports = {
  DEFAULT_TENANT_SETTINGS,
  ensureTenantSettingDefaults,
  ensureTenantSettingsInfrastructure,
  getInstrumentSpreadMarkup,
  getTenantSettingValue,
  getTenantSettingsMap,
  parseBooleanSetting,
  parseSpreadMarkupMap,
  upsertTenantSettings
}
