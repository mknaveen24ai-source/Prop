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

import { z } from 'zod'
import logger = require('./logger')
import type * as PriceFeedApi from '../priceFeed'
import { parseExternal } from '../validation/unknown'

const cachedPriceSchema = z.object({
  bid: z.number().finite(),
  ask: z.number().finite()
}).passthrough()
const priceMapSchema = z.record(z.string(), cachedPriceSchema.nullable())

type CachedPrice = z.infer<typeof cachedPriceSchema>
type PriceMap = z.infer<typeof priceMapSchema>
type TenantPriceResolver = (basePrices?: unknown) => Promise<unknown>

function emptyPriceMap(): PriceMap {
  return Object.create(null) as PriceMap
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

const STALE_AFTER_MS = 5000

let prices: PriceMap = emptyPriceMap()
let _lastUpdateAt = 0
let _lastChanged: string[] = []

// Resolved lazily to avoid a require cycle: priceFeed.js pulls in db.js, which
// several callers of this module are already inside the require path of.
let getCurrentPricesForTenant: TenantPriceResolver | null = null
function tenantPriceResolver(): TenantPriceResolver {
  if (!getCurrentPricesForTenant) {
    const priceFeed = require('../priceFeed') as typeof PriceFeedApi
    getCurrentPricesForTenant = priceFeed.getCurrentPricesForTenant as TenantPriceResolver
  }
  return getCurrentPricesForTenant
}

/**
 * Which instruments actually moved between two tenant-adjusted maps.
 *
 * This replaces the old JSON.stringify hash comparison in priceBroadcast.js. It
 * gives the same "don't re-broadcast identical data" guarantee, but per
 * instrument and without serialising the whole map on every tick — and the
 * result is what lets the engine scan only the trades that could have changed.
 */
function diffInstruments(prev: PriceMap, next: PriceMap): string[] {
  const changed: string[] = []
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
async function updatePrices(basePrices: unknown = null): Promise<string[]> {
  try {
    const rawNext: unknown = await tenantPriceResolver()(basePrices)
    const next = parseExternal(priceMapSchema, rawNext, 'tenant-adjusted price map')

    _lastChanged = diffInstruments(prices, next)
    prices = next
    _lastUpdateAt = Date.now()
    return _lastChanged
  } catch (error: unknown) {
    logger.error('[priceCache] updatePrices failed:', { error: errorMessage(error) })
    return []
  }
}

function getAllPrices(): PriceMap {
  return prices
}

function getPrice(instrument: unknown): CachedPrice | null {
  return prices[String(instrument)] || null
}

function getChangedInstruments(): string[] {
  return _lastChanged
}

/** Milliseconds since the last tick, or null if the cache has never been filled. */
function getPriceCacheAgeMs(): number | null {
  return _lastUpdateAt === 0 ? null : Date.now() - _lastUpdateAt
}

function isStale(): boolean {
  // Never-filled counts as stale. Checked explicitly because the null age would
  // otherwise compare false against the threshold and read as fresh.
  if (_lastUpdateAt === 0) return true
  return (Date.now() - _lastUpdateAt) > STALE_AFTER_MS
}

function hasPrices(): boolean {
  // _prices is a null-prototype object, so Object.keys is safe and cheap here —
  // it is only consulted on the cold/stale path, not per tick.
  return Object.keys(prices).length > 0
}

/** Test seam — lets tests drive the engine without a live feed. */
function __setPricesForTest(input: unknown): string[] {
  const next = parseExternal(priceMapSchema, input, 'test price map')
  _lastChanged = diffInstruments(prices, next)
  prices = next
  _lastUpdateAt = Date.now()
  return _lastChanged
}

function __reset(): void {
  prices = emptyPriceMap()
  _lastUpdateAt = 0
  _lastChanged = []
}

export {
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
