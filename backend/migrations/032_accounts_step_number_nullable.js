/**
 * Migration 032: `accounts.step_number` must be nullable
 *
 * Promoting the final challenge phase into a FUNDED account fails on this
 * database with:
 *
 *   null value in column "step_number" of relation "accounts"
 *   violates not-null constraint
 *
 * services/progressionService.js's funded branch inserts `NULL` for
 * step_number on purpose — a funded account is not a rung on the step ladder,
 * so there is no step to record — and utils/stepModels.js declares the column
 * as a plain nullable `INTEGER`:
 *
 *   ALTER TABLE accounts ADD COLUMN IF NOT EXISTS step_number INTEGER
 *
 * But that statement is a no-op against a database where the column already
 * exists, and the hand-built schema this project grew from has it as
 * NOT NULL DEFAULT 1. Same drift class as migration 031: the declared shape and
 * the real shape disagreed, and ADD COLUMN IF NOT EXISTS could never reconcile
 * them. The consequence is that no account has ever successfully reached
 * `funded` through the promotion path on this database.
 *
 * The DEFAULT 1 is left in place — it is harmless for challenge rows, which
 * always supply the column explicitly, and dropping it would change behaviour
 * for any INSERT that omits step_number.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE accounts ALTER COLUMN step_number DROP NOT NULL`)
}

exports.down = async function (knex) {
  // Backfill before restoring the constraint, or this fails on any funded row
  // created while it was relaxed. 1 matches the column's own default.
  await knex.raw(`UPDATE accounts SET step_number = 1 WHERE step_number IS NULL`)
  await knex.raw(`ALTER TABLE accounts ALTER COLUMN step_number SET NOT NULL`)
}
