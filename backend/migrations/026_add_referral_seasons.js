/**
 * Migration 026: Seasonal referral leaderboard + prize vouchers
 *
 * A time-boxed period (like `competitions`) that ranks affiliates by NEW
 * paying referrals acquired during the window, separate from the existing
 * all-time affiliate commission-tier ladder (affiliate_commission_tiers,
 * migration 019) and the all-time trading leaderboard (server.js).
 *
 * Deliberately NOT built on top of the `competitions` table: that schema and
 * competitionEngine.js assume a real trading `accounts` row per entrant
 * (competition_entries.account_id, closeAndFreezeAccount, etc.) — a referral
 * entrant has no trading account. A parallel, decoupled pair mirrors how the
 * affiliate ecosystem (019) is already its own vertical alongside
 * competitions (016), not layered on it.
 *
 * `referral_season_prize_vouchers` mirrors `competition_prize_vouchers`
 * (021) column-for-column but FKs to referral_seasons/referral_season_entries
 * instead. Kept as its own table rather than adding nullable
 * referral_season_id/season_entry_id columns to competition_prize_vouchers,
 * so the two independently-owned engines (competitionEngine.js,
 * referralSeasonEngine.js) never write to the same table. The redemption
 * branch in routes/accounts.js's POST /orders tries both tables (plus
 * gift_vouchers) before giving up — see utils/giftVouchers.js for the same
 * "code -> pre-paid challenge_orders row" pattern applied a third time.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS referral_seasons (
      id              BIGSERIAL PRIMARY KEY,
      slug            TEXT NOT NULL UNIQUE,
      title           TEXT NOT NULL,
      description     TEXT,
      status          TEXT NOT NULL DEFAULT 'upcoming',
      start_at        TIMESTAMPTZ NOT NULL,
      end_at          TIMESTAMPTZ NOT NULL,
      ranking_metric  TEXT NOT NULL DEFAULT 'new_paying_referrals',
      prize_pool_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT referral_seasons_status_check CHECK (status IN ('upcoming','active','completed','cancelled')),
      CONSTRAINT referral_seasons_window_check CHECK (end_at > start_at)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_referral_seasons_status ON referral_seasons(status)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS referral_season_entries (
      id                    BIGSERIAL PRIMARY KEY,
      season_id             BIGINT NOT NULL REFERENCES referral_seasons(id) ON DELETE CASCADE,
      referrer_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      new_paying_referrals  INTEGER NOT NULL DEFAULT 0,
      final_rank            INTEGER,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(season_id, referrer_user_id)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_referral_season_entries_season ON referral_season_entries(season_id)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS referral_season_prize_vouchers (
      id                BIGSERIAL PRIMARY KEY,
      code              TEXT NOT NULL UNIQUE,
      season_id         BIGINT NOT NULL REFERENCES referral_seasons(id) ON DELETE CASCADE,
      season_entry_id   BIGINT REFERENCES referral_season_entries(id) ON DELETE SET NULL,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_size      NUMERIC(12,2) NOT NULL,
      challenge_model_slug TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'issued',
      issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ,
      redeemed_at       TIMESTAMPTZ,
      redeemed_order_id BIGINT REFERENCES challenge_orders(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT referral_season_prize_vouchers_status_check CHECK (status IN ('issued','redeemed','expired','revoked'))
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_referral_season_prize_vouchers_user_status ON referral_season_prize_vouchers(user_id, status)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_referral_season_prize_vouchers_season ON referral_season_prize_vouchers(season_id)`)

  for (const [table, trigger] of [
    ['referral_seasons', 'referral_seasons_upd_trigger'],
    ['referral_season_entries', 'referral_season_entries_upd_trigger'],
    ['referral_season_prize_vouchers', 'referral_season_prize_vouchers_upd_trigger']
  ]) {
    await knex.raw(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${trigger}') THEN
          CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$;
    `)
  }

  await knex.raw(`
    INSERT INTO platform_settings (key, value) VALUES
      ('referral_season_voucher_expiry_days', '90')
    ON CONFLICT (key) DO NOTHING
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS referral_season_prize_vouchers`)
  await knex.raw(`DROP TABLE IF EXISTS referral_season_entries`)
  await knex.raw(`DROP TABLE IF EXISTS referral_seasons`)
}
