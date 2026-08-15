'use strict'
/**
 * Instrument-indexed trade + account index
 * ─────────────────────────────────────────────────────────────────────────────
 * This is what makes a 100K-trade engine tick affordable.
 *
 * The interval loops it replaces re-read every open trade from Postgres on every
 * pass, so their cost scaled with the *total* number of open trades regardless
 * of what actually moved. But a price tick only changes a handful of
 * instruments. Indexing trades by instrument means a tick scans the ~2,500
 * trades on the instruments that moved rather than all 100,000 — roughly a 95%
 * reduction before any other optimisation.
 *
 * ── Consistency model ──
 *
 * The index is authoritative for the hot path (single-instance deployment, by
 * decision). It is kept in sync two ways:
 *
 *   1. Incrementally — routes and the engine call addTrade/removeTrade as they
 *      open and close positions. This is the path that must be correct.
 *   2. fullReconcileFromDB() — runs once at boot *before* the engine is armed,
 *      then every 30s as a drift guard.
 *
 * The reconcile logs whatever divergence it corrects. In steady state that count
 * should be zero: a non-zero value means an incremental path is missing a call
 * and should be treated as a bug, not absorbed quietly by the safety net.
 *
 * Entries store pre-parsed native numbers (and a pre-resolved direction sign and
 * contract size) so the hot loop does no string comparison, no parseFloat and no
 * map lookups.
 */

const pool = require('../db')
const logger = require('./logger')
const { directionSign, contractSizeFor } = require('./fastPnL')
const { fetchStepModelBySlug } = require('./stepModels')
const { utcDayStart } = require('../services/tradingDaysService')

// ─── State ────────────────────────────────────────────────────────────────────
const _byInstrument = new Map()        // instrument   → Map<tradeId, TradeEntry>
const _byId = new Map()                // tradeId      → TradeEntry
const _byAccount = new Map()           // accountId    → AccountEntry
const _pendingByInstrument = new Map() // instrument   → Map<orderId, PendingEntry>
const _pendingById = new Map()         // orderId      → PendingEntry

// challenge_model_slug → { maxDrawdownPct, dailyDrawdownPct, drawdownLocksAtPct }
// Funded accounts take their drawdown limits from their challenge model rather
// than the account row. checkFloatingDrawdown resolved this per tick with a
// per-slug cache that died with each pass; here it persists.
const _fundedModelCache = new Map()

let _reconcileGeneration = 0
let _lastReconcileAt = 0
let _ready = false

function toNum(value, fallback = null) {
  if (value == null) return fallback
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

function dayKey(date = new Date()) {
  return utcDayStart(date).getTime()
}

// ─── Entry construction ───────────────────────────────────────────────────────

/**
 * @param {object} row  A trades row joined to nothing in particular — needs
 *   id, account_id, instrument, direction, lot_size, open_price, stop_loss,
 *   take_profit, commission, open_time.
 */
function buildTradeEntry(row) {
  const instrument = row.instrument
  return {
    id: row.id,
    accountId: row.account_id,
    instrument,
    sign: directionSign(row.direction),
    direction: row.direction,
    openPrice: toNum(row.open_price, 0),
    lots: toNum(row.lot_size, 0),
    commission: toNum(row.commission, 0) || 0,
    stopLoss: toNum(row.stop_loss),
    takeProfit: toNum(row.take_profit),
    openTimeMs: row.open_time ? new Date(row.open_time).getTime() : Date.now(),
    contractSize: contractSizeFor(instrument),
    // This trade's last computed contribution to its account's floating PnL.
    // See applyTradePnl for why it is stored rather than re-summed.
    lastPnl: 0,
    gen: _reconcileGeneration
  }
}

function buildPendingEntry(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    instrument: row.instrument,
    direction: row.direction,
    orderType: row.order_type,
    triggerPrice: toNum(row.pending_price),
    lots: toNum(row.lot_size, 0),
    ocoGroupId: row.oco_group_id || null,
    gen: _reconcileGeneration
  }
}

