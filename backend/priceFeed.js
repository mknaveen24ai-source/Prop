const fs = require('fs')
const path = require('path')
const axios = require('axios')
const pool = require('./db')
require('dotenv').config()

const logger = require('./utils/logger')

if (!process.env.DWX_PATH) {
  logger.error('DWX_PATH is not set in your .env file.', {
    message: 'Price feed will not work until DWX_PATH is configured.',
    example: 'DWX_PATH=C:/Users/YOU/AppData/Roaming/MetaQuotes/.../DWX'
  })
}

const DWX_PATH = process.env.DWX_PATH || ''

const MARKET_DATA_FILE = DWX_PATH ? path.join(DWX_PATH, 'DWX_Market_Data.txt') : null
const COMMANDS_FILE = DWX_PATH ? path.join(DWX_PATH, 'DWX_Commands_0.txt') : null
const INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']
const TWELVE_DATA_SYMBOLS = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD'
}
const DEFAULT_SPREADS = {
  EURUSD: 0.00012,
  GBPUSD: 0.00014,
  XAUUSD: 0.30,
  XAGUSD: 0.03
}

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const PRICE_HISTORY_RETAIN_DAYS = parsePositiveInt(process.env.PRICE_HISTORY_RETAIN_DAYS, 90)
const PRICE_HISTORY_1H_RETAIN_DAYS = parsePositiveInt(
  process.env.PRICE_HISTORY_1H_RETAIN_DAYS,
  Math.max(PRICE_HISTORY_RETAIN_DAYS, 365)
)
const PRICE_HISTORY_BOOTSTRAP_MIN_ROWS = parsePositiveInt(process.env.PRICE_HISTORY_BOOTSTRAP_MIN_ROWS, 500)
const PRICE_HISTORY_BOOTSTRAP_DAYS = parsePositiveInt(process.env.PRICE_HISTORY_BOOTSTRAP_DAYS, 90)
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || process.env.TWELVEDATA_API_KEY || ''
const BULK_INSERT_BATCH_SIZE = 500

let commandId = 1
let lastLoggedAt = 0
const LOG_INTERVAL_MS = 60 * 1000

function readDWXFileSafe(filePath, maxRetries = 3, delayMs = 50) {
  return new Promise((resolve, reject) => {
    let attempts = 0

    function attempt() {
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim()
        resolve(raw)
      } catch (err) {
        if (err.code === 'EBUSY' && attempts < maxRetries) {
          attempts++
          setTimeout(attempt, delayMs)
        } else if (err.code === 'EBUSY') {
          resolve(null)
        } else {
          reject(err)
        }
      }
    }

    attempt()
  })
}

