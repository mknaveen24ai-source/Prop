/**
 * Migration 033: Backfill historical admin adjustments into the canonical ledger
 *
 * Migration 020 created `balance_adjustments` as the general-purpose ledger but
 * explicitly did not retrofit existing call sites. One of those — the admin
 * adjust-balance endpoint — kept writing only `admin_balance_adjustments`, a
 * table nothing else reads.
 *
 * That turned out to be a live bug rather than just an inconsistency.
 * challengeEngine.js's evaluateScalingPlan isolates trading profit as
 * `current_balance - starting_balance - SUM(balance_adjustments)`. An admin
 * credit raised `current_balance` but never appeared in that sum, so it read as
 * *trading profit* and could mint a real scaling milestone — injecting further
 * capital on the back of a goodwill credit.
 *
 * routes/admin/accounts.js now writes both tables in one transaction. This
 * migration brings the history across so the invariant
 *
 *   current_balance = starting_balance + trading P&L + SUM(balance_adjustments)
 *
 * holds for accounts that were adjusted before the fix, rather than only for
 * ones adjusted after it.
 *
 * Idempotent: rows are matched on the `admin_balance_adjustments.id` recorded in
 * metadata_json, so re-running inserts nothing further.
 */

exports.up = async function (knex) {
  const hasAdminTable = await knex.schema.hasTable('admin_balance_adjustments')
  if (!hasAdminTable) return

  // Zero-amount rows are skipped: balance_adjustments carries a
  // CHECK (amount <> 0) from migration 020, and a zero adjustment moved no
  // money, so it has no bearing on the invariant.
  //
  // Orphans are skipped too — admin_balance_adjustments has no FK to accounts,
  // so it can outlive a deleted account, and the ledger's FK would reject those.
  await knex.raw(`
    INSERT INTO balance_adjustments
      (account_id, user_id, source, amount, balance_before, balance_after,
       reason, created_by, metadata_json, created_at)
    SELECT
      aba.account_id::uuid,
      aba.user_id::uuid,
      'admin_adjustment',
      aba.amount,
      aba.balance_before,
      aba.balance_after,
      COALESCE(aba.reason, ''),
      COALESCE(aba.created_by, 'system'),
      jsonb_build_object('backfilled_from_admin_balance_adjustment_id', aba.id),
      aba.created_at
    FROM admin_balance_adjustments aba
    JOIN accounts a ON a.id = aba.account_id::uuid
    WHERE aba.amount <> 0
      AND aba.balance_before IS NOT NULL
      AND aba.balance_after IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM balance_adjustments ba
         WHERE ba.metadata_json ->> 'backfilled_from_admin_balance_adjustment_id' = aba.id::text
      )
  `)
}

exports.down = async function (knex) {
  await knex.raw(`
    DELETE FROM balance_adjustments
     WHERE metadata_json ? 'backfilled_from_admin_balance_adjustment_id'
  `)
}
