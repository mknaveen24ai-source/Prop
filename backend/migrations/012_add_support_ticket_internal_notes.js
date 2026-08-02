/**
 * Migration 012: Add internal_notes to support_tickets
 *
 * The admin Support & Appeals Center ticket detail view has an internal
 * notes field (visible only to admin staff, per the original spec) that
 * had no backing column.
 */

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS internal_notes TEXT
  `)
}

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE support_tickets
      DROP COLUMN IF EXISTS internal_notes
  `)
}
