'use strict'
/**
 * Shared trading primitives
 * ─────────────────────────────────────────────────────────────────────────────
 * Helpers that both the HTTP layer (routes/trades.js) and the background engine
 * (services/tradeEngine.js) need.
 *
 * They live here rather than in either caller so the engine can be extracted out
 * of the route file without the two ending up requiring each other. Everything
 * in this module is either pure or reads cached/DB state — nothing here mutates
 * trades or accounts.
 *
 * routes/trades.js re-exports several of these under their original names, so
 * existing importers (weekendCloseService, competitionEngine, admin routes,
 * tests) keep working unchanged.
 */

const fs = require('fs')
const path = require('path')
const Decimal = require('decimal.js')
const pool = require('../db')
const logger = require('../utils/logger')
const priceCache = require('../utils/priceCache')
const { getTenantSettings } = require('./tenantPolicyService')
const { getCurrentPrices, getCurrentPricesForTenant, getPriceForTenant } = require('../priceFeed')
const {
  CONTRACT_SIZES,
  LEVERAGE,
  INSTRUMENTS
} = require('../constants')

// ─────────────────────────────────────────────────────────────────────────────
// Leverage: 1:30 on forex (EURUSD, GBPUSD), 1:10 on commodities (XAUUSD, XAGUSD)
// These values must NOT be changed without also reviewing margin checks.
// ─────────────────────────────────────────────────────────────────────────────
const VALID_INSTRUMENTS = INSTRUMENTS

// ─────────────────────────────────────────────────────────────────────────────
// Combined exposure limits per $1,000 of account size
//   Forex (all supported forex pairs combined):        0.10 lots per $1k
//   Commodities (XAUUSD + XAGUSD combined):            0.02 lots per $1k
// ─────────────────────────────────────────────────────────────────────────────
const FOREX_LOTS_PER_1K     = 0.10
const COMMODITY_LOTS_PER_1K = 0.02
// Flat cap, not scaled by account size (spec: "Max 10 open positions at once").
const MAX_OPEN_POSITIONS = 10

const TRADE_JOURNAL_UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads', 'trade-journal')

// ── Load admin-configurable trading rules from platform_settings ─────────────
// Falls back to hardcoded defaults if a setting hasn't been configured yet.
// Cached for 30s to avoid a DB hit on every single trade open.
let _tradingRulesCache = null
const TRADING_RULES_TTL = 30 * 1000 // 30 seconds
const TRADING_RULE_KEYS = [
  'min_hold_seconds',
  'forex_lots_per_1k',
  'commodity_lots_per_1k',
  'min_lot_size',
  'max_trades_per_1k',
  'max_open_positions',
  'dynamic_commission_per_lot',
  'commission_per_lot_json',
  'slippage_simulator_enabled',
  'slippage_max_pips_adverse',
  'slippage_max_pips_adverse_json',
  'weekend_holding_enabled',
  'max_daily_trades'
]
/**
 * Numeric setting resolver that treats NaN as "absent" — see the FIX (H-06)
 * note in getTradingRules(). `??` alone is not enough here because
 * parseFloat() of a malformed value yields NaN, which `??` happily passes
 * straight through into a risk-limit comparison.
 */
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

const DEFAULT_TRADING_RULES = {
  minHoldSeconds: 60,
  forexLotsPer1k: FOREX_LOTS_PER_1K,
  commodityLotsPer1k: COMMODITY_LOTS_PER_1K,
  minLotSize: 0.01,
  maxTradesPer1k: 1,
  maxOpenPositions: MAX_OPEN_POSITIONS,
  maxDailyTrades: 20,
  dynamicCommissionPerLot: 3.0,
  slippageSimulatorEnabled: false,
  slippageMaxPipsAdverse: 0,
  weekendHoldingEnabled: true,
}

const tradeFeatureInfraPromise = { current: null }