async function ensurePriceHistoryInfrastructure() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_feed_history_1h (
        id BIGSERIAL PRIMARY KEY,
        instrument TEXT NOT NULL,
        bucket_time TIMESTAMPTZ NOT NULL,
        open NUMERIC NOT NULL,
        high NUMERIC NOT NULL,
        low NUMERIC NOT NULL,
        close NUMERIC NOT NULL,
        ticks INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (instrument, bucket_time)
      )
    `)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_price_feed_history_instrument_recorded_at
       ON price_feed_history (instrument, recorded_at DESC)`
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_price_feed_history_1h_instrument_bucket
       ON price_feed_history_1h (instrument, bucket_time DESC)`
    )
  } catch (error) {
    logger.error('Price history infrastructure setup failed:', { error: error.message })
    throw error
  }
}

async function upsertHourlyTick(instrument, bid) {
  await pool.query(
    `INSERT INTO price_feed_history_1h
       (instrument, bucket_time, open, high, low, close, ticks, updated_at)
     VALUES
       ($1, date_trunc('hour', NOW()), $2, $2, $2, $2, 1, NOW())
     ON CONFLICT (instrument, bucket_time)
     DO UPDATE SET
       high = GREATEST(price_feed_history_1h.high, EXCLUDED.high),
       low = LEAST(price_feed_history_1h.low, EXCLUDED.low),
       close = EXCLUDED.close,
       ticks = price_feed_history_1h.ticks + 1,
       updated_at = NOW()`,
    [instrument, bid]
  )
}

function subscribeSymbols() {
  if (!COMMANDS_FILE) {
    logger.warn('subscribeSymbols: DWX_PATH not set, skipping symbol subscription.')
    return
  }
  try {
    const command = `<:${commandId++}|SUBSCRIBE_SYMBOLS|${INSTRUMENTS.join(',')}:>`
    fs.writeFileSync(COMMANDS_FILE, command)
    logger.info('Subscribed to MT5 symbols:', { instruments: INSTRUMENTS.join(',') })
  } catch (error) {
    logger.error('Subscribe error:', { error: error.message })
  }
}

async function fetchAndStorePrices() {
  if (!MARKET_DATA_FILE) return

  try {
    if (!fs.existsSync(MARKET_DATA_FILE)) {
      logger.warn('DWX market data file not found, waiting for MT5 to create it...')
      return
    }

    const raw = await readDWXFileSafe(MARKET_DATA_FILE)
    if (!raw || raw === '{}') return

    let data
    try {
      data = JSON.parse(raw)
    } catch (parseErr) {
      logger.warn('Price feed: malformed JSON from MT5, skipping tick:', { error: parseErr.message })
      return
    }

    for (const instrument of INSTRUMENTS) {
      const priceData = data[instrument]
      if (!priceData) continue

      const bid = parseFloat(priceData.bid)
      const ask = parseFloat(priceData.ask)
      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) continue

      await pool.query(
        `INSERT INTO price_feed (instrument, bid, ask, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (instrument) DO UPDATE
         SET bid = $2, ask = $3, updated_at = NOW()`,
        [instrument, bid, ask]
      )

      await pool.query(
        `INSERT INTO price_feed_history (instrument, bid, ask, recorded_at)
         VALUES ($1, $2, $3, NOW())`,
        [instrument, bid, ask]
      )

      await upsertHourlyTick(instrument, bid)
    }

    const now = Date.now()
    if (now - lastLoggedAt >= LOG_INTERVAL_MS) {
      lastLoggedAt = now
      logger.info('MT5 prices updating normally:', { timestamp: new Date().toISOString() })
    }
  } catch (error) {
    logger.error('Price feed error:', { error: error.message })
  }
}

async function getCurrentPrices() {
  try {
    const result = await pool.query('SELECT * FROM price_feed')
    const prices = {}
    const now = Date.now()
    let staleCount = 0

    result.rows.forEach(function(row) {
      const ageMs = now - new Date(row.updated_at).getTime()
      prices[row.instrument] = {
        bid: parseFloat(row.bid),
        ask: parseFloat(row.ask),
        updated_at: row.updated_at,
        age_ms: ageMs,
        stale: ageMs > 5000
      }
      if (ageMs > 5000) staleCount++
    })

    if (staleCount > 0) {
      logger.warn('Price feed has stale data:', { staleCount, total: result.rows.length })
    }

    return prices
  } catch (error) {
    logger.error('getCurrentPrices error:', { error: error.message })
    return {}
  }
}

function watchPriceFeed(callback) {
  if (!MARKET_DATA_FILE) {
    logger.warn('watchPriceFeed: DWX_PATH not set, real-time watcher disabled.')
    return
  }

  let watcher = null

  function attachWatcher() {
    if (!fs.existsSync(MARKET_DATA_FILE)) {
      logger.warn('DWX file not found, will retry watcher in 5s...')
      setTimeout(attachWatcher, 5000)
      return
    }

    try {
      watcher = fs.watch(MARKET_DATA_FILE, async (eventType) => {
        if (eventType === 'change') {
          await fetchAndStorePrices()
          if (callback) {
            const loggerRef = require('./utils/logger')
            try {
              const prices = await getCurrentPrices()
              callback(prices)
            } catch (callbackErr) {
              loggerRef.error('Price feed callback error:', {
                error: callbackErr.message,
                stack: callbackErr.stack
              })
            }
          }
        }

        if (eventType === 'rename') {
          logger.warn('DWX file renamed/replaced, reattaching watcher in 1s...')
          if (watcher) {
            watcher.close()
            watcher = null
          }
          setTimeout(attachWatcher, 1000)
        }
      })

      watcher.on('error', (err) => {
        logger.error('Price feed watcher error:', { error: err.message, message: 'restarting in 5s...' })
        if (watcher) {
          watcher.close()
          watcher = null
        }
        setTimeout(attachWatcher, 5000)
      })

      logger.info('Watching MT5 price feed for real-time updates...')
    } catch (error) {
      logger.error('Failed to attach watcher:', { error: error.message, message: 'retrying in 5s...' })
      setTimeout(attachWatcher, 5000)
    }
  }

  attachWatcher()
}

function formatTwelveDate(date) {
  const yyyy = date.getUTCFullYear()
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const min = String(date.getUTCMinutes()).padStart(2, '0')
  const ss = String(date.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`
}

