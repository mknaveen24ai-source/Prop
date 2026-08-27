/**
 * Migration 039: daily analytics rollup tables.
 * ─────────────────────────────────────────────────────────────────────────────
 * The two new admin intelligence pages compute ~150 analyses. A large share of
 * them are cohort, survival, percentile and benchmarking queries that would
 * otherwise scan the whole `trades` table on every tab load — `trades` is the
 * hottest table in the product and is already carrying the live trading engine.
 *
 * These three tables are pre-aggregated daily grain, refreshed by
 * services/analytics/rollups.js on a scheduler interval. Every intelligence
 * query that does not need trade-level detail reads these instead.
 *
 * Design notes:
 *
 *  - Grain is UTC calendar day, matching `daily_pnl_records.trading_date`, so
 *    the rollups line up with the drawdown engine's own day boundary rather
 *    than introducing a second, subtly different notion of "a trading day".
 *
 *  - account_id is uuid to match `accounts.id` / `trades.account_id`. Note that
 *    `daily_pnl_records.account_id` is TEXT (pre-existing inconsistency in the
 *    core schema) — joins against it cast explicitly rather than changing that
 *    column's type, which the drawdown service writes to on every tick.
 *
 *  - No foreign keys to `trades`. Rollup rows deliberately survive trade-row
 *    archival; they are a reporting artefact, not a referential one. They DO
 *    FK to accounts with ON DELETE CASCADE so a deleted account leaves no
 *    orphaned reporting rows.
 *
 *  - Every table is idempotently rebuildable from source: the refresh job
 *    deletes and re-inserts a trailing window rather than incrementally
 *    mutating, so a missed run self-heals on the next one and there is no
 *    drift state to reconcile.
 */

exports.up = async function up (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS account_daily_stats (
      account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      trading_date      DATE NOT NULL,
      trades_closed     INTEGER NOT NULL DEFAULT 0,
      wins              INTEGER NOT NULL DEFAULT 0,
      losses            INTEGER NOT NULL DEFAULT 0,
      gross_win         NUMERIC(15,2) NOT NULL DEFAULT 0,
      gross_loss        NUMERIC(15,2) NOT NULL DEFAULT 0,
      net_pnl           NUMERIC(15,2) NOT NULL DEFAULT 0,
      broker_pnl        NUMERIC(15,2) NOT NULL DEFAULT 0,
      commission        NUMERIC(15,2) NOT NULL DEFAULT 0,
      volume_lots       NUMERIC(15,4) NOT NULL DEFAULT 0,
      avg_hold_mins     NUMERIC(12,2),
      max_trade_pnl     NUMERIC(15,2),
      min_trade_pnl     NUMERIC(15,2),
      refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, trading_date)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS account_daily_stats_date_idx ON account_daily_stats (trading_date)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS trade_daily_stats (
      trading_date      DATE NOT NULL,
      instrument        TEXT NOT NULL,
      direction         TEXT NOT NULL,
      trades_closed     INTEGER NOT NULL DEFAULT 0,
      wins              INTEGER NOT NULL DEFAULT 0,
      net_pnl           NUMERIC(15,2) NOT NULL DEFAULT 0,
      broker_pnl        NUMERIC(15,2) NOT NULL DEFAULT 0,
      volume_lots       NUMERIC(15,4) NOT NULL DEFAULT 0,
      commission        NUMERIC(15,2) NOT NULL DEFAULT 0,
      avg_hold_mins     NUMERIC(12,2),
      avg_slippage_pips NUMERIC(10,3),
      refreshed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (trading_date, instrument, direction)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS trade_daily_stats_instrument_idx ON trade_daily_stats (instrument, trading_date)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS revenue_daily (
      revenue_date          DATE PRIMARY KEY,
      orders_paid           INTEGER NOT NULL DEFAULT 0,
      gross_revenue         NUMERIC(15,2) NOT NULL DEFAULT 0,
      discount_total        NUMERIC(15,2) NOT NULL DEFAULT 0,
      affiliate_commission  NUMERIC(15,2) NOT NULL DEFAULT 0,
      payouts_paid          NUMERIC(15,2) NOT NULL DEFAULT 0,
      payouts_count         INTEGER NOT NULL DEFAULT 0,
      new_buyers            INTEGER NOT NULL DEFAULT 0,
      returning_buyers      INTEGER NOT NULL DEFAULT 0,
      signups               INTEGER NOT NULL DEFAULT 0,
      refreshed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

exports.down = async function down (knex) {
  await knex.raw('DROP TABLE IF EXISTS revenue_daily')
  await knex.raw('DROP TABLE IF EXISTS trade_daily_stats')
  await knex.raw('DROP TABLE IF EXISTS account_daily_stats')
}