async function ensureTradeExperienceInfrastructure() {
  if (tradeFeatureInfraPromise.current) {
    return tradeFeatureInfraPromise.current
  }

  tradeFeatureInfraPromise.current = (async () => {
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS open_screenshot_path TEXT`)
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS close_screenshot_path TEXT`)
    await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS oco_group_id TEXT`)
    await pool.query(`CREATE INDEX IF NOT EXISTS trades_oco_group_idx ON trades(oco_group_id) WHERE oco_group_id IS NOT NULL`)
    await fs.promises.mkdir(TRADE_JOURNAL_UPLOAD_ROOT, { recursive: true })
  })().catch((error) => {
    tradeFeatureInfraPromise.current = null
    throw error
  })

  return tradeFeatureInfraPromise.current
}

// R-multiple = realized P&L expressed as a multiple of the dollar risk the
// stop-loss defined at entry. Computed on read (no migration, no backfill
// problem) — trades placed without a stop-loss have no defined risk unit,
// so they get r_multiple: null rather than a fabricated one; a muted "—"
// in the UI is itself useful risk-discipline signal, not a gap to paper over.
function computeRMultiple(trade) {
  const stopLoss = parseFloat(trade.stop_loss)
  const openPrice = parseFloat(trade.open_price)
  const lots = parseFloat(trade.lot_size)
  const pnl = parseFloat(trade.demo_pnl)
  if (!Number.isFinite(stopLoss) || !Number.isFinite(openPrice) || !Number.isFinite(lots) || !Number.isFinite(pnl)) return null
  const contractSize = CONTRACT_SIZES[trade.instrument]
  if (!contractSize) return null
  const riskAmount = Math.abs(openPrice - stopLoss) * lots * contractSize
  if (riskAmount <= 0) return null
  return parseFloat((pnl / riskAmount).toFixed(2))
}

async function getTradingRules() {
  if (_tradingRulesCache && (Date.now() - _tradingRulesCache.cachedAt) < TRADING_RULES_TTL) {
    return _tradingRulesCache.value
  }
  try {
    const settings = await getTenantSettings(TRADING_RULE_KEYS)
    // FIX (BUG-2): parseFloat('true') === NaN, so every boolean flag was always falsy.
    // Parse each value with the correct type: booleans use strict string comparison,
    // numerics continue to use parseFloat.
    const BOOL_KEYS = new Set(['slippage_simulator_enabled', 'weekend_holding_enabled'])
    const JSON_KEYS = new Set(['commission_per_lot_json', 'slippage_max_pips_adverse_json'])
    const parsed = {}
    for (const [key, value] of Object.entries(settings)) {
      if (JSON_KEYS.has(key)) {
        parsed[key] = value
      } else {
        parsed[key] = BOOL_KEYS.has(key)
          ? (value === 'true' || value === true)
          : parseFloat(value)
      }
    }
    // FIX (H-06): every numeric rule used `parsed.x ?? DEFAULT`, and `??` only
    // falls back on null/undefined — never on NaN. A single non-numeric row in
    // platform_settings therefore produced NaN, and every downstream
    // comparison against NaN is false:
    //
    //   secondsOpen < NaN                  → minimum hold time not enforced
    //   (currentLots + lots) > NaN         → lot exposure cap removed
    //   currentOpenCount >= NaN            → unlimited open positions
    //
    // i.e. a typo in one admin setting silently disabled the risk caps rather
    // than falling back to them. slippageMaxPipsAdverse below already guarded
    // correctly with Number.isFinite; this extends the same guard to the rest.
    const resolved = {
      minHoldSeconds: finiteOr(parsed.min_hold_seconds, DEFAULT_TRADING_RULES.minHoldSeconds),
      forexLotsPer1k: finiteOr(parsed.forex_lots_per_1k, DEFAULT_TRADING_RULES.forexLotsPer1k),
      commodityLotsPer1k: finiteOr(parsed.commodity_lots_per_1k, DEFAULT_TRADING_RULES.commodityLotsPer1k),
      minLotSize: finiteOr(parsed.min_lot_size, DEFAULT_TRADING_RULES.minLotSize),
      maxTradesPer1k: finiteOr(parsed.max_trades_per_1k, DEFAULT_TRADING_RULES.maxTradesPer1k),
      maxOpenPositions: finiteOr(parsed.max_open_positions, DEFAULT_TRADING_RULES.maxOpenPositions),
      maxDailyTrades: finiteOr(parsed.max_daily_trades, DEFAULT_TRADING_RULES.maxDailyTrades),
      dynamicCommissionPerLot: finiteOr(parsed.dynamic_commission_per_lot, DEFAULT_TRADING_RULES.dynamicCommissionPerLot),
      commissionPerLotJson: parsed.commission_per_lot_json ?? '{}',
      slippageSimulatorEnabled: parsed.slippage_simulator_enabled ?? DEFAULT_TRADING_RULES.slippageSimulatorEnabled,
      slippageMaxPipsAdverse: finiteOr(parsed.slippage_max_pips_adverse, DEFAULT_TRADING_RULES.slippageMaxPipsAdverse),
      slippageMaxPipsAdverseJson: parsed.slippage_max_pips_adverse_json ?? '{}',
      weekendHoldingEnabled: parsed.weekend_holding_enabled ?? DEFAULT_TRADING_RULES.weekendHoldingEnabled,
    }
    _tradingRulesCache = { value: resolved, cachedAt: Date.now() }
    return resolved
  } catch {
    // If DB read fails, return safe defaults
    return DEFAULT_TRADING_RULES
  }
}

function invalidateTradingRulesCache() {
  _tradingRulesCache = null
}

// ─── Prices ───────────────────────────────────────────────────────────────────

/**
 * The tenant-adjusted price map the engine and routes trade against.
 *
 * Reads from the in-memory cache when it is fresh, which on the event-driven
 * path is every time — the watcher populates it on each tick. The DB round-trip
 * only happens on a cold start or if the feed has gone quiet, which is also
 * exactly when the extra freshness is worth paying for.
 */
async function getLivePriceMap() {
  if (!priceCache.isStale() && priceCache.hasPrices()) {
    return priceCache.getAllPrices()
  }
  const basePrices = await getCurrentPrices()
  return getCurrentPricesForTenant(basePrices)
}

async function getLivePrice(instrument, basePrices = null) {
  return getPriceForTenant(instrument, basePrices)
}

// ─── Margin ───────────────────────────────────────────────────────────────────

function calculateMargin(instrument, lots) {
  const lotDec       = new Decimal(lots)
  const contractSize = new Decimal(CONTRACT_SIZES[instrument])
  const leverage     = new Decimal(LEVERAGE[instrument])
  return lotDec.times(contractSize).div(leverage).toDecimalPlaces(2).toNumber()
}

function calculateUsedMargin(trades) {
  return trades.reduce((total, trade) => {
    return total.plus(calculateMargin(trade.instrument, parseFloat(trade.lot_size)))
  }, new Decimal(0)).toDecimalPlaces(2).toNumber()
}

// ─── Market hours ─────────────────────────────────────────────────────────────

function getMarketStatus(instrument, options = {}) {
  const now      = options.now instanceof Date ? options.now : new Date()
  const purpose  = options.purpose || 'open'
  const day      = now.getUTCDay()
  const hour     = now.getUTCHours()
  const min      = now.getUTCMinutes()
  const totalMins = hour * 60 + min

  // Saturday — fully closed
  if (day === 6) {
    return { open: false, reason: 'Market is closed for the weekend. Opens Sunday 22:00 UTC.' }
  }
  // New positions are cut off earlier on Friday to reduce weekend gap exposure.
  if (purpose === 'open' && day === 5 && totalMins >= 21 * 60) {
    return { open: false, reason: 'New trades are disabled after Friday 21:00 UTC to avoid weekend gap risk.' }
  }
  // Friday after 22:00 UTC — weekend
  if (day === 5 && totalMins >= 22 * 60) {
    return { open: false, reason: 'Market is closed for the weekend. Opens Sunday 22:00 UTC.' }
  }
  // Sunday before 22:00 UTC — not yet open
  if (day === 0 && totalMins < 22 * 60) {
    const minsUntil = 22 * 60 - totalMins
    const h = Math.floor(minsUntil / 60)
    const m = minsUntil % 60
    return { open: false, reason: `Market opens Sunday 22:00 UTC (in ${h}h ${m}m).` }
  }
  // FIX (Bug 11): Daily rollover only applies to opens on Mon–Thu and
  // to closes on Mon–Fri, keeping Friday open cut-off aligned to 21:00 UTC.
  const inRollover = totalMins >= 21 * 60 + 55 && totalMins < 22 * 60 + 5
  if (
    (purpose === 'open' && day >= 1 && day <= 4 && inRollover) ||
    (purpose === 'close' && day >= 1 && day <= 5 && inRollover)
  ) {
    return { open: false, reason: 'Market is in daily rollover (21:55–22:05 UTC). Try again in a few minutes.' }
  }
  return { open: true, reason: '' }
}

// ─── Violation recording (non-throwing) ───────────────────────────────────────

async function safeRecordViolation(payload) {
  try {
    const { recordViolation } = require('./violationEngine')
    await recordViolation(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record violation:', { error: err.message, type: payload?.violationType })
  }
}

async function safeRecordEnforcement(payload) {
  try {
    const { recordEnforcementEvent } = require('./violationEngine')
    await recordEnforcementEvent(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record enforcement event:', { error: err.message, action: payload?.action })
  }
}

module.exports = {
  VALID_INSTRUMENTS,
  FOREX_LOTS_PER_1K,
  COMMODITY_LOTS_PER_1K,
  MAX_OPEN_POSITIONS,
  TRADE_JOURNAL_UPLOAD_ROOT,
  TRADING_RULE_KEYS,
  DEFAULT_TRADING_RULES,
  ensureTradeExperienceInfrastructure,
  computeRMultiple,
  getTradingRules,
  invalidateTradingRulesCache,
  getLivePriceMap,
  getLivePrice,
  calculateMargin,
  calculateUsedMargin,
  getMarketStatus,
  safeRecordViolation,
  safeRecordEnforcement
}
