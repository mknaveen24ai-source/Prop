/**
 * Quote-currency → USD conversion rates
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixes audit finding C-01.
 *
 * calculatePnL() computes `priceDiff × lots × contractSize`. That product is
 * denominated in the instrument's QUOTE currency, not USD — USDJPY pays in JPY,
 * JP225 in JPY, DE40 in EUR, HK50 in HKD. Booking it straight into a USD balance
 * was wrong for 31 of the 45 instruments, by ~150× on the JPY pairs.
 *
 * This module supplies the missing multiplier: how many USD one unit of a given
 * quote currency is worth.
 *
 * ── Where the rates come from ──
 *
 * Every rate needed is already a subscribed instrument, so no new feed symbol is
 * required:
 *
 *     JPY  ← USDJPY   (inverted)      GBP  ← GBPUSD
 *     CHF  ← USDCHF   (inverted)      AUD  ← AUDUSD
 *     CAD  ← USDCAD   (inverted)      NZD  ← NZDUSD
 *                                     EUR  ← EURUSD
 *
 * HKD is the exception: there is no USDHKD pair in the catalogue. HKD is pegged
 * to USD inside a 7.75–7.85 band, so it uses a configured constant
 * (HKD_USD_PEGGED_RATE, default 7.80). Worst case inside the band that is ~0.6%
 * off, against the ~680% error it replaces.
 *
 * ── Why the bid, and not the mid ──
 *
 * priceCache holds TENANT-ADJUSTED prices, and applyTenantMarkupToPriceRow()
 * (priceFeed.js) adds the tenant's spread markup to the ASK only — the bid is
 * the untouched feed price. Using the mid would fold a tenant's configured
 * markup into a conversion rate, which is not a price the tenant is quoting; the
 * bid keeps the rate raw and identical across tenants.
 *
 * ── Synchronous on purpose ──
 *
 * calculatePnL and fastPnL are both called from the engine's hot loop, and
 * fastPnL runs per trade. priceCache.getPrice() is an in-memory lookup, so this
 * stays synchronous and callers keep their existing signatures.
 *
 * ── Fails closed ──
 *
 * A missing or nonsensical rate throws FxRateUnavailableError rather than
 * defaulting to 1. Defaulting to 1 is exactly the bug this module exists to fix.
 */

import * as priceCache from './priceCache'

interface InstrumentConfig {
  quoteCurrency?: string
}

interface InstrumentsApi {
  getInstrumentConfig: (instrument: string) => InstrumentConfig | null | undefined
  isFxConversionEnabled: () => boolean
}

const { getInstrumentConfig, isFxConversionEnabled } = require('../instruments') as InstrumentsApi

const DEFAULT_HKD_USD_PEGGED_RATE = 7.8

/**
 * How to derive USD-per-unit for each quote currency.
 *   invert: false → the pair is QUOTE/USD, so its price IS the rate (GBPUSD)
 *   invert: true  → the pair is USD/QUOTE, so the rate is 1 / price (USDJPY)
 */
interface IdentityRateSource {
  identity: true
}

interface PairRateSource {
  pair: string
  invert: boolean
}

interface PeggedRateSource {
  pegged: string
  fallback: number
  invert: boolean
}

type RateSource = IdentityRateSource | PairRateSource | PeggedRateSource

interface RateSnapshotEntry {
  rate: number | null
  available: boolean
  reason?: string
}

const RATE_SOURCES: Readonly<Record<string, RateSource>> = Object.freeze({
  USD: { identity: true },
  JPY: { pair: 'USDJPY', invert: true },
  CHF: { pair: 'USDCHF', invert: true },
  CAD: { pair: 'USDCAD', invert: true },
  GBP: { pair: 'GBPUSD', invert: false },
  AUD: { pair: 'AUDUSD', invert: false },
  NZD: { pair: 'NZDUSD', invert: false },
  EUR: { pair: 'EURUSD', invert: false },
  HKD: { pegged: 'HKD_USD_PEGGED_RATE', fallback: DEFAULT_HKD_USD_PEGGED_RATE, invert: true }
})

