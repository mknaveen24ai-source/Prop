/**
 * Migration 045: two-person approval on large payouts.
 * ─────────────────────────────────────────────────────────────────────────────
 * One admin could approve any payout, of any size, to any wallet.
 *
 * The rest of the admin surface is genuinely well built — capability-based
 * RBAC, an immutable audit trail with before/after snapshots, a reason required
 * on destructive actions, per-admin token_version revocation, and mandatory
 * TOTP. What none of that survives is a single compromised or malicious
 * finance_ops session: RBAC says that role may approve payouts, so approving
 * every pending payout to attacker-controlled addresses is, to every control
 * listed above, an authorised action correctly performed.
 *
 * Dual control is the standard answer, and it is the only one that does not
 * depend on the first admin being honest.
 *
 *   first_approver_admin_id   who moved it first (the audit label, so it works
 *                             for both DB-backed admins and the bootstrap path)
 *   first_approved_at         when — also what the UI shows as "awaiting a
 *                             second approver"
 *   second_approver_admin_id  who completed it; enforced to differ from the first
 *   second_approved_at        when
 *
 * ── Why no new payout status ──
 *
 * A payout awaiting its second approver stays 'pending'. It is still an
 * unapproved request from every other angle — the trader sees it queued, the
 * account cannot request another, the SLA watch still counts it, and the
 * aggregates that filter on status keep working untouched. Introducing an
 * 'awaiting_second_approval' status would mean teaching every one of those the
 * difference between two states that behave identically.
 *
 * The threshold itself is a platform setting, not a column: it is a policy
 * knob, and pinning it per row would make historical rows argue with current
 * policy during an incident review.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS first_approver_admin_id TEXT`)
  await knex.raw(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ`)
  await knex.raw(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS second_approver_admin_id TEXT`)
  await knex.raw(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS second_approved_at TIMESTAMPTZ`)

  // The admin queue's "these are waiting on someone else" filter.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_payouts_awaiting_second_approval
      ON payouts (first_approved_at)
     WHERE status = 'pending' AND first_approved_at IS NOT NULL
  `)

  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('payout_dual_approval_threshold', '2500')
    ON CONFLICT (key) DO NOTHING
  `)

  return true
}

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_payouts_awaiting_second_approval`)
  await knex.raw(`DELETE FROM platform_settings WHERE key = 'payout_dual_approval_threshold'`)
  await knex.raw(`ALTER TABLE payouts DROP COLUMN IF EXISTS second_approved_at`)
  await knex.raw(`ALTER TABLE payouts DROP COLUMN IF EXISTS second_approver_admin_id`)
  await knex.raw(`ALTER TABLE payouts DROP COLUMN IF EXISTS first_approved_at`)
  await knex.raw(`ALTER TABLE payouts DROP COLUMN IF EXISTS first_approver_admin_id`)

  return true
}
