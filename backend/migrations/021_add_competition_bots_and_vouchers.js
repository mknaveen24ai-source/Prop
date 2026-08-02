/**
 * Migration 021: Competition bot participants + non-cash prize vouchers
 *
 * `users.is_bot` flags synthetic competition participants. A flag on `users`
 * (rather than a separate bots table) is enough because
 * utils/competitions.js's fetchCompetitionLeaderboard already
 * `JOIN users u ON u.id = ce.user_id` — a bot needs to be a real `users` row
 * to show up on the leaderboard through existing queries with zero changes.
 *
 * `competition_prize_vouchers` backs the "winners receive free challenge
 * accounts" requirement: a voucher is issued to a winning entry (see
 * competitionEngine.js's finalizeCompetition) and later redeemed through
 * routes/accounts.js's POST /orders, which turns it into a pre-paid
 * challenge_orders row (status='paid', amount=0) — the existing
 * POST /accounts/create gate then creates the account exactly as it would
 * for a real purchase, with no changes needed there.
 *
 * set_updated_at() is (re)defined here for the same reason migrations 016/019
 * redefine it: this runs as a deploy step before server.js's own
 * ensureUniqueIds() has created it.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_users_is_bot ON users(is_bot) WHERE is_bot = TRUE`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS competition_prize_vouchers (
      id                    BIGSERIAL PRIMARY KEY,
      code                  TEXT NOT NULL UNIQUE,
      competition_id        BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      competition_entry_id  BIGINT REFERENCES competition_entries(id) ON DELETE SET NULL,
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_size          NUMERIC(12,2) NOT NULL,
      challenge_model_slug  TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'issued',
      issued_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at            TIMESTAMPTZ,
      redeemed_at           TIMESTAMPTZ,
      redeemed_order_id     BIGINT REFERENCES challenge_orders(id) ON DELETE SET NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT competition_prize_vouchers_status_check CHECK (status IN ('issued','redeemed','expired','revoked'))
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_competition_prize_vouchers_user_status ON competition_prize_vouchers(user_id, status)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_competition_prize_vouchers_competition ON competition_prize_vouchers(competition_id)`)

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'competition_prize_vouchers_upd_trigger') THEN
        CREATE TRIGGER competition_prize_vouchers_upd_trigger BEFORE UPDATE ON competition_prize_vouchers
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$;
  `)

  // Seed platform_settings defaults for the new tiered-economics + bot-tick features.
  await knex.raw(`
    INSERT INTO platform_settings (key, value) VALUES
      ('commission_per_lot_json', '{}'),
      ('slippage_max_pips_adverse_json', '{}'),
      ('competition_bot_tick_enabled', 'false'),
      ('competition_bot_volatility_pct_per_tick', '0.3'),
      ('competition_voucher_expiry_days', '90')
    ON CONFLICT (key) DO NOTHING
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS competition_prize_vouchers`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS is_bot`)
}
