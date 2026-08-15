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
//
// ── Pure core / persisting shell ──
//
// resolveEffectiveFloor() is the pure calculator: same inputs, same answer, no
// I/O. getEffectiveDrawdownFloor() is the persisting wrapper that existing
// callers keep using unchanged.
//
// The split exists because the old shape issued an UPDATE per account per tick
// to advance eod_peak_equity. At interval cadence that was tolerable; driven off
// every price tick it would dominate the entire engine. The event-driven engine
// calls the pure version, accumulates dirty peaks in memory, and flushes them
// through flushPeakEquityUpdates() as one bulk statement on a timer.

function toNum(value, fallback = null) {
  if (value == null) return fallback
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

function computeTrailingFloor(peakEquity, maxDrawdownPct) {
  return peakEquity * (1 - maxDrawdownPct / 100)
}

/**
 * Pure floor resolution — no database access.
 *
 * @param {object} acc  Needs starting_balance, eod_peak_equity,
 *   eod_trailing_floor, account_type.
 * @param {{equity:number, maxDrawdownPct:number, drawdownLocksAtPct?:number|null}} opts
 * @returns {{
 *   floor: number,
 *   nextPeak: number,
 *   peakChanged: boolean,
 *   nextLockedFloor: number|null,
 *   lockedFloorChanged: boolean
 * }}
 */
function resolveEffectiveFloor(acc, opts) {
  const { equity, maxDrawdownPct, drawdownLocksAtPct = null } = opts
  const startingBalance = toNum(acc.starting_balance, 0)
  const priorPeak = acc.eod_peak_equity != null ? toNum(acc.eod_peak_equity, 0) : startingBalance
  const nextPeak = Math.max(priorPeak, equity)
  const peakChanged = nextPeak > priorPeak

  const trailingFloor = computeTrailingFloor(nextPeak, maxDrawdownPct)
  const existingLocked = acc.eod_trailing_floor != null ? toNum(acc.eod_trailing_floor) : null

  if (acc.account_type !== 'funded' || drawdownLocksAtPct == null) {
    return {
      floor: trailingFloor,
      nextPeak,
      peakChanged,
      nextLockedFloor: existingLocked,
      lockedFloorChanged: false
    }
  }

  const lockThreshold = startingBalance * (1 + drawdownLocksAtPct / 100)
  let nextLockedFloor = existingLocked
  let lockedFloorChanged = false

  if (nextPeak >= lockThreshold) {
    const candidateFloor = lockThreshold * (1 - maxDrawdownPct / 100)
    if (existingLocked == null || candidateFloor > existingLocked) {
      nextLockedFloor = candidateFloor
      lockedFloorChanged = true
    }
  }

  const floor = nextLockedFloor != null
    ? Math.max(trailingFloor, nextLockedFloor)
    : trailingFloor

  return { floor, nextPeak, peakChanged, nextLockedFloor, lockedFloorChanged }
}

// ─── Persisting wrappers (unchanged signatures) ───────────────────────────────

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
  const resolved = resolveEffectiveFloor(acc, opts)

  if (resolved.peakChanged) {
    await db.query(
      `UPDATE accounts SET eod_peak_equity = $2 WHERE id = $1 AND (eod_peak_equity IS NULL OR eod_peak_equity < $2)`,
      [acc.id, resolved.nextPeak]
    )
  }

  if (resolved.lockedFloorChanged) {
    await db.query(
      `UPDATE accounts SET eod_trailing_floor = $2 WHERE id = $1 AND (eod_trailing_floor IS NULL OR eod_trailing_floor < $2)`,
      [acc.id, resolved.nextLockedFloor]
    )
  }

  return resolved.floor
}

/**
 * Bulk-persist peak equity / locked floors accumulated across many ticks.
 *
 * The guards mirror the single-row wrappers (only ever raise, never lower), so a
 * flush racing an interval-loop write cannot walk a floor backwards.
 *
 * @param {object} db
 * @param {Array<{accountId:string, peak:number|null, lockedFloor:number|null}>} updates
 * @returns {Promise<number>} rows touched
 */
async function flushPeakEquityUpdates(db, updates) {
  if (!Array.isArray(updates) || updates.length === 0) return 0

  const ids = []
  const peaks = []
  const floors = []
  for (const update of updates) {
    if (!update || !update.accountId) continue
    ids.push(update.accountId)
    peaks.push(update.peak != null ? update.peak : null)
    floors.push(update.lockedFloor != null ? update.lockedFloor : null)
  }
  if (ids.length === 0) return 0

  const result = await db.query(
    `UPDATE accounts a SET
       eod_peak_equity = GREATEST(COALESCE(a.eod_peak_equity, v.peak), v.peak),
       eod_trailing_floor = GREATEST(COALESCE(a.eod_trailing_floor, v.floor), v.floor)
     FROM (
       SELECT unnest($1::uuid[])    AS id,
              unnest($2::numeric[]) AS peak,
              unnest($3::numeric[]) AS floor
     ) v
     WHERE a.id = v.id
       AND (
         (v.peak IS NOT NULL AND (a.eod_peak_equity IS NULL OR a.eod_peak_equity < v.peak))
         OR (v.floor IS NOT NULL AND (a.eod_trailing_floor IS NULL OR a.eod_trailing_floor < v.floor))
       )`,
    [ids, peaks, floors]
  )
  return result.rowCount || 0
}

module.exports = {
  updatePeakEquity,
  computeTrailingFloor,
  resolveEffectiveFloor,
  maybeLockFundedFloor,
  getEffectiveDrawdownFloor,
  flushPeakEquityUpdates
}
