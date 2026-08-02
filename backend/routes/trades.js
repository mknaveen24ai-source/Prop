// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
const express = require('express')
const router = express.Router()
const pool = require('../db')
const fs = require('fs')
const path = require('path')
const { authenticateToken } = require('./middleware')
const { v4: uuidv4 } = require('uuid')
const rateLimit = require('express-rate-limit')
const { fetchProgressionSettings, promotePassedAccount } = require('../services/progressionService')
const { tradingLimiter } = require('../utils/security')
const { isValidLotSize, sanitizeString } = require('../utils/validation')
const logger = require('../utils/logger')
const {
  CONTRACT_SIZES,
  LEVERAGE,
  INSTRUMENTS,
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  getPipSize,
  getMinDistance,
  roundPrice,
  formatPrice
} = require('../constants')
const Decimal = require('decimal.js')
const newsService = require('../services/newsService')
const { getCurrentPrices, getCurrentPricesForTenant, getPriceForTenant } = require('../priceFeed')
const { validatePendingOrderPrice } = require('../utils/pendingOrderValidation')
const { VALID_CHART_TIMEFRAME_LABELS, getChartTimeframeMinutes } = require('../utils/chartTimeframes')
const { ensureViolationTables, recordEnforcementEvent, recordViolation } = require('../services/violationEngine')
const { getTenantFeedConfig, getTenantSettings } = require('../services/tenantPolicyService')
const { resolveTieredInstrumentSetting } = require('../utils/tenantSettings')
const {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} = require('../utils/idempotency')
const drawdownService = require('../services/drawdownService')
const tradingDaysService = require('../services/tradingDaysService')
const { fetchStepModelBySlug } = require('../utils/stepModels')

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Leverage: 1:30 on forex (EURUSD, GBPUSD), 1:10 on commodities (XAUUSD, XAGUSD)
// These values must NOT be changed without also reviewing margin checks.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Instrument groups for combined exposure checks
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const VALID_INSTRUMENTS = INSTRUMENTS

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Combined exposure limits per $1,000 of account size
//   Forex (all supported forex pairs combined):        0.10 lots per $1k
//   Commodities (XAUUSD + XAGUSD combined):            0.02 lots per $1k
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const FOREX_LOTS_PER_1K     = 0.10
const COMMODITY_LOTS_PER_1K = 0.02
// Flat cap, not scaled by account size (spec: "Max 10 open positions at once").
const MAX_OPEN_POSITIONS = 10

// â”€â”€ Load admin-configurable trading rules from platform_settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Falls back to hardcoded defaults if a setting hasn't been configured yet.
// Cached for 30s to avoid a DB hit on every single trade open.
let _tradingRulesCache = null
const TRADING_RULES_TTL  = 30 * 1000 // 30 seconds
const candleCache = new Map()
const CANDLE_CACHE_TTL_MS = 15000
const MAX_RAW_CANDLE_BARS = 3000
const tradeFeatureInfraPromise = { current: null }
const TRADE_JOURNAL_UPLOAD_ROOT = path.resolve(__dirname, '..', 'uploads', 'trade-journal')
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

function getCachedCandles(cacheKey) {
  const cached = candleCache.get(cacheKey)
  if (!cached) return null
  if ((Date.now() - cached.cachedAt) > CANDLE_CACHE_TTL_MS) {
    candleCache.delete(cacheKey)
    return null
  }
  return cached.value
}

function setCachedCandles(cacheKey, value) {
  candleCache.set(cacheKey, { value, cachedAt: Date.now() })
}

function getRawCandleLookbackDays(tfMinutes, retainDays) {
  const safeTfMinutes = Math.max(1, parseInt(tfMinutes, 10) || 1)
  const cappedBars = Math.max(500, parseInt(process.env.MAX_RAW_CANDLE_BARS || String(MAX_RAW_CANDLE_BARS), 10) || MAX_RAW_CANDLE_BARS)
  const lookbackMinutes = safeTfMinutes * cappedBars
  const lookbackDays = Math.ceil(lookbackMinutes / (60 * 24))
  return Math.max(1, Math.min(retainDays, lookbackDays))
}

function normalizeCandleRows(rows = []) {
  return rows
    .map((row) => ({
      time: Number(row.time),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close),
      volume: parseInt(row.volume, 10) || 0
    }))
    .filter((row) =>
      Number.isFinite(row.time)
      && [row.open, row.high, row.low, row.close].every(Number.isFinite)
    )
}

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

function normalizePositiveNumber(value) {
  if (value === '' || value === null || value === undefined) return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function isValidImageDataUrl(dataUrl) {
  return typeof dataUrl === 'string'
    && /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl.trim())
}

async function persistTradeScreenshot({ tradeId, userId, kind, dataUrl }) {
  if (!isValidImageDataUrl(dataUrl)) {
    return null
  }

  const normalizedKind = kind === 'close' ? 'close' : 'open'
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i)
  if (!match) return null

  const format = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
  const buffer = Buffer.from(match[2], 'base64')
  if (!buffer.length || buffer.length > 1_500_000) {
    return null
  }

  const userPart = sanitizeString(String(userId || 'user'), 64) || 'user'
  const tradePart = sanitizeString(String(tradeId || 'trade'), 64) || 'trade'
  const relativeDir = path.join(userPart)
  const absoluteDir = path.join(TRADE_JOURNAL_UPLOAD_ROOT, relativeDir)
  await fs.promises.mkdir(absoluteDir, { recursive: true })

  const filename = `${tradePart}-${normalizedKind}-${Date.now()}.${format}`
  const absolutePath = path.join(absoluteDir, filename)
  await fs.promises.writeFile(absolutePath, buffer)

  return path.join(relativeDir, filename).replace(/\\/g, '/')
}

function buildTradeScreenshotAbsolutePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null
  const resolved = path.resolve(TRADE_JOURNAL_UPLOAD_ROOT, relativePath)
  return resolved.startsWith(TRADE_JOURNAL_UPLOAD_ROOT) ? resolved : null
}