function buildAccountEntry(row) {
  const existing = _byAccount.get(row.id)
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    accountType: row.account_type,
    challengeModelSlug: row.challenge_model_slug || null,
    currentBalance: toNum(row.current_balance, 0),
    startingBalance: toNum(row.starting_balance, 0),
    peakBalance: toNum(row.peak_balance, 0),
    accountSize: toNum(row.account_size, 0),
    profitTarget: toNum(row.profit_target, 0) || 0,
    scalingMultiplier: toNum(row.scaling_multiplier, 1),
    phaseEndDate: row.phase_end_date ? new Date(row.phase_end_date).getTime() : null,
    eodPeakEquity: toNum(row.eod_peak_equity),
    eodTrailingFloor: toNum(row.eod_trailing_floor),
    // Account-row limits. For funded accounts these get overridden by the
    // challenge model in resolveDrawdownSettings().
    maxDrawdownPct: toNum(row.max_drawdown_pct),
    dailyDrawdownPct: toNum(row.daily_drawdown_pct),
    drawdownLocksAtPct: null,
    // Cached so the daily-loss check doesn't need getTodayRealizedPnl per tick.
    todayRealizedPnl: existing ? existing.todayRealizedPnl : 0,
    realizedDayKey: existing ? existing.realizedDayKey : dayKey(),
    // Running sum of every open trade's lastPnl. Maintained by applyTradePnl.
    floatingPnl: existing ? existing.floatingPnl : 0,
    tradeIds: existing ? existing.tradeIds : new Set(),
    pendingIds: existing ? existing.pendingIds : new Set(),
    gen: _reconcileGeneration
  }
}

/**
 * Resolve the drawdown limits that actually apply, mirroring the funded-model
 * lookup in checkFloatingDrawdown. Async and therefore never called on the hot
 * path — the result is baked onto the AccountEntry at reconcile/insert time.
 */
