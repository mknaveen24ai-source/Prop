/**
 * Drawdown anchor maintenance.
 *
 * `accounts.eod_peak_equity` and `accounts.eod_trailing_floor` are the two
 * columns the drawdown engine actually reads (services/drawdownService.js).
 * Everywhere else in the codebase they are strictly monotonic — every writer
 * guards with `GREATEST` or `WHERE ... < $2` so a floor can never walk
 * backwards. That is correct for *trading*: equity moving inside an existing
 * drawdown frame must never lower the frame.
 *
 * It is wrong for *capital movements*. Trading P&L moves equity within the
 * frame; a deposit, withdrawal, payout or correction moves the frame itself.
 * This module is the only sanctioned place that writes these columns without
 * the monotonic guard, so the exception stays auditable and in one file.
 *
 * Two bugs motivated it:
 *
 *   - A payout debited `current_balance` but left `eod_peak_equity` at the
 *     pre-payout high, so the trailing floor stayed anchored to money that had
 *     already left the account. Withdrawing profit ate the trader's own
 *     drawdown buffer.
 *   - `restore_with_reset` reset `current_balance` to `starting_balance` but
 *     left the anchors at the pre-reset peak, so a reset account reawakened
 *     with a floor computed off its old high and could be failed on the very
 *     first price tick. Because the guards are monotonic, that never
 *     self-corrected.
 */

const { NotFound } = require('./errors')

/**
 * Shift the trailing anchor by a capital movement.
 *
 * Only `eod_peak_equity` moves. `eod_trailing_floor` is the funded-stage
 * one-way lock, derived from `starting_balance * (1 + drawdownLocksAtPct/100) *
 * (1 - maxDrawdownPct/100)` — it is an absolute dollar floor, and capital
 * movements do not change `starting_balance`, so it is deliberately left alone.
 * `resolveEffectiveFloor` takes `max(trailing, locked)`, so the locked floor
 * still binds after this call.
 *
 * @param {import('pg').PoolClient} client must already be inside a transaction
 * @param {string} accountId
 * @param {number} delta signed capital movement (credit positive, debit negative)
 * @returns {Promise<{peakBefore:number|null, peakAfter:number}>}
 */
async function shiftAnchors(client, accountId, delta) {
  const numericDelta = Number(delta)
  if (!Number.isFinite(numericDelta)) {
    throw new TypeError('shiftAnchors requires a finite delta')
  }
  if (numericDelta === 0) {
    const current = await readAnchors(client, accountId)
    return { peakBefore: current.peakEquity, peakAfter: current.peakEquity }
  }

  // COALESCE mirrors resolveEffectiveFloor's own fallback (drawdownService.js:53):
  // a NULL peak means "never ratcheted", which that function reads as
  // starting_balance. Materialising it here keeps the two in agreement.
  //
  // GREATEST(..., 0) stops a debit larger than the peak from producing a
  // negative anchor, which would make the floor negative and disable the
  // drawdown check entirely.
  const result = await client.query(
    `UPDATE accounts
        SET eod_peak_equity = GREATEST(COALESCE(eod_peak_equity, starting_balance) + $2, 0),
            updated_at = NOW()
      WHERE id = $1
      RETURNING eod_peak_equity`,
    [accountId, numericDelta]
  )
  if (result.rows.length === 0) throw new NotFound('Account not found')

  return {
    peakBefore: null,
    peakAfter: parseFloat(result.rows[0].eod_peak_equity)
  }
}

/**
 * Rebase both anchors — for a reset, where the account restarts its drawdown
 * frame from scratch.
 *
 * `eod_trailing_floor` is cleared: a funded account that had locked its floor
 * and is then reset back to `starting_balance` must not keep a lock derived
 * from a run that no longer counts.
 *
 * @param {import('pg').PoolClient} client must already be inside a transaction
 * @param {string} accountId
 * @param {number} equity the equity the frame restarts from
 */
async function rebaseAnchors(client, accountId, equity) {
  const numericEquity = Number(equity)
  if (!Number.isFinite(numericEquity)) {
    throw new TypeError('rebaseAnchors requires a finite equity')
  }

  const result = await client.query(
    `UPDATE accounts
        SET eod_peak_equity = $2,
            eod_trailing_floor = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING eod_peak_equity`,
    [accountId, numericEquity]
  )
  if (result.rows.length === 0) throw new NotFound('Account not found')

  return { peakAfter: parseFloat(result.rows[0].eod_peak_equity) }
}

async function readAnchors(client, accountId) {
  const result = await client.query(
    `SELECT eod_peak_equity, eod_trailing_floor, starting_balance
       FROM accounts WHERE id = $1`,
    [accountId]
  )
  if (result.rows.length === 0) throw new NotFound('Account not found')
  const row = result.rows[0]
  return {
    peakEquity: row.eod_peak_equity != null ? parseFloat(row.eod_peak_equity) : null,
    lockedFloor: row.eod_trailing_floor != null ? parseFloat(row.eod_trailing_floor) : null,
    startingBalance: parseFloat(row.starting_balance)
  }
}

module.exports = { shiftAnchors, rebaseAnchors, readAnchors }
