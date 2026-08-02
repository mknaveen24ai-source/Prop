/**
 * Migration 020: General-purpose balance adjustment ledger
 *
 * `admin_balance_adjustments` (created inline in routes/admin.js) is a
 * write-only audit log for one specific manual endpoint — nothing ever sums
 * it, and it isn't reused by new code. This migration adds a proper ledger
 * table that new balance-affecting features (competition bot P&L injection,
 * admin cheat correction) write through exclusively via
 * utils/balanceAdjustments.js's applyBalanceAdjustment(), instead of ever
 * issuing a raw `UPDATE accounts SET current_balance = ...` directly.
 *
 * The table is deliberately generic (not competition-scoped in name) —
 * competition_id/competition_entry_id are nullable so a future non-competition
 * ledger use (a real bonus/penalty system) can reuse it without a schema
 * change. This does NOT retrofit the ~13 pre-existing raw balance-write call
 * sites elsewhere in the codebase (challengeEngine.js, trades.js close paths,
 * competitionEngine.js's closeAndFreezeAccount, scheduled close services,
 * several admin.js endpoints) — that is out of scope for this task.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS balance_adjustments (
      id                    BIGSERIAL PRIMARY KEY,
      account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
      source                TEXT NOT NULL,
      competition_id        BIGINT REFERENCES competitions(id) ON DELETE SET NULL,
      competition_entry_id  BIGINT REFERENCES competition_entries(id) ON DELETE SET NULL,
      amount                NUMERIC(15,2) NOT NULL,
      balance_before        NUMERIC(15,2) NOT NULL,
      balance_after         NUMERIC(15,2) NOT NULL,
      reason                TEXT NOT NULL DEFAULT '',
      created_by            TEXT NOT NULL DEFAULT 'system',
      metadata_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT balance_adjustments_amount_nonzero_check CHECK (amount <> 0)
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_balance_adjustments_account_created ON balance_adjustments(account_id, created_at DESC)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_balance_adjustments_competition ON balance_adjustments(competition_id) WHERE competition_id IS NOT NULL`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_balance_adjustments_entry ON balance_adjustments(competition_entry_id) WHERE competition_entry_id IS NOT NULL`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_balance_adjustments_source ON balance_adjustments(source)`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS balance_adjustments`)
}