async function resolveDrawdownSettings(entry) {
  if (entry.accountType !== 'funded' || !entry.challengeModelSlug) return

  let settings = _fundedModelCache.get(entry.challengeModelSlug)
  if (settings === undefined) {
    try {
      const model = await fetchStepModelBySlug(entry.challengeModelSlug)
      settings = model
        ? {
            maxDrawdownPct: toNum(model.funded_max_drawdown_pct),
            dailyDrawdownPct: toNum(model.funded_daily_drawdown_pct),
            drawdownLocksAtPct: toNum(model.funded_drawdown_locks_at_pct)
          }
        : null
    } catch (error) {
      logger.error('[tradeIndex] funded model lookup failed:', {
        slug: entry.challengeModelSlug,
        error: error.message
      })
      settings = null
    }
    _fundedModelCache.set(entry.challengeModelSlug, settings)
  }

  if (settings && Number.isFinite(settings.maxDrawdownPct)) {
    entry.maxDrawdownPct = settings.maxDrawdownPct
    entry.dailyDrawdownPct = settings.dailyDrawdownPct
    entry.drawdownLocksAtPct = settings.drawdownLocksAtPct
  }
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function instrumentBucket(map, instrument) {
  let bucket = map.get(instrument)
  if (!bucket) {
    bucket = new Map()
    map.set(instrument, bucket)
  }
  return bucket
}

/**
 * Add (or replace) an open trade.
 * @param {object} tradeRow
 * @param {object} [accountRow] Present when the caller already has the account;
 *   otherwise the existing AccountEntry is kept.
 */
function addTrade(tradeRow, accountRow = null) {
  if (!tradeRow || !tradeRow.id || !tradeRow.instrument) return null

  if (accountRow) upsertAccount(accountRow)

  const entry = buildTradeEntry(tradeRow)
  const previous = _byId.get(entry.id)
  if (previous) {
    if (previous.instrument !== entry.instrument) {
      _byInstrument.get(previous.instrument)?.delete(previous.id)
    }
    // Re-indexing an existing trade (SL/TP modified, lots reduced by a partial
    // close) installs a fresh entry whose lastPnl starts at 0. Withdraw the old
    // entry's contribution first, or the account's running floating total counts
    // this position twice.
    const previousAccount = _byAccount.get(previous.accountId)
    if (previousAccount) previousAccount.floatingPnl -= previous.lastPnl
  }

  _byId.set(entry.id, entry)
  instrumentBucket(_byInstrument, entry.instrument).set(entry.id, entry)

  const account = _byAccount.get(entry.accountId)
  if (account) account.tradeIds.add(entry.id)

  return entry
}

function removeTrade(tradeId) {
  const entry = _byId.get(tradeId)
  if (!entry) return false

  _byId.delete(tradeId)
  const bucket = _byInstrument.get(entry.instrument)
  if (bucket) {
    bucket.delete(tradeId)
    if (bucket.size === 0) _byInstrument.delete(entry.instrument)
  }
  const account = _byAccount.get(entry.accountId)
  if (account) {
    account.tradeIds.delete(tradeId)
    // Withdraw this trade's contribution, or the account keeps carrying floating
    // PnL for a position it no longer holds.
    account.floatingPnl -= entry.lastPnl
    entry.lastPnl = 0
  }
  return true
}

/**
 * Record a trade's current floating PnL and roll the delta into its account.
 *
 * Storing each trade's last contribution is what keeps a tick O(trades that
 * moved) rather than O(all open trades): when EURUSD ticks, an account holding
 * both EURUSD and XAUUSD positions only needs its EURUSD legs recomputed — the
 * XAUUSD contribution is still valid and stays in the running total.
 *
 * Float drift in the running sum is bounded by the reseed that follows every
 * reconciliation, which rebuilds all totals from scratch.
 */
function applyTradePnl(entry, pnl) {
  if (!entry) return
  const account = _byAccount.get(entry.accountId)
  if (account) account.floatingPnl += pnl - entry.lastPnl
  entry.lastPnl = pnl
}

/** Zero every running total ahead of a full reseed. */
function resetFloatingPnl() {
  for (const account of _byAccount.values()) account.floatingPnl = 0
  for (const entry of _byId.values()) entry.lastPnl = 0
}

function getFloatingPnl(accountId) {
  return _byAccount.get(accountId)?.floatingPnl ?? 0
}

function addPending(orderRow, accountRow = null) {
  if (!orderRow || !orderRow.id || !orderRow.instrument) return null
  if (accountRow) upsertAccount(accountRow)

  const entry = buildPendingEntry(orderRow)
  const previous = _pendingById.get(entry.id)
  if (previous && previous.instrument !== entry.instrument) {
    _pendingByInstrument.get(previous.instrument)?.delete(previous.id)
  }

  _pendingById.set(entry.id, entry)
  instrumentBucket(_pendingByInstrument, entry.instrument).set(entry.id, entry)
  _byAccount.get(entry.accountId)?.pendingIds.add(entry.id)
  return entry
}

function removePending(orderId) {
  const entry = _pendingById.get(orderId)
  if (!entry) return false

  _pendingById.delete(orderId)
  const bucket = _pendingByInstrument.get(entry.instrument)
  if (bucket) {
    bucket.delete(orderId)
    if (bucket.size === 0) _pendingByInstrument.delete(entry.instrument)
  }
  _byAccount.get(entry.accountId)?.pendingIds.delete(orderId)
  return true
}

function upsertAccount(accountRow) {
  if (!accountRow || !accountRow.id) return null
  const entry = buildAccountEntry(accountRow)
  _byAccount.set(entry.id, entry)
  return entry
}

function removeAccount(accountId) {
  const account = _byAccount.get(accountId)
  if (!account) return false
  // Snapshot before mutating — removeTrade/removePending write back into these
  // same sets.
  for (const tradeId of Array.from(account.tradeIds)) removeTrade(tradeId)
  for (const orderId of Array.from(account.pendingIds)) removePending(orderId)
  _byAccount.delete(accountId)
  return true
}

const ACCOUNT_COLUMNS = `id, user_id, status, account_type, challenge_model_slug,
       current_balance, starting_balance, peak_balance, account_size,
       profit_target, scaling_multiplier, phase_end_date,
       eod_peak_equity, eod_trailing_floor,
       max_drawdown_pct, daily_drawdown_pct`

/**
 * Load an account into the index if it isn't there yet.
 *
 * Covers the window where an account is created between reconciliations and
 * immediately places a trade — without this its first trades would be indexed
 * against a missing account entry, so floating PnL and drawdown would not
 * aggregate for it until the next 30s pass.
 *
 * Deliberately loads the full column set rather than reusing whatever partial
 * account row the caller happens to hold: an incomplete upsert would clobber
 * drawdown limits with nulls.
 */
async function ensureAccountLoaded(accountId) {
  const existing = _byAccount.get(accountId)
  if (existing) return existing

  const result = await pool.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND status = 'active'`,
    [accountId]
  )
  if (result.rows.length === 0) return null

  const entry = upsertAccount(result.rows[0])
  await resolveDrawdownSettings(entry)
  return entry
}

function updateAccountBalance(accountId, newBalance) {
  const account = _byAccount.get(accountId)
  if (!account) return
  account.currentBalance = toNum(newBalance, account.currentBalance)
  if (account.currentBalance > account.peakBalance) {
    account.peakBalance = account.currentBalance
  }
}

/**
 * Fold a realised PnL into the cached daily total, so the daily-loss check does
 * not need a getTodayRealizedPnl query per tick. Rolls over at UTC midnight to
 * match utcDayStart().
 */
function applyRealizedPnl(accountId, pnl) {
  const account = _byAccount.get(accountId)
  if (!account) return
  const today = dayKey()
  if (account.realizedDayKey !== today) {
    account.realizedDayKey = today
    account.todayRealizedPnl = 0
  }
  account.todayRealizedPnl += toNum(pnl, 0)
}

function getTodayRealizedPnl(accountId) {
  const account = _byAccount.get(accountId)
  if (!account) return 0
  return account.realizedDayKey === dayKey() ? account.todayRealizedPnl : 0
}

function setPeakEquity(accountId, peak, lockedFloor) {
  const account = _byAccount.get(accountId)
  if (!account) return
  if (peak != null && (account.eodPeakEquity == null || peak > account.eodPeakEquity)) {
    account.eodPeakEquity = peak
  }
  if (lockedFloor != null && (account.eodTrailingFloor == null || lockedFloor > account.eodTrailingFloor)) {
    account.eodTrailingFloor = lockedFloor
  }
}

// ─── Reads (hot path) ─────────────────────────────────────────────────────────

const EMPTY = new Map()

function getTradesByInstrument(instrument) {
  return _byInstrument.get(instrument) || EMPTY
}

function getPendingByInstrument(instrument) {
  return _pendingByInstrument.get(instrument) || EMPTY
}

function getTrade(tradeId) {
  return _byId.get(tradeId) || null
}

function getAccountEntry(accountId) {
  return _byAccount.get(accountId) || null
}

function getTradeCount() {
  return _byId.size
}

function getPendingCount() {
  return _pendingById.size
}

function getAccountCount() {
  return _byAccount.size
}

function isReady() {
  return _ready
}

function getLastReconcileAt() {
  return _lastReconcileAt
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Rebuild the index from the database.
 *
 * Uses a generation stamp rather than clearing the maps first: entries seen in
 * this pass are stamped with the new generation, and anything still carrying an
 * old stamp afterwards is stale and evicted. That keeps the index continuously
 * readable — a concurrent tick never observes a half-empty index.
 *
 * @returns {Promise<{trades:number, pending:number, accounts:number, drift:number}>}
 */
async function fullReconcileFromDB() {
  const generation = ++_reconcileGeneration
  let drift = 0

  try {
    const accountsResult = await pool.query(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE status = 'active'`
    )

    for (const row of accountsResult.rows) {
      const existed = _byAccount.has(row.id)
      const entry = upsertAccount(row)
      entry.gen = generation
      if (!existed) drift++
    }

    // Funded limits come from the challenge model, not the account row.
    await Promise.all(
      accountsResult.rows.map((row) => {
        const entry = _byAccount.get(row.id)
        return entry ? resolveDrawdownSettings(entry) : null
      })
    )

    const tradesResult = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size,
              t.open_price, t.stop_loss, t.take_profit, t.commission, t.open_time
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.status = 'open' AND a.status = 'active'`
    )

    for (const account of _byAccount.values()) {
      if (account.gen !== generation) continue
      account.tradeIds.clear()
      account.pendingIds.clear()
    }

    for (const row of tradesResult.rows) {
      if (!_byId.has(row.id)) drift++
      const entry = addTrade(row)
      if (entry) entry.gen = generation
    }

    const pendingResult = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size,
              t.order_type, t.pending_price, t.oco_group_id
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.status = 'pending' AND a.status = 'active'`
    )

    for (const row of pendingResult.rows) {
      if (!_pendingById.has(row.id)) drift++
      const entry = addPending(row)
      if (entry) entry.gen = generation
    }

    // Seed the cached daily realised PnL. Only needed for accounts that are new
    // to the index or have rolled over midnight — the incremental
    // applyRealizedPnl path keeps the rest current.
    const today = dayKey()
    const needsRealized = []
    for (const account of _byAccount.values()) {
      if (account.gen !== generation) continue
      if (account.realizedDayKey !== today || account.todayRealizedPnl === 0) {
        needsRealized.push(account.id)
      }
    }
    if (needsRealized.length > 0) {
      const { getTodayRealizedPnl: fetchRealized } = require('../services/tradingDaysService')
      const realizedMap = await fetchRealized(pool, needsRealized)
      for (const accountId of needsRealized) {
        const account = _byAccount.get(accountId)
        if (!account) continue
        account.todayRealizedPnl = realizedMap.get(accountId) || 0
        account.realizedDayKey = today
      }
    }

    // Evict anything the database no longer says is open/pending/active.
    for (const [tradeId, entry] of _byId) {
      if (entry.gen !== generation) { removeTrade(tradeId); drift++ }
    }
    for (const [orderId, entry] of _pendingById) {
      if (entry.gen !== generation) { removePending(orderId); drift++ }
    }
    for (const [accountId, entry] of _byAccount) {
      if (entry.gen !== generation) { removeAccount(accountId); drift++ }
    }

    _lastReconcileAt = Date.now()
    const wasReady = _ready
    _ready = true

    const summary = {
      trades: _byId.size,
      pending: _pendingById.size,
      accounts: _byAccount.size,
      drift
    }

    // Drift on the first pass is just the initial load. After that it means an
    // incremental sync path is missing — worth surfacing rather than absorbing.
    if (wasReady && drift > 0) {
      logger.warn('[tradeIndex] reconcile corrected drift — an incremental sync path may be missing', summary)
    } else {
      logger.info('[tradeIndex] reconciled', summary)
    }

    return summary
  } catch (error) {
    logger.error('[tradeIndex] reconcile failed:', { error: error.message })
    throw error
  }
}

