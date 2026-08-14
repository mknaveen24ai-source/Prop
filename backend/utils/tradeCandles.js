// Chart candle cache and row normalisation, used only by GET /api/trades/candles.
// Moved verbatim out of routes/trades.js.
const candleCache = new Map()
const CANDLE_CACHE_TTL_MS = 15000
const MAX_RAW_CANDLE_BARS = 3000

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

module.exports = {
  MAX_RAW_CANDLE_BARS,
  getCachedCandles,
  setCachedCandles,
  getRawCandleLookbackDays,
  normalizeCandleRows
}
