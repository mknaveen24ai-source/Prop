/**
 * Migration 043: refund, chargeback and webhook-replay infrastructure.
 * ─────────────────────────────────────────────────────────────────────────────
 * The platform had NO refund path and NO chargeback path at all.
 *
 * routes/billing.js handled exactly one Stripe event — checkout.session.completed
 * — and nothing else. charge.refunded, charge.dispute.created,
 * checkout.session.expired and payment_intent.payment_failed all fell on the
 * floor. Three consequences, each of which happens in a normal first month:
 *
 *   1. A trader pays, passes, gets funded, then files a dispute. Stripe pulls
 *      the money back plus a fee. The platform never hears about it. The funded
 *      account stays live and withdraws the firm's capital.
 *   2. A refund issued by hand in the Stripe dashboard left the order row still
 *      reading `status = 'paid'`, so the account could still be created.
 *   3. markChallengeOrderPaid() issued an unconditional
 *      `UPDATE challenge_orders SET status = 'paid'` with no guard on the
 *      current status, so a Stripe redelivery flipped a refunded order back to
 *      paid.
 *
 * frontend/src/pages/RefundPolicy.jsx published a refund policy the platform
 * had no mechanism to execute.
 *
 * ── stripe_events ──
 *
 * Idempotency previously rode entirely on `ON CONFLICT DO NOTHING` in whichever
 * downstream INSERT happened to run. That worked for the one handled event, but
 * it is a property of each statement rather than of the handler — so every new
 * event type was a fresh opportunity to double-process. This table makes replay
 * protection a property of the webhook itself: the event id is claimed first,
 * inside the same transaction as the work, so the claim commits with the work
 * and rolls back with it.
 *
 * ── No new account status ──
 *
 * A disputed account is frozen by setting accounts.status = 'locked', which
 * already exists, already blocks trading (routes/trades/open.js requires
 * status = 'active'), and is already refused by evaluatePayoutEligibility's
 * NOT_ACTIVE blocker — so a freeze blocks withdrawal with no extra code. Adding
 * a 'disputed' status would have meant teaching the engine, the analytics and
 * every list filter about a state that behaves identically to one they know.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id     TEXT PRIMARY KEY,
      event_type   TEXT NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_stripe_events_type ON stripe_events (event_type, received_at DESC)`)

  // challenge_orders.status has no CHECK constraint, so 'refunded' and
  // 'disputed' need no schema change — only the timestamps that record when.
  await knex.raw(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ`)
  await knex.raw(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ`)
  await knex.raw(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC`)

  // Lets the dispute/refund handler find an order from a Stripe payment intent
  // without a sequential scan. Partial — most orders never carry a reference.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_challenge_orders_provider_reference
      ON challenge_orders (provider_reference)
     WHERE provider_reference IS NOT NULL
  `)

  // The entry fee is refunded to the trader's balance on their first payout
  // (domain/payout.js). "Has it already been refunded" is derived from the
  // ledger rather than a flag, so it cannot disagree with the money — this
  // index is what makes that derivation cheap.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_balance_adjustments_account_source
      ON balance_adjustments (account_id, source)
  `)

  return true
}

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_balance_adjustments_account_source`)
  await knex.raw(`DROP INDEX IF EXISTS idx_challenge_orders_provider_reference`)
  await knex.raw(`ALTER TABLE challenge_orders DROP COLUMN IF EXISTS refund_amount`)
  await knex.raw(`ALTER TABLE challenge_orders DROP COLUMN IF EXISTS disputed_at`)
  await knex.raw(`ALTER TABLE challenge_orders DROP COLUMN IF EXISTS refunded_at`)
  await knex.raw(`DROP INDEX IF EXISTS idx_stripe_events_type`)
  await knex.raw(`DROP TABLE IF EXISTS stripe_events`)
  return true
}
