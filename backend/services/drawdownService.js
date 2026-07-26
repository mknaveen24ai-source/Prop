// Trailing (peak-equity-based) drawdown, with a one-time funded-stage lock.
//
// Challenge phases: floor = peak_equity * (1 - maxDrawdownPct/100). Peak equity
// only ever rises (GREATEST), so this is a proper trailing floor.
//
// Funded accounts: same trailing floor, UNTIL peak equity first crosses
// starting_balance * (1 + drawdownLocksAtPct/100) — at that point the floor
// locks at that threshold's drawdown level (persisted in accounts.eod_trailing_floor)
// and never drops again, even if equity pulls back below the threshold. The
// account can still make new (higher) peaks after locking, in which case the
// trailing floor may exceed the locked floor — we always take the higher of
// the two.

async function updatePeakEquity(db, accountId, equity, currentPeak) {
  const next = Math.max(parseFloat(currentPeak || 0), equity)
  if (next > parseFloat(currentPeak || 0)) {
    await db.query(
      `UPDATE accounts SET eod_peak_equity = $2 WHERE id = $1 AND (eod_peak_equity IS NULL OR eod_peak_equity < $2)`,
      [accountId, next]
    )
  }
  return next
}

function computeTrailingFloor(peakEquity, maxDrawdownPct) {
  return peakEquity * (1 - maxDrawdownPct / 100)
}

async function maybeLockFundedFloor(db, acc, { peakEquity, maxDrawdownPct, drawdownLocksAtPct }) {
  const existing = acc.eod_trailing_floor != null ? parseFloat(acc.eod_trailing_floor) : null
  if (drawdownLocksAtPct == null) return existing

  const startingBalance = parseFloat(acc.starting_balance)
  const lockThreshold = startingBalance * (1 + drawdownLocksAtPct / 100)
  if (peakEquity < lockThreshold) return existing

  const candidateFloor = lockThreshold * (1 - maxDrawdownPct / 100)
  if (existing == null || candidateFloor > existing) {
    await db.query(
      `UPDATE accounts SET eod_trailing_floor = $2 WHERE id = $1 AND (eod_trailing_floor IS NULL OR eod_trailing_floor < $2)`,
      [acc.id, candidateFloor]
    )
    return candidateFloor
  }
  return existing
}

// acc must include: id, starting_balance, eod_peak_equity, eod_trailing_floor, account_type
// opts: { equity, maxDrawdownPct, drawdownLocksAtPct (funded only, else null) }
async function getEffectiveDrawdownFloor(db, acc, opts) {
  const { equity, maxDrawdownPct, drawdownLocksAtPct = null } = opts
  const startingBalance = parseFloat(acc.starting_balance)
  const priorPeak = acc.eod_peak_equity != null ? parseFloat(acc.eod_peak_equity) : startingBalance
  const peakEquity = await updatePeakEquity(db, acc.id, equity, priorPeak)

  const trailingFloor = computeTrailingFloor(peakEquity, maxDrawdownPct)
  if (acc.account_type !== 'funded' || drawdownLocksAtPct == null) return trailingFloor

  const lockedFloor = await maybeLockFundedFloor(db, acc, { peakEquity, maxDrawdownPct, drawdownLocksAtPct })
  return lockedFloor != null ? Math.max(trailingFloor, lockedFloor) : trailingFloor
}

module.exports = {
  updatePeakEquity,
  computeTrailingFloor,
  maybeLockFundedFloor,
  getEffectiveDrawdownFloor
}
