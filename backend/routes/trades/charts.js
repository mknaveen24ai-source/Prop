// GET /api/trades/candles — OHLC series for the price chart.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.

const express = require('express')
const pool = require('../../db')
const logger = require('../../utils/logger')
const { authenticateToken } = require('../middleware')
const {
  VALID_CHART_TIMEFRAME_LABELS,
  getChartTimeframeMinutes
} = require('../../utils/chartTimeframes')
const { getTenantFeedConfig } = require('../../services/tenantPolicyService')
const {
  getCachedCandles,
  setCachedCandles,
  getRawCandleLookbackDays,
  normalizeCandleRows
} = require('../../utils/tradeCandles')
const { VALID_INSTRUMENTS } = require('../../services/tradeShared')

const router = express.Router()

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

module.exports = router
