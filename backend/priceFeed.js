const fs = require('fs')
const path = require('path')
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
const COMMANDS_FILE    = DWX_PATH ? path.join(DWX_PATH, 'DWX_Commands_0.txt') : null

const INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']

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

function subscribeSymbols() {
  if (!COMMANDS_FILE) {
    logger.warn('subscribeSymbols: DWX_PATH not set — skipping symbol subscription.')
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
      logger.warn('DWX market data file not found — waiting for MT5 to create it...')
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

      // FIX 1: replaced (!bid || !ask) with explicit isNaN + range check
      // because !bid is true when bid === 0, causing valid zero-prices to be skipped
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
        stale: ageMs > 5000 // Mark as stale if older than 5 seconds
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
    logger.warn('watchPriceFeed: DWX_PATH not set — real-time watcher disabled.')
    return
  }

  let watcher = null

  function attachWatcher() {
    if (!fs.existsSync(MARKET_DATA_FILE)) {
      logger.warn('DWX file not found — will retry watcher in 5s...')
      setTimeout(attachWatcher, 5000)
      return
    }

    try {
      watcher = fs.watch(MARKET_DATA_FILE, async (eventType) => {
        if (eventType === 'change') {
          await fetchAndStorePrices()
          if (callback) {
            const logger = require('./utils/logger')
            try {
              const prices = await getCurrentPrices()
              callback(prices)
            } catch (callbackErr) {
              logger.error('Price feed callback error:', { error: callbackErr.message, stack: callbackErr.stack })
            }
          }
        }

        if (eventType === 'rename') {
          logger.warn('DWX file renamed/replaced — reattaching watcher in 1s...')
          if (watcher) { watcher.close(); watcher = null }
          setTimeout(attachWatcher, 1000)
        }
      })

      watcher.on('error', (err) => {
        logger.error('Price feed watcher error:', { error: err.message, message: 'restarting in 5s...' })
        if (watcher) { watcher.close(); watcher = null }
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

// ADDED: prune price_feed_history rows older than PRICE_HISTORY_RETAIN_DAYS.
// Without this the table grows ~170k rows/day (4 instruments × ~2s ticks)
// and will slow queries and fill disk over time.
// Called once on server startup and then every 24 hours from server.js.
//
// FIX Bug 4: replaced template literal SQL interpolation with a parameterized
// query using an interval cast. The old version interpolated
// PRICE_HISTORY_RETAIN_DAYS directly into the SQL string — even though parseInt
// made it safe in practice, it's bad pattern and would break silently if the
// env value was ever non-numeric (NaN interpolated = invalid SQL).
// Using $1 * INTERVAL '1 day' is fully parameterized and type-safe.
const PRICE_HISTORY_RETAIN_DAYS = parseInt(process.env.PRICE_HISTORY_RETAIN_DAYS || '7', 10)

// Fallback to 7 if env value parsed to NaN
const RETAIN_DAYS = isNaN(PRICE_HISTORY_RETAIN_DAYS) ? 7 : PRICE_HISTORY_RETAIN_DAYS

async function pruneOldPriceHistory() {
  try {
    const result = await pool.query(
      `DELETE FROM price_feed_history
       WHERE recorded_at < NOW() - ($1 * INTERVAL '1 day')`,
      [RETAIN_DAYS]
    )
    const deleted = result.rowCount
    if (deleted > 0) {
      logger.info('Price history pruned:', { deleted, days: RETAIN_DAYS, message: `rows older than ${RETAIN_DAYS} days removed.` })
    }
  } catch (error) {
    logger.error('Price history pruning error:', { error: error.message })
  }
}

module.exports = { fetchAndStorePrices, getCurrentPrices, subscribeSymbols, watchPriceFeed, pruneOldPriceHistory }