class FxRateUnavailableError extends Error {
  override name = 'FxRateUnavailableError'
  readonly code = 'FX_RATE_UNAVAILABLE'
  readonly currency: string

  constructor(currency: string, reason: string) {
    super(`No USD conversion rate available for ${currency}: ${reason}`)
    this.currency = currency
  }
}

function normalizeCurrency(currency: unknown): string {
  return String(currency || '').trim().toUpperCase()
}

function readPeggedRate(source: PeggedRateSource, currency: string): number {
  const raw = process.env[source.pegged]
  const parsed = raw == null || String(raw).trim() === '' ? source.fallback : parseFloat(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new FxRateUnavailableError(currency, `${source.pegged} is not a positive number`)
  }
  return source.invert ? 1 / parsed : parsed
}

/**
 * USD value of one unit of `currency`.
 *
 * @param {string} currency  ISO code, e.g. 'JPY'
 * @returns {number} strictly positive multiplier; 1 for USD
 * @throws {FxRateUnavailableError} when no usable rate exists
 */
function getUsdRate(currency: unknown): number {
  const normalized = normalizeCurrency(currency)
  const source = RATE_SOURCES[normalized]

  if (!source) {
    throw new FxRateUnavailableError(normalized || '(empty)', 'no rate source is configured')
  }
  if ('identity' in source) return 1
  if ('pegged' in source) return readPeggedRate(source, normalized)

  const price = priceCache.getPrice(source.pair)
  if (!price) {
    throw new FxRateUnavailableError(normalized, `${source.pair} is not in the price cache`)
  }

  // Bid only — see the "Why the bid" note above.
  const bid = Number(price.bid)
  if (!Number.isFinite(bid) || bid <= 0) {
    throw new FxRateUnavailableError(normalized, `${source.pair} bid is ${price.bid}`)
  }

  return source.invert ? 1 / bid : bid
}

/**
 * USD value of one unit of the currency `instrument` settles in — the
 * multiplier PnL must be scaled by.
 *
 * ── Grandfathering ──
 *
 * Returns 1 for every instrument while FX_CONVERSION_ENABLED is false, which
 * reproduces the pre-fix behaviour exactly. That is deliberate: positions
 * opened under the old maths must not be revalued underneath the trader,
 * and it means turning this module on is a single flag rather than a
 * behavioural change that ships with the code.
 *
 * The cutover is therefore an operation, not a deploy. Run
 * `node scripts/verify-fx-cutover.js` first — it refuses the flag while any
 * position opened under the old maths is still open, which is the only window
 * in which "grandfathered" and "correct" could disagree.
 *
 * Instruments the catalogue does not know about fall back to USD, matching
 * CONTRACT_SIZES' behaviour; an unknown symbol cannot reach a trade path
 * anyway, since VALID_INSTRUMENTS gates entry.
 */
function getUsdRateForInstrument(instrument: string): number {
  if (!isFxConversionEnabled()) return 1
  const config = getInstrumentConfig(instrument)
  return getUsdRate(config?.quoteCurrency || 'USD')
}

/** True when `instrument` needs no conversion — the common, cheap case. */
function isUsdQuoted(instrument: string): boolean {
  const config = getInstrumentConfig(instrument)
  return (config?.quoteCurrency || 'USD') === 'USD'
}

/**
 * Every quote currency the catalogue uses, with its current rate or the reason
 * it is unavailable. Powers the /api/price-status readiness probe, so an
 * operator can see a rate source has gone dark before it blocks trades.
 */
function getRateSnapshot(): Record<string, RateSnapshotEntry> {
  const snapshot: Record<string, RateSnapshotEntry> = {}
  for (const currency of Object.keys(RATE_SOURCES)) {
    try {
      snapshot[currency] = { rate: getUsdRate(currency), available: true }
    } catch (error: unknown) {
      snapshot[currency] = {
        rate: null,
        available: false,
        reason: error instanceof Error ? error.message : String(error)
      }
    }
  }
  return snapshot
}

export {
  DEFAULT_HKD_USD_PEGGED_RATE,
  FxRateUnavailableError,
  RATE_SOURCES,
  getRateSnapshot,
  getUsdRate,
  getUsdRateForInstrument,
  isUsdQuoted
}
