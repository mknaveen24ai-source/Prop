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

import type { Pool, QueryResultRow } from 'pg'
import pool = require('../db')
import logger = require('./logger')

type DirectionSign = 1 | -1
type NumericInput = string | number | null | undefined

interface FastPnlApi {
  directionSign: (direction: string) => DirectionSign
  contractSizeFor: (instrument: string) => number
}

interface FundedModelRow {
  funded_max_drawdown_pct: NumericInput
  funded_daily_drawdown_pct: NumericInput
  funded_drawdown_locks_at_pct: NumericInput
}

interface StepModelsApi {
  fetchStepModelBySlug: (slug: string) => Promise<FundedModelRow | null>
}

interface TradingDaysApi {
  utcDayStart: (date?: Date) => Date
  getTodayRealizedPnl: (database: Pool, accountIds: string[]) => Promise<Map<string, number>>
}

const { directionSign, contractSizeFor } = require('./fastPnL') as FastPnlApi
const { fetchStepModelBySlug } = require('./stepModels') as StepModelsApi
const { utcDayStart } = require('../services/tradingDaysService') as TradingDaysApi

interface TradeIndexRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: NumericInput
  open_price: NumericInput
  stop_loss: NumericInput
  take_profit: NumericInput
  commission: NumericInput
  open_time: Date | string | null | undefined
  pending_close_price?: NumericInput
  pending_close_reason?: string | null
}

interface PendingIndexRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  order_type: string
  pending_price: NumericInput
  lot_size: NumericInput
  oco_group_id: string | null | undefined
}

interface AccountIndexRow extends QueryResultRow {
  id: string
  user_id: string | null
  status: string | null
  account_type: string
  challenge_model_slug: string | null
  current_balance: NumericInput
  starting_balance: NumericInput
  peak_balance: NumericInput
  account_size: NumericInput
  profit_target: NumericInput
  scaling_multiplier: NumericInput
  phase_end_date: Date | string | null
  eod_peak_equity: NumericInput
  eod_trailing_floor: NumericInput
  max_drawdown_pct: NumericInput
  daily_drawdown_pct: NumericInput
}

interface TradeEntry {
  id: string
  accountId: string
  instrument: string
  sign: DirectionSign
  direction: string
  openPrice: number
  lots: number
  commission: number
  stopLoss: number | null
  takeProfit: number | null
  pendingClosePrice: number | null
  pendingCloseReason: string | null
  openTimeMs: number
  contractSize: number
  lastPnl: number
  gen: number
}

interface PendingEntry {
  id: string
  accountId: string
  instrument: string
  direction: string
  orderType: string
  triggerPrice: number | null
  lots: number
  ocoGroupId: string | null
  gen: number
}

interface AccountEntry {
  id: string
  userId: string | null
  status: string | null
  accountType: string
  challengeModelSlug: string | null
  currentBalance: number
  startingBalance: number
  peakBalance: number
  accountSize: number
  profitTarget: number
  scalingMultiplier: number
  phaseEndDate: number | null
  eodPeakEquity: number | null
  eodTrailingFloor: number | null
  maxDrawdownPct: number | null
  dailyDrawdownPct: number | null
  drawdownLocksAtPct: number | null
  todayRealizedPnl: number
  realizedDayKey: number
  floatingPnl: number
  tradeIds: Set<string>
  pendingIds: Set<string>
  gen: number
}

interface DrawdownSettings {
  maxDrawdownPct: number | null
  dailyDrawdownPct: number | null
  drawdownLocksAtPct: number | null
}

interface ReconcileSummary {
  trades: number
  pending: number
  accounts: number
  drift: number
}

// ─── State ────────────────────────────────────────────────────────────────────
const _byInstrument = new Map<string, Map<string, TradeEntry>>()
const _byId = new Map<string, TradeEntry>()
const _byAccount = new Map<string, AccountEntry>()
const _pendingByInstrument = new Map<string, Map<string, PendingEntry>>()
const _pendingById = new Map<string, PendingEntry>()

// challenge_model_slug → { maxDrawdownPct, dailyDrawdownPct, drawdownLocksAtPct }
// Funded accounts take their drawdown limits from their challenge model rather
// than the account row. checkFloatingDrawdown resolved this per tick with a
// per-slug cache that died with each pass; here it persists.
const _fundedModelCache = new Map<string, DrawdownSettings | null>()

let _reconcileGeneration = 0
let _lastReconcileAt = 0
let _ready = false

function toNum<Fallback extends number | null = null>(
  value: NumericInput,
  fallback: Fallback = null as Fallback
): number | Fallback {
  if (value == null) return fallback
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

function dayKey(date: Date = new Date()): number {
  return utcDayStart(date).getTime()
}

// ─── Entry construction ───────────────────────────────────────────────────────

/**
 * @param {object} row  A trades row joined to nothing in particular — needs
 *   id, account_id, instrument, direction, lot_size, open_price, stop_loss,
 *   take_profit, commission, open_time.
 */
function buildTradeEntry(row: TradeIndexRow): TradeEntry {
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
    // A stop/take level crossed inside the minimum-hold window, recorded so it
    // can be filled AT THE LEVEL once the window expires (migration 044).
    // Carried on the entry so the event path can fire it on the next tick
    // rather than waiting for the interval fallback to notice.
    pendingClosePrice: toNum(row.pending_close_price),
    pendingCloseReason: row.pending_close_reason || null,
    openTimeMs: row.open_time ? new Date(row.open_time).getTime() : Date.now(),
    contractSize: contractSizeFor(instrument),
    // This trade's last computed contribution to its account's floating PnL.
    // See applyTradePnl for why it is stored rather than re-summed.
    lastPnl: 0,
    gen: _reconcileGeneration
  }
}

