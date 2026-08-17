/**
 * Migration 031: Reconcile `admin_balance_adjustments` with the code that writes it
 *
 * POST /api/admin/accounts/:accountId/adjust-balance has been failing outright
 * with `column "user_id" of relation "admin_balance_adjustments" does not exist`
 * (see logs/error4.log around 2026-08-15 16:04). The table was never created by
 * a migration — it predates the admin modularization and exists only in
 * whatever shape the database was hand-built with:
 *
 *   id, account_id, amount, balance_before, balance_after, reason, created_at
 *
 * while routes/admin/accounts.js writes:
 *
 *   account_id, user_id, amount, reason, adjustment_type, created_by
 *
 * routes/admin/shared/schema.js does declare a newer shape, but only as
 * CREATE TABLE IF NOT EXISTS — a no-op against the pre-existing table, and it
 * never followed up with ADD COLUMN backfills the way services/violationEngine.js
 * correctly does for its own tables. (The live `id` is a plain integer, not the
 * BIGSERIAL that DDL would have produced: proof it never ran.) That companion
 * gap is fixed in schema.js alongside this migration.
 *
 * The three missing columns are added rather than dropped from the INSERT,
 * because an admin audit log that cannot say WHO adjusted a balance is not an
 * audit log. The route already holds the before/after balances, so it starts
 * supplying those too.
 *
 * Deliberately written as create-then-backfill with no branching: two different
 * shapes exist in the wild (the legacy hand-built one, and schema.js's, which
 * lacks balance_before/balance_after entirely), and this converges both.
 * Idempotent.
 */

const COLUMNS = [
  ['account_id', `TEXT`],
  ['user_id', `TEXT`],
  ['amount', `NUMERIC(15,2)`],
  ['balance_before', `NUMERIC(15,2)`],
  ['balance_after', `NUMERIC(15,2)`],
  ['reason', `TEXT NOT NULL DEFAULT ''`],
  ['adjustment_type', `TEXT NOT NULL DEFAULT 'manual'`],
  ['created_by', `TEXT NOT NULL DEFAULT 'admin'`],
  ['created_at', `TIMESTAMPTZ NOT NULL DEFAULT NOW()`]
]

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS admin_balance_adjustments (
      id BIGSERIAL PRIMARY KEY
    )
  `)

  for (const [name, definition] of COLUMNS) {
    await knex.raw(`ALTER TABLE admin_balance_adjustments ADD COLUMN IF NOT EXISTS ${name} ${definition}`)
  }

  // Backfill the owner for rows written before user_id existed. account_id is
  // TEXT here but accounts.id is uuid, hence the cast.
  await knex.raw(`
    UPDATE admin_balance_adjustments adj
       SET user_id = a.user_id::text
      FROM accounts a
     WHERE adj.user_id IS NULL
       AND a.id::text = adj.account_id
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_admin_balance_adjustments_account_created
      ON admin_balance_adjustments(account_id, created_at DESC)
  `)
}

exports.down = async function (knex) {
  // Only the columns this migration is responsible for adding are dropped — the
  // table itself is older than the migration set and is not ours to remove.
  for (const name of ['user_id', 'adjustment_type', 'created_by']) {
    await knex.raw(`ALTER TABLE admin_balance_adjustments DROP COLUMN IF EXISTS ${name}`)
  }
  await knex.raw(`DROP INDEX IF EXISTS idx_admin_balance_adjustments_account_created`)
}