function mapTradeRow(row) {
  if (!row || typeof row !== 'object') return row

  return {
    ...row,
    open_screenshot_url: row.open_screenshot_path ? `/api/trades/${row.id}/screenshot/open` : null,
    close_screenshot_url: row.close_screenshot_path ? `/api/trades/${row.id}/screenshot/close` : null
  }
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
    const resolved = {
      minHoldSeconds: parsed.min_hold_seconds ?? DEFAULT_TRADING_RULES.minHoldSeconds,
      forexLotsPer1k: parsed.forex_lots_per_1k ?? DEFAULT_TRADING_RULES.forexLotsPer1k,
      commodityLotsPer1k: parsed.commodity_lots_per_1k ?? DEFAULT_TRADING_RULES.commodityLotsPer1k,
      minLotSize: parsed.min_lot_size ?? DEFAULT_TRADING_RULES.minLotSize,
      maxTradesPer1k: parsed.max_trades_per_1k ?? DEFAULT_TRADING_RULES.maxTradesPer1k,
      maxOpenPositions: parsed.max_open_positions ?? DEFAULT_TRADING_RULES.maxOpenPositions,
      maxDailyTrades: parsed.max_daily_trades ?? DEFAULT_TRADING_RULES.maxDailyTrades,
      dynamicCommissionPerLot: parsed.dynamic_commission_per_lot ?? DEFAULT_TRADING_RULES.dynamicCommissionPerLot,
      commissionPerLotJson: parsed.commission_per_lot_json ?? '{}',
      slippageSimulatorEnabled: parsed.slippage_simulator_enabled ?? DEFAULT_TRADING_RULES.slippageSimulatorEnabled,
      slippageMaxPipsAdverse: Number.isFinite(parsed.slippage_max_pips_adverse)
        ? parsed.slippage_max_pips_adverse
        : DEFAULT_TRADING_RULES.slippageMaxPipsAdverse,
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Rate limit on trade open endpoint
// Max 30 trade open requests per minute per authenticated user.
// Key is userId only â€” avoids IPv6 bypass warning from express-rate-limit.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tradeOpenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many trade requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? String(req.user.userId) : 'anon'
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function getLivePrice(instrument, basePrices = null) {
  return getPriceForTenant(instrument, basePrices)
}

async function getPlatformSettingsForProgression(client) {
  return fetchProgressionSettings(client)
}

async function getLivePriceMap() {
  const basePrices = await getCurrentPrices()
  return getCurrentPricesForTenant(basePrices)
}

function calculatePnL(direction, open_price, current_price, lots, instrument, commission = 0) {
  const lotDec       = new Decimal(lots)
  const contractSize = new Decimal(CONTRACT_SIZES[instrument])
  const priceDiff = direction === 'buy' ? new Decimal(current_price).minus(open_price) : new Decimal(open_price).minus(current_price)
  return priceDiff.times(lotDec).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

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

function getMarketStatus(instrument, options = {}) {
  const now      = options.now instanceof Date ? options.now : new Date()
  const purpose  = options.purpose || 'open'
  const day      = now.getUTCDay()
  const hour     = now.getUTCHours()
  const min      = now.getUTCMinutes()
  const totalMins = hour * 60 + min

  // Saturday â€” fully closed
  if (day === 6) {
    return { open: false, reason: 'Market is closed for the weekend. Opens Sunday 22:00 UTC.' }
  }
  // New positions are cut off earlier on Friday to reduce weekend gap exposure.
  if (purpose === 'open' && day === 5 && totalMins >= 21 * 60) {
    return { open: false, reason: 'New trades are disabled after Friday 21:00 UTC to avoid weekend gap risk.' }
  }
  // Friday after 22:00 UTC â€” weekend
  if (day === 5 && totalMins >= 22 * 60) {
    return { open: false, reason: 'Market is closed for the weekend. Opens Sunday 22:00 UTC.' }
  }
  // Sunday before 22:00 UTC â€” not yet open
  if (day === 0 && totalMins < 22 * 60) {
    const minsUntil = 22 * 60 - totalMins
    const h = Math.floor(minsUntil / 60)
    const m = minsUntil % 60
    return { open: false, reason: `Market opens Sunday 22:00 UTC (in ${h}h ${m}m).` }
  }
  // FIX (Bug 11): Daily rollover only applies to opens on Monâ€“Thu and
  // to closes on Monâ€“Fri, keeping Friday open cut-off aligned to 21:00 UTC.
  const inRollover = totalMins >= 21 * 60 + 55 && totalMins < 22 * 60 + 5
  if (
    (purpose === 'open' && day >= 1 && day <= 4 && inRollover) ||
    (purpose === 'close' && day >= 1 && day <= 5 && inRollover)
  ) {
    return { open: false, reason: 'Market is in daily rollover (21:55â€“22:05 UTC). Try again in a few minutes.' }
  }
  return { open: true, reason: '' }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// checkSLTP â€” SL/TP background checker
//
// FIX: Previously ran trade close + balance update as two independent queries
// with no transaction. If the balance update failed after the trade was already
// marked closed, the account balance would be permanently wrong.
//
// Fix: each triggered SL/TP now runs inside its own BEGIN/COMMIT block with a
// FOR UPDATE SKIP LOCKED lock on the trade row, preventing the floating
// drawdown checker from racing on the same trade simultaneously.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FIX: Concurrency guards for background engine functions.
// setInterval fires every 500ms, but each function makes DB queries that can
// take longer than 500ms under load. Without guards, multiple invocations pile
// up, issuing redundant queries and exhausting the connection pool.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _checkSLTPRunning = false
let _checkPendingOrdersRunning = false
let _checkFloatingDrawdownRunning = false

async function safeRecordViolation(payload) {
  try {
    await recordViolation(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record violation:', { error: err.message, type: payload?.violationType })
  }
}

async function safeRecordEnforcement(payload) {
  try {
    await recordEnforcementEvent(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record enforcement event:', { error: err.message, action: payload?.action })
  }
}

async function checkSLTP(io) {
  if (_checkSLTPRunning) return
  _checkSLTPRunning = true
  try {
    await ensureTradeExperienceInfrastructure()
    const openTrades = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              t.commission,
              a.user_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
       AND (
         t.stop_loss IS NOT NULL
         OR t.take_profit IS NOT NULL
       )`
    )

    const priceMap = await getLivePriceMap()
    const rules = await getTradingRules()

    for (const trade of openTrades.rows) {
      const price = priceMap[trade.instrument]
      if (!price) continue

      // BUY trades close at BID. SELL trades close at ASK.
      const currentPrice = trade.direction === 'buy'
        ? parseFloat(price.bid)
        : parseFloat(price.ask)

      let triggered   = false
      let closeReason = ''

      if (trade.stop_loss) {
        const sl = parseFloat(trade.stop_loss)
        if (trade.direction === 'buy'  && currentPrice <= sl) { triggered = true; closeReason = 'Stop Loss' }
        if (trade.direction === 'sell' && currentPrice >= sl) { triggered = true; closeReason = 'Stop Loss' }
      }

      if (!triggered && trade.take_profit) {
        const tp = parseFloat(trade.take_profit)
        if (trade.direction === 'buy'  && currentPrice >= tp) { triggered = true; closeReason = 'Take Profit' }
        if (trade.direction === 'sell' && currentPrice <= tp) { triggered = true; closeReason = 'Take Profit' }
      }

      if (!triggered) continue

      // FIX (Bug 5): Use admin-configurable min hold time instead of hardcoded 60s
      if (trade.open_time) {
        const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
        if (secondsOpen < rules.minHoldSeconds) continue
      }

      // FIX: wrap close + balance update in a transaction with row-level lock
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Lock the trade row â€” skip if already being processed elsewhere
        const lockResult = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (lockResult.rows.length === 0) {
          await client.query('ROLLBACK')
          continue
        }

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
          [currentPrice, demo_pnl, closeReason, trade.id]
        )

        await client.query(
          `UPDATE accounts SET
             current_balance = current_balance + $1,
             peak_balance    = GREATEST(peak_balance, current_balance + $1)
           WHERE id = $2`,
          [demo_pnl, trade.account_id]
        )

        await client.query('COMMIT')

        if (io) {
          io.to(String(trade.user_id)).emit('account_update', {
            message: `${closeReason} triggered on ${trade.instrument}`,
            pnl: demo_pnl
          })
        }
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error(`checkSLTP: transaction failed for trade ${trade.id}:`, { error: err.message })
      } finally {
        client.release()
      }
    }
  } catch (error) {
    logger.error('SL/TP check error:', { error: error.message })
  } finally {
    _checkSLTPRunning = false
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Pending orders background checker
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function cancelPendingOrder(orderId, reason) {
  await pool.query(
    `UPDATE trades SET
       status = 'cancelled',
       close_time = NOW(),
       close_reason = $1
     WHERE id = $2`,
    [reason, orderId]
  )
}

async function validatePendingTrigger(client, order, rules, livePrices) {
  const lotsNum = parseFloat(order.lot_size)
  if (isNaN(lotsNum) || lotsNum <= 0) {
    return 'Invalid lot size on pending order'
  }

  // Fetch the fresh account balance inside the transaction (account_type/
  // scaling_multiplier come from the batch join in checkPendingOrders since
  // they don't change mid-tick the way balance can).
  const accountResult = await client.query(
    `SELECT current_balance FROM accounts WHERE id = $1`,
    [order.account_id]
  )
  if (accountResult.rows.length === 0) {
    return 'Account not found during pending order trigger'
  }
  const current_balance = parseFloat(accountResult.rows[0].current_balance)

  // Funded accounts' scaling-plan multiplier raises risk capacity (lot caps)
  // proportionally, matching the same check in POST /open.
  const scalingMultiplier = order.account_type === 'funded' && order.scaling_multiplier != null
    ? parseFloat(order.scaling_multiplier)
    : 1
  const accountSizeK = (parseFloat(order.account_size) / 1000) * (Number.isFinite(scalingMultiplier) ? scalingMultiplier : 1)

  if (COMMODITY_INSTRUMENTS.includes(order.instrument)) {
    const maxCommodityLots = parseFloat((accountSizeK * rules.commodityLotsPer1k).toFixed(4))
    const existingResult = await client.query(
      `SELECT COALESCE(SUM(lot_size), 0) as total_lots
       FROM trades
       WHERE account_id = $1
         AND instrument = ANY($2::text[])
         AND status IN ('open', 'pending')
         AND id <> $3`,
      [order.account_id, COMMODITY_INSTRUMENTS, order.id]
    )
    const currentLots = parseFloat(existingResult.rows[0].total_lots)
    if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxCommodityLots) {
      return `Pending order exceeds combined commodity exposure limit (${maxCommodityLots} lots)`
    }
  } else if (FOREX_INSTRUMENTS.includes(order.instrument)) {
    const maxForexLots = parseFloat((accountSizeK * rules.forexLotsPer1k).toFixed(4))
    const existingResult = await client.query(
      `SELECT COALESCE(SUM(lot_size), 0) as total_lots
       FROM trades
       WHERE account_id = $1
         AND instrument = ANY($2::text[])
         AND status IN ('open', 'pending')
         AND id <> $3`,
      [order.account_id, FOREX_INSTRUMENTS, order.id]
    )
    const currentLots = parseFloat(existingResult.rows[0].total_lots)
    if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxForexLots) {
      return `Pending order exceeds combined forex exposure limit (${maxForexLots} lots)`
    }
  }

  const maxOpenTrades = rules.maxOpenPositions
  const openTradeCountResult = await client.query(
    `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status IN ('open', 'pending') AND id <> $2`,
    [order.account_id, order.id]
  )
  const currentOpenCount = parseInt(openTradeCountResult.rows[0].count)
  if ((currentOpenCount + 1) > maxOpenTrades) {
    return `Pending order exceeds max open trades (${maxOpenTrades})`
  }

  const margin = calculateMargin(order.instrument, lotsNum)
  let floatingPnl = new Decimal(0)
  const openTradesResult = await client.query(
    `SELECT t.direction, t.open_price, t.lot_size, t.instrument, t.commission
     FROM trades t
     WHERE t.account_id = $1 AND t.status = 'open' AND t.id <> $2`,
    [order.account_id, order.id]
  )
  for (const t of openTradesResult.rows) {
    const livePrice = livePrices[t.instrument]
    if (!livePrice) continue
    const currentPrice = t.direction === 'buy' ? parseFloat(livePrice.bid) : parseFloat(livePrice.ask)
    floatingPnl = floatingPnl.plus(calculatePnL(t.direction, parseFloat(t.open_price), currentPrice, parseFloat(t.lot_size), t.instrument, parseFloat(t.commission || 0)))
  }
  const equity = new Decimal(current_balance).plus(floatingPnl)
  const requiredMargin = new Decimal(calculateUsedMargin(openTradesResult.rows)).plus(margin)
  if (requiredMargin.gt(equity)) {
    return `Insufficient equity at trigger. Required margin: $${requiredMargin.toFixed(2)}`
  }

  return null
}

async function checkPendingOrders(io) {
  if (_checkPendingOrdersRunning) return
  _checkPendingOrdersRunning = true
  try {
    await ensureTradeExperienceInfrastructure()
    const pendingOrders = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.order_type,
              t.pending_price, t.status, a.user_id, a.current_balance, a.peak_balance,
              a.status as account_status, a.account_size, a.phase_end_date,
              a.account_type, a.scaling_multiplier, t.oco_group_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'pending'`
    )

    const priceMap = await getLivePriceMap()
    const rules = await getTradingRules()

    for (const order of pendingOrders.rows) {
      if (order.account_status !== 'active') {
        await cancelPendingOrder(order.id, 'Account inactive')
        continue
      }

      if (order.phase_end_date && new Date(order.phase_end_date) <= new Date()) {
        await cancelPendingOrder(order.id, 'Challenge phase expired')
        continue
      }

      const pendingMarketStatus = getMarketStatus(order.instrument, { purpose: 'open' })
      if (!pendingMarketStatus.open) {
        continue
      }

      const price = priceMap[order.instrument]
      if (!price) continue

      const bid           = parseFloat(price.bid)
      const ask           = parseFloat(price.ask)
      const pending_price = parseFloat(order.pending_price)

      let triggered = false

      if (order.order_type === 'buy_limit'  && ask <= pending_price) triggered = true
      if (order.order_type === 'sell_limit' && bid >= pending_price) triggered = true
      if (order.order_type === 'buy_stop'   && ask >= pending_price) triggered = true
      if (order.order_type === 'sell_stop'  && bid <= pending_price) triggered = true

      if (triggered) {
        // FIX (Bug 4): Wrap activation in a transaction with row lock to prevent
        // double-triggering and concurrent limit violations
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          let cancelledSiblingRows = []

          // Lock the order row — skip if already being processed elsewhere
          const lockResult = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
            [order.id]
          )
          if (lockResult.rows.length === 0) {
            await client.query('ROLLBACK')
            continue
          }

          const limitError = await validatePendingTrigger(client, order, rules, priceMap)
          if (limitError) {
            await client.query(
              `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = $1 WHERE id = $2`,
              [limitError, order.id]
            )
            await client.query('COMMIT')
            continue
          }

          const open_price = order.direction === 'buy' ? ask : bid

          await client.query(
            `UPDATE trades SET
               status = 'open',
               open_price = $1,
               open_time = NOW(),
               close_reason = NULL
             WHERE id = $2`,
            [open_price, order.id]
          )

          if (order.oco_group_id) {
            const siblingCancelResult = await client.query(
              `UPDATE trades
               SET status = 'cancelled',
                   close_time = NOW(),
                   close_reason = 'OCO sibling triggered'
               WHERE oco_group_id = $1
                 AND id <> $2
                 AND status = 'pending'
               RETURNING id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit, status, close_reason`,
              [order.oco_group_id, order.id]
            )
            cancelledSiblingRows = siblingCancelResult.rows
          }

          await client.query('COMMIT')

          if (io) {
            io.to(String(order.user_id)).emit('account_update', {
              message: `${order.order_type.replace(/_/g, ' ').toUpperCase()} triggered on ${order.instrument} at ${open_price}`,
              pnl: null
            })
          }

          logger.info(`Pending order ${order.id} triggered: ${order.order_type} ${order.instrument} at ${open_price}`)
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {})
          logger.error(`checkPendingOrders: transaction error for order ${order.id}:`, { error: txErr.message })
        } finally {
          client.release()
        }
      }
    }
  } catch (error) {
    logger.error('Pending orders check error:', { error: error.message })
  } finally {
    _checkPendingOrdersRunning = false
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// autoCloseAndFail â€” balance update race condition resolved.
// Collects all trade PnLs first, then applies a single summed balance UPDATE
// after all trades are closed inside the same transaction.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function autoCloseAndFail(acc, reason, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const openTrades   = await client.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status, commission
       FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [acc.id]
    )
    const priceMap = await getCurrentPricesForTenant()

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (!priceData) {
          await client.query(
            `UPDATE trades SET
               status = 'closed',
               close_price = open_price,
               close_time = NOW(),
               demo_pnl = 0,
               close_reason = 'Account Failed'
             WHERE id = $1`,
            [trade.id]
          )
          continue
        }

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        totalPnlDec = totalPnlDec.plus(demo_pnl)

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Account Failed'
           WHERE id = $3`,
           [close_price, demo_pnl, trade.id]
        )
      } catch (err) {
        logger.error(`Failed to close trade ${trade.id} during drawdown breach`, { error: err.message })
      }
    }

    // FIX (BUG-C001): Convert Decimal accumulator to number — was previously
    // referencing undefined `totalPnl` instead of `totalPnlDec`.
    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()

    // Single balance update after all trades are closed — no race condition
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [totalPnl, acc.id]
      )
    }

    const cancelledPendingResult = await client.query(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = 'Account Failed'
       WHERE account_id = $1 AND status = 'pending'
       RETURNING id, account_id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit`,
      [acc.id]
    )

    await client.query(`UPDATE accounts SET status = 'failed' WHERE id = $1`, [acc.id])

    await client.query(
      `INSERT INTO bbook_pnl (date, accounts_failed)
       VALUES (CURRENT_DATE, 1)
       ON CONFLICT (date) DO UPDATE
       SET accounts_failed = bbook_pnl.accounts_failed + 1`
    )

    await client.query('COMMIT')

    await safeRecordViolation({
      violationType: 'floating_drawdown_breach',
      severity: 'critical',
      accountId: acc.id,
      userId: acc.user_id,
      source: 'trades_engine',
      message: reason,
      payload: {
        auto_status: 'failed',
        total_closed_pnl: totalPnl
      }
    })

    await safeRecordEnforcement({
      accountId: acc.id,
      userId: acc.user_id,
      action: 'auto_fail_account',
      status: 'applied',
      message: `Account failed automatically: ${reason}`,
      payload: {
        source: 'floating_drawdown',
        total_closed_pnl: totalPnl
      }
    })

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: `âŒ Account FAILED â€” ${reason}. All trades closed automatically.`,
        pnl: totalPnl,
        account_id: acc.id,
        event: 'account_failed'
      })
    }

    logger.info(`Account ${acc.id} FAILED via floating drawdown â€” ${reason}`)

  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`autoCloseAndFail error for account ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// autoCloseAndPass â€” same single-update pattern as autoCloseAndFail
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function autoCloseAndPass(acc, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    // Floating pass closes open trades inside this transaction before promotion.
    // This makes the open-trade check and the promotion atomic — eliminating the
    // TOCTOU race where two concurrent engine cycles both saw 0 open trades and
    // both tried to promote the same account.
    const openTrades   = await client.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status, commission
       FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [acc.id]
    )
    const priceMap = await getCurrentPricesForTenant()

    const closeReason = acc.account_type === 'phase1' ? 'Phase 1 Passed' : 'Phase 2 Passed'
    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (!priceData) throw new Error(`Missing live price for ${trade.instrument}`)

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        totalPnlDec = totalPnlDec.plus(demo_pnl)

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
           [close_price, demo_pnl, closeReason, trade.id]
        )
      } catch (err) {
        logger.error(`Failed to close trade ${trade.id} on profit target:`, { error: err.message })
        throw err
      }
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()

    // Single balance update AND status update after all trades are closed
    await client.query(
      `UPDATE accounts SET
         current_balance = current_balance + $1,
         peak_balance    = GREATEST(peak_balance, current_balance + $1),
         status          = 'passed'
       WHERE id = $2`,
      [totalPnl, acc.id]
    )

    const cancelledPendingResult = await client.query(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = $1
       WHERE account_id = $2 AND status = 'pending'
       RETURNING id, account_id, instrument, direction, lot_size, order_type, pending_price, stop_loss, take_profit`,
      [closeReason, acc.id]
    )

    const settings    = await fetchProgressionSettings(client)
    const promoted    = await promotePassedAccount(client, acc, settings)
    const newAccountId = promoted ? promoted.new_account_id : null

    await client.query('COMMIT')

    const passMsg = acc.account_type === 'phase1'
      ? `ðŸ† Phase 1 PASSED! Floating profit target hit. All trades closed. Phase 2 activating shortly.`
      : `ðŸŽ‰ Phase 2 PASSED! Floating profit target hit. All trades closed. Funded account activating shortly.`

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: passMsg,
        pnl: totalPnl,
        account_id: acc.id,
        new_account_id: newAccountId,
        event: promoted?.event || (acc.account_type === 'phase1' ? 'phase1_passed' : 'phase2_passed')
      })
    }

    logger.info(`Account ${acc.id} PASSED via floating equity (${acc.account_type})`)

  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`autoCloseAndPass error for account ${acc.id}:`, { error: err.message, auto_pass_aborted: true })
  } finally {
    client.release()
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// checkFloatingDrawdown
//
// FIX 1 (BUG 3): Funded accounts now use funded_max_drawdown_pct from
// platform_settings instead of the stored max_drawdown_pct column, which
// could be stale or accidentally 0 (which would instantly fail any account).
//
// FIX 2 (N+1 query): Previously fetched open trades per-account in a loop
// (N accounts Ã— 1 query each). Now fetches ALL open trades and ALL prices
// in two queries up front and groups in JS â€” O(2) queries regardless of
// how many active accounts exist.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function checkFloatingDrawdown(io) {
  if (_checkFloatingDrawdownRunning) return
  _checkFloatingDrawdownRunning = true
  try {
    // FIX: single query for all open trades across all active accounts
    const tradesResult = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              a.user_id, a.current_balance, a.starting_balance, a.peak_balance,
              a.max_drawdown_pct, a.account_type, a.profit_target, a.account_size,
              a.starting_balance as acc_starting,
              a.eod_peak_equity, a.eod_trailing_floor, a.challenge_model_slug, a.daily_drawdown_pct
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
         AND a.status = 'active'`
    )

    if (tradesResult.rows.length === 0) return

    const priceMap = await getLivePriceMap()
    const fundedModelSettingsCache = new Map()

    // Group trades by account_id in JS â€” no extra queries
    const accountTrades = {}
    const accountMeta   = {}

    for (const row of tradesResult.rows) {
      const aid = row.account_id
      if (!accountTrades[aid]) {
        accountTrades[aid] = []
        accountMeta[aid] = {
          id:                    aid,
          user_id:               row.user_id,
          current_balance:       parseFloat(row.current_balance),
          starting_balance:      parseFloat(row.acc_starting),
          peak_balance:          parseFloat(row.peak_balance),
          max_drawdown_pct:      parseFloat(row.max_drawdown_pct),
          account_type:          row.account_type,
          account_size:          parseFloat(row.account_size),
          profit_target:         parseFloat(row.profit_target || 0),
          eod_peak_equity:       row.eod_peak_equity,
          eod_trailing_floor:    row.eod_trailing_floor,
          challenge_model_slug:  row.challenge_model_slug,
          daily_drawdown_pct:    row.daily_drawdown_pct != null ? parseFloat(row.daily_drawdown_pct) : null,
        }
      }
      accountTrades[aid].push(row)
    }

    const todayRealizedMap = await tradingDaysService.getTodayRealizedPnl(pool, Object.keys(accountTrades))

    for (const [aid, trades] of Object.entries(accountTrades)) {
      const acc = accountMeta[aid]

      let floatingPnl = new Decimal(0)
      for (const trade of trades) {
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

        const currentPrice = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        floatingPnl = floatingPnl.plus(calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        ))
      }

      const equity = new Decimal(acc.current_balance).plus(floatingPnl)
      let max_drawdown_pct = acc.max_drawdown_pct
      let daily_drawdown_pct = acc.daily_drawdown_pct
      let drawdownLocksAtPct = null

      if (acc.account_type === 'funded' && acc.challenge_model_slug) {
        let modelSettings = fundedModelSettingsCache.get(acc.challenge_model_slug)
        if (!modelSettings) {
          const model = await fetchStepModelBySlug(acc.challenge_model_slug)
          modelSettings = model
            ? {
                funded_max_drawdown_pct: parseFloat(model.funded_max_drawdown_pct),
                funded_daily_drawdown_pct: parseFloat(model.funded_daily_drawdown_pct),
                funded_drawdown_locks_at_pct: model.funded_drawdown_locks_at_pct != null ? parseFloat(model.funded_drawdown_locks_at_pct) : null
              }
            : null
          fundedModelSettingsCache.set(acc.challenge_model_slug, modelSettings || {})
        }
        if (modelSettings && Number.isFinite(modelSettings.funded_max_drawdown_pct)) {
          max_drawdown_pct = modelSettings.funded_max_drawdown_pct
          daily_drawdown_pct = modelSettings.funded_daily_drawdown_pct
          drawdownLocksAtPct = modelSettings.funded_drawdown_locks_at_pct
        }
      }

      if (!(max_drawdown_pct > 0)) continue

      const floor = await drawdownService.getEffectiveDrawdownFloor(pool, acc, {
        equity: equity.toNumber(),
        maxDrawdownPct: max_drawdown_pct,
        drawdownLocksAtPct
      })

      if (equity.lt(floor)) {
        const drawdownPctUsed = new Decimal(acc.starting_balance).minus(equity).div(acc.starting_balance).times(100)
        const reason = `Trailing drawdown breach — equity $${equity.toFixed(2)} fell below the $${floor.toFixed(2)} floor (${drawdownPctUsed.toFixed(2)}% of a ${max_drawdown_pct}% limit)`
        logger.info(`Account ${aid} DRAWDOWN BREACH: ${reason}`)
        await autoCloseAndFail(acc, reason, io)
        continue
      }

      if (Number.isFinite(daily_drawdown_pct) && daily_drawdown_pct > 0 && acc.starting_balance > 0) {
        const todayRealized = todayRealizedMap.get(aid) || 0
        const todayTotalPnl = new Decimal(todayRealized).plus(floatingPnl)
        const todayLossPct = todayTotalPnl.isNegative()
          ? todayTotalPnl.abs().div(acc.starting_balance).times(100)
          : new Decimal(0)
        if (todayLossPct.gte(daily_drawdown_pct)) {
          const reason = `Daily loss limit breach — today's loss ${todayLossPct.toFixed(2)}% reached the ${daily_drawdown_pct}% daily limit`
          logger.info(`Account ${aid} DAILY LOSS BREACH: ${reason}`)
          await autoCloseAndFail(acc, reason, io)
          continue
        }
      }

      // Competition accounts have no profit-target auto-pass — they run for a
      // fixed window and are settled by competitionEngine.js at end_at instead.
      if (acc.account_type === 'funded' || acc.account_type === 'competition') continue

      let profit_target = acc.profit_target
      if (profit_target <= 0) {
        profit_target = acc.starting_balance * 0.10
        logger.warn(`Account ${aid} had no profit_target set — defaulting to 10% = $${profit_target.toFixed(2)}`)
      }

      const equity_profit = equity.minus(acc.starting_balance)
      if (equity_profit.gte(profit_target)) {
        // FIX (BUG-9): Open-trade COUNT was outside the transaction so two concurrent
        // engine cycles (floating-drawdown + challenge engine) could both read 0 and
        // both attempt promotion simultaneously. The COUNT is now moved INSIDE
        // autoCloseAndPass, after the FOR UPDATE lock, so only one promotion wins.
        await autoCloseAndPass(acc, io)
      }
    }

  } catch (error) {
    logger.error('Floating drawdown check error:', { error: error.message })
  } finally {
    _checkFloatingDrawdownRunning = false
  }
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/candles
// Uses bid price for candle series â€” matches what traders see when a BUY trade
// closes (at bid), giving chart levels consistent with execution prices.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/candles', authenticateToken, async function(req, res) {
  try {
    const { instrument, timeframe } = req.query
    const normalizedInstrument = String(instrument || '').trim().toUpperCase()

    if (!instrument || !timeframe) {
      return res.status(400).json({ error: 'instrument and timeframe are required' })
    }

    if (!VALID_INSTRUMENTS.includes(normalizedInstrument)) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    const tfMinutes = getChartTimeframeMinutes(timeframe)
    if (!tfMinutes) {
      return res.status(400).json({ error: `Invalid timeframe. Use: ${VALID_CHART_TIMEFRAME_LABELS.join(', ')}` })
    }

    const tfSeconds = tfMinutes * 60
    const feedConfig = await getTenantFeedConfig()
    const effectiveSourceKey = String(feedConfig?.effective_source_key || 'shared').trim().toLowerCase()
    const cacheKey = `${effectiveSourceKey}:${normalizedInstrument}:${String(timeframe).toUpperCase()}`
    const cachedCandles = getCachedCandles(cacheKey)
    if (cachedCandles) {
      res.set('Cache-Control', 'private, max-age=15')
      return res.json(cachedCandles)
    }
    const retainDays = Math.max(1, parseInt(process.env.PRICE_HISTORY_RETAIN_DAYS || '90', 10) || 90)
    const hourlyRetainDays = Math.max(
      retainDays,
      parseInt(process.env.PRICE_HISTORY_1H_RETAIN_DAYS || String(Math.max(retainDays, 365)), 10) || Math.max(retainDays, 365)
    )

    // Use the rolled-up 1H table for high timeframes to keep queries fast on long history.
    if (tfMinutes >= 60) {
      const sinceHourly = new Date(Date.now() - hourlyRetainDays * 24 * 60 * 60 * 1000)
      const hourlyRows = await pool.query(
        effectiveSourceKey === 'shared'
          ? `WITH bucketed AS (
               SELECT FLOOR(EXTRACT(EPOCH FROM bucket_time) / $3)::bigint * $3 AS time,
                      bucket_time,
                      open,
                      high,
                      low,
                      close,
                      ticks
                 FROM price_feed_history_1h
                WHERE instrument = $1 AND bucket_time >= $2
             )
             SELECT time,
                    (array_agg(open ORDER BY bucket_time ASC))[1]::float8 AS open,
                    MAX(high)::float8 AS high,
                    MIN(low)::float8 AS low,
                    (array_agg(close ORDER BY bucket_time DESC))[1]::float8 AS close,
                    SUM(ticks)::int AS volume
               FROM bucketed
              GROUP BY time
              ORDER BY time ASC`
          : `WITH bucketed AS (
               SELECT FLOOR(EXTRACT(EPOCH FROM bucket_time) / $4)::bigint * $4 AS time,
                      bucket_time,
                      open,
                      high,
                      low,
                      close,
                      ticks
                 FROM price_feed_source_history_1h
                WHERE source_key = $1 AND instrument = $2 AND bucket_time >= $3
             )
             SELECT time,
                    (array_agg(open ORDER BY bucket_time ASC))[1]::float8 AS open,
                    MAX(high)::float8 AS high,
                    MIN(low)::float8 AS low,
                    (array_agg(close ORDER BY bucket_time DESC))[1]::float8 AS close,
                    SUM(ticks)::int AS volume
               FROM bucketed
              GROUP BY time
              ORDER BY time ASC`,
        effectiveSourceKey === 'shared'
          ? [normalizedInstrument, sinceHourly, tfSeconds]
          : [effectiveSourceKey, normalizedInstrument, sinceHourly, tfSeconds]
      )

      if (hourlyRows.rows.length > 0) {
        const candles = normalizeCandleRows(hourlyRows.rows)
        setCachedCandles(cacheKey, candles)
        res.set('Cache-Control', 'private, max-age=15')
        return res.json(candles)
      }
    }

    // Raw tick fallback (also used for 1M/3M/5M/15M/30M).
    const rawLookbackDays = getRawCandleLookbackDays(tfMinutes, retainDays)
    const since = new Date(Date.now() - rawLookbackDays * 24 * 60 * 60 * 1000)
    const rows = await pool.query(
      effectiveSourceKey === 'shared'
        ? `WITH bucketed AS (
             SELECT FLOOR(EXTRACT(EPOCH FROM recorded_at) / $3)::bigint * $3 AS time,
                    recorded_at,
                    bid
               FROM price_feed_history
              WHERE instrument = $1 AND recorded_at >= $2
           )
           SELECT time,
                  (array_agg(bid ORDER BY recorded_at ASC))[1]::float8 AS open,
                  MAX(bid)::float8 AS high,
                  MIN(bid)::float8 AS low,
                  (array_agg(bid ORDER BY recorded_at DESC))[1]::float8 AS close,
                  COUNT(*)::int AS volume
             FROM bucketed
            GROUP BY time
            ORDER BY time ASC`
        : `WITH bucketed AS (
             SELECT FLOOR(EXTRACT(EPOCH FROM recorded_at) / $4)::bigint * $4 AS time,
                    recorded_at,
                    bid
               FROM price_feed_source_history
              WHERE source_key = $1 AND instrument = $2 AND recorded_at >= $3
           )
           SELECT time,
                  (array_agg(bid ORDER BY recorded_at ASC))[1]::float8 AS open,
                  MAX(bid)::float8 AS high,
                  MIN(bid)::float8 AS low,
                  (array_agg(bid ORDER BY recorded_at DESC))[1]::float8 AS close,
                  COUNT(*)::int AS volume
             FROM bucketed
            GROUP BY time
            ORDER BY time ASC`,
      effectiveSourceKey === 'shared'
        ? [normalizedInstrument, since, tfSeconds]
        : [effectiveSourceKey, normalizedInstrument, since, tfSeconds]
    )

    if (rows.rows.length === 0) {
      setCachedCandles(cacheKey, [])
      res.set('Cache-Control', 'private, max-age=15')
      return res.json([])
    }

    const candles = normalizeCandleRows(rows.rows)

    setCachedCandles(cacheKey, candles)
    res.set('Cache-Control', 'private, max-age=15')
    res.json(candles)
  } catch (error) {
    logger.error('Candles error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch candles' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// validatePendingOrderPrice
//   buy_limit  â†’ price must be BELOW current ask
//   sell_limit â†’ price must be ABOVE current bid
//   buy_stop   â†’ price must be ABOVE current ask
//   sell_stop  â†’ price must be BELOW current bid
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/open
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/open', authenticateToken, tradingLimiter, async function(req, res) {
  let idempotencyClaim = null
  try {
    await ensureTradeExperienceInfrastructure()

    const {
      account_id,
      instrument,
      direction,
      lots,
      stop_loss,
      take_profit,
      order_type,
      pending_price,
      screenshot_data_url,
      oco_sibling
    } = req.body

    // Enhanced input validation
    if (!account_id || !instrument || !direction || !lots) {
      return res.status(400).json({ error: 'account_id, instrument, direction, and lots are required' })
    }

    if (screenshot_data_url != null && !isValidImageDataUrl(screenshot_data_url)) {
      return res.status(400).json({ error: 'Invalid screenshot data' })
    }

    // FIX (BUG-C002): tradeIp was never declared in this handler — caused
    // ReferenceError when inserting into trade_logs on every trade open.
    const tradeIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'

    // Sanitize inputs
    const sanitizedInstrument = sanitizeString(String(instrument).toUpperCase(), 10)
    const sanitizedDirection = sanitizeString(String(direction).toLowerCase(), 10)
    const instrumentFinal = sanitizedInstrument
    const directionFinal = sanitizedDirection
    
    if (!VALID_INSTRUMENTS.includes(sanitizedInstrument)) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    if (!['buy', 'sell'].includes(sanitizedDirection)) {
      return res.status(400).json({ error: 'Direction must be buy or sell' })
    }

    // â”€â”€ Strict News Protection (3 min USD High Impact) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const activeNews = newsService.getActiveNewsEvent(3)
    if (activeNews) {
      return res.status(400).json({ error: `Cannot open trade. USD High-impact news event '${activeNews.title}' is active.` })
    }

    // Use validation utility for lot size
    if (!isValidLotSize(lots)) {
      return res.status(400).json({ error: 'Invalid lot size. Must be between 0.01 and 1000 in 0.01 increments.' })
    }

    const lotsNum = parseFloat(lots)
    // â”€â”€ Minimum lot size (admin-configurable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let rules = await getTradingRules()
    const MIN_LOT_SIZE = rules.minLotSize
    if (lotsNum < MIN_LOT_SIZE) {
      return res.status(400).json({ error: `Minimum lot size is ${MIN_LOT_SIZE}. You entered ${lotsNum}.` })
    }

    // â”€â”€ Lot size must be in 0.01 increments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lotsRounded = Math.round(lotsNum * 100) / 100
    if (Math.abs(lotsRounded - lotsNum) > 0.00001) {
      return res.status(400).json({ error: `Lot size must be in 0.01 increments (e.g. 0.01, 0.05, 1.00). You entered ${lotsNum}.` })
    }

    const accountIdStr = String(account_id).trim()
    if (!accountIdStr) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const marketStatus      = getMarketStatus(instrumentFinal, { purpose: 'open' })
    const PENDING_ORDER_TYPES = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop']
    const orderTypeFinal    = order_type || 'market'
    const isPending         = PENDING_ORDER_TYPES.includes(orderTypeFinal)
    const hasOcoSibling = !!oco_sibling

    if (!isPending && !marketStatus.open) {
      return res.status(400).json({ error: marketStatus.reason })
    }

    if (hasOcoSibling && !isPending) {
      return res.status(400).json({ error: 'OCO is only available for pending orders' })
    }

    let ocoSiblingConfig = null
    if (hasOcoSibling) {
      if (typeof oco_sibling !== 'object') {
        return res.status(400).json({ error: 'Invalid OCO sibling payload' })
      }
      const siblingOrderType = sanitizeString(String(oco_sibling.order_type || '').toLowerCase(), 20)
      const siblingPendingPrice = normalizePositiveNumber(oco_sibling.pending_price)
      if (!PENDING_ORDER_TYPES.includes(siblingOrderType) || !siblingPendingPrice) {
        return res.status(400).json({ error: 'OCO sibling requires a valid pending order type and price' })
      }
      ocoSiblingConfig = {
        order_type: siblingOrderType,
        pending_price: siblingPendingPrice,
        direction: siblingOrderType.startsWith('buy') ? 'buy' : 'sell'
      }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // RACE CONDITION FIX: All read-check-write operations run inside a single
    // transaction with SELECT ... FOR UPDATE on the account row. This serialises
    // concurrent trade opens for the same account â€” two simultaneous requests
    // will queue at the lock, and the second will see the first's INSERT already
    // in the DB when it runs its checks.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const client = await pool.connect()
    let newTrade
    try {
      await client.query('BEGIN')

      // Lock the account row for this transaction
      const lockedAccount = await client.query(
        `SELECT id, user_id, account_size, current_balance, starting_balance, peak_balance,
                status, account_type, phase_end_date, scaling_multiplier, challenge_model_slug
         FROM accounts WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
        [accountIdStr, req.user.userId]
      )
      if (lockedAccount.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Account not found or not active' })
      }

      // FIX (LOOPHOLE 2): Reject trades on accounts past their phase_end_date
      // The challenge engine checks every 30s, so there's a window where traders
      // could still open trades on an expired account.
      const account = lockedAccount.rows[0]
      rules = await getTradingRules()
      if (lotsNum < rules.minLotSize) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Minimum lot size is ${rules.minLotSize}. You entered ${lotsNum}.` })
      }
      if (account.phase_end_date && new Date(account.phase_end_date) <= new Date()) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Challenge phase has expired. No new trades allowed.' })
      }

      // ── Trading-restriction flags from the account's challenge model ──────────
      // no_ea_bots is intentionally not enforced here — there is no reliable
      // server-side signal (e.g. client fingerprinting) to distinguish bot-driven
      // orders from manual ones, so a check would just be security theater.
      if (account.challenge_model_slug) {
        const model = await fetchStepModelBySlug(account.challenge_model_slug)
        if (model) {
          if (model.no_hedging) {
            const oppositeDirection = directionFinal === 'buy' ? 'sell' : 'buy'
            const hedgeCheck = await client.query(
              `SELECT 1 FROM trades
               WHERE account_id = $1 AND instrument = $2 AND direction = $3
                 AND status IN ('open', 'pending') LIMIT 1`,
              [accountIdStr, instrumentFinal, oppositeDirection]
            )
            if (hedgeCheck.rows.length > 0) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Hedging is not allowed on this account. Close your existing ${instrumentFinal} position before opening the opposite direction.`
              })
            }
          }

          // Simplified enforcement: one open/pending position per instrument+direction.
          if (model.no_grid_trading) {
            const gridCheck = await client.query(
              `SELECT 1 FROM trades
               WHERE account_id = $1 AND instrument = $2 AND direction = $3
                 AND status IN ('open', 'pending') LIMIT 1`,
              [accountIdStr, instrumentFinal, directionFinal]
            )
            if (gridCheck.rows.length > 0) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Grid trading is not allowed on this account. You already have an open or pending ${directionFinal} order on ${instrumentFinal}.`
              })
            }
          }

          // Simplified enforcement: can't size up on the same instrument+direction
          // right after that setup closed at a loss (classic doubling-down pattern).
          if (model.no_martingale) {
            const lastClosed = await client.query(
              `SELECT lot_size, demo_pnl FROM trades
               WHERE account_id = $1 AND instrument = $2 AND direction = $3 AND status = 'closed'
               ORDER BY close_time DESC LIMIT 1`,
              [accountIdStr, instrumentFinal, directionFinal]
            )
            const lastRow = lastClosed.rows[0]
            if (lastRow && parseFloat(lastRow.demo_pnl) < 0 && lotsNum > parseFloat(lastRow.lot_size)) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Martingale trading is not allowed on this account. You cannot increase lot size after a loss on the same ${instrumentFinal} ${directionFinal} setup.`
              })
            }
          }
        }
      }

      if (rules.maxDailyTrades > 0) {
        const dailyTradesResult = await client.query(
          `SELECT COUNT(*)::int AS count
           FROM trade_logs
           WHERE account_id = $1
             AND logged_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
             AND logged_at < date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day'`,
          [accountIdStr]
        )
        const tradesToday = parseInt(dailyTradesResult.rows[0].count || 0, 10)
        if (tradesToday >= rules.maxDailyTrades) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Daily trade limit reached. You have already placed ${tradesToday} trade${tradesToday === 1 ? '' : 's'} today. Maximum allowed per account is ${rules.maxDailyTrades} per UTC day.`
          })
        }
      }

      // â”€â”€ Combined exposure check (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Funded accounts' scaling-plan multiplier raises risk capacity (lot caps)
      // proportionally — it does not change the account's literal balance.
      const scalingMultiplier = account.account_type === 'funded' && account.scaling_multiplier != null
        ? parseFloat(account.scaling_multiplier)
        : 1
      const accountSizeK = (parseFloat(account.account_size) / 1000) * (Number.isFinite(scalingMultiplier) ? scalingMultiplier : 1)

      if (COMMODITY_INSTRUMENTS.includes(instrumentFinal)) {
        const maxCommodityLots = parseFloat((accountSizeK * rules.commodityLotsPer1k).toFixed(4))
        const existingResult   = await client.query(
          `SELECT COALESCE(SUM(lot_size), 0) as total_lots
           FROM trades
           WHERE account_id = $1
             AND instrument = ANY($2::text[])
             AND status IN ('open', 'pending')`,
          [accountIdStr, COMMODITY_INSTRUMENTS]
        )
        const currentLots = parseFloat(existingResult.rows[0].total_lots)
        if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxCommodityLots) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Max combined gold+silver exposure for a $${Number(account.account_size).toLocaleString()} account is ${maxCommodityLots} lots (${rules.commodityLotsPer1k}/1k). Currently used: ${currentLots.toFixed(4)} lots. Available: ${Math.max(0, maxCommodityLots - currentLots).toFixed(4)} lots.`
          })
        }
      } else if (FOREX_INSTRUMENTS.includes(instrumentFinal)) {
        const maxForexLots   = parseFloat((accountSizeK * rules.forexLotsPer1k).toFixed(4))
        const existingResult = await client.query(
          `SELECT COALESCE(SUM(lot_size), 0) as total_lots
           FROM trades
           WHERE account_id = $1
             AND instrument = ANY($2::text[])
             AND status IN ('open', 'pending')`,
          [accountIdStr, FOREX_INSTRUMENTS]
        )
        const currentLots = parseFloat(existingResult.rows[0].total_lots)
        if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxForexLots) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Max combined forex exposure for a $${Number(account.account_size).toLocaleString()} account is ${maxForexLots} lots (${rules.forexLotsPer1k}/1k). Currently used: ${currentLots.toFixed(4)} lots. Available: ${Math.max(0, maxForexLots - currentLots).toFixed(4)} lots.`
          })
        }
      }

      // â”€â”€ Max simultaneous open trades cap (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const maxOpenTrades = rules.maxOpenPositions
      const openTradeCountResult = await client.query(
        `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status IN ('open', 'pending')`,
        [accountIdStr]
      )
      const currentOpenCount = parseInt(openTradeCountResult.rows[0].count)
      if (currentOpenCount >= maxOpenTrades) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Maximum of ${maxOpenTrades} simultaneous open/pending trades allowed for a $${Number(account.account_size).toLocaleString()} account. You currently have ${currentOpenCount}. Close some trades before opening new ones.`
        })
      }

      // â”€â”€ Margin check (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const margin = calculateMargin(instrumentFinal, lotsNum)
      
      let floatingPnl = new Decimal(0)
      const livePrices = await getCurrentPricesForTenant()
      const openTradesResult = await client.query(
        `SELECT t.direction, t.open_price, t.lot_size, t.instrument, t.commission
         FROM trades t
         WHERE t.account_id = $1 AND t.status = 'open'`,
        [accountIdStr]
      )
      for (const t of openTradesResult.rows) {
        const livePrice = livePrices[t.instrument]
        if (!livePrice) continue
        const currentPrice = t.direction === 'buy' ? parseFloat(livePrice.bid) : parseFloat(livePrice.ask)
        floatingPnl = floatingPnl.plus(calculatePnL(t.direction, parseFloat(t.open_price), currentPrice, parseFloat(t.lot_size), t.instrument, parseFloat(t.commission || 0)))
      }
      
      const equity = new Decimal(account.current_balance).plus(floatingPnl)
      const requiredMargin = new Decimal(calculateUsedMargin(openTradesResult.rows)).plus(margin)
      
      if (requiredMargin.gt(equity)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Insufficient equity. Required margin: $${requiredMargin.toFixed(2)}, Available Equity: $${equity.toFixed(2)}` })
      }

      const demo_trade_id = uuidv4()
      const commissionPerLot = resolveTieredInstrumentSetting(rules.commissionPerLotJson, account.account_type, instrumentFinal, rules.dynamicCommissionPerLot)
      const tradeCommission = parseFloat((lotsNum * commissionPerLot).toFixed(2))

      async function ensureTradeOpenIdempotencyClaim() {
        if (idempotencyClaim) return null

        const idempotencyResult = await beginIdempotentRequest(pool, {
          scope: 'trades:open',
          actorId: req.user.userId,
          idempotencyKey: getIdempotencyKey(req)
        })

        if (idempotencyResult.replay) {
          return {
            status: idempotencyResult.responseStatus,
            body: idempotencyResult.responseBody
          }
        }
        if (idempotencyResult.inProgress) {
          return {
            status: 409,
            body: { error: 'This trade-open request is already being processed.' }
          }
        }

        idempotencyClaim = idempotencyResult.claimId || null
        return null
      }

      // â”€â”€ Pending order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (isPending) {
        const p = parseFloat(pending_price)
        const price = await getLivePrice(instrumentFinal).catch(() => null)
        const bid = price ? parseFloat(price.bid) : NaN
        const ask = price ? parseFloat(price.ask) : NaN

        const validationError = validatePendingOrderPrice(orderTypeFinal, p, bid, ask)
        if (validationError) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: validationError })
        }
        if (ocoSiblingConfig) {
          const siblingValidationError = validatePendingOrderPrice(
            ocoSiblingConfig.order_type,
            ocoSiblingConfig.pending_price,
            bid,
            ask
          )
          if (siblingValidationError) {
            await client.query('ROLLBACK')
            return res.status(400).json({ error: `OCO sibling invalid: ${siblingValidationError}` })
          }
        }
        const pendingClaimResult = await ensureTradeOpenIdempotencyClaim()
        if (pendingClaimResult) {
          await client.query('ROLLBACK')
          return res.status(pendingClaimResult.status).json(pendingClaimResult.body)
        }
        const ocoGroupId = ocoSiblingConfig ? uuidv4() : null
        newTrade = await client.query(
          `INSERT INTO trades
           (account_id, demo_trade_id, instrument, direction, lot_size,
            status, stop_loss, take_profit, order_type, pending_price, commission, original_commission,
            oco_group_id)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $10, $11)
           RETURNING *`,
          [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, lotsNum,
           stop_loss   ? parseFloat(stop_loss)   : null,
           take_profit ? parseFloat(take_profit) : null,
           orderTypeFinal,
           parseFloat(pending_price),
           tradeCommission,
           ocoGroupId]
        )
        if (screenshot_data_url) {
          const openScreenshotPath = await persistTradeScreenshot({
            tradeId: newTrade.rows[0].id,
            userId: req.user.userId,
            kind: 'open',
            dataUrl: screenshot_data_url
          })
          if (openScreenshotPath) {
            await client.query(`UPDATE trades SET open_screenshot_path = $1 WHERE id = $2`, [openScreenshotPath, newTrade.rows[0].id])
            newTrade.rows[0].open_screenshot_path = openScreenshotPath
          }
        }
        let siblingTradeId = null
        if (ocoSiblingConfig && ocoGroupId) {
          const siblingTrade = await client.query(
            `INSERT INTO trades
             (account_id, demo_trade_id, instrument, direction, lot_size,
              status, stop_loss, take_profit, order_type, pending_price, commission, original_commission,
              oco_group_id)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $10, $11)
             RETURNING *`,
            [accountIdStr, uuidv4(), instrumentFinal, ocoSiblingConfig.direction, lotsNum,
             stop_loss   ? parseFloat(stop_loss)   : null,
             take_profit ? parseFloat(take_profit) : null,
             ocoSiblingConfig.order_type,
             ocoSiblingConfig.pending_price,
             tradeCommission,
             ocoGroupId]
          )
          siblingTradeId = siblingTrade.rows[0]?.id || null
        }
        await client.query(
          `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [newTrade.rows[0].id, req.user.userId, accountIdStr, tradeIp]
        )
        await client.query('COMMIT')

        const tradeRow = newTrade.rows[0]

        const responseBody = {
          message: `${orderTypeFinal.replace(/_/g, ' ')} order placed`,
          trade_id: tradeRow.id,
          account_id: tradeRow.account_id,
          trade: tradeRow,
          oco_sibling_trade_id: siblingTradeId
        }
        if (idempotencyClaim) {
          await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
          idempotencyClaim = null
        }
        return res.status(201).json(responseBody)
      }

      // â”€â”€ Market order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const price = await getLivePrice(instrumentFinal)
      const priceAgeMs = Date.now() - new Date(price.updated_at).getTime()
      // Allow up to 10 seconds for price age (more lenient for slower MT5 setups)
      if (priceAgeMs > 10000) {
        logger.warn('Price feed too old:', { instrument: instrumentFinal, ageMs: priceAgeMs })
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Price feed is currently delayed. Order rejected due to volatility protection/latency.' })
      }
      let open_price = directionFinal === 'buy' ? parseFloat(price.ask) : parseFloat(price.bid)

      let slippageIncurred = 0
      const openSlippageMaxPipsAdverse = resolveTieredInstrumentSetting(rules.slippageMaxPipsAdverseJson, account.account_type, instrumentFinal, rules.slippageMaxPipsAdverse)
      if (rules.slippageSimulatorEnabled && openSlippageMaxPipsAdverse > 0) {
        const randPips = Math.random() * openSlippageMaxPipsAdverse
        slippageIncurred = parseFloat(randPips.toFixed(2))
        const slippageAmt = randPips * getPipSize(instrumentFinal)

        open_price = directionFinal === 'buy' ? open_price + slippageAmt : open_price - slippageAmt
        open_price = roundPrice(open_price, instrumentFinal)
      }

      if (stop_loss) {
        if (directionFinal === 'buy'  && parseFloat(stop_loss) >= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Stop loss must be below entry price for BUY trades' })
        }
        if (directionFinal === 'sell' && parseFloat(stop_loss) <= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Stop loss must be above entry price for SELL trades' })
        }
      }

      if (take_profit) {
        if (directionFinal === 'buy'  && parseFloat(take_profit) <= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Take profit must be above entry price for BUY trades' })
        }
        if (directionFinal === 'sell' && parseFloat(take_profit) >= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Take profit must be below entry price for SELL trades' })
        }
      }

      const marketClaimResult = await ensureTradeOpenIdempotencyClaim()
      if (marketClaimResult) {
        await client.query('ROLLBACK')
        return res.status(marketClaimResult.status).json(marketClaimResult.body)
      }

      newTrade = await client.query(
        `INSERT INTO trades
         (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
          status, stop_loss, take_profit, order_type, commission, original_commission, slippage_pips)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'open', $7, $8, 'market', $9, $9, $10)
         RETURNING *`,
        [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, lotsNum, open_price,
         stop_loss   ? parseFloat(stop_loss)   : null,
         take_profit ? parseFloat(take_profit) : null,
         tradeCommission,
         slippageIncurred]
      )

      if (screenshot_data_url) {
        const openScreenshotPath = await persistTradeScreenshot({
          tradeId: newTrade.rows[0].id,
          userId: req.user.userId,
          kind: 'open',
          dataUrl: screenshot_data_url
        })
        if (openScreenshotPath) {
          await client.query(`UPDATE trades SET open_screenshot_path = $1 WHERE id = $2`, [openScreenshotPath, newTrade.rows[0].id])
          newTrade.rows[0].open_screenshot_path = openScreenshotPath
        }
      }

      await client.query(
        `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [newTrade.rows[0].id, req.user.userId, accountIdStr, tradeIp]
      )

      await client.query('COMMIT')

    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    const tradeRow = newTrade.rows[0]
    const responseBody = {
      message: 'Trade opened successfully',
      trade_id: tradeRow.id,
      account_id: tradeRow.account_id,
      trade: tradeRow
    }
    if (idempotencyClaim) {
      await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
      idempotencyClaim = null
    }
    res.status(201).json(responseBody)

    // â”€â”€ IP logging on trade open (non-fatal, runs after response) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  } catch (error) {
    if (idempotencyClaim) {
      await abandonIdempotentRequest(pool, idempotencyClaim).catch(() => {})
    }
    logger.error('Open trade error:', { error: error.message })
    if (error?.code === 'PRICE_NOT_AVAILABLE') {
      return res.status(400).json({ error: 'This instrument is currently unavailable for your tenant feed.' })
    }
    res.status(500).json({ error: 'Could not open trade' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/close
//
// FIX (Bug 1): Wrapped trade close + balance update in a single transaction
// with FOR UPDATE SKIP LOCKED on the trade row. This prevents:
// (a) balance corruption if one query succeeds but the other fails
// (b) double-close race with the background checkSLTP checker
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// FIX (LOOPHOLE 1): Rate limit trade close to prevent DoS flooding
const tradeCloseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many close requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/close', authenticateToken, tradeCloseLimiter, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()

    const { trade_id, close_lots, screenshot_data_url } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
    }
    if (screenshot_data_url != null && !isValidImageDataUrl(screenshot_data_url)) {
      return res.status(400).json({ error: 'Invalid screenshot data' })
    }

    // Pre-flight check (outside transaction) for quick rejection
    const tradeResult = await pool.query(
      `SELECT t.*, t.original_commission, a.user_id, a.account_type FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    const trade = tradeResult.rows[0]

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
    const rules = await getTradingRules()
    const { minHoldSeconds } = rules
    if (secondsOpen < minHoldSeconds) {
      return res.status(400).json({
        error: `Minimum trade duration is ${minHoldSeconds} seconds. Please wait ${Math.ceil(minHoldSeconds - secondsOpen)} more seconds.`
      })
    }

    // ── Market hours check — block manual close on weekend / rollover ──────────
    const closeMarketStatus = getMarketStatus(trade.instrument, { purpose: 'close' })
    if (!closeMarketStatus.open) {
      return res.status(400).json({ error: `Cannot close trade: ${closeMarketStatus.reason}` })
    }

    const price = await getLivePrice(trade.instrument)
    const priceAgeMs = Date.now() - new Date(price.updated_at).getTime()
    // Allow up to 10 seconds for price age (more lenient for slower MT5 setups)
    if (priceAgeMs > 10000) {
      logger.warn('Price feed too old on close:', { instrument: trade.instrument, ageMs: priceAgeMs })
      return res.status(400).json({ error: 'Price feed is currently delayed. Close rejected due to volatility protection/latency.' })
    }
    
    // BUY closes at BID, SELL closes at ASK
    let close_price = trade.direction === 'buy'
      ? parseFloat(price.bid)
      : parseFloat(price.ask)

    const closeSlippageMaxPipsAdverse = resolveTieredInstrumentSetting(rules.slippageMaxPipsAdverseJson, trade.account_type, trade.instrument, rules.slippageMaxPipsAdverse)
    if (rules.slippageSimulatorEnabled && closeSlippageMaxPipsAdverse > 0) {
      const randPips = Math.random() * closeSlippageMaxPipsAdverse
      const slippageAmt = randPips * getPipSize(trade.instrument)

      close_price = trade.direction === 'buy' ? close_price - slippageAmt : close_price + slippageAmt
      close_price = roundPrice(close_price, trade.instrument)
    }

    let demo_pnl = 0
    let isPartial = false
    let remainingLotsNum = 0
    let closedTradeId = null
    const requestedCloseLots = close_lots == null ? null : parseFloat(close_lots)

    if (requestedCloseLots != null && !Number.isFinite(requestedCloseLots)) {
      return res.status(400).json({ error: 'Invalid close amount' })
    }

    // FIX (Bug 1): Transaction with row-level lock
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Lock the trade row â€” skip if already being processed by checkSLTP
      let lockResult = { rows: [] }
      for (let attempt = 0; attempt < 2; attempt++) {
        lockResult = await client.query(
          `SELECT id, account_id, instrument, direction, lot_size, open_price, open_time,
                  commission, original_commission
           FROM trades
           WHERE id = $1 AND status = 'open'
           FOR UPDATE SKIP LOCKED`,
          [trade_id]
        )
        if (lockResult.rows.length > 0) break
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 150))
        }
      }
      if (lockResult.rows.length === 0) {
        const currentTradeState = await client.query(
          `SELECT id, status FROM trades WHERE id = $1`,
          [trade_id]
        )
        await client.query('ROLLBACK')
        if (currentTradeState.rows.length > 0) {
          const currentStatus = currentTradeState.rows[0].status
          return res.status(409).json({
            error: currentStatus === 'open'
              ? 'Trade is already being updated. Please try again in a moment.'
              : 'Trade was already processed. Refreshing latest trade state.',
            code: currentStatus === 'open' ? 'TRADE_BUSY' : 'TRADE_ALREADY_PROCESSED'
          })
        }
        return res.status(404).json({ error: 'Trade not found or already closed' })
      }

      const lockedTrade = lockResult.rows[0]
      const currentLotSizeDec = new Decimal(lockedTrade.lot_size)
      const minLotSize = parseFloat(rules.minLotSize || 0.01)
      const closeLotsDec = requestedCloseLots == null
        ? currentLotSizeDec
        : new Decimal(requestedCloseLots)

      if (!closeLotsDec.isFinite() || closeLotsDec.lte(0) || closeLotsDec.gt(currentLotSizeDec)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Invalid close amount' })
      }

      const closeLotsNum = closeLotsDec.toNumber()
      if (!isValidLotSize(closeLotsNum)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Close amount must be in 0.01 lot steps' })
      }

      const remainingLotsDec = currentLotSizeDec.minus(closeLotsDec).toDecimalPlaces(2)
      remainingLotsNum = remainingLotsDec.toNumber()
      isPartial = remainingLotsNum > 0

      if (isPartial) {
        if (remainingLotsNum < minLotSize || !isValidLotSize(remainingLotsNum)) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Partial close must leave at least ${minLotSize.toFixed(2)} lots open`
          })
        }
      }

      const ratio = closeLotsDec.div(currentLotSizeDec)
      const originalCommissionDec = new Decimal(lockedTrade.commission ?? lockedTrade.original_commission ?? 0)
      const partialCommission = originalCommissionDec.times(ratio).toDecimalPlaces(2).toNumber()
      const remainingCommission = originalCommissionDec.minus(partialCommission).toDecimalPlaces(2).toNumber()

      demo_pnl = calculatePnL(
        lockedTrade.direction,
        parseFloat(lockedTrade.open_price),
        close_price,
        closeLotsNum,
        lockedTrade.instrument,
        partialCommission
      )

      if (isPartial) {
        const partialTradeDemoId = uuidv4()
        // Log child closed trade
        const partialCloseResult = await client.query(
          `INSERT INTO trades (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
           status, close_price, close_time, demo_pnl, close_reason, commission, original_commission, parent_trade_id, is_partial,
           close_screenshot_path)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'closed', $8, NOW(), $9, 'Manual Partial Close', $10, $10, $11, true, NULL)
           RETURNING id`,
          [
            lockedTrade.account_id,
            partialTradeDemoId,
            lockedTrade.instrument,
            lockedTrade.direction,
            closeLotsNum,
            lockedTrade.open_price,
            lockedTrade.open_time,
            close_price,
            demo_pnl,
            partialCommission,
            trade_id
          ]
        )
        closedTradeId = partialCloseResult.rows[0]?.id || null
        // Shrink the current open trade
        await client.query(
          `UPDATE trades SET lot_size = $1, commission = $2 WHERE id = $3`,
          [remainingLotsNum, remainingCommission, trade_id]
        )
      } else {
        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Manual Close'
           WHERE id = $3`,
          [close_price, demo_pnl, trade_id]
        )
        closedTradeId = trade_id
      }

      if (screenshot_data_url && closedTradeId) {
        const screenshotPath = await persistTradeScreenshot({
          tradeId: closedTradeId,
          userId: req.user.userId,
          kind: 'close',
          dataUrl: screenshot_data_url
        })
        if (screenshotPath) {
          await client.query(`UPDATE trades SET close_screenshot_path = $1 WHERE id = $2`, [screenshotPath, closedTradeId])
        }
      }

      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [demo_pnl, lockedTrade.account_id]
      )

      await client.query('COMMIT')
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    if (req.app.get('io')) {
      req.app.get('io').to(String(trade.user_id)).emit('account_update', {
        message: `${isPartial ? 'Trade partially closed' : 'Trade closed'} on ${trade.instrument}: ${demo_pnl >= 0 ? '+' : ''}$${demo_pnl.toFixed(2)}`,
        pnl: demo_pnl
      })
    }

    res.json({
      message: isPartial ? 'Trade partially closed successfully' : 'Trade closed successfully',
      pnl: demo_pnl,
      close_price,
      is_partial: isPartial,
      remaining_lots: remainingLotsNum
    })

  } catch (error) {
    logger.error('Close trade error:', { error: error.message })
    res.status(500).json({ error: 'Could not close trade' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/cancel   (cancel a pending order)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/cancel', authenticateToken, tradeCloseLimiter, async function(req, res) {
  try {
    const { trade_id } = req.body

    if (!trade_id) return res.status(400).json({ error: 'Trade ID required' })

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'pending'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pending order not found' })
    }

    if (tradeResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    // Race-safe cancel: only cancel if still pending (prevents double-cancel)
    const cancelResult = await pool.query(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = 'Cancelled by trader'
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [trade_id]
    )

    if (cancelResult.rowCount === 0) {
      return res.status(409).json({ error: 'Pending order was already processed' })
    }

    res.json({ message: 'Order cancelled' })

  } catch (error) {
    logger.error('Cancel order error:', { error: error.message })
    res.status(500).json({ error: 'Could not cancel order' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// PATCH /api/trades/modify  (update SL/TP on open trade)
// FIX: Added rate limiter â€” 60 modifications per minute per user is generous
// for legitimate use but prevents bot-level abuse that would hammer the DB.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const tradeModifyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many modify requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? String(req.user.userId) : 'anon'
})

// PATCH /api/trades/modify-pending  (adjust price/SL/TP on a pending order)
router.patch('/modify-pending', authenticateToken, tradeModifyLimiter, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { trade_id, pending_price, stop_loss, take_profit } = req.body

    if (!trade_id) return res.status(400).json({ error: 'Trade ID required' })

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.id = $1 AND t.status = 'pending'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pending order not found or already processed' })
    }

    const trade = tradeResult.rows[0]

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const prices = await getLivePriceMap()
    const price = prices[trade.instrument]
    const bid = price ? parseFloat(price.bid) : NaN
    const ask = price ? parseFloat(price.ask) : NaN

    const nextPendingPrice = pending_price != null ? parseFloat(pending_price) : parseFloat(trade.pending_price)
    const priceError = validatePendingOrderPrice(trade.order_type, nextPendingPrice, bid, ask)
    if (priceError) return res.status(400).json({ error: priceError })

    const updates = []
    const vals = []
    let idx = 1
    if (pending_price != null) { updates.push('pending_price = $' + idx++); vals.push(nextPendingPrice) }
    if (stop_loss != null)     { updates.push('stop_loss = $' + idx++);     vals.push(parseFloat(stop_loss)) }
    if (take_profit != null)   { updates.push('take_profit = $' + idx++);   vals.push(parseFloat(take_profit)) }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' })
    updates.push('updated_at = NOW()')
    vals.push(trade_id)

    const updated = await pool.query(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${idx} AND status = 'pending' RETURNING *`,
      vals
    )
    if (updated.rowCount === 0) return res.status(409).json({ error: 'Trade was already processed' })
    const row = updated.rows[0]

    res.json({ message: 'Pending order updated', trade: row })

  } catch (error) {
    logger.error('Modify pending order error:', { error: error.message })
    res.status(500).json({ error: 'Could not modify pending order' })
  }
})

router.patch('/modify', authenticateToken, tradeModifyLimiter, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()

    const {
      trade_id,
      stop_loss,
      take_profit,
      move_to_breakeven
    } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
    }

    if (
      stop_loss === undefined
      && take_profit === undefined
      && !move_to_breakeven
    ) {
      return res.status(400).json({ error: 'Provide at least one trade modification field' })
    }

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    const trade      = tradeResult.rows[0]
    const open_price = parseFloat(trade.open_price)

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    // FIX (BUG-M7): Added minimum distance enforcement for SL/TP modification.
    // Prevents setting SL/TP so close to entry that they trigger immediately or
    // are used to game the system. Distance now comes from per-instrument metadata
    // so JPY pairs and indices use the correct quote precision as well.
    const MIN_DISTANCE = getMinDistance(trade.instrument)

    if (stop_loss !== undefined && stop_loss !== '' && stop_loss !== null && !move_to_breakeven) {
      const sl = parseFloat(stop_loss)
      if (isNaN(sl)) return res.status(400).json({ error: 'Invalid stop loss value' })
      if (trade.direction === 'buy'  && sl >= open_price) return res.status(400).json({ error: 'Stop loss must be below entry price for BUY trades' })
      if (trade.direction === 'sell' && sl <= open_price) return res.status(400).json({ error: 'Stop loss must be above entry price for SELL trades' })
      if (Math.abs(open_price - sl) < MIN_DISTANCE) return res.status(400).json({ error: `Stop loss must be at least ${MIN_DISTANCE} away from entry price` })
    }

    if (take_profit !== undefined && take_profit !== '' && take_profit !== null) {
      const tp = parseFloat(take_profit)
      if (isNaN(tp)) return res.status(400).json({ error: 'Invalid take profit value' })
      if (trade.direction === 'buy'  && tp <= open_price) return res.status(400).json({ error: 'Take profit must be above entry price for BUY trades' })
      if (trade.direction === 'sell' && tp >= open_price) return res.status(400).json({ error: 'Take profit must be below entry price for SELL trades' })
      if (Math.abs(open_price - tp) < MIN_DISTANCE) return res.status(400).json({ error: `Take profit must be at least ${MIN_DISTANCE} away from entry price` })
    }

    const updates = []
    const values  = []
    let idx = 1

    if (move_to_breakeven) {
      updates.push(`stop_loss = $${idx++}`)
      values.push(roundPrice(open_price, trade.instrument))
    } else if (stop_loss !== undefined) {
      updates.push(`stop_loss = $${idx++}`)
      values.push(stop_loss === '' || stop_loss === null ? null : parseFloat(stop_loss))
    }

    if (take_profit !== undefined) {
      updates.push(`take_profit = $${idx++}`)
      values.push(take_profit === '' || take_profit === null ? null : parseFloat(take_profit))
    }

    values.push(trade_id)
    const modResult = await pool.query(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${idx} AND status = 'open'`,
      values
    )
    if (modResult.rowCount === 0) {
      return res.status(409).json({ error: 'Trade was already processed' })
    }

    res.json({ message: 'Trade modified successfully' })

  } catch (error) {
    logger.error('Modify trade error:', { error: error.message })
    res.status(500).json({ error: 'Could not modify trade' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/open
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/open', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, stop_loss,
              take_profit, status, demo_pnl, open_time, close_time, close_reason, order_type,
              open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status = 'open' ORDER BY open_time DESC`,
      [account_id]
    )

    res.json(trades.rows.map(mapTradeRow))
  } catch (error) {
    logger.error('Open trades error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch open trades' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/pending
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/pending', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, pending_price, order_type,
              status, open_time, demo_trade_id, stop_loss, take_profit,
              oco_group_id, open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status = 'pending' ORDER BY open_time DESC`,
      [account_id]
    )

    res.json(trades.rows.map(mapTradeRow))
  } catch (error) {
    logger.error('Pending orders error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch pending orders' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/history
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/history', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type, pending_price, open_screenshot_path, close_screenshot_path
       FROM trades WHERE account_id = $1 AND status NOT IN ('open', 'pending') ORDER BY close_time DESC`,
      [account_id]
    )

    res.json(trades.rows.map(mapTradeRow))
  } catch (error) {
    logger.error('Trade history error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trade history' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/trades/export â€” download full trade history as CSV
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/export', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    const { account_id } = req.query
    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id, account_type, account_size FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const acc = accountCheck.rows[0]

    const tradesResult = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades
       WHERE account_id = $1
       AND status NOT IN ('open', 'pending')
       ORDER BY close_time DESC`,
      [account_id]
    )

    const trades = tradesResult.rows

    const headers = [
      'ID', 'Instrument', 'Direction', 'Lots',
      'Open Price', 'Close Price', 'Open Time', 'Close Time',
      'P&L', 'Close Reason', 'Order Type'
    ]

    const rows = trades.map(t => [
      t.id,
      t.instrument,
      t.direction,
      parseFloat(t.lot_size).toFixed(2),
      t.open_price  ? formatPrice(t.open_price, t.instrument)  : '',
      t.close_price ? formatPrice(t.close_price, t.instrument) : '',
      t.open_time   ? new Date(t.open_time).toISOString()  : '',
      t.close_time  ? new Date(t.close_time).toISOString() : '',
      t.demo_pnl    ? parseFloat(t.demo_pnl).toFixed(2)    : '0.00',
      t.close_reason || 'Manual',
      t.order_type  || 'market'
    ])

    // FIX (Bug 12): Sanitize CSV values to prevent formula injection
    function csvSafeValue(val) {
      let str = String(val).replace(/"/g, '""')
      // Prefix formula-triggering characters with a single quote
      if (/^[=+\-@\t\r]/.test(str)) str = "'" + str
      return `"${str}"`
    }

    const csvContent = [headers, ...rows]
      .map(row => row.map(v => csvSafeValue(v)).join(','))
      .join('\r\n')

    const filename = `trades_${acc.account_type}_${acc.account_size}_${new Date().toISOString().slice(0,10)}.csv`

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csvContent)

  } catch (error) {
    logger.error('Trade export error:', { error: error.message })
    res.status(500).json({ error: 'Could not export trades' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ANALYTICS_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ANALYTICS_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

function toFiniteNumber(value, fallback = 0) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toSafeDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function computeDaysRemainingForAnalytics(value) {
  const date = toSafeDate(value)
  if (!date) return null
  const diffMs = date.getTime() - Date.now()
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)))
}

function computeTradeDurationMinutes(trade) {
  const openTime = toSafeDate(trade?.open_time)
  const closeTime = toSafeDate(trade?.close_time)
  if (!openTime || !closeTime) return null
  const duration = (closeTime.getTime() - openTime.getTime()) / (1000 * 60)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function getAnalyticsSessionMeta(value) {
  const date = toSafeDate(value)
  const hour = date ? date.getUTCHours() : null
  if (!Number.isFinite(hour)) {
    return { key: 'unknown', label: 'Unknown', order: 99 }
  }
  if (hour < 8) return { key: 'asia', label: 'Asia', order: 0 }
  if (hour < 13) return { key: 'london', label: 'London', order: 1 }
  if (hour < 21) return { key: 'new_york', label: 'New York', order: 2 }
  return { key: 'rollover', label: 'Rollover', order: 3 }
}

function buildPerformanceBreakdown(trades, bucketFactory) {
  const map = new Map()

  for (const trade of trades) {
    const bucket = bucketFactory(trade) || {}
    const key = String(bucket.key || bucket.label || 'unknown')
    const label = String(bucket.label || bucket.key || 'Unknown')
    const pnl = toFiniteNumber(trade.demo_pnl)
    const durationMins = computeTradeDurationMinutes(trade)

    const entry = map.get(key) || {
      key,
      label,
      order: Number.isFinite(bucket.order) ? bucket.order : Number.MAX_SAFE_INTEGER,
      trades: 0,
      wins: 0,
      losses: 0,
      total_pnl: 0,
      total_hold_mins: 0,
      hold_samples: 0
    }

    entry.trades += 1
    if (pnl > 0) entry.wins += 1
    if (pnl < 0) entry.losses += 1
    entry.total_pnl += pnl
    if (Number.isFinite(durationMins)) {
      entry.total_hold_mins += durationMins
      entry.hold_samples += 1
    }

    map.set(key, entry)
  }

  return Array.from(map.values())
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      order: entry.order,
      trades: entry.trades,
      wins: entry.wins,
      losses: entry.losses,
      total_pnl: parseFloat(entry.total_pnl.toFixed(2)),
      avg_pnl: entry.trades ? parseFloat((entry.total_pnl / entry.trades).toFixed(2)) : 0,
      win_rate: entry.trades ? parseFloat(((entry.wins / entry.trades) * 100).toFixed(1)) : 0,
      avg_hold_mins: entry.hold_samples ? parseFloat((entry.total_hold_mins / entry.hold_samples).toFixed(1)) : null
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      if (b.total_pnl !== a.total_pnl) return b.total_pnl - a.total_pnl
      return b.trades - a.trades
    })
}

function buildActivityHeatmap(trades) {
  const weekdays = ANALYTICS_WEEKDAY_ORDER.map((index) => ANALYTICS_WEEKDAY_LABELS[index])
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))
  const dayMap = new Map()

  for (const dayIndex of ANALYTICS_WEEKDAY_ORDER) {
    const label = ANALYTICS_WEEKDAY_LABELS[dayIndex]
    dayMap.set(dayIndex, {
      day_index: dayIndex,
      day_label: label,
      total_trades: 0,
      total_pnl: 0,
      slots: hours.map((hour) => ({ hour, trades: 0, pnl: 0 }))
    })
  }

  const hourlyTotals = hours.map((hour) => ({ hour, trades: 0, pnl: 0 }))

  for (const trade of trades) {
    const openTime = toSafeDate(trade.open_time)
    if (!openTime) continue
    const pnl = toFiniteNumber(trade.demo_pnl)
    const dayIndex = openTime.getUTCDay()
    const hourIndex = openTime.getUTCHours()
    const dayEntry = dayMap.get(dayIndex)
    if (!dayEntry || !dayEntry.slots[hourIndex]) continue

    dayEntry.total_trades += 1
    dayEntry.total_pnl += pnl
    dayEntry.slots[hourIndex].trades += 1
    dayEntry.slots[hourIndex].pnl += pnl
    hourlyTotals[hourIndex].trades += 1
    hourlyTotals[hourIndex].pnl += pnl
  }

  const matrix = ANALYTICS_WEEKDAY_ORDER.map((index) => {
    const entry = dayMap.get(index)
    return {
      day_index: index,
      day_label: entry.day_label,
      total_trades: entry.total_trades,
      total_pnl: parseFloat(entry.total_pnl.toFixed(2)),
      slots: entry.slots.map((slot) => ({
        hour: slot.hour,
        trades: slot.trades,
        pnl: parseFloat(slot.pnl.toFixed(2))
      }))
    }
  })

  const weekdaySummary = matrix
    .map((row) => ({
      label: row.day_label,
      trades: row.total_trades,
      total_pnl: row.total_pnl
    }))
    .sort((a, b) => b.total_pnl - a.total_pnl)

  const hourlySummary = hourlyTotals.map((slot) => ({
    hour: slot.hour,
    trades: slot.trades,
    total_pnl: parseFloat(slot.pnl.toFixed(2))
  }))

  return {
    weekdays,
    hours,
    matrix,
    weekday_summary: weekdaySummary,
    hourly_summary: hourlySummary
  }
}

function buildEquityCurveRanges(curve) {
  if (!Array.isArray(curve) || curve.length === 0) {
    return { day: [], week: [], month: [], full: [] }
  }

  const lastPointDate = toSafeDate(curve[curve.length - 1]?.date) || new Date()
  const filterByDays = (days) => curve.filter((point) => {
    const pointDate = toSafeDate(point.date)
    if (!pointDate) return false
    return (lastPointDate.getTime() - pointDate.getTime()) <= (days * 24 * 60 * 60 * 1000)
  })

  return {
    day: filterByDays(1),
    week: filterByDays(7),
    month: filterByDays(30),
    full: curve
  }
}

function percentile(sortedValues, percentileValue) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(percentileValue * (sortedValues.length - 1))))
  return sortedValues[index]
}

