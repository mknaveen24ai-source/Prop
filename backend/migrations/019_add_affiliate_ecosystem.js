/**
 * Migration 019: Affiliate ecosystem (referral attribution, tiered commissions,
 * affiliate payout requests)
 *
 * Every user already gets an `affiliate_code` at registration (see routes/auth.js)
 * — this migration does not duplicate that identity into a separate `affiliates`
 * table. Instead `affiliate_referrals` is the source of truth for who-referred-whom
 * (a hard FK join, captured once at registration and permanent for the life of the
 * account), and `affiliate_commissions` is a ledger with one row per PAID challenge
 * order from a referred user — not just their first order. Commission is a lifetime
 * revenue share, not a one-time signup bonus; the referred user's own incentive
 * (a first-purchase-only discount) lives entirely in application code, not schema.
 *
 * set_updated_at() is (re)defined here for the same reason migration 016 redefines
 * it: migrations run as a separate deploy step before server.js's ensureUniqueIds()
 * has a chance to create it.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  // 1. Referral attribution — single-level, captured once at registration, permanent.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS affiliate_referrals (
      id                  BIGSERIAL PRIMARY KEY,
      referrer_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      affiliate_code_used TEXT NOT NULL,
      source              TEXT NOT NULL DEFAULT 'registration',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_referrals_referred_user ON affiliate_referrals(referred_user_id)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_referrer ON affiliate_referrals(referrer_user_id)`)

  // 2. Admin-configurable commission tiers (by paying-referral volume).
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS affiliate_commission_tiers (
      id                BIGSERIAL PRIMARY KEY,
      tier_rank         INTEGER NOT NULL UNIQUE,
      label             TEXT,
      min_referrals     INTEGER NOT NULL,
      commission_pct    NUMERIC NOT NULL,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_tiers_min_referrals ON affiliate_commission_tiers(min_referrals) WHERE is_active = TRUE`)

  // 3. Commission ledger — one row per PAID ORDER, for the lifetime of the referral
  //    relationship (not just the referred user's first order). Also holds manual
  //    admin balance-adjustment rows (order_id NULL, commission_amount may be negative).
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id                    BIGSERIAL PRIMARY KEY,
      referral_id           BIGINT REFERENCES affiliate_referrals(id) ON DELETE SET NULL,
      referrer_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      referred_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
      order_id              BIGINT REFERENCES challenge_orders(id) ON DELETE SET NULL,
      tier_rank             INTEGER,
      commission_rate_pct   NUMERIC,
      order_amount          NUMERIC,
      commission_amount     NUMERIC NOT NULL,
      status                TEXT NOT NULL DEFAULT 'available',
      payout_request_id     BIGINT,
      adjustment_note       TEXT,
      adjusted_by           TEXT,
      adjusted_at           TIMESTAMPTZ,
      earned_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT affiliate_commissions_status_check CHECK (status IN ('pending','available','paid','adjusted'))
    )
  `)
  // Partial unique index (not plain UNIQUE) — manual 'adjusted' rows have order_id = NULL
  // and must be allowed to repeat; idempotency only matters for order-linked rows, mirroring
  // uq_challenge_payments_order's guard against Stripe's at-least-once webhook redelivery.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_affiliate_commissions_order ON affiliate_commissions(order_id) WHERE order_id IS NOT NULL`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referrer_status ON affiliate_commissions(referrer_user_id, status)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_referred ON affiliate_commissions(referred_user_id)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_payout ON affiliate_commissions(payout_request_id)`)

  // 4. Affiliate payout requests — mirrors the existing `payouts` table shape/flow.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS affiliate_payout_requests (
      id                BIGSERIAL PRIMARY KEY,
      affiliate_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount_requested  NUMERIC NOT NULL,
      payment_method    TEXT NOT NULL,
      payment_details   TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      admin_notes       TEXT,
      transaction_id    TEXT,
      requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at           TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT affiliate_payout_requests_status_check CHECK (status IN ('pending','paid','rejected'))
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_payout_requests_affiliate_status ON affiliate_payout_requests(affiliate_user_id, status)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_affiliate_payout_requests_status ON affiliate_payout_requests(status, requested_at DESC)`)

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_commission_tiers_upd_trigger') THEN
        CREATE TRIGGER affiliate_commission_tiers_upd_trigger BEFORE UPDATE ON affiliate_commission_tiers
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_commissions_upd_trigger') THEN
        CREATE TRIGGER affiliate_commissions_upd_trigger BEFORE UPDATE ON affiliate_commissions
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'affiliate_payout_requests_upd_trigger') THEN
        CREATE TRIGGER affiliate_payout_requests_upd_trigger BEFORE UPDATE ON affiliate_payout_requests
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$;
  `)

  // Seed default tiers — admin can edit/replace these via the Affiliate Settings UI.
  await knex.raw(`
    INSERT INTO affiliate_commission_tiers (tier_rank, label, min_referrals, commission_pct) VALUES
      (1, 'Starter', 0, 10),
      (2, 'Silver', 5, 15),
      (3, 'Gold', 15, 20),
      (4, 'Platinum', 30, 25)
    ON CONFLICT (tier_rank) DO NOTHING
  `)

  // Seed platform_settings defaults (existing flat key/value config table).
  await knex.raw(`
    INSERT INTO platform_settings (key, value) VALUES
      ('affiliate_program_enabled', 'true'),
      ('affiliate_referred_discount_pct', '10'),
      ('affiliate_min_payout_amount', '50'),
      ('affiliate_default_commission_pct', '10')
    ON CONFLICT (key) DO NOTHING
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS affiliate_payout_requests`)
  await knex.raw(`DROP TABLE IF EXISTS affiliate_commissions`)
  await knex.raw(`DROP TABLE IF EXISTS affiliate_commission_tiers`)
  await knex.raw(`DROP TABLE IF EXISTS affiliate_referrals`)
}
