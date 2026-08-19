/**
 * Migration 037: add the missing `payouts.updated_at` column.
 * ─────────────────────────────────────────────────────────────────────────────
 * PRE-EXISTING BUG, found while wiring the payout certificate trigger.
 *
 * Four code paths write `payouts.updated_at`:
 *
 *   domain/payout.js:105        approve  (UPDATE ... SET status='paid', updated_at=NOW())
 *   routes/admin/payouts.js:187 reject
 *   routes/admin/payouts.js:253 flag
 *   routes/admin/payouts.js:321 unflag
 *
 * The column has never existed. It is absent from `000_core_schema.sql` — the
 * schema of record, itself a pg_dump of production — and no migration or
 * runtime ALTER adds it (routes/admin/shared/schema.js adds is_flagged,
 * flag_reason and admin_notes, but not this).
 *
 * So every one of those four admin actions raises
 * `column "updated_at" of relation "payouts" does not exist` and returns 500
 * against a correctly-provisioned database.
 *
 * WHY NOTHING CAUGHT IT: the payout tests mock the pg pool and hand back
 * synthetic rows, so no SQL in that path has ever been executed against real
 * Postgres. It surfaced here only because the certificate work was verified
 * against a live database rather than the mocks.
 *
 * Backfilled from paid_at, then requested_at, so existing rows carry a
 * meaningful timestamp rather than the moment this migration happened to run.
 *
 * `timestamp without time zone` deliberately matches the neighbouring
 * requested_at/paid_at columns rather than introducing a lone timestamptz into
 * this table.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`)
  await knex.raw(`
    UPDATE payouts
       SET updated_at = COALESCE(paid_at, requested_at, NOW())
     WHERE updated_at IS NULL
  `)
}

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE payouts DROP COLUMN IF EXISTS updated_at`)
}