function buildHoldTimeAnalytics(trades, symbolBreakdown, strategyBreakdown, minHoldSeconds) {
  const durations = trades
    .map((trade) => computeTradeDurationMinutes(trade))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)

  if (durations.length === 0) {
    return {
      average_mins: 0,
      median_mins: 0,
      winners_average_mins: 0,
      losers_average_mins: 0,
      quick_exit_rate: 0,
      overhold_rate: 0,
      quick_exit_threshold_mins: 0,
      overhold_threshold_mins: 0,
      bias_label: 'No hold-time samples yet',
      by_symbol: [],
      by_strategy: []
    }
  }

  const average = durations.reduce((sum, value) => sum + value, 0) / durations.length
  const median = durations.length % 2 === 1
    ? durations[(durations.length - 1) / 2]
    : (durations[(durations.length / 2) - 1] + durations[durations.length / 2]) / 2

  const winnerDurations = trades
    .filter((trade) => toFiniteNumber(trade.demo_pnl) > 0)
    .map((trade) => computeTradeDurationMinutes(trade))
    .filter((value) => Number.isFinite(value))
  const loserDurations = trades
    .filter((trade) => toFiniteNumber(trade.demo_pnl) < 0)
    .map((trade) => computeTradeDurationMinutes(trade))
    .filter((value) => Number.isFinite(value))

  const winnersAverage = winnerDurations.length
    ? winnerDurations.reduce((sum, value) => sum + value, 0) / winnerDurations.length
    : 0
  const losersAverage = loserDurations.length
    ? loserDurations.reduce((sum, value) => sum + value, 0) / loserDurations.length
    : 0

  const quickExitThreshold = Math.max(5, Math.ceil((toFiniteNumber(minHoldSeconds, 60) / 60) * 2))
  const overholdThreshold = Math.max(240, Math.ceil(median * 1.75))
  const quickExits = durations.filter((value) => value <= quickExitThreshold).length
  const overholds = durations.filter((value) => value >= overholdThreshold).length

  let biasLabel = 'Your hold times are balanced across winners and losers.'
  if (winnersAverage > 0 && losersAverage > winnersAverage * 1.2) {
    biasLabel = 'Losing trades are staying open longer than winners.'
  } else if (losersAverage > 0 && winnersAverage > losersAverage * 1.2) {
    biasLabel = 'Winning trades are getting more room than losing trades.'
  } else if ((quickExits / durations.length) > 0.35) {
    biasLabel = 'A large share of trades are being closed quickly.'
  }

  return {
    average_mins: parseFloat(average.toFixed(1)),
    median_mins: parseFloat(median.toFixed(1)),
    winners_average_mins: parseFloat(winnersAverage.toFixed(1)),
    losers_average_mins: parseFloat(losersAverage.toFixed(1)),
    quick_exit_rate: parseFloat(((quickExits / durations.length) * 100).toFixed(1)),
    overhold_rate: parseFloat(((overholds / durations.length) * 100).toFixed(1)),
    quick_exit_threshold_mins: quickExitThreshold,
    overhold_threshold_mins: overholdThreshold,
    bias_label: biasLabel,
    lower_quartile_mins: parseFloat((percentile(durations, 0.25) || 0).toFixed(1)),
    upper_quartile_mins: parseFloat((percentile(durations, 0.75) || 0).toFixed(1)),
    by_symbol: (symbolBreakdown || []).filter((entry) => entry.avg_hold_mins != null).slice(0, 8),
    by_strategy: (strategyBreakdown || []).filter((entry) => entry.avg_hold_mins != null).slice(0, 8)
  }
}

