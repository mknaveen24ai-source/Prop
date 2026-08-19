/**
 * Migration 038: `trades.parent_trade_id` is integer but holds a trade id, and
 * trade ids are uuid.
 * ─────────────────────────────────────────────────────────────────────────────
 * PRE-EXISTING BUG. EVERY PARTIAL CLOSE RETURNS 500.
 *
 * routes/trades/close.js inserts the child row of a partial close with the
 * parent's id in `parent_trade_id`:
 *
 *     INSERT INTO trades (..., parent_trade_id, is_partial, ...)
 *     VALUES (..., $11, true, NULL)      -- $11 = trade_id, a uuid
 *
 * `trades.id` is uuid. `trades.parent_trade_id` is integer. Postgres rejects the
 * insert outright:
 *
 *     invalid input syntax for type integer: "b9aa1b25-6266-42c3-8f97-24e400fdbf87"
 *
 * The whole transaction rolls back, so the trader gets "Could not close trade"
 * and the position stays open at full size. Scaling out of a winner, or cutting
 * half a loser, is impossible: the only way out of a position is to close all of
 * it. On a platform with drawdown limits that is not a cosmetic restriction — a
 * trader who wanted to halve their exposure keeps all of it instead.
 *
 * WHY NOTHING CAUGHT IT: the same reason as `payouts.updated_at` in migration
 * 037. The trade tests mock the pg pool, so the INSERT had never run against
 * real Postgres. Lint cannot see inside a SQL string, and the type mismatch is
 * between a column and a parameter rather than between two columns, so
 * scripts/check-param-type-collisions.js does not cover it either.
 *
 * The column is almost certainly a survivor of the migration from integer trade
 * ids to uuid: `trades.id` was converted and this self-reference was not.
 *
 * ── Safety ──
 *
 * No data can be lost. The column has never successfully accepted a value —
 * every write to it failed — so it is NULL for every row. Verified as zero
 * non-null on both the production-shaped database and a freshly provisioned one
 * before this was written, and the migration re-checks at run time rather than
 * trusting that: if any non-null value exists it refuses instead of discarding
 * it, so a database with history nobody anticipated stops the deploy rather than
 * silently losing rows.
 */

exports.up = async function up(knex) {
  const [{ non_null }] = (await knex.raw(
    'SELECT COUNT(*)::int AS non_null FROM trades WHERE parent_trade_id IS NOT NULL'
  )).rows

  if (non_null > 0) {
    throw new Error(
      `038: trades.parent_trade_id holds ${non_null} non-null value(s). This migration ` +
      'assumes the column is empty because every write to it failed on a type error. ' +
      'Inspect those rows and map them to trades.id by hand before re-running.'
    )
  }

  // USING NULL rather than a cast: there is nothing to convert, and an
  // integer->uuid cast does not exist anyway.
  await knex.raw('ALTER TABLE trades ALTER COLUMN parent_trade_id TYPE uuid USING NULL')

  // The index is what makes "fetch the parts of this partial close" cheap; it
  // was pointing at a column no query could ever match a value in.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_trades_parent_trade_id ON trades(parent_trade_id) WHERE parent_trade_id IS NOT NULL'
  )
}

exports.down = async function down(knex) {
  // Reversing loses the parent links, since a uuid cannot become an integer.
  // Any partial close recorded after 038 ran would have its child rows
  // orphaned, which is why this refuses rather than quietly nulling them.
  const [{ non_null }] = (await knex.raw(
    'SELECT COUNT(*)::int AS non_null FROM trades WHERE parent_trade_id IS NOT NULL'
  )).rows

  if (non_null > 0) {
    throw new Error(
      `038 down: ${non_null} partial-close link(s) exist and cannot be represented as integers. ` +
      'Rolling back would orphan them. Export them first if this rollback is genuinely intended.'
    )
  }

  await knex.raw('DROP INDEX IF EXISTS idx_trades_parent_trade_id')
  await knex.raw('ALTER TABLE trades ALTER COLUMN parent_trade_id TYPE integer USING NULL')
}
