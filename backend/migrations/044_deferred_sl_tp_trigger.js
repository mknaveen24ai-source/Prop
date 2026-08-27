/**
 * Migration 044: deferred stop-loss / take-profit fills.
 * ─────────────────────────────────────────────────────────────────────────────
 * Stop losses did not exist for the first `minHoldSeconds` of a position.
 *
 * services/tradeEngine.js `checkSLTP` skipped any trade younger than the hold
 * window entirely — the crossing was not queued and was not remembered:
 *
 *   - Price touched the stop at second 10  → nothing happened.
 *   - Price still through it at second 61  → it closed at the price THEN,
 *                                            which could be far worse.
 *   - Price came back before second 61     → the stop never filled at all.
 *
 * That is the single highest-volatility minute of a position's life, and the
 * published rules had to carry a disclosure saying so (see
 * docs/TRADING_RULES_DISCLOSURES.md §1). The disclosure was accurate but it is
 * not a sentence that can be disclosed into acceptability: a trader who reads
 * it and signs up anyway still disputes the first time it costs them an
 * account, and they are right to.
 *
 * These three columns record that a level was crossed inside the hold window,
 * so the fill can be honoured AT THE LEVEL once the window expires. They live
 * on the row rather than in an engine-local map because the engine restarts and
 * a trader's stop must not evaporate with the process.
 *
 *   pending_close_price   the LEVEL (stop_loss / take_profit), not the market
 *                         price at the crossing — the level is what the trader
 *                         asked for and what they get.
 *   pending_close_reason  'Stop Loss' | 'Take Profit', matching close_reason.
 *   pending_close_at      when the crossing was observed. First crossing wins;
 *                         a later one never overwrites it.
 *
 * Cleared when the trader moves or removes the level (routes/trades/modify.js)
 * and when the trade closes by any other route, so a stale trigger can never
 * fire against a level that no longer exists.
 *
 * The partial index is what keeps the engine's "does this trade have a pending
 * trigger" question cheap — the overwhelming majority of open trades never
 * cross a level inside the window, so the index stays tiny.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS pending_close_price NUMERIC`)
  await knex.raw(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS pending_close_reason TEXT`)
  await knex.raw(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS pending_close_at TIMESTAMPTZ`)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_trades_pending_close
      ON trades (id)
     WHERE pending_close_price IS NOT NULL AND status = 'open'
  `)

  return true
}

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_trades_pending_close`)
  await knex.raw(`ALTER TABLE trades DROP COLUMN IF EXISTS pending_close_at`)
  await knex.raw(`ALTER TABLE trades DROP COLUMN IF EXISTS pending_close_reason`)
  await knex.raw(`ALTER TABLE trades DROP COLUMN IF EXISTS pending_close_price`)

  return true
}
