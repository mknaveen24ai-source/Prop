/**
 * Migration 008: Remove multi-tenant system
 *
 * The app is now a single-tenant product (one business, one operator).
 * This drops the entire multi-tenant SaaS layer:
 *   - the 7 tenant-infrastructure tables (tenants, tenant_domains,
 *     tenant_settings, tenant_admins, tenant_price_feeds,
 *     tenant_subscriptions, tenant_subscription_events)
 *   - the Postgres Row-Level-Security policies that scoped queries by
 *     tenant_id on the tables in RLS_TABLES
 *   - the tenant_id column itself from every table that carried one
 *
 * All application code was updated in the same change to stop reading/
 * writing tenant_id anywhere, so this migration is safe to run as a single
 * step rather than a staged relax-then-drop sequence.
 */

// Tables that had a tenant_id column + an RLS policy named `${table}_tenant_scope`
const RLS_COLUMN_TABLES = [
  'users', 'accounts', 'trades', 'payouts',
  'support_tickets', 'support_ticket_messages',
  'chat_conversations', 'chat_messages',
  'disputes', 'trade_logs', 'login_logs', 'bbook_pnl',
  'admin_rule_violations', 'admin_enforcement_events',
  'admin_balance_adjustments', 'admin_immutable_audit',
  'admin_four_eyes_requests', 'admin_notifications',
  'admin_cases', 'admin_dispute_meta', 'admin_scheduled_reports',
  'challenge_products', 'challenge_orders', 'challenge_payments',
  'challenge_checkout_sessions'
]

// Tables that had a nullable/soft tenant_id column but no RLS policy
const SOFT_COLUMN_TABLES = [
  'admin_saved_views', 'admin_entity_meta', 'admin_entity_tags', 'admin_entity_notes',
  'idempotency_requests', 'email_jobs', 'phone_otp_pending',
  'challenge_models', 'challenge_model_pricing',
  'account_promotion_reviews', 'tenant_monthly_quotas', 'tenant_monthly_size_quotas',
  'copier_masters', 'copier_followers', 'copier_master_followers',
  'copier_symbol_mappings', 'copier_events', 'copier_jobs',
  'copier_job_attempts', 'copier_position_links', 'copier_alert_endpoints',
  'copier_runtime_status'
]

// Tenant-infrastructure tables to drop entirely
const TENANT_TABLES_TO_DROP = [
  'tenant_subscription_events',
  'tenant_subscriptions',
  'tenant_price_feeds',
  'tenant_admins',
  'tenant_settings',
  'tenant_domains',
  'tenants'
]

exports.up = async function (knex) {
  for (const table of RLS_COLUMN_TABLES) {
    const exists = await knex.schema.hasTable(table)
    if (!exists) continue
    await knex.raw(`DROP POLICY IF EXISTS ${table}_tenant_scope ON ${table}`)
    await knex.raw(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`)
    await knex.raw(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`)
    await knex.raw(`DROP INDEX IF EXISTS idx_${table}_tenant_id`)
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS tenant_id`)
  }

  for (const table of SOFT_COLUMN_TABLES) {
    const exists = await knex.schema.hasTable(table)
    if (!exists) continue
    await knex.raw(`DROP INDEX IF EXISTS idx_${table}_tenant_id`)
    await knex.raw(`ALTER TABLE ${table} DROP COLUMN IF EXISTS tenant_id`)
  }

  // Table-specific composite indexes/constraints that included tenant_id
  // and would otherwise block the column drop above or be left dangling.
  await knex.raw(`DROP INDEX IF EXISTS bbook_pnl_tenant_date_idx`)
  await knex.raw(`DROP INDEX IF EXISTS support_tickets_tenant_created_idx`)
  await knex.raw(`DROP INDEX IF EXISTS support_ticket_messages_tenant_ticket_idx`)
  await knex.raw(`DROP INDEX IF EXISTS disputes_tenant_created_idx`)
  if (await knex.schema.hasTable('bbook_pnl')) {
    await knex.raw(`ALTER TABLE bbook_pnl DROP CONSTRAINT IF EXISTS bbook_pnl_pkey`)
    await knex.raw(`ALTER TABLE bbook_pnl ADD PRIMARY KEY (date)`)
    await knex.raw(`CREATE INDEX IF NOT EXISTS bbook_pnl_date_idx ON bbook_pnl(date DESC)`)
  }
  await knex.raw(`DROP INDEX IF EXISTS copier_runtime_scope_idx`)
  if (await knex.schema.hasTable('copier_runtime_status')) {
    await knex.raw(`CREATE INDEX IF NOT EXISTS copier_runtime_scope_idx ON copier_runtime_status(runtime_scope, follower_id)`)
  }

  await knex.raw(`DROP TABLE IF EXISTS ${TENANT_TABLES_TO_DROP.join(', ')} CASCADE`)
}

exports.down = async function () {
  throw new Error('Migration 008 is not reversible — the multi-tenant system has been permanently removed. Restore from a pre-migration backup if needed.')
}
