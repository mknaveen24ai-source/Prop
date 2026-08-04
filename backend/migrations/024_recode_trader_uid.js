/**
 * Migration 024: Recode trader_uid from random UUIDs to a sequential,
 * human-readable scheme — TRADER-00001, TRADER-00002, ... — mirroring
 * migration 023's account_uid recode.
 *
 * trader_uid was previously just uuidv4() with no structure, used only for
 * display/search (never as a security token). Safe to overwrite in place.
 *
 * Numbered in `created_at ASC` order so the earliest-registered user becomes
 * TRADER-00001 — users.id is a UUID, not a sequential key, so it can't be
 * used to infer registration order. trader_id_sequences is seeded with the
 * final count so users created after this migration continue the sequence
 * with no collisions or gaps.
 */

const { TRADER_UID_PREFIX, TRADER_UID_PAD } = require('../utils/traderIds')

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS trader_id_sequences (
      id          INTEGER PRIMARY KEY,
      last_value  INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Clear existing values first so the per-row reassignment loop below can
  // never collide with a not-yet-updated row's still-old trader_uid under
  // the unique index — NULLs don't collide, so this also makes the
  // migration safe to re-run (e.g. after a rollback).
  await knex.raw(`UPDATE users SET trader_uid = NULL`)

  const { rows: users } = await knex.raw(
    `SELECT id FROM users ORDER BY created_at ASC, id ASC`
  )

  let seq = 0
  for (const user of users) {
    seq += 1
    const traderUid = `${TRADER_UID_PREFIX}${String(seq).padStart(TRADER_UID_PAD, '0')}`
    await knex.raw(`UPDATE users SET trader_uid = ? WHERE id = ?`, [traderUid, user.id])
  }

  await knex.raw(
    `INSERT INTO trader_id_sequences (id, last_value) VALUES (1, ?)
     ON CONFLICT (id) DO UPDATE SET last_value = EXCLUDED.last_value`,
    [seq]
  )

  console.log(`✓ Recoded trader_uid for ${users.length} users`)
}

exports.down = async function (knex) {
  // The original random UUIDs aren't recoverable, so this migration is
  // one-way for trader_uid data — only the added sequence table rolls back.
  await knex.raw(`DROP TABLE IF EXISTS trader_id_sequences`)
  console.log('✓ Migration rolled back (trader_uid values from the recode are not restored)')
}