function calculateCoefficientOfVariation(values) {
  if (!Array.isArray(values) || values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!Number.isFinite(mean) || mean === 0) return 0
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length
  return Math.sqrt(variance) / mean
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function toScoreGrade(score) {
  if (score >= 85) return 'A'
  if (score >= 70) return 'B'
  if (score >= 55) return 'C'
  if (score >= 40) return 'D'
  return 'E'
}

function buildDisciplineScore(trades, violations, tradingRules) {
  const maxDailyTrades = Math.max(1, parseInt(tradingRules?.max_daily_trades || 20, 10))
  const minHoldSeconds = Math.max(0, parseInt(tradingRules?.min_hold_seconds || 60, 10))
  const tradesByDay = new Map()
  const orderedByOpen = [...trades].sort((a, b) => new Date(a.open_time) - new Date(b.open_time))

  for (const trade of orderedByOpen) {
    const openTime = toSafeDate(trade.open_time)
    if (!openTime) continue
    const key = openTime.toISOString().slice(0, 10)
    tradesByDay.set(key, (tradesByDay.get(key) || 0) + 1)
  }

  const overtradingDays = Array.from(tradesByDay.values()).filter((count) => count > maxDailyTrades).length
  let revengeSequences = 0
  let impulsiveTrades = 0

  for (let index = 0; index < orderedByOpen.length; index += 1) {
    const trade = orderedByOpen[index]
    const durationMins = computeTradeDurationMinutes(trade)
    if (Number.isFinite(durationMins) && durationMins * 60 <= Math.max(300, minHoldSeconds * 2)) {
      impulsiveTrades += 1
    }

    if (index === 0) continue
    const previousTrade = orderedByOpen[index - 1]
    const previousPnl = toFiniteNumber(previousTrade.demo_pnl)
    if (previousPnl >= 0) continue

    const previousClose = toSafeDate(previousTrade.close_time)
    const currentOpen = toSafeDate(trade.open_time)
    if (!previousClose || !currentOpen) continue

    const gapMins = (currentOpen.getTime() - previousClose.getTime()) / (1000 * 60)
    const previousLots = toFiniteNumber(previousTrade.lot_size)
    const currentLots = toFiniteNumber(trade.lot_size)
    if (gapMins >= 0 && gapMins <= 15 && currentLots > previousLots * 1.1) {
      revengeSequences += 1
    }
  }

  const warningHits = (violations || []).reduce((sum, violation) => sum + Math.max(1, parseInt(violation.hit_count || 1, 10)), 0)
  const tradeCount = Math.max(1, trades.length)

  const overtradingComponent = clampScore(100 - ((overtradingDays / Math.max(1, tradesByDay.size)) * 220))
  const revengeComponent = clampScore(100 - ((revengeSequences / tradeCount) * 320))
  const warningComponent = clampScore(100 - (warningHits * 10))
  const patienceComponent = clampScore(100 - ((impulsiveTrades / tradeCount) * 180))

  const score = clampScore(
    (overtradingComponent * 0.3) +
    (revengeComponent * 0.3) +
    (warningComponent * 0.2) +
    (patienceComponent * 0.2)
  )

  const weakestComponent = [
    { key: 'overtrading', score: overtradingComponent },
    { key: 'revenge_trading', score: revengeComponent },
    { key: 'rule_warnings', score: warningComponent },
    { key: 'patience', score: patienceComponent }
  ].sort((a, b) => a.score - b.score)[0]

  const summaryByComponent = {
    overtrading: 'Trade frequency is pushing close to or beyond your daily limits.',
    revenge_trading: 'There are fast re-entries after losses with larger size.',
    rule_warnings: 'Rule warnings or enforcement events are dragging discipline down.',
    patience: 'A high share of trades are being closed quickly.'
  }

  return {
    score,
    grade: toScoreGrade(score),
    summary: summaryByComponent[weakestComponent.key] || 'Discipline is steady overall.',
    components: {
      overtrading: overtradingComponent,
      revenge_trading: revengeComponent,
      rule_warnings: warningComponent,
      patience: patienceComponent
    },
    metrics: {
      overtrading_days: overtradingDays,
      revenge_sequences: revengeSequences,
      warning_hits: warningHits,
      impulsive_trades: impulsiveTrades
    }
  }
}

function buildRiskConsistencyScore(trades) {
  const lotSizes = trades
    .map((trade) => toFiniteNumber(trade.lot_size))
    .filter((value) => value > 0)

  const plannedRiskValues = trades
    .map((trade) => {
      const openPrice = toFiniteNumber(trade.open_price, NaN)
      const stopLoss = toFiniteNumber(trade.stop_loss, NaN)
      const lotSize = toFiniteNumber(trade.lot_size, NaN)
      if (!Number.isFinite(openPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(lotSize)) {
        return null
      }
      const contractSize = CONTRACT_SIZES[trade.instrument] || 100000
      return Math.abs(openPrice - stopLoss) * lotSize * contractSize
    })
    .filter((value) => Number.isFinite(value) && value > 0)

  const lotSizeCv = calculateCoefficientOfVariation(lotSizes)
  const plannedRiskCv = calculateCoefficientOfVariation(plannedRiskValues)
  const stopLossUsagePct = trades.length
    ? parseFloat(((plannedRiskValues.length / trades.length) * 100).toFixed(1))
    : 0

  const lotSizeComponent = clampScore(100 - Math.min(85, lotSizeCv * 100))
  const plannedRiskComponent = clampScore(100 - Math.min(90, plannedRiskCv * 100))
  const stopLossComponent = clampScore(stopLossUsagePct)
  const score = clampScore((lotSizeComponent * 0.35) + (plannedRiskComponent * 0.4) + (stopLossComponent * 0.25))

  let summary = 'Sizing is fairly controlled across the sample.'
  if (plannedRiskComponent < 60) {
    summary = 'Your monetary risk per trade varies a lot even when lot sizes look similar.'
  } else if (lotSizeComponent < 60) {
    summary = 'Lot sizes are swinging enough to make risk look random.'
  } else if (stopLossComponent < 70) {
    summary = 'A meaningful share of trades are still going out without a defined stop loss.'
  }

  return {
    score,
    grade: toScoreGrade(score),
    summary,
    components: {
      lot_size_consistency: lotSizeComponent,
      planned_risk_consistency: plannedRiskComponent,
      stop_loss_usage: stopLossComponent
    },
    metrics: {
      lot_size_cv: parseFloat(lotSizeCv.toFixed(2)),
      planned_risk_cv: parseFloat(plannedRiskCv.toFixed(2)),
      stop_loss_usage_pct: stopLossUsagePct
    }
  }
}

function buildSetupReports(symbolBreakdown, sessionBreakdown, strategyBreakdown) {
  const candidates = [
    ...(strategyBreakdown || []).map((entry) => ({ ...entry, setup_type: 'Strategy' })),
    ...(symbolBreakdown || []).map((entry) => ({ ...entry, setup_type: 'Symbol' })),
    ...(sessionBreakdown || []).map((entry) => ({ ...entry, setup_type: 'Session' }))
  ].filter((entry) => entry.trades >= 2)

  const bestSetups = [...candidates]
    .sort((a, b) => b.total_pnl - a.total_pnl || b.win_rate - a.win_rate)
    .slice(0, 4)
  const worstSetups = [...candidates]
    .sort((a, b) => a.total_pnl - b.total_pnl || a.win_rate - b.win_rate)
    .slice(0, 4)

  return {
    best_setups: bestSetups,
    worst_setups: worstSetups
  }
}

function buildBreachAnalysis(account, trades, violations) {
  const currentBalance = toFiniteNumber(account.current_balance)
  const startingBalance = toFiniteNumber(account.starting_balance)
  const peakBalance = toFiniteNumber(account.peak_balance || account.starting_balance)
  const profitTarget = toFiniteNumber(account.profit_target)
  const maxDrawdownPct = toFiniteNumber(account.max_drawdown_pct, 0)
  const currentDrawdownPct = peakBalance > 0
    ? parseFloat((((peakBalance - currentBalance) / peakBalance) * 100).toFixed(2))
    : 0
  const totalDrawdownPct = startingBalance > 0
    ? parseFloat((Math.max(0, ((startingBalance - currentBalance) / startingBalance) * 100)).toFixed(2))
    : 0
  const targetProgressPct = profitTarget > 0
    ? parseFloat((Math.max(0, ((currentBalance - startingBalance) / profitTarget) * 100).toFixed(1)))
    : String(account.account_type || '').toLowerCase() === 'funded' ? 100 : 0
  const latestTrade = trades[trades.length - 1] || null
  const recentViolations = (violations || []).slice(0, 3).map((violation) => ({
    violation_type: violation.violation_type,
    severity: violation.severity,
    status: violation.status,
    message: violation.message,
    detected_at: violation.last_detected_at
  }))

  let title = 'Challenge Health'
  let primaryCause = 'monitoring'
  let explanation = 'This account is still live. The key job now is balancing target progress against drawdown usage.'

  if (String(account.status).toLowerCase() === 'failed') {
    title = 'Breach Cause'
    if (recentViolations.length > 0) {
      primaryCause = recentViolations[0].violation_type || 'rule_violation'
      explanation = recentViolations[0].message || 'A recorded rule violation pushed the account into failure.'
    } else if (maxDrawdownPct > 0 && totalDrawdownPct >= maxDrawdownPct * 0.9) {
      primaryCause = 'max_drawdown'
      explanation = `Total drawdown reached ${totalDrawdownPct.toFixed(2)}% against a ${maxDrawdownPct.toFixed(2)}% limit.`
    } else {
      primaryCause = 'account_failed'
      explanation = latestTrade?.close_reason || 'The account was closed after a failure condition was hit.'
    }
  } else if (String(account.status).toLowerCase() === 'expired') {
    title = 'Expiry Cause'
    primaryCause = 'time_limit'
    explanation = `The account expired before the profit target was completed. Progress reached ${targetProgressPct.toFixed(1)}% of target.`
  } else if (String(account.status).toLowerCase() === 'passed') {
    title = 'Pass Analysis'
    primaryCause = 'target_hit'
    explanation = 'The profit target was completed before the risk limits were breached.'
  } else if (maxDrawdownPct > 0 && totalDrawdownPct >= maxDrawdownPct * 0.7) {
    primaryCause = 'drawdown_pressure'
    explanation = `Drawdown is at ${totalDrawdownPct.toFixed(2)}% of a ${maxDrawdownPct.toFixed(2)}% max loss limit, so risk control is the main pressure right now.`
  } else if (profitTarget > 0 && targetProgressPct < 40) {
    primaryCause = 'target_distance'
    explanation = `Target progress is still only ${targetProgressPct.toFixed(1)}%, so the focus is efficient target building without forcing extra trades.`
  }

  return {
    title,
    status: account.status,
    primary_cause: primaryCause,
    explanation,
    latest_close_reason: latestTrade?.close_reason || null,
    recent_violations: recentViolations,
    review_flag_reason: account.review_flag_reason || null,
    days_remaining: computeDaysRemainingForAnalytics(account.phase_end_date),
    target_progress_pct: targetProgressPct,
    current_drawdown_pct: currentDrawdownPct,
    total_drawdown_pct: totalDrawdownPct,
    drawdown_usage_pct: maxDrawdownPct > 0 ? parseFloat(((totalDrawdownPct / maxDrawdownPct) * 100).toFixed(1)) : 0
  }
}

function buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, recentTrades) {
  const accountType = String(account.account_type || '').toLowerCase()
  const status = String(account.status || '').toLowerCase()
  const sharePct = toFiniteNumber(tenantSettings.profit_share_pct, 80)
  const shareRatio = sharePct / 100
  const minRequestAmount = toFiniteNumber(tenantSettings.min_payout_amount, 50)
  const processingDays = Math.max(1, parseInt(tenantSettings.payout_processing_days || 3, 10))
  const currentBalance = toFiniteNumber(account.current_balance)
  const startingBalance = toFiniteNumber(account.starting_balance)
  const realizedProfit = parseFloat((currentBalance - startingBalance).toFixed(2))
  const estimatedPayable = parseFloat((Math.max(0, realizedProfit) * shareRatio).toFixed(2))
  const pendingPayoutCount = (payoutRows || []).filter((row) => String(row.status).toLowerCase() === 'pending').length
  const hasOpenExposure = (openTradeSummary?.open_count || 0) > 0 || (openTradeSummary?.pending_count || 0) > 0
  const nextMilestoneProfit = shareRatio > 0 ? parseFloat((minRequestAmount / shareRatio).toFixed(2)) : minRequestAmount
  const profitGap = parseFloat(Math.max(0, nextMilestoneProfit - realizedProfit).toFixed(2))
  const recentTrendPnl = parseFloat(
    (recentTrades || [])
      .slice(-5)
      .reduce((sum, trade) => sum + toFiniteNumber(trade.demo_pnl), 0)
      .toFixed(2)
  )
  const trendLabel = recentTrendPnl > 0 ? 'improving' : recentTrendPnl < 0 ? 'cooling' : 'flat'

  const blockers = []
  if (accountType !== 'funded') blockers.push('Only funded accounts can request payouts.')
  if (status !== 'active') blockers.push(`Account status is ${account.status}.`)
  if ((userProfile?.kyc_status || '').toLowerCase() !== 'approved') blockers.push('KYC approval is still required.')
  if (hasOpenExposure) blockers.push('All open and pending trades must be closed before requesting a payout.')
  if (pendingPayoutCount > 0) blockers.push('There is already a pending payout request on this account.')
  if (estimatedPayable < minRequestAmount) blockers.push(`You need ${parseFloat((minRequestAmount - estimatedPayable).toFixed(2))} more payable profit to clear the minimum payout.`)

  return {
    eligible_now: blockers.length === 0,
    next_status: blockers.length === 0 ? 'Ready to request payout' : blockers[0],
    estimated_payable: estimatedPayable,
    realized_profit: realizedProfit,
    profit_share_pct: sharePct,
    min_request_amount: minRequestAmount,
    payout_processing_days: processingDays,
    kyc_status: userProfile?.kyc_status || 'unknown',
    open_trade_count: parseInt(openTradeSummary?.open_count || 0, 10),
    pending_order_count: parseInt(openTradeSummary?.pending_count || 0, 10),
    pending_payout_count: pendingPayoutCount,
    profit_gap_to_min_request: profitGap,
    next_profit_milestone: nextMilestoneProfit,
    days_remaining: computeDaysRemainingForAnalytics(account.phase_end_date),
    trend_label: trendLabel,
    trend_pnl_last_5_trades: recentTrendPnl,
    blockers
  }
}

function buildImprovementSuggestions(context) {
  const suggestions = []
  const {
    breakdowns,
    holdTime,
    discipline,
    riskConsistency,
    payoutForecast,
    setupReports
  } = context

  const weakestSession = (breakdowns?.session || [])
    .filter((entry) => entry.trades >= 2)
    .sort((a, b) => a.total_pnl - b.total_pnl)[0]
  if (weakestSession && weakestSession.total_pnl < 0) {
    suggestions.push({
      priority: 'high',
      title: `Trim exposure during ${weakestSession.label}`,
      detail: `${weakestSession.label} trades are down ${Math.abs(weakestSession.total_pnl).toFixed(2)} with a ${weakestSession.win_rate.toFixed(1)}% win rate. Reduce size or tighten entry quality in that session.`,
      metric: 'session_breakdown'
    })
  }

  if ((holdTime?.quick_exit_rate || 0) >= 35) {
    suggestions.push({
      priority: 'medium',
      title: 'Let valid trades breathe a little longer',
      detail: `${holdTime.quick_exit_rate.toFixed(1)}% of closed trades ended inside ${holdTime.quick_exit_threshold_mins} minutes. That often points to cutting trades before the idea has time to develop.`,
      metric: 'hold_time'
    })
  }

  if ((discipline?.score || 100) < 70) {
    suggestions.push({
      priority: 'high',
      title: 'Tighten discipline before adding more size',
      detail: `${discipline.summary} Current discipline score is ${discipline.score}/100, so the best edge right now is cleaner execution rather than more trades.`,
      metric: 'discipline_score'
    })
  }

  if ((riskConsistency?.score || 100) < 70) {
    suggestions.push({
      priority: 'high',
      title: 'Standardize risk per trade',
      detail: `${riskConsistency.summary} Use consistent stop placement and lot sizing so similar ideas risk similar dollars.`,
      metric: 'risk_consistency'
    })
  }

  const worstSetup = setupReports?.worst_setups?.[0]
  if (worstSetup && worstSetup.total_pnl < 0) {
    suggestions.push({
      priority: 'medium',
      title: `Review the weakest ${String(worstSetup.setup_type || 'setup').toLowerCase()}`,
      detail: `${worstSetup.label} has produced ${worstSetup.total_pnl.toFixed(2)} across ${worstSetup.trades} trades. Pause it or lower size until the edge is clearer.`,
      metric: 'setup_report'
    })
  }

  if (!(payoutForecast?.eligible_now)) {
    suggestions.push({
      priority: 'medium',
      title: 'Clear payout blockers early',
      detail: payoutForecast?.blockers?.[0] || 'There are still conditions to clear before the account is payout-ready.',
      metric: 'payout_forecast'
    })
  }

  if (suggestions.length === 0) {
    suggestions.push({
      priority: 'low',
      title: 'Keep compounding what is already working',
      detail: 'The data is relatively balanced right now. Stay selective, keep risk stable, and avoid forcing trades when the quality is not obvious.',
      metric: 'overall'
    })
  }

  return suggestions.slice(0, 5)
}

// GET /api/trades/analytics
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/analytics', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    await ensureViolationTables()
    const { account_id } = req.query
    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountResult = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct,
              phase_start_date, phase_end_date, created_at, review_flag_reason
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountResult.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const account = accountResult.rows[0]

    const [userResult, openTradeSummaryResult, payoutRowsResult, violationsResult, tenantSettings] = await Promise.all([
      pool.query(
        `SELECT id, email, kyc_status
           FROM users
          WHERE id = $1`,
        [req.user.userId]
      ),
      pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
           FROM trades
          WHERE account_id = $1`,
        [account_id]
      ),
      pool.query(
        `SELECT status, amount_requested, amount_payable, requested_at, paid_at
           FROM payouts
          WHERE account_id = $1
          ORDER BY requested_at DESC
          LIMIT 10`,
        [account_id]
      ),
      pool.query(
        `SELECT violation_type, severity, status, message, hit_count, last_detected_at
           FROM admin_rule_violations
          WHERE account_id = $1
          ORDER BY last_detected_at DESC
          LIMIT 25`,
        [String(account_id)]
      ),
      getTenantSettings([
        'profit_share_pct',
        'min_payout_amount',
        'payout_processing_days',
        'max_daily_trades',
        'min_hold_seconds'
      ])
    ])

    const userProfile = userResult.rows[0] || { id: req.user.userId, kyc_status: 'unknown' }
    const openTradeSummary = openTradeSummaryResult.rows[0] || { open_count: 0, pending_count: 0 }
    const payoutRows = payoutRowsResult.rows || []
    const violations = violationsResult.rows || []

    const tradesResult = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades WHERE account_id = $1 AND status = 'closed' ORDER BY close_time ASC`,
      [account_id]
    )
    const trades = tradesResult.rows

    if (trades.length === 0) {
      return res.json({
        account,
        analytics: {
          total_trades: 0,
          winning_trades: 0,
          losing_trades: 0,
          breakeven_trades: 0,
          win_rate: 0,
          total_pnl: 0,
          avg_win: 0,
          avg_loss: 0,
          profit_factor: 0,
          avg_rr: 0,
          best_trade: 0,
          worst_trade: 0,
          avg_trade_duration_mins: 0,
          drawdown_curve: [],
          equity_curve_ranges: { day: [], week: [], month: [], full: [] },
          heatmap: {},
          activity_heatmap: buildActivityHeatmap([]),
          breakdowns: {
            symbol: [],
            weekday: [],
            session: []
          },
          hold_time: buildHoldTimeAnalytics([], [], [], tenantSettings.min_hold_seconds),
          setup_report: buildSetupReports([], [], []),
          discipline_score: buildDisciplineScore([], violations, tenantSettings),
          risk_consistency_score: buildRiskConsistencyScore([]),
          breach_analysis: buildBreachAnalysis(account, [], violations),
          payout_forecast: buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, []),
          improvement_suggestions: buildImprovementSuggestions({
            breakdowns: { session: [] },
            holdTime: buildHoldTimeAnalytics([], [], [], tenantSettings.min_hold_seconds),
            discipline: buildDisciplineScore([], violations, tenantSettings),
            riskConsistency: buildRiskConsistencyScore([]),
            payoutForecast: buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, []),
            setupReports: buildSetupReports([], [], [])
          })
        }
      })
    }

    const winners   = trades.filter(t => parseFloat(t.demo_pnl) > 0)
    const losers    = trades.filter(t => parseFloat(t.demo_pnl) < 0)
    const breakeven = trades.filter(t => parseFloat(t.demo_pnl) === 0)

    const win_rate     = parseFloat(((winners.length / trades.length) * 100).toFixed(1))
    const total_pnl    = trades.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0)
    const gross_profit = winners.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0)
    const gross_loss   = Math.abs(losers.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0))

    const avg_win       = winners.length ? parseFloat((gross_profit / winners.length).toFixed(2)) : 0
    const avg_loss      = losers.length  ? parseFloat((gross_loss   / losers.length).toFixed(2))  : 0
    const profit_factor = gross_loss > 0 ? parseFloat((gross_profit / gross_loss).toFixed(2)) : gross_profit > 0 ? 999 : 0
    const avg_rr        = avg_loss > 0   ? parseFloat((avg_win / avg_loss).toFixed(2)) : 0

    const pnlValues   = trades.map(t => parseFloat(t.demo_pnl))
    const best_trade  = parseFloat(pnlValues.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(2))
    const worst_trade = parseFloat(pnlValues.reduce((a, b) => Math.min(a, b),  Infinity).toFixed(2))

    const durations = trades
      .filter(t => t.open_time && t.close_time)
      .map(t => (new Date(t.close_time) - new Date(t.open_time)) / 1000 / 60)
    const avg_trade_duration_mins = durations.length
      ? parseFloat((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1))
      : 0

    let runningBalance = parseFloat(account.starting_balance)
    let peakBalance    = runningBalance
    const drawdown_curve = trades.map(t => {
      runningBalance += parseFloat(t.demo_pnl)
      peakBalance     = Math.max(peakBalance, runningBalance)
      const drawdown  = parseFloat(((peakBalance - runningBalance) / peakBalance * 100).toFixed(2))
      return {
        date:     t.close_time,
        balance:  parseFloat(runningBalance.toFixed(2)),
        drawdown: Math.max(0, drawdown)
      }
    })

    const activityHeatmap = buildActivityHeatmap(trades)
    const heatmap = activityHeatmap.hourly_summary.reduce((acc, slot) => {
      acc[`${slot.hour}:00`] = slot.total_pnl
      return acc
    }, {})

    const symbolBreakdown = buildPerformanceBreakdown(trades, (trade) => ({
      key: trade.instrument,
      label: trade.instrument,
      order: Number.MAX_SAFE_INTEGER
    }))
    const weekdayBreakdown = buildPerformanceBreakdown(trades, (trade) => {
      const openTime = toSafeDate(trade.open_time)
      const dayIndex = openTime ? openTime.getUTCDay() : 0
      return {
        key: ANALYTICS_WEEKDAY_LABELS[dayIndex],
        label: ANALYTICS_WEEKDAY_LABELS[dayIndex],
        order: ANALYTICS_WEEKDAY_ORDER.indexOf(dayIndex)
      }
    })
    const sessionBreakdown = buildPerformanceBreakdown(trades, (trade) => getAnalyticsSessionMeta(trade.open_time))

    const holdTime = buildHoldTimeAnalytics(trades, symbolBreakdown, [], tenantSettings.min_hold_seconds)
    const setupReport = buildSetupReports(symbolBreakdown, sessionBreakdown, [])
    const disciplineScore = buildDisciplineScore(trades, violations, tenantSettings)
    const riskConsistencyScore = buildRiskConsistencyScore(trades)
    const breachAnalysis = buildBreachAnalysis(account, trades, violations)
    const payoutForecast = buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, trades)
    const improvementSuggestions = buildImprovementSuggestions({
      breakdowns: {
        symbol: symbolBreakdown,
        weekday: weekdayBreakdown,
        session: sessionBreakdown
      },
      holdTime,
      discipline: disciplineScore,
      riskConsistency: riskConsistencyScore,
      payoutForecast,
      setupReports: setupReport
    })
    const equityCurveRanges = buildEquityCurveRanges(drawdown_curve)

    res.json({
      account,
      analytics: {
        total_trades: trades.length,
        winning_trades: winners.length,
        losing_trades: losers.length,
        breakeven_trades: breakeven.length,
        win_rate,
        total_pnl: parseFloat(total_pnl.toFixed(2)),
        avg_win, avg_loss, profit_factor, avg_rr,
        best_trade, worst_trade, avg_trade_duration_mins,
        drawdown_curve,
        equity_curve_ranges: equityCurveRanges,
        heatmap,
        activity_heatmap: activityHeatmap,
        breakdowns: {
          symbol: symbolBreakdown,
          weekday: weekdayBreakdown,
          session: sessionBreakdown
        },
        hold_time: holdTime,
        setup_report: setupReport,
        discipline_score: disciplineScore,
        risk_consistency_score: riskConsistencyScore,
        breach_analysis: breachAnalysis,
        payout_forecast: payoutForecast,
        improvement_suggestions: improvementSuggestions
      }
    })

  } catch (error) {
    logger.error('Analytics error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch analytics' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/batch-action
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/batch-action', authenticateToken, tradingLimiter, async function(req, res) {
  try {
    const { action, account_id } = req.body
    if (!['close_winning', 'close_losing', 'breakeven_winning'].includes(action) || !account_id) {
      return res.status(400).json({ error: 'Invalid batch action or account ID' })
    }

    const openTradesResult = await pool.query(
      `SELECT t.* FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1 AND t.account_id = $2 AND t.status = 'open'`,
      [req.user.userId, account_id]
    )

    if (openTradesResult.rows.length === 0) {
      return res.json({ message: 'No open trades to process', affected: 0 })
    }

    // FIX: Check news protection before any batch close (same rule as manual close)
    const activeNews = newsService.getActiveNewsEvent(3)
    if (activeNews && action !== 'breakeven_winning') {
      return res.status(400).json({ error: `Cannot close trades. USD High-impact news event '${activeNews.title}' is active.` })
    }

    // Block batch closes on weekends / daily rollover (same rule as manual close)
    if (action !== 'breakeven_winning') {
      const batchMarketStatus = getMarketStatus('EURUSD', { purpose: 'close' }) // instrument-agnostic; same schedule for all
      if (!batchMarketStatus.open) {
        return res.status(400).json({ error: `Cannot close trades: ${batchMarketStatus.reason}` })
      }
    }

    const rules = await getTradingRules()
    let affectedCount = 0
    const skipped = {
      min_hold: 0,
      price_unavailable: 0,
      no_match: 0,
      locked: 0,
      error: 0
    }

    const tradeIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'
    const client = await pool.connect()
    try {
      for (const trade of openTradesResult.rows) {
        // FIX: Enforce minimum hold time on batch closes (same rule as individual close)
        if (action !== 'breakeven_winning') {
          const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
          if (secondsOpen < rules.minHoldSeconds) {
            skipped.min_hold++
            continue
          }
        }

        let currentPrice
        try {
          const priceObj = await getLivePrice(trade.instrument)
          currentPrice = trade.direction === 'buy' ? parseFloat(priceObj.bid) : parseFloat(priceObj.ask)
        } catch {
          skipped.price_unavailable++
          continue
        } // Skip if price feed down for this instrument

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        let shouldProcess = false
        if (action === 'close_winning' && demo_pnl > 0) shouldProcess = true
        if (action === 'close_losing' && demo_pnl < 0) shouldProcess = true
        if (action === 'breakeven_winning' && demo_pnl > 0) shouldProcess = true

        if (!shouldProcess) {
          skipped.no_match++
          continue
        }

        try {
          await client.query('BEGIN')
          // Lock trade row
          const lock = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
            [trade.id]
          )
          if (lock.rows.length === 0) {
            skipped.locked++
            await client.query('ROLLBACK')
            continue
          }

          if (action === 'breakeven_winning') {
            await client.query(
              `UPDATE trades SET stop_loss = $1 WHERE id = $2`,
              [trade.open_price, trade.id]
            )
            await client.query('COMMIT')
            affectedCount++
          } else {
            // Close trade logic
            await client.query(
              `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(), demo_pnl = $2, close_reason = 'Batch Close' WHERE id = $3`,
              [currentPrice, demo_pnl, trade.id]
            )
            await client.query(
              `UPDATE accounts SET current_balance = current_balance + $1, peak_balance = GREATEST(peak_balance, current_balance + $1) WHERE id = $2`,
              [demo_pnl, trade.account_id]
            )
            await client.query('COMMIT')
            affectedCount++
          }
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {})
          logger.error('Batch action trade error:', { tradeId: trade.id, error: txErr.message })
          skipped.error++
        }
      }
    } finally {
       client.release()
    }

    const attempted = openTradesResult.rows.length
    const skippedCount = Object.values(skipped).reduce((sum, value) => sum + value, 0)
    const actionLabel = action.replace(/_/g, ' ')
    let message = `Batch ${actionLabel} completed successfully`

    if (affectedCount === 0) {
      if (skipped.min_hold > 0) {
        message = `No trades closed yet. ${skipped.min_hold} trade(s) are still inside the minimum hold time.`
      } else if (skipped.no_match > 0) {
        if (action === 'close_winning') {
          message = 'No winning trades are available to close right now.'
        } else if (action === 'close_losing') {
          message = 'No losing trades are available to close right now.'
        } else {
          message = 'No profitable trades are available to move to breakeven right now.'
        }
      } else if (skipped.price_unavailable > 0) {
        message = 'Live price data is unavailable for the selected trade(s). Please try again in a moment.'
      } else {
        message = `No trades were updated for batch ${actionLabel}.`
      }
    } else if (skippedCount > 0) {
      message = `Batch ${actionLabel} completed. ${affectedCount} trade(s) updated, ${skippedCount} skipped.`
    }

    res.json({
      message,
      affected: affectedCount,
      attempted,
      skipped,
      minHoldSeconds: rules.minHoldSeconds
    })
  } catch (error) {
    logger.error('Batch action error:', { error: error.message })
    res.status(500).json({ error: 'Could not process batch action' })
  }
})



router.get('/:tradeId/screenshot/:kind', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()

    const { tradeId, kind } = req.params
    const normalizedKind = kind === 'close' ? 'close' : 'open'

    const tradeResult = await pool.query(
      `SELECT t.id, t.open_screenshot_path, t.close_screenshot_path
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.id = $1
          AND a.user_id = $2`,
      [tradeId, req.user.userId]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade screenshot not found' })
    }

    const screenshotPath = normalizedKind === 'close'
      ? tradeResult.rows[0].close_screenshot_path
      : tradeResult.rows[0].open_screenshot_path
    const absolutePath = buildTradeScreenshotAbsolutePath(screenshotPath)

    if (!absolutePath) {
      return res.status(404).json({ error: 'Trade screenshot not found' })
    }

    return res.sendFile(absolutePath)
  } catch (error) {
    logger.error('Trade screenshot error:', { error: error.message })
    return res.status(500).json({ error: 'Could not load trade screenshot' })
  }
})

module.exports = {
  router,
  checkSLTP,
  checkPendingOrders,
  checkFloatingDrawdown,
  getTradingRules,
  getMarketStatus,
  ensureTradeExperienceInfrastructure,
  calculatePnL,
  getLivePriceMap
}