function invalidateFundedModelCache(slug = null) {
  if (slug) _fundedModelCache.delete(slug)
  else _fundedModelCache.clear()
}

/** Test seam — lets tests arm the event path without a database round-trip. */
function __setReadyForTest(ready = true) {
  _ready = ready
}

function __reset() {
  _byInstrument.clear()
  _byId.clear()
  _byAccount.clear()
  _pendingByInstrument.clear()
  _pendingById.clear()
  _fundedModelCache.clear()
  _reconcileGeneration = 0
  _lastReconcileAt = 0
  _ready = false
}

module.exports = {
  addTrade,
  removeTrade,
  addPending,
  removePending,
  upsertAccount,
  removeAccount,
  ensureAccountLoaded,
  updateAccountBalance,
  applyTradePnl,
  resetFloatingPnl,
  getFloatingPnl,
  applyRealizedPnl,
  getTodayRealizedPnl,
  setPeakEquity,
  getTradesByInstrument,
  getPendingByInstrument,
  getTrade,
  getAccountEntry,
  getTradeCount,
  getPendingCount,
  getAccountCount,
  isReady,
  getLastReconcileAt,
  fullReconcileFromDB,
  resolveDrawdownSettings,
  invalidateFundedModelCache,
  buildTradeEntry,
  buildAccountEntry,
  __setReadyForTest,
  __reset
}
