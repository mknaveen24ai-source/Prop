/**
 * Migration 017: Extend accounts_status_check for competition account lifecycle
 *
 * accounts_status_check previously only allowed
 * ('active','passed','failed','expired','locked'). Competition accounts need
 * two more terminal states — 'cancelled' (left before the contest started, or
 * admin-cancelled) and 'closed' (contest ended, account frozen) — that don't
 * fit any existing value ('locked' is already reserved for the fraud-detection
 * auto-lock in challengeEngine.js and would be misleading to reuse here).
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check`)
  await knex.raw(`
    ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
      CHECK (status IN ('active','passed','failed','expired','locked','cancelled','closed'))
  `)
}

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_status_check`)
  await knex.raw(`
    ALTER TABLE accounts ADD CONSTRAINT accounts_status_check
      CHECK (status IN ('active','passed','failed','expired','locked'))
  `)
}
