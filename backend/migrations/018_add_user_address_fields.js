/**
 * Migration 018: Add address fields to users for the trader-facing Profile page
 *
 * `full_name`/`country`/`phone` already exist from registration, but no
 * street-address fields exist anywhere on `users`. `country` is reused as-is.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line1 TEXT`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS address_line2 TEXT`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS state_province TEXT`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code TEXT`)
  // users had no updated_at column at all (unlike accounts) — needed for the
  // new profile-update endpoint's audit trail.
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`)
}

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS address_line1`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS address_line2`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS city`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS state_province`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS postal_code`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS updated_at`)
}
