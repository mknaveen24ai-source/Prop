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
const { fetchProgressionSettings } = require('../services/progressionService')
const { tradingLimiter } = require('../utils/security')
const { isValidLotSize, sanitizeString } = require('../utils/validation')
const logger = require('../utils/logger')
// LEVERAGE and INSTRUMENTS moved out with the margin helpers and
// VALID_INSTRUMENTS — see services/tradeShared.js.
const {
  CONTRACT_SIZES,
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  getPipSize,
  getMinDistance,
  roundPrice,
  formatPrice
} = require('../constants')
const Decimal = require('decimal.js')
const newsService = require('../services/newsService')
const { getCurrentPricesForTenant } = require('../priceFeed')
const { validatePendingOrderPrice } = require('../utils/pendingOrderValidation')
const { VALID_CHART_TIMEFRAME_LABELS, getChartTimeframeMinutes } = require('../utils/chartTimeframes')
const { ensureViolationTables } = require('../services/violationEngine')
const { getTenantFeedConfig, getTenantSettings } = require('../services/tenantPolicyService')
const { resolveTieredInstrumentSetting } = require('../utils/tenantSettings')
const { calculatePnL } = require('../utils/pnlCalculator')
const {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} = require('../utils/idempotency')
// Resolved lazily so this file and services/tradeEngine.js can require each
// other's exports without depending on which one Node loads first.
let _tradeEngine = null
function engine() {
  if (!_tradeEngine) _tradeEngine = require('../services/tradeEngine')
  return _tradeEngine
}
const tradeIndex = require('../utils/tradeIndex')
const { fetchStepModelBySlug } = require('../utils/stepModels')
const {
  MAX_RAW_CANDLE_BARS,
  getCachedCandles,
  setCachedCandles,
  getRawCandleLookbackDays,
  normalizeCandleRows
} = require('../utils/tradeCandles')
const {
  toFiniteNumber,
  toSafeDate,
  computeDaysRemainingForAnalytics,
  computeTradeDurationMinutes,
  getAnalyticsSessionMeta,
  buildPerformanceBreakdown,
  buildActivityHeatmap,
  buildEquityCurveRanges,
  percentile,
  buildHoldTimeAnalytics,
  calculateCoefficientOfVariation,
  clampScore,
  toScoreGrade,
  buildDisciplineScore,
  buildRiskConsistencyScore,
  buildSetupReports,
  buildBreachAnalysis,
  buildPayoutForecast,
  buildImprovementSuggestions,
  ANALYTICS_WEEKDAY_LABELS,
  ANALYTICS_WEEKDAY_ORDER
} = require('../services/tradeAnalytics')
// Shared trading primitives. These used to be defined here, but the background
// engine needs them too — see services/tradeShared.js. Re-exported at the bottom
// of this file so existing importers keep working.
const {
  VALID_INSTRUMENTS,
  TRADE_JOURNAL_UPLOAD_ROOT,
  ensureTradeExperienceInfrastructure,
  computeRMultiple,
  getTradingRules,
  getLivePriceMap,
  getLivePrice,
  calculateMargin,
  calculateUsedMargin,
  getMarketStatus
} = require('../services/tradeShared')

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
    r_multiple: ['closed', 'cancelled'].includes(row.status) ? computeRMultiple(row) : null,
    open_screenshot_url: row.open_screenshot_path ? `/api/trades/${row.id}/screenshot/open` : null,
    close_screenshot_url: row.close_screenshot_path ? `/api/trades/${row.id}/screenshot/close` : null
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
async function getPlatformSettingsForProgression(client) {
  return fetchProgressionSettings(client)
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

        // Keep the engine's in-memory index in step with what was just written,
        // so the order can be triggered on the very next price tick rather than
        // waiting for the next reconciliation.
        await engine().syncPendingOrder(tradeRow)
        if (siblingTradeId) {
          await engine().syncPendingOrder({ ...tradeRow, id: siblingTradeId, direction: ocoSiblingConfig.direction, order_type: ocoSiblingConfig.order_type, pending_price: ocoSiblingConfig.pending_price })
        }

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

    // Index the new position (and seed its floating PnL from the current price)
    // so it is eligible for SL/TP and drawdown checks on the next tick.
    await engine().syncOpenedTrade(tradeRow)

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
    // Captured inside the transaction, applied to the engine index after COMMIT.
    let indexSync = null
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

      indexSync = {
        accountId: lockedTrade.account_id,
        remainingTrade: isPartial
          ? { ...lockedTrade, lot_size: remainingLotsNum, commission: remainingCommission }
          : null
      }
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    // Index sync — a partial close shrinks the live position rather than ending
    // it, so the entry is refreshed (new lot size and commission) instead of
    // dropped. Either way the realised PnL feeds the cached daily-loss total.
    if (indexSync) {
      if (indexSync.remainingTrade) {
        await engine().syncOpenedTrade(indexSync.remainingTrade)
        tradeIndex.applyRealizedPnl(indexSync.accountId, demo_pnl)
      } else {
        engine().syncClosedTrade(trade_id, indexSync.accountId, demo_pnl)
      }
      const accountEntry = tradeIndex.getAccountEntry(indexSync.accountId)
      if (accountEntry) {
        tradeIndex.updateAccountBalance(indexSync.accountId, accountEntry.currentBalance + demo_pnl)
      }
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

    tradeIndex.removePending(trade_id)

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

    // Re-index at the new trigger price, or the engine keeps watching the old one.
    await engine().syncPendingOrder(row)

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
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${idx} AND status = 'open'
       RETURNING id, account_id, instrument, direction, lot_size, open_price,
                 stop_loss, take_profit, commission, open_time`,
      values
    )
    if (modResult.rowCount === 0) {
      return res.status(409).json({ error: 'Trade was already processed' })
    }

    // Re-index against the new SL/TP levels — the engine compares against the
    // values it holds in memory, not the row.
    await engine().syncOpenedTrade(modResult.rows[0])

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
          avg_r_multiple: null,
          r_distribution: [],
          expectancy: 0,
          best_win_streak: 0,
          sharpe_30d: null,
          best_trade: 0,
          worst_trade: 0,
          avg_trade_duration_mins: 0,
          drawdown_curve: [],
          equity_curve_ranges: { day: [], week: [], month: [], ytd: [], full: [] },
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

    // R-multiple — a different metric from avg_rr above (that's a win/loss
    // dollar ratio; this is realized P&L against the stop-loss-defined risk
    // per trade). Only trades with a stop-loss have a defined R; the rest
    // are excluded from the average rather than counted as 0.
    const rMultiples = trades.map((t) => computeRMultiple(t)).filter((r) => r != null)
    const avg_r_multiple = rMultiples.length ? parseFloat((rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length).toFixed(2)) : null
    const r_distribution = rMultiples.map((r) => parseFloat(r.toFixed(2)))

    // Expectancy — average realized P&L per trade, over the whole set.
    const expectancy = parseFloat((total_pnl / trades.length).toFixed(2))

    // Best win streak — longest run of consecutive winning trades in close
    // order. Breakeven trades (pnl === 0) break a streak without starting a
    // losing one.
    const chronological = [...trades].sort((a, b) => new Date(a.close_time) - new Date(b.close_time))
    let best_win_streak = 0
    let currentStreak = 0
    for (const t of chronological) {
      if (parseFloat(t.demo_pnl) > 0) {
        currentStreak += 1
        best_win_streak = Math.max(best_win_streak, currentStreak)
      } else {
        currentStreak = 0
      }
    }

    // Sharpe (30d) — mean/stddev of daily realized P&L over the last 30
    // calendar days ending on the most recent close, unannualized (days
    // with no trades count as a 0 return, standard for a return-series
    // Sharpe rather than only-active-days).
    let sharpe_30d = null
    if (chronological.length > 0) {
      const lastClose = new Date(chronological[chronological.length - 1].close_time)
      const dailyPnl = new Map()
      for (const t of chronological) {
        const closeDate = new Date(t.close_time)
        const daysAgo = Math.floor((lastClose - closeDate) / (1000 * 60 * 60 * 24))
        if (daysAgo < 0 || daysAgo >= 30) continue
        const dayKey = closeDate.toISOString().slice(0, 10)
        dailyPnl.set(dayKey, (dailyPnl.get(dayKey) || 0) + parseFloat(t.demo_pnl))
      }
      const returns = []
      for (let i = 0; i < 30; i++) {
        const d = new Date(lastClose.getTime() - i * 24 * 60 * 60 * 1000)
        returns.push(dailyPnl.get(d.toISOString().slice(0, 10)) || 0)
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length
      const stddev = Math.sqrt(variance)
      sharpe_30d = stddev > 0 ? parseFloat((mean / stddev).toFixed(2)) : null
    }

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
        avg_r_multiple, r_distribution,
        expectancy, best_win_streak, sharpe_30d,
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
            // Re-index at the moved stop so the engine watches the new level.
            await engine().syncOpenedTrade({ ...trade, stop_loss: trade.open_price })
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
            engine().syncClosedTrade(trade.id, trade.account_id, demo_pnl)
            const batchAccount = tradeIndex.getAccountEntry(trade.account_id)
            if (batchAccount) {
              tradeIndex.updateAccountBalance(trade.account_id, batchAccount.currentBalance + demo_pnl)
            }
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

// The engine functions now live in services/tradeEngine.js and the shared
// helpers in services/tradeShared.js. They are re-exported here so existing
// importers (server.js, weekendCloseService, competitionEngine, admin routes)
// keep working against the original names.
const tradeEngine = require('../services/tradeEngine')

module.exports = {
  router,
  checkSLTP: tradeEngine.checkSLTP,
  checkPendingOrders: tradeEngine.checkPendingOrders,
  checkFloatingDrawdown: tradeEngine.checkFloatingDrawdown,
  getTradingRules,
  getMarketStatus,
  ensureTradeExperienceInfrastructure,
  calculatePnL,
  getLivePriceMap,
  computeRMultiple
}

