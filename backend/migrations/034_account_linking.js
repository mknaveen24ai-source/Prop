/**
 * Migration 034: Account sharing / passing-service detection
 *
 * Unregulated "passing services" take a trader's credentials and pass challenges
 * on their behalf, running many customers' accounts at once through copy-trading
 * software. The tells are a shared network origin, near-simultaneous order flow
 * across supposedly unrelated accounts, and a shared physical device.
 *
 * Rather than bolting identifying columns onto users/accounts/trades/payouts,
 * every identifying observation lands in one normalized table (identity_signals)
 * so that finding a sharing ring collapses to a single self-join on
 * (signal_type, signal_value).
 *
 * These tables live in a migration rather than the runtime ensureFeatureTables()
 * DDL deliberately — see routes/admin/shared/schema.js:78-96 for the drift
 * hazard that pattern already carries.
 */

exports.up = async function (knex) {
  // ── The linkage substrate ──────────────────────────────────────────────────
  // One row per (user, signal type, signal value). signal_value is normalized,
  // and hashed for anything directly identifying (payout destinations, KYC
  // document numbers) so this table never becomes a second copy of the PII.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS identity_signals (
      id            BIGSERIAL PRIMARY KEY,
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      signal_type   TEXT NOT NULL,
      signal_value  TEXT NOT NULL,
      context       TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      hit_count     INTEGER NOT NULL DEFAULT 1,
      CONSTRAINT identity_signals_uq UNIQUE (user_id, signal_type, signal_value)
    )
  `)

  // The cluster self-join reads (signal_type, signal_value) and counts distinct
  // users, so lead with those two columns.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS identity_signals_value_idx
      ON identity_signals(signal_type, signal_value)
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS identity_signals_user_idx
      ON identity_signals(user_id)
  `)
  // Retention prune walks last_seen_at.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS identity_signals_last_seen_idx
      ON identity_signals(last_seen_at)
  `)

  // ── Detected clusters ──────────────────────────────────────────────────────
  // cluster_key is a stable hash of the sorted member ids, so a re-scan that
  // finds the same ring updates the existing row (preserving the admin's
  // resolution) instead of piling up duplicates. Same dedupe strategy as
  // violationEngine.buildViolationKey.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS account_link_clusters (
      id                BIGSERIAL PRIMARY KEY,
      cluster_key       TEXT NOT NULL UNIQUE,
      score             INTEGER NOT NULL DEFAULT 0,
      confidence        TEXT NOT NULL DEFAULT 'low',
      member_user_ids   UUID[] NOT NULL DEFAULT '{}',
      member_count      INTEGER NOT NULL DEFAULT 0,
      signal_types      TEXT[] NOT NULL DEFAULT '{}',
      signal_summary    JSONB NOT NULL DEFAULT '{}'::jsonb,
      status            TEXT NOT NULL DEFAULT 'open',
      first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at       TIMESTAMPTZ,
      resolved_by       TEXT,
      resolution_note   TEXT
    )
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS account_link_clusters_triage_idx
      ON account_link_clusters(status, score DESC, last_detected_at DESC)
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS account_link_clusters_members_idx
      ON account_link_clusters USING GIN (member_user_ids)
  `)

  // ── Per-cluster evidence ───────────────────────────────────────────────────
  // What actually tied these users together, so an admin reviewing a cluster
  // sees the reasoning rather than an unexplained score.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS account_link_evidence (
      id             BIGSERIAL PRIMARY KEY,
      cluster_id     BIGINT NOT NULL REFERENCES account_link_clusters(id) ON DELETE CASCADE,
      evidence_type  TEXT NOT NULL,
      evidence_value TEXT,
      evidence_label TEXT,
      user_ids       UUID[] NOT NULL DEFAULT '{}',
      distinct_users INTEGER NOT NULL DEFAULT 0,
      weight         INTEGER NOT NULL DEFAULT 0,
      detail         JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS account_link_evidence_cluster_idx
      ON account_link_evidence(cluster_id)
  `)

  // ── Indexes the detector needs on existing tables ──────────────────────────
  // login_logs was created by utils/bootstrap.js with NO indexes at all, and
  // trade_logs is indexed only on logged_at (002_hot_path_indexes.js). Every
  // IP-correlation query today is a sequential scan.
  await knex.raw(`CREATE INDEX IF NOT EXISTS login_logs_user_idx ON login_logs(user_id, logged_in_at DESC)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS login_logs_ip_idx ON login_logs(ip_address, logged_in_at)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS trade_logs_ip_idx ON trade_logs(ip_address, logged_at)`)

  // Simultaneity bucketing scans trades by open_time across all statuses;
  // trades_status_open_time_idx is leading-column-status so it can't serve this.
  await knex.raw(`CREATE INDEX IF NOT EXISTS trades_open_time_idx ON trades(open_time)`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS trades_open_time_idx`)
  await knex.raw(`DROP INDEX IF EXISTS trade_logs_ip_idx`)
  await knex.raw(`DROP INDEX IF EXISTS login_logs_ip_idx`)
  await knex.raw(`DROP INDEX IF EXISTS login_logs_user_idx`)
  await knex.raw(`DROP TABLE IF EXISTS account_link_evidence`)
  await knex.raw(`DROP TABLE IF EXISTS account_link_clusters`)
  await knex.raw(`DROP TABLE IF EXISTS identity_signals`)
}
