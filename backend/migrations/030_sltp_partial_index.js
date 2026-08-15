/**
 * Partial index for the SL/TP scan (audit finding M-11)
 * ─────────────────────────────────────────────────────────────────────────────
 * checkSLTP runs every 500ms in the default interval mode and selects:
 *
 *     WHERE t.status = 'open'
 *       AND (t.stop_loss IS NOT NULL OR t.take_profit IS NOT NULL)
 *
 * trades_status_open_time_idx (migration 002) covers `status`, but the planner
 * still has to read and discard every open trade that carries neither level.
 * On a book where most positions run without a stop, that is the bulk of the
 * scan, twice a second.
 *
 * A partial index stores only the rows the query actually wants, so it is both
 * far smaller than the full index and cheaper to maintain — rows without a
 * stop or target are never indexed at all.
 *
 * CONCURRENTLY so this does not lock `trades` on a live platform. That forbids
 * running inside a transaction, hence the disableTransactions flag below.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS trades_open_with_levels_idx
      ON trades (account_id)
      WHERE status = 'open' AND (stop_loss IS NOT NULL OR take_profit IS NOT NULL)
  `)
  return true
}

exports.down = async function (knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS trades_open_with_levels_idx')
  return true
}

// knex wraps each migration in a transaction by default, and CREATE INDEX
// CONCURRENTLY cannot run inside one.
exports.config = { transaction: false }
