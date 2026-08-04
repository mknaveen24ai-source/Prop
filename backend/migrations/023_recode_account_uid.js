/**
 * Migration 023: Recode account_uid from random UUIDs to a human-readable,
 * per-category sequential scheme.
 *
 * account_uid was previously just uuidv4() with no structure. It's used only
 * for display/search/CSV export (never as a security token or MT5/broker
 * login — verified across the codebase before writing this), so it's safe to
 * overwrite in place rather than adding a parallel column.
 *
 * New scheme (see utils/accountIds.js — the single source of truth this
 * migration and every account-creation call site both use, so they can't
 * drift apart):
 *   competition                -> C00001
 *   1-step, phase1             -> 1S00001
 *   2-step, phase1 / phase2    -> 2SP100001 / 2SP200001
 *   3-step, phase1/2/3         -> 3SP100001 / 3SP200001 / 3SP300001
 *   funded (from 1/2/3-step)   -> F1-00001 / F2-00001 / F3-00001
 *
 * Numbering is per-category, assigned in `created_at ASC` (creation) order so
 * the oldest account in a category becomes ...00001 — accounts.id is a UUID,
 * not a sequential key, so it can't be used to infer creation order.
 * account_id_sequences is seeded with each category's final count so accounts
 * created after this migration continue the sequence with no collisions or
 * gaps.
 */

const { resolveAccountIdCategory, ACCOUNT_UID_PAD } = require('../utils/accountIds')

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS account_id_sequences (
      category    TEXT PRIMARY KEY,
      last_value  INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Clear existing values first so the per-row reassignment loop below can
  // never collide with a not-yet-updated row's still-old account_uid under
  // the unique index — NULLs don't collide, so this also makes the migration
  // safe to re-run (e.g. after a rollback) without a duplicate-key error.
  await knex.raw(`UPDATE accounts SET account_uid = NULL`)

  const { rows: accounts } = await knex.raw(
    `SELECT id, account_type, challenge_model_slug FROM accounts ORDER BY created_at ASC, id ASC`
  )

  const counters = new Map()
  for (const account of accounts) {
    const { category, prefix } = resolveAccountIdCategory({
      accountType: account.account_type,
      challengeModelSlug: account.challenge_model_slug
    })
    const next = (counters.get(category) || 0) + 1
    counters.set(category, next)
    const accountUid = `${prefix}${String(next).padStart(ACCOUNT_UID_PAD, '0')}`
    await knex.raw(`UPDATE accounts SET account_uid = ? WHERE id = ?`, [accountUid, account.id])
  }

  for (const [category, lastValue] of counters.entries()) {
    await knex.raw(
      `INSERT INTO account_id_sequences (category, last_value) VALUES (?, ?)
       ON CONFLICT (category) DO UPDATE SET last_value = EXCLUDED.last_value`,
      [category, lastValue]
    )
  }

  console.log(`✓ Recoded account_uid for ${accounts.length} accounts across ${counters.size} categories`)
}

exports.down = async function (knex) {
  // The original random UUIDs aren't recoverable, so this migration is
  // one-way for account_uid data — only the added sequence table rolls back.
  await knex.raw(`DROP TABLE IF EXISTS account_id_sequences`)
  console.log('✓ Migration rolled back (account_uid values from the recode are not restored)')
}
