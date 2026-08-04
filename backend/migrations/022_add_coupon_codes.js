/**
 * Migration 022: Admin-managed checkout coupon/discount codes
 *
 * Distinct from `competition_prize_vouchers` (migration 021), which are
 * always-100%-free prize redemptions issued automatically to competition
 * winners. `coupon_codes` are manually created by admins (see routes/
 * adminCoupons.js) and grant a percent or fixed-amount discount at checkout
 * (routes/accounts.js's POST /orders) — the order still goes through normal
 * payment for whatever amount remains after the discount.
 *
 * One redemption per user per coupon is enforced with a plain unique index
 * on (coupon_id, user_id) rather than a configurable per-user cap — simplest
 * rule that covers the actual use case (single-use promo codes).
 *
 * set_updated_at() is (re)defined here for the same reason migrations
 * 016/019/021 redefine it: this runs as a deploy step before server.js's own
 * ensureUniqueIds() has created it.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS coupon_codes (
      id                BIGSERIAL PRIMARY KEY,
      code              TEXT NOT NULL UNIQUE,
      description       TEXT,
      discount_type     TEXT NOT NULL,
      discount_value    NUMERIC NOT NULL,
      max_redemptions   INTEGER,
      redemption_count  INTEGER NOT NULL DEFAULT 0,
      min_order_amount  NUMERIC,
      expires_at        TIMESTAMPTZ,
      is_active         BOOLEAN NOT NULL DEFAULT TRUE,
      created_by        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT coupon_codes_discount_type_check CHECK (discount_type IN ('percent', 'fixed')),
      CONSTRAINT coupon_codes_discount_value_check CHECK (discount_value > 0)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_coupon_codes_active ON coupon_codes(is_active)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id                BIGSERIAL PRIMARY KEY,
      coupon_id         BIGINT NOT NULL REFERENCES coupon_codes(id) ON DELETE CASCADE,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id          BIGINT REFERENCES challenge_orders(id) ON DELETE SET NULL,
      discount_amount   NUMERIC NOT NULL,
      redeemed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_coupon_redemptions_coupon_user ON coupon_redemptions(coupon_id, user_id)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_order ON coupon_redemptions(order_id)`)

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'coupon_codes_upd_trigger') THEN
        CREATE TRIGGER coupon_codes_upd_trigger BEFORE UPDATE ON coupon_codes
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$;
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS coupon_redemptions`)
  await knex.raw(`DROP TABLE IF EXISTS coupon_codes`)
}
