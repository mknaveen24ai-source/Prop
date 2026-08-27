// Chart candle cache and row normalisation, used only by GET /api/trades/candles.
// Moved verbatim out of routes/trades.js.
import type { CandleDto } from '@propfirm/contracts'

type NumericInput = string | number

interface RawCandleRow {
  time: NumericInput
  open: NumericInput
  high: NumericInput
  low: NumericInput
  close: NumericInput
  volume: NumericInput
}

interface CandleCacheEntry {
  value: CandleDto[]
  cachedAt: number
}

const candleCache = new Map<string, CandleCacheEntry>()
const CANDLE_CACHE_TTL_MS = 15000
const MAX_RAW_CANDLE_BARS = 3000

function getCachedCandles(cacheKey: string): CandleDto[] | null {
  const cached = candleCache.get(cacheKey)
  if (!cached) return null
  if ((Date.now() - cached.cachedAt) > CANDLE_CACHE_TTL_MS) {
    candleCache.delete(cacheKey)
    return null
  }
  return cached.value
}

function setCachedCandles(cacheKey: string, value: CandleDto[]): void {
  candleCache.set(cacheKey, { value, cachedAt: Date.now() })
}

function getRawCandleLookbackDays(tfMinutes: number, retainDays: number): number {
  const safeTfMinutes = Math.max(1, parseInt(String(tfMinutes), 10) || 1)
  const cappedBars = Math.max(500, parseInt(process.env.MAX_RAW_CANDLE_BARS || String(MAX_RAW_CANDLE_BARS), 10) || MAX_RAW_CANDLE_BARS)
  const lookbackMinutes = safeTfMinutes * cappedBars
  const lookbackDays = Math.ceil(lookbackMinutes / (60 * 24))
  return Math.max(1, Math.min(retainDays, lookbackDays))
}

function normalizeCandleRows(rows: readonly RawCandleRow[] = []): CandleDto[] {
  return rows
    .map((row) => ({
      time: Number(row.time),
      open: parseFloat(String(row.open)),
      high: parseFloat(String(row.high)),
      low: parseFloat(String(row.low)),
      close: parseFloat(String(row.close)),
      volume: parseInt(String(row.volume), 10) || 0
    }))
    .filter((row) =>
      Number.isFinite(row.time)
      && [row.open, row.high, row.low, row.close].every(Number.isFinite)
    )
}

const tradeCandles = {
  MAX_RAW_CANDLE_BARS,
  getCachedCandles,
  setCachedCandles,
  getRawCandleLookbackDays,
  normalizeCandleRows
}

export = tradeCandles
