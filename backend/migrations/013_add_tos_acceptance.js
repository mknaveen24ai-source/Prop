/**
 * Migration 013: Add user_agreement_acceptances table
 *
 * No ToS/agreement-acceptance tracking existed anywhere — the registration
 * form already has a client-side "I agree to Terms" checkbox that blocks
 * submission, but the acceptance itself was never recorded. This table
 * captures it going forward; existing users have no row until they next
 * accept, which is the correct "outdated" state for the admin tracking view.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS user_agreement_acceptances (
      id          BIGSERIAL PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tos_version TEXT NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address  TEXT
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_user_agreement_acceptances_user ON user_agreement_acceptances(user_id, accepted_at DESC)`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS user_agreement_acceptances`)
}