function parseTwelveTimestamp(value) {
  if (!value) return null
  const isoLike = String(value).replace(' ', 'T')
  const withZone = isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`
  const ts = Date.parse(withZone)
  if (!Number.isNaN(ts)) return ts
  const fallback = Date.parse(String(value))
  return Number.isNaN(fallback) ? null : fallback
}

async function fetchTwelveDataBars(instrument) {
  const symbol = TWELVE_DATA_SYMBOLS[instrument]
  if (!symbol || !TWELVE_DATA_API_KEY) return []

  const sinceMs = Date.now() - (PRICE_HISTORY_BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000)
  const startDate = formatTwelveDate(new Date(sinceMs))

  const response = await axios.get('https://api.twelvedata.com/time_series', {
    params: {
      symbol,
      interval: '1h',
      start_date: startDate,
      timezone: 'UTC',
      outputsize: 5000,
      order: 'ASC',
      apikey: TWELVE_DATA_API_KEY
    },
    timeout: 25000
  })

  const payload = response.data || {}
  if (payload.status === 'error') {
    throw new Error(payload.message || `Twelve Data rejected request for ${instrument}`)
  }
  if (!Array.isArray(payload.values)) return []

  return payload.values
    .map((row) => {
      const time = parseTwelveTimestamp(row.datetime)
      const open = parseFloat(row.open)
      const high = parseFloat(row.high)
      const low = parseFloat(row.low)
      const close = parseFloat(row.close)
      if (!time || [open, high, low, close].some(v => Number.isNaN(v))) return null
      return { time, open, high, low, close }
    })
    .filter(Boolean)
    .filter(bar => bar.time >= sinceMs)
    .sort((a, b) => a.time - b.time)
}

async function bulkInsertHistoryTicks(client, rows) {
  if (!rows.length) return
  const values = []
  const placeholders = rows.map((row, i) => {
    const base = i * 4
    values.push(row.instrument, row.bid, row.ask, row.recorded_at)
    return `($${base + 1}, $${base + 2}, $${base + 3}, to_timestamp($${base + 4} / 1000.0))`
  })

  await client.query(
    `INSERT INTO price_feed_history (instrument, bid, ask, recorded_at)
     VALUES ${placeholders.join(',')}`,
    values
  )
}

async function bulkUpsertHourlyBars(client, rows) {
  if (!rows.length) return
  const values = []
  const placeholders = rows.map((row, i) => {
    const base = i * 7
    values.push(row.instrument, row.bucket_time, row.open, row.high, row.low, row.close, row.ticks)
    return `($${base + 1}, to_timestamp($${base + 2} / 1000.0), $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, NOW())`
  })

  await client.query(
    `INSERT INTO price_feed_history_1h
       (instrument, bucket_time, open, high, low, close, ticks, updated_at)
     VALUES ${placeholders.join(',')}
     ON CONFLICT (instrument, bucket_time)
     DO UPDATE SET
       open = EXCLUDED.open,
       high = EXCLUDED.high,
       low = EXCLUDED.low,
       close = EXCLUDED.close,
       ticks = EXCLUDED.ticks,
       updated_at = NOW()`,
    values
  )
}

async function bootstrapHistoricalPriceHistory() {
  if (!TWELVE_DATA_API_KEY) {
    logger.warn('TWELVE_DATA_API_KEY is missing; skipping historical bootstrap.')
    return
  }

  for (const instrument of INSTRUMENTS) {
    try {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count, MIN(recorded_at) AS min_recorded_at
         FROM price_feed_history
         WHERE instrument = $1`,
        [instrument]
      )

      const count = countResult.rows[0]?.count || 0
      if (count >= PRICE_HISTORY_BOOTSTRAP_MIN_ROWS) continue

      const minRecordedAt = countResult.rows[0]?.min_recorded_at
      const existingMinMs = minRecordedAt ? new Date(minRecordedAt).getTime() : null
      const bars = await fetchTwelveDataBars(instrument)
      if (!bars.length) {
        logger.warn('No bootstrap candles returned from Twelve Data', { instrument })
        continue
      }

      const spread = DEFAULT_SPREADS[instrument] || 0.00012
      const ticks = []
      const hourlyBars = []

      for (const bar of bars) {
        if (existingMinMs && bar.time >= (existingMinMs - 60 * 60 * 1000)) {
          continue
        }

        hourlyBars.push({
          instrument,
          bucket_time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          ticks: 4
        })

        ticks.push(
          { instrument, bid: bar.open, ask: bar.open + spread, recorded_at: bar.time },
          { instrument, bid: bar.high, ask: bar.high + spread, recorded_at: bar.time + 15 * 60 * 1000 },
          { instrument, bid: bar.low, ask: bar.low + spread, recorded_at: bar.time + 30 * 60 * 1000 },
          { instrument, bid: bar.close, ask: bar.close + spread, recorded_at: bar.time + 59 * 60 * 1000 }
        )
      }

      if (!ticks.length) continue

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (let i = 0; i < ticks.length; i += BULK_INSERT_BATCH_SIZE) {
          await bulkInsertHistoryTicks(client, ticks.slice(i, i + BULK_INSERT_BATCH_SIZE))
        }
        for (let i = 0; i < hourlyBars.length; i += BULK_INSERT_BATCH_SIZE) {
          await bulkUpsertHourlyBars(client, hourlyBars.slice(i, i + BULK_INSERT_BATCH_SIZE))
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      logger.info('Historical bootstrap inserted', {
        instrument,
        insertedTicks: ticks.length,
        insertedHourlyBars: hourlyBars.length
      })
    } catch (error) {
      logger.warn('Historical bootstrap failed for instrument', {
        instrument,
        error: error.message
      })
    }
  }
}

