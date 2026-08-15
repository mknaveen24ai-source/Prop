/**
 * Migration 028: Partial indexes for the trade engine
 *
 * The engine's hot path is in memory and touches no rows at all. These indexes
 * serve everything around it: the boot-time index build, the 30s reconciliation,
 * and the interval loops that remain as safety fallbacks.
 *
 * Every one is *partial* (`WHERE status = ...`). Open and pending trades are a
 * small and roughly bounded slice of the `trades` table, while closed trades
 * grow without limit — so a full index on `account_id` would spend most of its
 * size and write cost on rows these queries never look at. The partial form
 * stays proportional to live trading instead of to lifetime history.
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this
 * migration disables knex's per-migration transaction. That means a failure
 * halfway through leaves the earlier indexes in place; all four statements are
 * IF NOT EXISTS, so re-running is safe and idempotent.
 */

exports.config = { transaction: false }

const INDEXES = [
  {
    name: 'idx_trades_open_sltp',
    // checkSLTP's fallback query and the reconcile both filter to open trades
    // that actually have a level set — usually a minority of open positions.
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_open_sltp
            ON trades (account_id, instrument)
            WHERE status = 'open' AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL)`
  },
  {
    name: 'idx_trades_pending',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_pending
            ON trades (account_id, instrument)
            WHERE status = 'pending'`
  },
  {
    name: 'idx_trades_open',
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_open
            ON trades (account_id)
            WHERE status = 'open'`
  },
  {
    name: 'idx_trades_closed_today',
    // Backs getTodayRealizedPnl, which the daily-loss rule seeds from.
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trades_closed_today
            ON trades (account_id, close_time)
            WHERE status = 'closed'`
  }
]

exports.up = async function (knex) {
  for (const index of INDEXES) {
    await knex.raw(index.sql)
  }
}

exports.down = async function (knex) {
  for (const index of INDEXES) {
    await knex.raw(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`)
  }
}
