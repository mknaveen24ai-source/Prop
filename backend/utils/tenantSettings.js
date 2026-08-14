const pool = require('../db')
const logger = require('./logger')

const DEFAULT_TENANT_SETTINGS = {
  phase1_profit_target_pct: '10',
  phase1_max_drawdown_pct: '10',
  phase1_day_limit: '30',
  phase2_profit_target_pct: '5',
  phase2_max_drawdown_pct: '5',
  phase2_day_limit: '30',
  funded_max_drawdown_pct: '4',
  profit_share_pct: '75',
  max_accounts_per_user: '5',
  max_daily_trades: '20',
  min_hold_seconds: '60',
  min_lot_size: '0.01',
  forex_lots_per_1k: '0.10',
  commodity_lots_per_1k: '0.02',
  max_trades_per_1k: '5',
  max_open_positions: '10',
  inactivity_auto_fail_enabled: 'true',
  inactivity_fail_days: '30',
  weekend_holding_enabled: 'true',
  shared_price_feed_enabled: 'true',
  use_shared_feed_only: 'true',
  spread_markup_points_json: '{}',
  commission_per_lot_json: '{}',
  slippage_max_pips_adverse_json: '{}',
  allow_custom_mt5_feed: 'false',
  payment_provider: '',
  payment_provider_public_key: '',
  payment_provider_secret_key: '',
  payment_provider_webhook_secret: '',
  payment_provider_account_id: '',
  billing_email: '',
  quota_5000: '999999',
  quota_10000: '999999',
  quota_25000: '999999',
  quota_50000: '999999',
  quota_100000: '999999'
}

let challengeCommerceInfrastructurePromise = null

function normalizeSettingValue(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// Creates the challenge purchase tables (checkout/orders/payments). These are
// part of the trader-facing challenge product, not the removed multi-tenant
// SaaS billing layer.
async function ensureTenantSettingsInfrastructure() {
  if (challengeCommerceInfrastructurePromise) return challengeCommerceInfrastructurePromise

  challengeCommerceInfrastructurePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_products (
        id BIGSERIAL PRIMARY KEY,
        account_size NUMERIC(12,2) NOT NULL UNIQUE,
        display_name TEXT,
        challenge_fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_orders (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        account_size NUMERIC(12,2) NOT NULL,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_mode TEXT NOT NULL DEFAULT 'paid',
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

    // Gift-a-challenge: a buyer purchases an order for someone else. Added via
    // ALTER (not the CREATE TABLE above) because this table is bootstrapped
    // ad-hoc rather than through a knex migration, so existing deployments
    // need the columns backfilled onto an already-created table.
    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS is_gift BOOLEAN NOT NULL DEFAULT FALSE`)
    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS gift_recipient_email TEXT`)

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenge_orders_user_status ON challenge_orders(user_id, status, created_at DESC)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_payments (
        id BIGSERIAL PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES challenge_orders(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_payment_id TEXT,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // FIX (SECURITY AUDIT): ON CONFLICT DO NOTHING on the INSERT in
    // markChallengeOrderPaid was a no-op with no matching constraint to
    // trigger on — Stripe's documented at-least-once webhook delivery could
    // double-insert a payment row for the same order on redelivery.
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_challenge_payments_order ON challenge_payments(order_id)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_challenge_payments_order ON challenge_payments(order_id, status)`)
  })().catch((error) => {
    challengeCommerceInfrastructurePromise = null
    logger.error('[settings] Failed to ensure challenge commerce infrastructure:', { error: error.message })
    throw error
  })

  return challengeCommerceInfrastructurePromise
}

async function getTenantSettingsMap(keys = []) {
  const useKeyFilter = Array.isArray(keys) && keys.length > 0
  const result = useKeyFilter
    ? await pool.query(`SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`, [keys])
    : await pool.query(`SELECT key, value FROM platform_settings`)

  const settings = { ...DEFAULT_TENANT_SETTINGS }
  for (const row of result.rows) settings[row.key] = row.value
  return settings
}

async function getTenantSettingValue(key, fallback = null) {
  const settings = await getTenantSettingsMap([key])
  return settings[key] !== undefined ? settings[key] : fallback
}

async function upsertTenantSettings(clientOrPool, settings = {}) {
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const entries = Object.entries(settings).filter(([key]) => !!key)
  for (const [key, value] of entries) {
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, normalizeSettingValue(value)]
    )
  }
}

async function ensureTenantSettingDefaults(clientOrPool, defaults = DEFAULT_TENANT_SETTINGS) {
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const entries = Object.entries(defaults).filter(([key]) => !!key)
  for (const [key, value] of entries) {
    await db.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key)
       DO NOTHING`,
      [key, normalizeSettingValue(value)]
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

// Normalizes the DB's 5 raw account_type values down to the 3-way tier axis
// used by per-symbol commission/slippage config: challenge (phase1/2/3),
// funded, competition.
function normalizeAccountTypeTier(accountType) {
  const type = String(accountType || '').toLowerCase()
  if (type === 'funded') return 'funded'
  if (type === 'competition') return 'competition'
  return 'challenge'
}

// Two-level (tier -> instrument) lookup with wildcard fallback at both
// levels, e.g. {"challenge":{"XAUUSD":5,"*":3},"funded":{"*":2}}. Falls
// through tier-specific -> tier wildcard -> global tier ('*') specific ->
// global tier wildcard -> caller-supplied fallback (the legacy flat setting).
function resolveTieredInstrumentSetting(rawJsonValue, accountType, instrument, fallback) {
  const map = parseSpreadMarkupMap(rawJsonValue)
  const tier = normalizeAccountTypeTier(accountType)

  const tierMap = map?.[tier]
  const tierSpecific = Number(tierMap?.[instrument])
  if (Number.isFinite(tierSpecific)) return tierSpecific
  const tierWildcard = Number(tierMap?.['*'])
  if (Number.isFinite(tierWildcard)) return tierWildcard

  const globalTierMap = map?.['*']
  const globalSpecific = Number(globalTierMap?.[instrument])
  if (Number.isFinite(globalSpecific)) return globalSpecific
  const globalWildcard = Number(globalTierMap?.['*'])
  if (Number.isFinite(globalWildcard)) return globalWildcard

  return fallback
}

module.exports = {
  DEFAULT_TENANT_SETTINGS,
  ensureTenantSettingDefaults,
  ensureTenantSettingsInfrastructure,
  getInstrumentSpreadMarkup,
  getTenantSettingValue,
  getTenantSettingsMap,
  normalizeAccountTypeTier,
  parseBooleanSetting,
  parseSpreadMarkupMap,
  resolveTieredInstrumentSetting,
  upsertTenantSettings
}