async function syncHourlyPriceHistory() {
  try {
    const lookbackDays = Math.max(PRICE_HISTORY_RETAIN_DAYS, PRICE_HISTORY_BOOTSTRAP_DAYS) + 2
    await pool.query(
      `INSERT INTO price_feed_history_1h
         (instrument, bucket_time, open, high, low, close, ticks, updated_at)
       SELECT
         instrument,
         date_trunc('hour', recorded_at) AS bucket_time,
         (array_agg(bid ORDER BY recorded_at ASC))[1] AS open,
         MAX(bid) AS high,
         MIN(bid) AS low,
         (array_agg(bid ORDER BY recorded_at DESC))[1] AS close,
         COUNT(*)::int AS ticks,
         NOW() AS updated_at
       FROM price_feed_history
       WHERE recorded_at >= NOW() - ($1 * INTERVAL '1 day')
       GROUP BY instrument, bucket_time
       ON CONFLICT (instrument, bucket_time)
       DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         ticks = EXCLUDED.ticks,
         updated_at = NOW()`,
      [lookbackDays]
    )
  } catch (error) {
    logger.error('Hourly rollup sync failed:', { error: error.message })
  }
}

async function pruneOldPriceHistory() {
  try {
    const rawResult = await pool.query(
      `DELETE FROM price_feed_history
       WHERE recorded_at < NOW() - ($1 * INTERVAL '1 day')`,
      [PRICE_HISTORY_RETAIN_DAYS]
    )
    const hourlyResult = await pool.query(
      `DELETE FROM price_feed_history_1h
       WHERE bucket_time < NOW() - ($1 * INTERVAL '1 day')`,
      [PRICE_HISTORY_1H_RETAIN_DAYS]
    )

    if (rawResult.rowCount > 0 || hourlyResult.rowCount > 0) {
      logger.info('Price history pruned:', {
        rawDeleted: rawResult.rowCount,
        rawDays: PRICE_HISTORY_RETAIN_DAYS,
        hourlyDeleted: hourlyResult.rowCount,
        hourlyDays: PRICE_HISTORY_1H_RETAIN_DAYS
      })
    }
  } catch (error) {
    logger.error('Price history pruning error:', { error: error.message })
  }
}

module.exports = {
  fetchAndStorePrices,
  getCurrentPrices,
  subscribeSymbols,
  watchPriceFeed,
  pruneOldPriceHistory,
  ensurePriceHistoryInfrastructure,
  bootstrapHistoricalPriceHistory,
  syncHourlyPriceHistory,
  INSTRUMENTS
}
