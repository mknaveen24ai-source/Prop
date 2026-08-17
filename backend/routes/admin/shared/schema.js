// Feature-table DDL and platform_settings access, moved verbatim from
// routes/admin.js during the admin modularization. Leaf module: depends only on
// the pool and the tenant-settings bootstrap.
const pool = require('../../../db')
const { ensureTenantSettingsInfrastructure } = require('../../../utils/tenantSettings')

let _featureTablesReady = false
let _featureTablesPromise = null

async function runEnsureFeatureTables() {
  if (_featureTablesReady) return

  await ensureTenantSettingsInfrastructure()

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_incidents (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      acknowledged_by TEXT
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_incidents_status_created ON admin_incidents(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_rules (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 100,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_rules_enabled_priority ON admin_rules(enabled, priority ASC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_enforcement_events (
      id BIGSERIAL PRIMARY KEY,
      rule_id BIGINT REFERENCES admin_rules(id) ON DELETE SET NULL,
      account_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'applied',
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_enforcement_events_created ON admin_enforcement_events(created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_balance_adjustments (
      id BIGSERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      user_id TEXT,
      amount NUMERIC(15,2) NOT NULL,
      balance_before NUMERIC(15,2),
      balance_after NUMERIC(15,2),
      reason TEXT NOT NULL DEFAULT '',
      adjustment_type TEXT NOT NULL DEFAULT 'manual',
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // CREATE TABLE IF NOT EXISTS is a no-op against a table that already exists in
  // an older shape, so the DDL above silently did nothing on databases carrying
  // the hand-built version of this table — and adjust-balance failed on every
  // call with `column "user_id" does not exist`. Reconciling ALTERs are what
  // make the declaration above actually authoritative; see migration 031 and
  // the same pattern in services/violationEngine.js.
  //
  // The other tables in this file have the same latent hazard and no known
  // drift; if one ever does, extend it the same way rather than editing the
  // CREATE and expecting it to take effect.
  for (const [column, definition] of [
    ['user_id', `TEXT`],
    ['balance_before', `NUMERIC(15,2)`],
    ['balance_after', `NUMERIC(15,2)`],
    ['adjustment_type', `TEXT NOT NULL DEFAULT 'manual'`],
    ['created_by', `TEXT NOT NULL DEFAULT 'admin'`]
  ]) {
    await pool.query(`ALTER TABLE admin_balance_adjustments ADD COLUMN IF NOT EXISTS ${column} ${definition}`)
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_balance_adjustments_account_created ON admin_balance_adjustments(account_id, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_immutable_audit (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'admin',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload_text TEXT NOT NULL DEFAULT '{}',
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_immutable_audit_created ON admin_immutable_audit(created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_four_eyes_requests (
      id BIGSERIAL PRIMARY KEY,
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'generic',
      target_id TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      requested_by TEXT NOT NULL DEFAULT 'admin',
      approvals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      required_approvals INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_four_eyes_status_created ON admin_four_eyes_requests(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_feature_flags (
      id BIGSERIAL PRIMARY KEY,
      flag_key TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rollout_pct INTEGER NOT NULL DEFAULT 100,
      segment TEXT NOT NULL DEFAULT 'all',
      updated_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_feature_flags_updated ON admin_feature_flags(updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'info',
      channel TEXT NOT NULL DEFAULT 'web',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'all',
      status TEXT NOT NULL DEFAULT 'queued',
      scheduled_for TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_notifications_status_created ON admin_notifications(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_cases (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      owner TEXT,
      notes TEXT,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_cases_status_priority ON admin_cases(status, priority, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_saved_views (
      id BIGSERIAL PRIMARY KEY,
      admin_id TEXT NOT NULL DEFAULT '',
      admin_role TEXT NOT NULL DEFAULT 'admin',
      resource TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_saved_views_owner_resource ON admin_saved_views(admin_id, resource, updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_entity_meta (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      owner_admin_id TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      workflow_status TEXT NOT NULL DEFAULT 'open',
      classification TEXT,
      risk_tier TEXT NOT NULL DEFAULT 'low',
      status_reason TEXT,
      sla_state TEXT,
      linked_case_id BIGINT REFERENCES admin_cases(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, entity_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_entity_meta_type_updated ON admin_entity_meta(entity_type, updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_entity_tags (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (entity_type, entity_id, tag)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_entity_tags_lookup ON admin_entity_tags(entity_type, entity_id, tag)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_entity_notes (
      id BIGSERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      note_text TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_entity_notes_lookup ON admin_entity_notes(entity_type, entity_id, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_dispute_meta (
      id BIGSERIAL PRIMARY KEY,
      dispute_id TEXT NOT NULL UNIQUE,
      owner TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      sla_hours INTEGER NOT NULL DEFAULT 48,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_dispute_meta_updated ON admin_dispute_meta(updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_scheduled_reports (
      id BIGSERIAL PRIMARY KEY,
      report_key TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      recipients TEXT NOT NULL DEFAULT '',
      schedule_cron TEXT NOT NULL DEFAULT '0 9 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_scheduled_reports_enabled ON admin_scheduled_reports(enabled, updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'super_admin',
      status TEXT NOT NULL DEFAULT 'active',
      token_version INTEGER NOT NULL DEFAULT 1,
      totp_secret TEXT,
      totp_temp_secret TEXT,
      totp_backup_codes TEXT,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_admins_status_email ON platform_admins(status, email)`)

  // Backfill-safe columns used by auto-enforcement actions.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flag_reason TEXT`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1`)
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_rejection_reason TEXT`)
  await pool.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS flag_reason TEXT`)
  await pool.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS admin_notes TEXT`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_status_created ON accounts(status, created_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payouts_status_requested ON payouts(status, requested_at DESC)`)

  _featureTablesReady = true
}

async function ensureFeatureTables() {
  if (_featureTablesReady) return
  if (!_featureTablesPromise) {
    _featureTablesPromise = runEnsureFeatureTables().catch((error) => {
      _featureTablesPromise = null
      throw error
    })
  }
  await _featureTablesPromise
}

async function getSettingsMap(keys) {
  if (!keys || keys.length === 0) return {}
  const result = await pool.query(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [keys]
  )
  const out = {}
  for (const row of result.rows) out[row.key] = row.value
  return out
}

async function upsertSetting(client, key, value) {
  await client.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  )
}

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v || '').toLowerCase().trim()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

module.exports = {
  ensureFeatureTables,
  getSettingsMap,
  upsertSetting,
  toBool
}
