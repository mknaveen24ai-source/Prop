/**
 * Migration 027: Gift-a-challenge vouchers
 *
 * Lets a trader buy a challenge for someone else. Structurally close to
 * `competition_prize_vouchers` (migration 021) — a code redeemable through
 * routes/accounts.js's POST /orders into a pre-paid challenge_orders row —
 * but a gift's recipient may not have an account yet at issuance time, so
 * `user_id` can't be NOT NULL the way it is on competition vouchers.
 * `recipient_email` is the durable claim key; `recipient_user_id` is an
 * optional convenience backfill once a matching account is found, but
 * redemption is always gated by an email match, not this column.
 *
 * `order_id` is the buyer's original (paid) challenge_orders row;
 * `claimed_order_id` is the new pre-paid order created for the recipient at
 * claim time — same downstream POST /accounts/create gate as every other
 * voucher type, unchanged.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS gift_vouchers (
      id                  BIGSERIAL PRIMARY KEY,
      code                TEXT NOT NULL UNIQUE,
      purchaser_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      order_id            BIGINT REFERENCES challenge_orders(id) ON DELETE SET NULL,
      recipient_email     TEXT NOT NULL,
      recipient_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
      account_size        NUMERIC(12,2) NOT NULL,
      challenge_model_slug TEXT NOT NULL,
      amount_paid         NUMERIC(12,2) NOT NULL DEFAULT 0,
      gift_message         TEXT,
      status               TEXT NOT NULL DEFAULT 'issued',
      issued_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at           TIMESTAMPTZ,
      claimed_at           TIMESTAMPTZ,
      claimed_order_id     BIGINT REFERENCES challenge_orders(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT gift_vouchers_status_check CHECK (status IN ('issued','claimed','expired','revoked'))
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_gift_vouchers_recipient_email ON gift_vouchers(LOWER(recipient_email))`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_gift_vouchers_purchaser ON gift_vouchers(purchaser_user_id)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_gift_vouchers_status ON gift_vouchers(status)`)

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'gift_vouchers_upd_trigger') THEN
        CREATE TRIGGER gift_vouchers_upd_trigger BEFORE UPDATE ON gift_vouchers
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$;
  `)

  await knex.raw(`
    INSERT INTO platform_settings (key, value) VALUES
      ('gift_voucher_expiry_days', '30')
    ON CONFLICT (key) DO NOTHING
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS gift_vouchers`)
}
