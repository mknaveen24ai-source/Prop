/**
 * Migration 041: trader profit split to 100%, and unlimited concurrent accounts.
 * ─────────────────────────────────────────────────────────────────────────────
 * BUSINESS DECISION, not a bug fix. The platform now pays the trader 100% of
 * realised profit on every payout, on every account, permanently. Firm revenue
 * is challenge fees only.
 *
 * This is the positioning the offer is built around: the cheapest entry in the
 * category, published (hard) odds, and no cut taken from what a funded trader
 * earns. It only works because the evaluation is genuinely difficult — see the
 * 4% trailing drawdown and 15% consistency rules in utils/stepModels.js.
 *
 * ── Why a migration and not just a code change ──
 *
 * `profit_share_pct` lives in platform_settings, and routes/payouts.js reads it
 * at request time to compute amount_payable. Migration 010 set that row to '75'
 * on every existing database. Seed defaults (setup_platform_settings.js,
 * routes/setup.js) only apply on a fresh install — `INSERT ... ON CONFLICT DO
 * NOTHING` will not update a row that already exists. So an existing deployment
 * would keep paying 75% no matter what the code said.
 *
 * Migrations 001 and 010 are deliberately left alone. They have already run
 * everywhere; rewriting an applied migration means two databases with the same
 * migration log can disagree about what that log means.
 *
 * ── Blast radius ──
 *
 * payouts.amount_payable is computed and stored at request time, so payouts
 * ALREADY REQUESTED keep the 75% figure they were quoted. That is deliberate:
 * a trader who submitted under the old split saw a number, and retroactively
 * changing a pending payout's payable amount — in either direction — is worse
 * than honouring the quote. Only requests made after this migration get 100%.
 *
 * challenge_models.profit_split_pct is also updated so the rulebook page
 * (frontend/src/pages/ChallengeRules.jsx, which renders model.profit_split_pct)
 * stops advertising 75%. utils/stepModels.js re-upserts this value from
 * FUNDED_STAGE on every boot, so this statement mainly matters for the window
 * between the migration running and the next process start.
 */

exports.up = async function (knex) {
  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('profit_share_pct', '100')
    ON CONFLICT (key) DO UPDATE SET value = '100'
  `)

  await knex.raw(`UPDATE challenge_models SET profit_split_pct = 100, updated_at = NOW()`)

  // ── Concurrent-account limit: unlimited ──
  //
  // Same seed problem as profit_share_pct. Migration 001 wrote '5' on every
  // existing database, and the enforcement path in routes/accounts.js now
  // treats 0 as "no limit" rather than falling back to a magic 999999. Without
  // this statement a live deployment would keep capping traders at 5 while
  // every default in the codebase said unlimited.
  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('max_accounts_per_user', '0')
    ON CONFLICT (key) DO UPDATE SET value = '0'
  `)

  return true
}

exports.down = async function (knex) {
  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('profit_share_pct', '75')
    ON CONFLICT (key) DO UPDATE SET value = '75'
  `)
  await knex.raw(`UPDATE challenge_models SET profit_split_pct = 75, updated_at = NOW()`)
  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('max_accounts_per_user', '5')
    ON CONFLICT (key) DO UPDATE SET value = '5'
  `)
  return true
}