function buildPendingEntry(row: PendingIndexRow): PendingEntry {
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

function buildAccountEntry(row: AccountIndexRow): AccountEntry {
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
async function resolveDrawdownSettings(entry: AccountEntry): Promise<void> {
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
    } catch (error: unknown) {
      logger.error('[tradeIndex] funded model lookup failed:', {
        slug: entry.challengeModelSlug,
        error: error instanceof Error ? error.message : String(error)
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

function instrumentBucket<Entry>(
  map: Map<string, Map<string, Entry>>,
  instrument: string
): Map<string, Entry> {
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
function addTrade(
  tradeRow: TradeIndexRow | null | undefined,
  accountRow: AccountIndexRow | null = null
): TradeEntry | null {
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

function removeTrade(tradeId: string): boolean {
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
function applyTradePnl(entry: TradeEntry | null | undefined, pnl: number): void {
  if (!entry) return
  const account = _byAccount.get(entry.accountId)
  if (account) account.floatingPnl += pnl - entry.lastPnl
  entry.lastPnl = pnl
}

/** Zero every running total ahead of a full reseed. */
function resetFloatingPnl(): void {
  for (const account of _byAccount.values()) account.floatingPnl = 0
  for (const entry of _byId.values()) entry.lastPnl = 0
}

function getFloatingPnl(accountId: string): number {
  return _byAccount.get(accountId)?.floatingPnl ?? 0
}

function addPending(
  orderRow: PendingIndexRow | null | undefined,
  accountRow: AccountIndexRow | null = null
): PendingEntry | null {
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

function removePending(orderId: string): boolean {
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

function upsertAccount(accountRow: AccountIndexRow | null | undefined): AccountEntry | null {
  if (!accountRow || !accountRow.id) return null
  const entry = buildAccountEntry(accountRow)
  _byAccount.set(entry.id, entry)
  return entry
}

function removeAccount(accountId: string): boolean {
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
async function ensureAccountLoaded(accountId: string): Promise<AccountEntry | null> {
  const existing = _byAccount.get(accountId)
  if (existing) return existing

  const result = await pool.query<AccountIndexRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND status = 'active'`,
    [accountId]
  )
  const row = result.rows[0]
  if (!row) return null

  const entry = upsertAccount(row)
  if (!entry) return null
  await resolveDrawdownSettings(entry)
  return entry
}

function updateAccountBalance(accountId: string, newBalance: NumericInput): void {
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
function applyRealizedPnl(accountId: string, pnl: NumericInput): void {
  const account = _byAccount.get(accountId)
  if (!account) return
  const today = dayKey()
  if (account.realizedDayKey !== today) {
    account.realizedDayKey = today
    account.todayRealizedPnl = 0
  }
  account.todayRealizedPnl += toNum(pnl, 0)
}

function getTodayRealizedPnl(accountId: string): number {
  const account = _byAccount.get(accountId)
  if (!account) return 0
  return account.realizedDayKey === dayKey() ? account.todayRealizedPnl : 0
}

function setPeakEquity(accountId: string, peak: number | null, lockedFloor: number | null): void {
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

const EMPTY_TRADES = new Map<string, TradeEntry>()
const EMPTY_PENDING = new Map<string, PendingEntry>()

function getTradesByInstrument(instrument: string): ReadonlyMap<string, TradeEntry> {
  return _byInstrument.get(instrument) || EMPTY_TRADES
}

function getPendingByInstrument(instrument: string): ReadonlyMap<string, PendingEntry> {
  return _pendingByInstrument.get(instrument) || EMPTY_PENDING
}

function getTrade(tradeId: string): TradeEntry | null {
  return _byId.get(tradeId) || null
}

function getAccountEntry(accountId: string): AccountEntry | null {
  return _byAccount.get(accountId) || null
}

function getTradeCount(): number {
  return _byId.size
}

function getPendingCount(): number {
  return _pendingById.size
}

function getAccountCount(): number {
  return _byAccount.size
}

function isReady(): boolean {
  return _ready
}

function getLastReconcileAt(): number {
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
async function fullReconcileFromDB(): Promise<ReconcileSummary> {
  const generation = ++_reconcileGeneration
  let drift = 0

  try {
    const accountsResult = await pool.query<AccountIndexRow>(
      `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE status = 'active'`
    )

    for (const row of accountsResult.rows) {
      const existed = _byAccount.has(row.id)
      const entry = upsertAccount(row)
      if (!entry) continue
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

    const tradesResult = await pool.query<TradeIndexRow>(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size,
              t.open_price, t.stop_loss, t.take_profit, t.commission, t.open_time,
              t.pending_close_price, t.pending_close_reason
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

    const pendingResult = await pool.query<PendingIndexRow>(
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
    const needsRealized: string[] = []
    for (const account of _byAccount.values()) {
      if (account.gen !== generation) continue
      if (account.realizedDayKey !== today || account.todayRealizedPnl === 0) {
        needsRealized.push(account.id)
      }
    }
    if (needsRealized.length > 0) {
      const { getTodayRealizedPnl: fetchRealized } = require('../services/tradingDaysService') as TradingDaysApi
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
  } catch (error: unknown) {
    logger.error('[tradeIndex] reconcile failed:', {
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

function invalidateFundedModelCache(slug: string | null = null): void {
  if (slug) _fundedModelCache.delete(slug)
  else _fundedModelCache.clear()
}

/** Test seam — lets tests arm the event path without a database round-trip. */
function __setReadyForTest(ready = true): void {
  _ready = ready
}

function __reset(): void {
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

export {
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

export type {
  AccountEntry,
  AccountIndexRow,
  PendingEntry,
  PendingIndexRow,
  ReconcileSummary,
  TradeEntry,
  TradeIndexRow
}
