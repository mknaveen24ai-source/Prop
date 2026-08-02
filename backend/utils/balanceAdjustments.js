/**
 * Ledger-backed balance mutation helper.
 *
 * applyBalanceAdjustment() is the ONLY sanctioned way new code (competition
 * bot P&L ticks, admin cheat corrections) touches accounts.current_balance —
 * every call both mutates the balance and records a balance_adjustments row
 * in the same statement/transaction, so current_balance always stays
 * reconstructable as starting_balance + SUM(realized trade P&L) +
 * SUM(balance_adjustments.amount) for any account whose balance has only
 * ever moved through this helper (e.g. a bot account with no real trades).
 *
 * Pre-existing raw `UPDATE accounts SET current_balance = ...` call sites
 * elsewhere in the codebase are intentionally left untouched — this helper
 * is for new call sites only, not a retrofit.
 */

class BalanceAdjustmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.statusCode = statusCode
  }
}

// `client` must already be inside an open transaction (BEGIN already issued
// by the caller) — this function does not open or commit/rollback one itself,
// so callers can compose it with their own additional statements atomically.
async function applyBalanceAdjustment(client, {
  accountId,
  amount,
  source,
  reason = '',
  createdBy = 'system',
  competitionId = null,
  competitionEntryId = null,
  metadata = {}
}) {
  const numericAmount = parseFloat(amount)
  if (!Number.isFinite(numericAmount) || numericAmount === 0) {
    throw new BalanceAdjustmentError('A non-zero adjustment amount is required')
  }
  if (!accountId) {
    throw new BalanceAdjustmentError('accountId is required')
  }
  if (!source) {
    throw new BalanceAdjustmentError('source is required')
  }

  const updateResult = await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2
      RETURNING id, user_id, current_balance, peak_balance`,
    [numericAmount, accountId]
  )

  if (updateResult.rows.length === 0) {
    throw new BalanceAdjustmentError('Account not found', 404)
  }

  const account = updateResult.rows[0]
  const balanceAfter = parseFloat(account.current_balance)
  const balanceBefore = Math.round((balanceAfter - numericAmount) * 100) / 100

  const insertResult = await client.query(
    `INSERT INTO balance_adjustments
       (account_id, user_id, source, competition_id, competition_entry_id,
        amount, balance_before, balance_after, reason, created_by, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     RETURNING id`,
    [
      account.id,
      account.user_id,
      source,
      competitionId,
      competitionEntryId,
      numericAmount,
      balanceBefore,
      balanceAfter,
      reason,
      createdBy,
      JSON.stringify(metadata || {})
    ]
  )

  return {
    ledgerId: insertResult.rows[0].id,
    accountId: account.id,
    userId: account.user_id,
    amount: numericAmount,
    balanceBefore,
    balanceAfter,
    peakBalance: parseFloat(account.peak_balance)
  }
}

module.exports = {
  BalanceAdjustmentError,
  applyBalanceAdjustment
}
