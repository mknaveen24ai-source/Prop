exports.up = async function(knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS tenant_monthly_quotas (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL,
      quota_month DATE NOT NULL,
      account_limit INT,
      is_unlimited BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, quota_month)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS tenant_monthly_quotas_tenant_month_idx ON tenant_monthly_quotas(tenant_id, quota_month DESC)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS account_promotion_reviews (
      id BIGSERIAL PRIMARY KEY,
      tenant_id BIGINT NOT NULL DEFAULT 1,
      source_account_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      from_account_type TEXT NOT NULL,
      target_account_type TEXT NOT NULL,
      account_size NUMERIC,
      status TEXT NOT NULL DEFAULT 'pending',
      triggered_by TEXT,
      reason TEXT,
      requested_by_admin_id TEXT,
      decided_by_admin_id TEXT,
      decision_note TEXT,
      created_account_id TEXT,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS account_promotion_reviews_tenant_status_idx ON account_promotion_reviews(tenant_id, status, created_at DESC)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS account_promotion_reviews_source_idx ON account_promotion_reviews(source_account_id)`)
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS account_promotion_reviews_pending_source_uq ON account_promotion_reviews(source_account_id) WHERE status = 'pending'`)
}

exports.down = async function(knex) {
  await knex.raw(`DROP INDEX IF EXISTS account_promotion_reviews_pending_source_uq`)
  await knex.raw(`DROP INDEX IF EXISTS account_promotion_reviews_source_idx`)
  await knex.raw(`DROP INDEX IF EXISTS account_promotion_reviews_tenant_status_idx`)
  await knex.schema.dropTableIfExists('account_promotion_reviews')
  await knex.raw(`DROP INDEX IF EXISTS tenant_monthly_quotas_tenant_month_idx`)
  await knex.schema.dropTableIfExists('tenant_monthly_quotas')
}
