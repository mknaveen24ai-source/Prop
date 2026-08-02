/**
 * Migration 015: Add A/B experiment tracking infrastructure + users.signup_source
 *
 * Neither had any data source anywhere in this schema. Per your decision,
 * both ship as real infrastructure now, even though they'll read empty
 * (ab_experiments/ab_experiment_events) or 'unknown' (signup_source on
 * existing users) until a future feature actually assigns experiment
 * variants or captures acquisition source at registration.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ab_experiments (
      id          BIGSERIAL PRIMARY KEY,
      key         TEXT NOT NULL UNIQUE,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft',
      outcome_metric TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ab_experiment_events (
      id             BIGSERIAL PRIMARY KEY,
      experiment_key TEXT NOT NULL REFERENCES ab_experiments(key) ON DELETE CASCADE,
      variant_key    TEXT NOT NULL,
      user_id        UUID,
      outcome_value  NUMERIC,
      occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_ab_experiment_events_key ON ab_experiment_events(experiment_key, variant_key)`)

  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS signup_source TEXT`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS ab_experiment_events`)
  await knex.raw(`DROP TABLE IF EXISTS ab_experiments`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS signup_source`)
}
