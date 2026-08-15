'use strict'
/**
 * In-memory price cache
 * ─────────────────────────────────────────────────────────────────────────────
 * Holds the most recent tick so the trade engine never reads prices from the
 * database on the hot path. Previously each engine pass called getLivePriceMap()
 * — a `SELECT * FROM price_feed` — three times a second between the three
 * interval loops.
 *
 * ── The prices stored here are TENANT-ADJUSTED, not raw. ──
 *
 * This matters more than it looks. Trades are evaluated against the marked-up
 * map returned by getCurrentPricesForTenant(): the tenant's spread markup is
 * added to the ask. Caching the raw feed instead would make every SL/TP and
 * pending order fire at a level the trader was never quoted.
 *
 * Routing between the shared feed and a tenant's dedicated feed is left to
 * getCurrentPricesForTenant(), which already handles it. The tenant feed config
 * and spread settings it consults are both TTL-cached in tenantPolicyService, so
 * the per-tick cost is a couple of map walks in the common (shared-feed) case.
 */

const logger = require('./logger')

const STALE_AFTER_MS = 5000

let _prices = Object.create(null)
let _lastUpdateAt = 0
let _lastChanged = []

// Resolved lazily to avoid a require cycle: priceFeed.js pulls in db.js, which
// several callers of this module are already inside the require path of.
let _getCurrentPricesForTenant = null
function tenantPriceResolver() {
  if (!_getCurrentPricesForTenant) {
    _getCurrentPricesForTenant = require('../priceFeed').getCurrentPricesForTenant
  }
  return _getCurrentPricesForTenant
}

/**
 * Which instruments actually moved between two tenant-adjusted maps.
 *
 * This replaces the old JSON.stringify hash comparison in priceBroadcast.js. It
 * gives the same "don't re-broadcast identical data" guarantee, but per
 * instrument and without serialising the whole map on every tick — and the
 * result is what lets the engine scan only the trades that could have changed.
 */
function diffInstruments(prev, next) {
  const changed = []
  for (const instrument in next) {
    const before = prev[instrument]
    const after = next[instrument]
    if (!after) continue
    if (!before || before.bid !== after.bid || before.ask !== after.ask) {
      changed.push(instrument)
    }
  }
  return changed
}

/**
 * Ingest a tick. Applies tenant markup, diffs against the previous state, and
 * stores the result.
 *
 * @param {object|null} basePrices Raw shared-feed prices, when the caller
 *   already has them (the watcher does). Ignored when the tenant is on a
 *   dedicated feed, where getCurrentPricesForTenant reads that source instead.
 * @returns {Promise<string[]>} instruments whose bid or ask moved
 */
async function updatePrices(basePrices = null) {
  try {
    const next = await tenantPriceResolver()(basePrices)
    if (!next || typeof next !== 'object') return []

    _lastChanged = diffInstruments(_prices, next)
    _prices = next
    _lastUpdateAt = Date.now()
    return _lastChanged
  } catch (error) {
    logger.error('[priceCache] updatePrices failed:', { error: error.message })
    return []
  }
}

function getAllPrices() {
  return _prices
}

function getPrice(instrument) {
  return _prices[instrument] || null
}

function getChangedInstruments() {
  return _lastChanged
}

/** Milliseconds since the last tick, or null if the cache has never been filled. */
function getPriceCacheAgeMs() {
  return _lastUpdateAt === 0 ? null : Date.now() - _lastUpdateAt
}

function isStale() {
  // Never-filled counts as stale. Checked explicitly because the null age would
  // otherwise compare false against the threshold and read as fresh.
  if (_lastUpdateAt === 0) return true
  return (Date.now() - _lastUpdateAt) > STALE_AFTER_MS
}

function hasPrices() {
  // _prices is a null-prototype object, so Object.keys is safe and cheap here —
  // it is only consulted on the cold/stale path, not per tick.
  return Object.keys(_prices).length > 0
}

/** Test seam — lets tests drive the engine without a live feed. */
function __setPricesForTest(prices) {
  _lastChanged = diffInstruments(_prices, prices)
  _prices = prices
  _lastUpdateAt = Date.now()
  return _lastChanged
}

function __reset() {
  _prices = Object.create(null)
  _lastUpdateAt = 0
  _lastChanged = []
}

module.exports = {
  STALE_AFTER_MS,
  updatePrices,
  getAllPrices,
  getPrice,
  getChangedInstruments,
  getPriceCacheAgeMs,
  isStale,
  hasPrices,
  diffInstruments,
  __setPricesForTest,
  __reset
}
