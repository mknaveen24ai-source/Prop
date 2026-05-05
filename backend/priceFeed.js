const fs = require('fs')
const path = require('path')
const pool = require('./db')
require('./loadEnv')

const logger = require('./utils/logger')
const { INSTRUMENTS, DEFAULT_SPREADS, getPointMultiplier, getPriceDecimals } = require('./constants')
const { getInstrumentSpreadMarkup } = require('./utils/tenantSettings')
const { getTenantFeedConfig, getTenantSettings } = require('./services/tenantPolicyService')
const {
  SHARED_FEED_SOURCE_KEY,
  appendSourcePriceHistory,
  ensureTenantFeedInfrastructure,
  getCurrentPriceForSource,
  getCurrentPricesForSource,
  listManagedPriceFeedSources,
  markPriceFeedSourceError,
  markPriceFeedSourceHeartbeat,
  upsertSourcePrices
} = require('./utils/tenantFeeds')

if (!process.env.DWX_PATH) {
  logger.error('DWX_PATH is not set in your .env file.', {
    message: 'Price feed will not work until DWX_PATH is configured.',
    example: 'DWX_PATH=C:/Users/YOU/AppData/Roaming/MetaQuotes/.../DWX'
  })
}

const DWX_PATH = process.env.DWX_PATH || ''

function resolveDwXPathFile(envKey, dwxPath, fileName) {
  const override = String(process.env[envKey] || '').trim()
  if (override) return path.normalize(override)
  return dwxPath ? path.join(dwxPath, fileName) : null
}

const MARKET_DATA_FILE = resolveDwXPathFile('DWX_MARKET_DATA_FILE', DWX_PATH, 'DWX_Market_Data.txt')
const COMMANDS_FILE = resolveDwXPathFile('DWX_COMMANDS_FILE', DWX_PATH, 'DWX_Commands_0.txt')
const HISTORY_EXPORT_FILE = resolveDwXPathFile('DWX_HISTORY_EXPORT_FILE', DWX_PATH, 'DWX_History_Export.json')
function buildSourceFiles(dwxPath) {
  const normalizedPath = String(dwxPath || '').trim()
  if (!normalizedPath) {
    return {
      marketDataFile: null,
      commandsFile: null,
      historyExportFile: null
    }
  }

  return {
    marketDataFile: path.join(normalizedPath, 'DWX_Market_Data.txt'),
    commandsFile: path.join(normalizedPath, 'DWX_Commands_0.txt'),
    historyExportFile: path.join(normalizedPath, 'DWX_History_Export.json')
  }
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
const BULK_INSERT_BATCH_SIZE = 500
const FEED_WARNING_INTERVAL_MS = 60 * 1000
const SHARED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS = parsePositiveInt(process.env.SHARED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS, 15000)
const SHARED_CURRENT_PRICE_PERSIST_INTERVAL_MS = parsePositiveInt(process.env.SHARED_CURRENT_PRICE_PERSIST_INTERVAL_MS, 3000)

let commandId = 1
let lastLoggedAt = 0
let lastSharedHourlyPersistedAt = 0
let lastSharedCurrentPricePersistedAt = 0
let sharedHourlyPersistPromise = null
let sharedFetchInFlightPromise = null
let sharedCurrentPricePersistPromise = null
let lastProcessedSharedMarketDataSignature = null
let lastProcessedSharedRealtimePrices = null
const LOG_INTERVAL_MS = 60 * 1000
const sharedWatcherState = {
  watcher: null,
  retryTimer: null
}
const dedicatedSourceWatchers = new Map()
const throttledLogState = new Map()
const sourceRuntimeState = new Map()

function setSourceRuntimeState(sourceKey, patch = {}) {
  const normalizedSourceKey = String(sourceKey || SHARED_FEED_SOURCE_KEY).trim().toLowerCase() || SHARED_FEED_SOURCE_KEY
  const existing = sourceRuntimeState.get(normalizedSourceKey) || { source_key: normalizedSourceKey }
  const next = {
    ...existing,
    ...patch,
    source_key: normalizedSourceKey,
    updated_at: new Date().toISOString()
  }
  sourceRuntimeState.set(normalizedSourceKey, next)
  return next
}

function getPriceFeedRuntimeStatus(sourceKey = null) {
  if (!sourceKey) {
    return Object.fromEntries(
      [...sourceRuntimeState.entries()].map(([key, value]) => [key, { ...value }])
    )
  }

  const normalizedSourceKey = String(sourceKey || SHARED_FEED_SOURCE_KEY).trim().toLowerCase() || SHARED_FEED_SOURCE_KEY
  const runtime = sourceRuntimeState.get(normalizedSourceKey)
  return runtime ? { ...runtime } : null
}

function logThrottled(level, key, message, meta = {}, intervalMs = FEED_WARNING_INTERVAL_MS) {
  const now = Date.now()
  const signature = JSON.stringify({ message, meta })
  const existing = throttledLogState.get(key)
  if (existing && existing.signature === signature && (now - existing.loggedAt) < intervalMs) {
    return false
  }

  const logFn = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger)
  logFn(message, meta)
  throttledLogState.set(key, { loggedAt: now, signature })
  return true
}

function canReadFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

function canWriteOrCreateFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.accessSync(filePath, fs.constants.W_OK)
      return true
    }
    const parentDir = path.dirname(filePath)
    fs.accessSync(parentDir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function clearSharedWatcherRetryTimer() {
  if (sharedWatcherState.retryTimer) {
    clearTimeout(sharedWatcherState.retryTimer)
    sharedWatcherState.retryTimer = null
  }
}

function scheduleSharedWatcherRetry(fn, delayMs) {
  clearSharedWatcherRetryTimer()
  sharedWatcherState.retryTimer = setTimeout(() => {
    sharedWatcherState.retryTimer = null
    fn()
  }, delayMs)
}

function closeWatcherHandle(watcher) {
  if (!watcher) return
  try {
    watcher.close()
  } catch {}
}

function ensureDedicatedWatcherState(sourceKey) {
  const normalizedSourceKey = String(sourceKey || '').trim().toLowerCase()
  let watcherState = dedicatedSourceWatchers.get(normalizedSourceKey)
  if (!watcherState) {
    watcherState = {
      watcher: null,
      retryTimer: null,
      close() {
        if (this.retryTimer) {
          clearTimeout(this.retryTimer)
          this.retryTimer = null
        }
        closeWatcherHandle(this.watcher)
        this.watcher = null
      }
    }
    dedicatedSourceWatchers.set(normalizedSourceKey, watcherState)
  }
  return watcherState
}

function scheduleDedicatedWatcherRetry(sourceKey, fn, delayMs) {
  const watcherState = ensureDedicatedWatcherState(sourceKey)
  if (watcherState.retryTimer) {
    clearTimeout(watcherState.retryTimer)
  }
  watcherState.retryTimer = setTimeout(() => {
    watcherState.retryTimer = null
    fn()
  }, delayMs)
}

function stopPriceFeedWatchers() {
  clearSharedWatcherRetryTimer()
  closeWatcherHandle(sharedWatcherState.watcher)
  sharedWatcherState.watcher = null
  setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
    watcher_attached: false,
    last_reason: 'watcher_shutdown'
  })

  for (const [sourceKey, watcherState] of dedicatedSourceWatchers.entries()) {
    try {
      watcherState.close()
    } catch {}
    setSourceRuntimeState(sourceKey, {
      watcher_attached: false,
      last_reason: 'watcher_shutdown'
    })
  }
  dedicatedSourceWatchers.clear()
}

function getFileChangeSignature(filePath) {
  try {
    const stats = fs.statSync(filePath)
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return null
  }
}

function buildRealtimePriceMap(priceRows = [], updatedAt = new Date()) {
  const updatedAtValue = updatedAt instanceof Date ? updatedAt.toISOString() : updatedAt
  return Object.fromEntries(
    priceRows.map((row) => [
      row.instrument,
      {
        bid: Number(row.bid),
        ask: Number(row.ask),
        updated_at: updatedAtValue,
        age_ms: 0,
        stale: false
      }
    ])
  )
}

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

function parseMt5ExportTimestampMs(value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed > 1e12 ? Math.floor(parsed) : Math.floor(parsed * 1000)
}

async function loadMt5HistoryExport() {
  if (!HISTORY_EXPORT_FILE) {
    logger.warn('DWX_PATH is not configured; skipping MT5 history bootstrap.')
    return null
  }

  if (!fs.existsSync(HISTORY_EXPORT_FILE)) {
    logger.info('MT5 history export not found; using stored/live MT5 data only for charts.', {
      file: HISTORY_EXPORT_FILE
    })
    return null
  }

  try {
    const raw = await readDWXFileSafe(HISTORY_EXPORT_FILE, 3, 100)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
      logger.info('MT5 history export is empty; using stored/live MT5 data only for charts.', {
        file: HISTORY_EXPORT_FILE
      })
      return null
    }
    return parsed
  } catch (error) {
    logger.warn('Failed to read MT5 history export for chart bootstrap.', {
      file: HISTORY_EXPORT_FILE,
      error: error.message
    })
    return null
  }
}

function buildMt5HistoryTicks(instrument, bar, fallbackSpread) {
  const time = parseMt5ExportTimestampMs(bar?.t)
  const open = parseFloat(bar?.o)
  const high = parseFloat(bar?.h)
  const low = parseFloat(bar?.l)
  const close = parseFloat(bar?.c)

  if (!time || [open, high, low, close].some((value) => Number.isNaN(value))) {
    return []
  }

  const spreadCandidate = parseFloat(bar?.s)
  const spread = Number.isFinite(spreadCandidate) ? spreadCandidate : fallbackSpread

  return [
    { instrument, bid: open, ask: open + spread, recorded_at: time },
    { instrument, bid: high, ask: high + spread, recorded_at: time + 15 * 1000 },
    { instrument, bid: low, ask: low + spread, recorded_at: time + 30 * 1000 },
    { instrument, bid: close, ask: close + spread, recorded_at: time + 59 * 1000 }
  ]
}

function extractPriceRows(raw) {
  if (!raw || raw === '{}') return []

  let data
  try {
    data = JSON.parse(raw)
  } catch (parseErr) {
    logger.warn('Price feed: malformed JSON from MT5, skipping tick:', { error: parseErr.message })
    return []
  }

  const rows = []
  for (const instrument of INSTRUMENTS) {
    const priceData = data[instrument]
    if (!priceData) continue

    const bid = parseFloat(priceData.bid)
    const ask = parseFloat(priceData.ask)
    if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) continue
    rows.push({ instrument, bid, ask })
  }

  return rows
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
      `CREATE INDEX IF NOT EXISTS idx_price_feed_history_instrument_recorded_at_cover
       ON price_feed_history (instrument, recorded_at DESC) INCLUDE (bid, ask)`
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

async function upsertHourlyTicks(priceRows = []) {
  if (!Array.isArray(priceRows) || priceRows.length === 0) return

  if (sharedHourlyPersistPromise) {
    return sharedHourlyPersistPromise
  }

  const nowMs = Date.now()
  if ((nowMs - lastSharedHourlyPersistedAt) < SHARED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS) {
    return
  }
  const previousPersistedAt = lastSharedHourlyPersistedAt
  lastSharedHourlyPersistedAt = nowMs

  const placeholders = []
  const values = []

  priceRows.forEach((row, index) => {
    const offset = index * 2
    placeholders.push(`($${offset + 1}, date_trunc('hour', NOW()), $${offset + 2}, $${offset + 2}, $${offset + 2}, $${offset + 2}, 1, NOW())`)
    values.push(row.instrument, row.bid)
  })

  sharedHourlyPersistPromise = pool.query(
    `INSERT INTO price_feed_history_1h
       (instrument, bucket_time, open, high, low, close, ticks, updated_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (instrument, bucket_time)
     DO UPDATE SET
       high = GREATEST(price_feed_history_1h.high, EXCLUDED.high),
       low = LEAST(price_feed_history_1h.low, EXCLUDED.low),
       close = EXCLUDED.close,
       ticks = price_feed_history_1h.ticks + 1,
       updated_at = NOW()`,
    values
  ).catch((error) => {
    lastSharedHourlyPersistedAt = previousPersistedAt
    throw error
  }).finally(() => {
    sharedHourlyPersistPromise = null
  })

  return sharedHourlyPersistPromise
}

function subscribeSymbols() {
  return subscribeSymbolsForFile(COMMANDS_FILE, 'shared')
}

function subscribeSymbolsForFile(commandsFile, sourceKey = 'shared') {
  if (!commandsFile) {
    setSourceRuntimeState(sourceKey, {
      command_channel_configured: false,
      command_channel_writable: false,
      commands_file_present: false,
      last_reason: 'command_channel_not_configured'
    })
    logThrottled('warn', `dwx:${sourceKey}:commands:unset`, 'DWX command channel not configured; skipping MT5 symbol subscription.', {
      sourceKey
    })
    return false
  }

  if (!canWriteOrCreateFile(commandsFile)) {
    setSourceRuntimeState(sourceKey, {
      command_channel_configured: true,
      command_channel_writable: false,
      commands_file_present: fs.existsSync(commandsFile),
      last_failure_at: new Date().toISOString(),
      last_reason: 'command_channel_unavailable'
    })
    logThrottled(
      'warn',
      `dwx:${sourceKey}:commands:unavailable`,
      'DWX command channel unavailable; continuing in read-only mode without MT5 command writes.',
      { sourceKey, commandsFile }
    )
    return false
  }
  try {
    const command = `<:${commandId++}|SUBSCRIBE_SYMBOLS|${INSTRUMENTS.join(',')}:>`
    fs.writeFileSync(commandsFile, command)
    setSourceRuntimeState(sourceKey, {
      command_channel_configured: true,
      command_channel_writable: true,
      commands_file_present: true,
      last_command_write_at: new Date().toISOString(),
      last_reason: 'subscription_sent'
    })
    logger.info('Subscribed to MT5 symbols:', { sourceKey, instruments: INSTRUMENTS.join(',') })
    return true
  } catch (error) {
    const isPermissionError = ['EPERM', 'EACCES'].includes(error?.code)
    setSourceRuntimeState(sourceKey, {
      command_channel_configured: true,
      command_channel_writable: false,
      commands_file_present: fs.existsSync(commandsFile),
      last_failure_at: new Date().toISOString(),
      last_reason: 'command_channel_write_failed',
      last_error: error.message
    })
    logThrottled(
      isPermissionError ? 'warn' : 'error',
      `dwx:${sourceKey}:commands:error`,
      isPermissionError
        ? 'DWX command channel is not writable; shared feed will remain in read-only mode.'
        : 'DWX command channel write failed.',
      { sourceKey, commandsFile, error: error.message }
    )
    return false
  }
}

async function persistSharedPriceRows(priceRows) {
  if (!Array.isArray(priceRows) || priceRows.length === 0) return

  const historyPlaceholders = []
  const historyValues = []
  const nowMs = Date.now()
  const shouldPersistCurrentPrices = (nowMs - lastSharedCurrentPricePersistedAt) >= SHARED_CURRENT_PRICE_PERSIST_INTERVAL_MS

  priceRows.forEach((row, index) => {
    const historyOffset = index * 3
    historyPlaceholders.push(`($${historyOffset + 1}, $${historyOffset + 2}, $${historyOffset + 3}, NOW())`)
    historyValues.push(row.instrument, row.bid, row.ask)
  })

  if (shouldPersistCurrentPrices) {
    if (!sharedCurrentPricePersistPromise) {
      const currentPricePlaceholders = []
      const currentPriceValues = []

      priceRows.forEach((row, index) => {
        const currentOffset = index * 3
        currentPricePlaceholders.push(`($${currentOffset + 1}, $${currentOffset + 2}, $${currentOffset + 3}, NOW())`)
        currentPriceValues.push(row.instrument, row.bid, row.ask)
      })

      const previousPersistedAt = lastSharedCurrentPricePersistedAt
      lastSharedCurrentPricePersistedAt = nowMs
      sharedCurrentPricePersistPromise = pool.query(
        `INSERT INTO price_feed (instrument, bid, ask, updated_at)
         VALUES ${currentPricePlaceholders.join(', ')}
         ON CONFLICT (instrument) DO UPDATE
         SET bid = EXCLUDED.bid,
             ask = EXCLUDED.ask,
             updated_at = NOW()`,
        currentPriceValues
      ).catch((error) => {
        lastSharedCurrentPricePersistedAt = previousPersistedAt
        throw error
      }).finally(() => {
        sharedCurrentPricePersistPromise = null
      })
    }
    await sharedCurrentPricePersistPromise
  }

  await pool.query(
    `INSERT INTO price_feed_history (instrument, bid, ask, recorded_at)
     VALUES ${historyPlaceholders.join(', ')}`,
    historyValues
  )

  await upsertHourlyTicks(priceRows)
  await markPriceFeedSourceHeartbeat(SHARED_FEED_SOURCE_KEY)
}

async function fetchAndStorePrices() {
  if (sharedFetchInFlightPromise) {
    return sharedFetchInFlightPromise
  }

  sharedFetchInFlightPromise = (async () => {
  if (!MARKET_DATA_FILE) {
    setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
      live_feed_available: false,
      market_data_configured: false,
      market_data_readable: false,
      watcher_attached: false,
      last_reason: 'market_data_not_configured'
    })
    logThrottled('warn', 'dwx:shared:market:unset', 'DWX market data file is not configured; live MT5 pricing is disabled.', {
      sourceKey: SHARED_FEED_SOURCE_KEY
    })
    return { updated: false, liveFeedAvailable: false, reason: 'market_data_not_configured' }
  }

  try {
    if (!fs.existsSync(MARKET_DATA_FILE) || !canReadFile(MARKET_DATA_FILE)) {
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        live_feed_available: false,
        market_data_configured: true,
        market_data_readable: false,
        last_fetch_at: new Date().toISOString(),
        last_failure_at: new Date().toISOString(),
        last_reason: 'market_data_missing'
      })
      logThrottled(
        'warn',
        'dwx:shared:market:missing',
        'DWX market data file not found or not readable; shared feed is running without live MT5 ticks.',
        { sourceKey: SHARED_FEED_SOURCE_KEY, marketDataFile: MARKET_DATA_FILE }
      )
      return { updated: false, liveFeedAvailable: false, reason: 'market_data_missing' }
    }

    const fileSignature = getFileChangeSignature(MARKET_DATA_FILE)
    if (fileSignature && fileSignature === lastProcessedSharedMarketDataSignature && lastProcessedSharedRealtimePrices) {
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        live_feed_available: true,
        market_data_configured: true,
        market_data_readable: true,
        last_fetch_at: new Date().toISOString(),
        symbol_count: Object.keys(lastProcessedSharedRealtimePrices).length,
        last_reason: 'unchanged'
      })
      return {
        updated: false,
        liveFeedAvailable: true,
        reason: 'unchanged',
        prices: lastProcessedSharedRealtimePrices
      }
    }

    const raw = await readDWXFileSafe(MARKET_DATA_FILE)
    const priceRows = extractPriceRows(raw)
    if (priceRows.length === 0) {
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        live_feed_available: true,
        market_data_configured: true,
        market_data_readable: true,
        last_fetch_at: new Date().toISOString(),
        symbol_count: 0,
        last_reason: 'no_price_rows'
      })
      return { updated: false, liveFeedAvailable: true, reason: 'no_price_rows' }
    }

    await persistSharedPriceRows(priceRows)
    const prices = buildRealtimePriceMap(priceRows)
    lastProcessedSharedMarketDataSignature = fileSignature
    lastProcessedSharedRealtimePrices = prices
    setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
      live_feed_available: true,
      market_data_configured: true,
      market_data_readable: true,
      last_fetch_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      symbol_count: priceRows.length,
      last_reason: 'updated'
    })

    const now = Date.now()
    if (now - lastLoggedAt >= LOG_INTERVAL_MS) {
      lastLoggedAt = now
      logger.info('MT5 prices updating normally:', { timestamp: new Date().toISOString() })
    }
    return { updated: true, liveFeedAvailable: true, prices }
  } catch (error) {
    await markPriceFeedSourceError(SHARED_FEED_SOURCE_KEY, error.message).catch(() => {})
    setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
      live_feed_available: false,
      market_data_configured: true,
      last_fetch_at: new Date().toISOString(),
      last_failure_at: new Date().toISOString(),
      last_reason: 'market_data_error',
      last_error: error.message
    })
    logThrottled('error', 'dwx:shared:market:error', 'Shared MT5 price feed error.', {
      sourceKey: SHARED_FEED_SOURCE_KEY,
      marketDataFile: MARKET_DATA_FILE,
      error: error.message
    })
    return { updated: false, liveFeedAvailable: false, reason: 'market_data_error', error: error.message }
  }
  })().finally(() => {
    sharedFetchInFlightPromise = null
  })

  return sharedFetchInFlightPromise
}

async function getCurrentPrices() {
  try {
    const result = await pool.query('SELECT * FROM price_feed')
    const prices = {}
    const now = Date.now()
    let staleCount = 0
    const sharedRuntime = getPriceFeedRuntimeStatus(SHARED_FEED_SOURCE_KEY)
    const lastSuccessAtMs = sharedRuntime?.last_success_at ? new Date(sharedRuntime.last_success_at).getTime() : null
    const watcherAttached = sharedRuntime?.watcher_attached === true

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

    const shouldWarnAboutStaleData = staleCount > 0
      && (!watcherAttached || !lastSuccessAtMs || (now - lastSuccessAtMs) > 15000)

    if (shouldWarnAboutStaleData) {
      logThrottled('warn', 'price-feed:shared:stale', 'Price feed has stale data:', {
        staleCount,
        total: result.rows.length
      })
    }

    return prices
  } catch (error) {
    logger.error('getCurrentPrices error:', { error: error.message })
    return {}
  }
}

function hasExplicitSpreadMarkupOverride(rawValue) {
  if (!rawValue) return false

  let parsed = rawValue
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return false
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  return Object.entries(parsed).some(([, value]) => Number.isFinite(Number(value)))
}

function buildEffectiveSpreadSettings(tenantSettings, feedConfig) {
  if (!hasExplicitSpreadMarkupOverride(feedConfig?.spread_markup_points_json)) {
    return tenantSettings
  }
  return {
    ...tenantSettings,
    spread_markup_points_json: typeof feedConfig.spread_markup_points_json === 'string'
      ? feedConfig.spread_markup_points_json
      : JSON.stringify(feedConfig.spread_markup_points_json)
  }
}

function applyTenantMarkupToPriceRow(instrument, row, settings = null) {
  if (!row) return null
  const normalizedRow = {
    ...row,
    bid: Number(row.bid),
    ask: Number(row.ask)
  }
  if (!settings) {
    return normalizedRow
  }

  const markupPoints = getInstrumentSpreadMarkup(settings, instrument)
  if (!markupPoints) {
    return {
      ...normalizedRow,
      tenant_markup_points: 0
    }
  }

  const pointMultiplier = Number(getPointMultiplier(instrument)) || 100000
  const markup = markupPoints / pointMultiplier
  const decimals = getPriceDecimals(instrument)

  return {
    ...normalizedRow,
    ask: Number((normalizedRow.ask + markup).toFixed(decimals)),
    tenant_markup_points: markupPoints
  }
}

async function getCurrentPricesForTenant(tenantId, basePrices = null) {
  const normalizedTenantId = parseInt(tenantId, 10)
  if (!Number.isFinite(normalizedTenantId) || normalizedTenantId <= 0) {
    return basePrices || await getCurrentPrices()
  }

  const feedConfig = await getTenantFeedConfig(normalizedTenantId)
  const prices = feedConfig.effective_source_key === SHARED_FEED_SOURCE_KEY && basePrices
    ? basePrices
    : await getCurrentPricesForSource(feedConfig.effective_source_key || SHARED_FEED_SOURCE_KEY)
  const settings = buildEffectiveSpreadSettings(
    await getTenantSettings(normalizedTenantId, ['spread_markup_points_json']),
    feedConfig
  )
  return Object.fromEntries(
    Object.entries(prices).map(([instrument, row]) => [
      instrument,
      applyTenantMarkupToPriceRow(instrument, row, settings)
    ])
  )
}

async function getPriceForTenant(tenantId, instrument, basePrices = null) {
  const normalizedInstrument = String(instrument || '').trim().toUpperCase()
  if (!normalizedInstrument) {
    throw new Error('Instrument is required')
  }

  const normalizedTenantId = parseInt(tenantId, 10)
  if (!Number.isFinite(normalizedTenantId) || normalizedTenantId <= 0) {
    if (basePrices && basePrices[normalizedInstrument]) {
      return applyTenantMarkupToPriceRow(normalizedInstrument, basePrices[normalizedInstrument], null)
    }
    const result = await pool.query(
      'SELECT bid, ask, updated_at FROM price_feed WHERE instrument = $1',
      [normalizedInstrument]
    )
    if (result.rows.length === 0) {
      const error = new Error('Price not available')
      error.code = 'PRICE_NOT_AVAILABLE'
      throw error
    }
    return applyTenantMarkupToPriceRow(normalizedInstrument, result.rows[0], null)
  }

  const feedConfig = await getTenantFeedConfig(normalizedTenantId)
  let basePrice = null
  if (feedConfig.effective_source_key === SHARED_FEED_SOURCE_KEY && basePrices?.[normalizedInstrument]) {
    basePrice = basePrices[normalizedInstrument]
  } else {
    basePrice = await getCurrentPriceForSource(feedConfig.effective_source_key || SHARED_FEED_SOURCE_KEY, normalizedInstrument)
  }
  if (!basePrice) {
    const error = new Error('Price not available')
    error.code = 'PRICE_NOT_AVAILABLE'
    throw error
  }

  const settings = buildEffectiveSpreadSettings(
    await getTenantSettings(normalizedTenantId, ['spread_markup_points_json']),
    feedConfig
  )
  return applyTenantMarkupToPriceRow(normalizedInstrument, basePrice, settings)
}

function watchPriceFeed(callback) {
  if (!MARKET_DATA_FILE) {
    setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
      watcher_attached: false,
      market_data_configured: false,
      last_reason: 'watcher_not_configured'
    })
    logThrottled('warn', 'dwx:shared:watcher:unset', 'watchPriceFeed: DWX market data file not configured, real-time watcher disabled.', {
      sourceKey: SHARED_FEED_SOURCE_KEY
    })
    return
  }

  let watcher = sharedWatcherState.watcher || null

  function attachWatcher() {
    if (sharedWatcherState.watcher) {
      return
    }

    if (!fs.existsSync(MARKET_DATA_FILE) || !canReadFile(MARKET_DATA_FILE)) {
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        watcher_attached: false,
        market_data_configured: true,
        market_data_readable: false,
        last_reason: 'watcher_market_data_missing'
      })
      logThrottled('warn', 'dwx:shared:watcher:missing', 'DWX market data file not found, watcher will retry.', {
        sourceKey: SHARED_FEED_SOURCE_KEY,
        marketDataFile: MARKET_DATA_FILE,
        retryInMs: 5000
      })
      scheduleSharedWatcherRetry(attachWatcher, 5000)
      return
    }

    try {
      clearSharedWatcherRetryTimer()
      watcher = fs.watch(MARKET_DATA_FILE, async (eventType) => {
        if (eventType === 'change') {
          const fetchResult = await fetchAndStorePrices()
          if (callback && fetchResult?.updated) {
            const loggerRef = require('./utils/logger')
            try {
              callback(fetchResult.prices || await getCurrentPrices())
            } catch (callbackErr) {
              loggerRef.error('Price feed callback error:', {
                error: callbackErr.message,
                stack: callbackErr.stack
              })
            }
          }
        }

        if (eventType === 'rename') {
          setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
            watcher_attached: false,
            last_reason: 'watcher_reattaching'
          })
          logger.warn('DWX file renamed/replaced, reattaching watcher in 1s...')
          if (watcher) {
            watcher.close()
            watcher = null
            sharedWatcherState.watcher = null
          }
          scheduleSharedWatcherRetry(attachWatcher, 1000)
        }
      })

      watcher.on('error', (err) => {
        setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
          watcher_attached: false,
          last_failure_at: new Date().toISOString(),
          last_reason: 'watcher_error',
          last_error: err.message
        })
        logThrottled('error', 'dwx:shared:watcher:error', 'Price feed watcher error; restarting watcher.', {
          sourceKey: SHARED_FEED_SOURCE_KEY,
          error: err.message,
          retryInMs: 5000
        })
        if (watcher) {
          watcher.close()
          watcher = null
          sharedWatcherState.watcher = null
        }
        scheduleSharedWatcherRetry(attachWatcher, 5000)
      })

      sharedWatcherState.watcher = watcher
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        watcher_attached: true,
        market_data_configured: true,
        market_data_readable: true,
        last_reason: 'watching'
      })
      logger.info('Watching MT5 price feed for real-time updates...')
    } catch (error) {
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        watcher_attached: false,
        last_failure_at: new Date().toISOString(),
        last_reason: 'watcher_attach_failed',
        last_error: error.message
      })
      logThrottled('error', 'dwx:shared:watcher:attach-error', 'Failed to attach MT5 price feed watcher; retrying.', {
        sourceKey: SHARED_FEED_SOURCE_KEY,
        error: error.message,
        retryInMs: 5000
      })
      scheduleSharedWatcherRetry(attachWatcher, 5000)
    }
  }

  attachWatcher()
}

async function fetchAndStoreDedicatedSourcePrices(source) {
  const sourceKey = String(source?.source_key || '').trim().toLowerCase()
  const files = buildSourceFiles(source?.dwx_path)
  if (!sourceKey || !files.marketDataFile) return

  try {
    if (!fs.existsSync(files.marketDataFile) || !canReadFile(files.marketDataFile)) {
      await markPriceFeedSourceError(sourceKey, 'DWX market data file not found')
      setSourceRuntimeState(sourceKey, {
        live_feed_available: false,
        market_data_configured: true,
        market_data_readable: false,
        last_fetch_at: new Date().toISOString(),
        last_failure_at: new Date().toISOString(),
        last_reason: 'market_data_missing'
      })
      logThrottled('warn', `dwx:${sourceKey}:market:missing`, 'Dedicated DWX market data file not found or not readable.', {
        sourceKey,
        marketDataFile: files.marketDataFile
      })
      return
    }

    const raw = await readDWXFileSafe(files.marketDataFile)
    const priceRows = extractPriceRows(raw)
    if (priceRows.length === 0) {
      setSourceRuntimeState(sourceKey, {
        live_feed_available: true,
        market_data_configured: true,
        market_data_readable: true,
        last_fetch_at: new Date().toISOString(),
        symbol_count: 0,
        last_reason: 'no_price_rows'
      })
      return
    }
    await upsertSourcePrices(sourceKey, priceRows)
    await appendSourcePriceHistory(sourceKey, priceRows)
    setSourceRuntimeState(sourceKey, {
      live_feed_available: true,
      market_data_configured: true,
      market_data_readable: true,
      last_fetch_at: new Date().toISOString(),
      last_success_at: new Date().toISOString(),
      symbol_count: priceRows.length,
      last_reason: 'updated'
    })
  } catch (error) {
    await markPriceFeedSourceError(sourceKey, error.message).catch(() => {})
    setSourceRuntimeState(sourceKey, {
      live_feed_available: false,
      market_data_configured: true,
      last_fetch_at: new Date().toISOString(),
      last_failure_at: new Date().toISOString(),
      last_reason: 'market_data_error',
      last_error: error.message
    })
    logThrottled('error', `dwx:${sourceKey}:market:error`, 'Dedicated price feed error.', {
      sourceKey,
      marketDataFile: files.marketDataFile,
      error: error.message
    })
  }
}

function attachDedicatedSourceWatcher(source, callback) {
  const sourceKey = String(source?.source_key || '').trim().toLowerCase()
  const files = buildSourceFiles(source?.dwx_path)
  if (!sourceKey || !files.marketDataFile) return

  const watcherState = ensureDedicatedWatcherState(sourceKey)
  let watcher = watcherState.watcher || null

  const attach = () => {
    if (watcherState.watcher) {
      return
    }

    if (!fs.existsSync(files.marketDataFile) || !canReadFile(files.marketDataFile)) {
      setSourceRuntimeState(sourceKey, {
        watcher_attached: false,
        market_data_configured: true,
        market_data_readable: false,
        last_reason: 'watcher_market_data_missing'
      })
      logThrottled('warn', `dwx:${sourceKey}:watcher:missing`, 'Dedicated DWX market data file not found, watcher will retry.', {
        sourceKey,
        marketDataFile: files.marketDataFile,
        retryInMs: 5000
      })
      scheduleDedicatedWatcherRetry(sourceKey, attach, 5000)
      return
    }

    try {
      if (watcherState.retryTimer) {
        clearTimeout(watcherState.retryTimer)
        watcherState.retryTimer = null
      }
      subscribeSymbolsForFile(files.commandsFile, sourceKey)
      watcher = fs.watch(files.marketDataFile, async (eventType) => {
        if (eventType === 'change') {
          await fetchAndStoreDedicatedSourcePrices(source)
          if (callback) callback(sourceKey)
        }

        if (eventType === 'rename') {
          setSourceRuntimeState(sourceKey, {
            watcher_attached: false,
            last_reason: 'watcher_reattaching'
          })
          if (watcher) {
            watcher.close()
            watcher = null
            watcherState.watcher = null
          }
          scheduleDedicatedWatcherRetry(sourceKey, attach, 1000)
        }
      })

      watcher.on('error', async (error) => {
        await markPriceFeedSourceError(sourceKey, error.message).catch(() => {})
        setSourceRuntimeState(sourceKey, {
          watcher_attached: false,
          last_failure_at: new Date().toISOString(),
          last_reason: 'watcher_error',
          last_error: error.message
        })
        if (watcher) {
          watcher.close()
          watcher = null
          watcherState.watcher = null
        }
        scheduleDedicatedWatcherRetry(sourceKey, attach, 5000)
      })

      watcherState.watcher = watcher
      setSourceRuntimeState(sourceKey, {
        watcher_attached: true,
        market_data_configured: true,
        market_data_readable: true,
        last_reason: 'watching'
      })
    } catch (error) {
      markPriceFeedSourceError(sourceKey, error.message).catch(() => {})
      setSourceRuntimeState(sourceKey, {
        watcher_attached: false,
        last_failure_at: new Date().toISOString(),
        last_reason: 'watcher_attach_failed',
        last_error: error.message
      })
      scheduleDedicatedWatcherRetry(sourceKey, attach, 5000)
    }
  }

  attach()
}

async function syncDedicatedPriceFeedWatchers(callback) {
  await ensureTenantFeedInfrastructure()
  const sources = await listManagedPriceFeedSources()
  const dedicatedSources = sources.filter((source) =>
    source.source_key !== SHARED_FEED_SOURCE_KEY
    && source.source_type === 'dwx_path'
    && source.dwx_path
  )
  const activeKeys = new Set(dedicatedSources.map((source) => String(source.source_key).trim().toLowerCase()))

  for (const [sourceKey, watcher] of dedicatedSourceWatchers.entries()) {
    if (!activeKeys.has(sourceKey)) {
      try {
        watcher.close()
      } catch {}
      setSourceRuntimeState(sourceKey, {
        watcher_attached: false,
        last_reason: 'watcher_removed'
      })
      dedicatedSourceWatchers.delete(sourceKey)
    }
  }

  for (const source of dedicatedSources) {
    const sourceKey = String(source.source_key).trim().toLowerCase()
    if (!dedicatedSourceWatchers.has(sourceKey)) {
      subscribeSymbolsForFile(buildSourceFiles(source.dwx_path).commandsFile, sourceKey)
      await fetchAndStoreDedicatedSourcePrices(source)
      attachDedicatedSourceWatcher(source, callback)
    }
  }
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

async function bootstrapHistoricalPriceHistory() {
  const exportData = await loadMt5HistoryExport()
  if (!exportData) return

  const lookbackStartMs = Date.now() - (Math.max(PRICE_HISTORY_RETAIN_DAYS, PRICE_HISTORY_BOOTSTRAP_DAYS) * 24 * 60 * 60 * 1000)
  const normalizedExportData = Object.fromEntries(
    Object.entries(exportData)
      .map(([instrument, bars]) => [String(instrument || '').trim().toUpperCase(), bars])
      .filter(([instrument, bars]) => instrument && Array.isArray(bars))
  )
  const exportInstrumentSet = new Set(Object.keys(normalizedExportData))
  const bootstrapInstruments = INSTRUMENTS.filter((instrument) => exportInstrumentSet.has(instrument))
  const skippedConfiguredInstruments = INSTRUMENTS.filter((instrument) => !exportInstrumentSet.has(instrument))
  const extraExportInstruments = Object.keys(normalizedExportData).filter((instrument) => !INSTRUMENTS.includes(instrument))
  const insertedSummaries = []
  const failedInstruments = []

  if (bootstrapInstruments.length === 0) {
    logger.info('MT5 history export does not contain any platform-configured instruments; skipping bootstrap.', {
      source: path.basename(HISTORY_EXPORT_FILE),
      exportSymbolCount: exportInstrumentSet.size
    })
    return
  }

  const historyStatsResult = await pool.query(
    `SELECT instrument, COUNT(*)::int AS count, MIN(recorded_at) AS min_recorded_at
       FROM price_feed_history
      WHERE instrument = ANY($1::text[])
      GROUP BY instrument`,
    [bootstrapInstruments]
  )
  const historyStatsByInstrument = new Map(
    historyStatsResult.rows.map((row) => [
      String(row.instrument || '').trim().toUpperCase(),
      {
        count: parseInt(row.count, 10) || 0,
        minRecordedAt: row.min_recorded_at || null
      }
    ])
  )

  for (const instrument of bootstrapInstruments) {
    try {
      const historyStats = historyStatsByInstrument.get(instrument) || { count: 0, minRecordedAt: null }
      const count = historyStats.count || 0
      const minRecordedAt = historyStats.minRecordedAt
      const existingMinMs = minRecordedAt ? new Date(minRecordedAt).getTime() : null
      const needsBootstrap = count < PRICE_HISTORY_BOOTSTRAP_MIN_ROWS
        || !existingMinMs
        || existingMinMs > (lookbackStartMs + 60 * 1000)

      if (!needsBootstrap) continue

      const bars = normalizedExportData[instrument] || []

      const spread = DEFAULT_SPREADS[instrument] || 0.00012
      const ticks = []

      for (const bar of bars) {
        const barTimeMs = parseMt5ExportTimestampMs(bar?.t)
        if (!barTimeMs || barTimeMs < lookbackStartMs) {
          continue
        }
        if (existingMinMs && barTimeMs >= (existingMinMs - 60 * 1000)) {
          continue
        }

        ticks.push(...buildMt5HistoryTicks(instrument, bar, spread))
      }

      if (!ticks.length) continue

      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (let i = 0; i < ticks.length; i += BULK_INSERT_BATCH_SIZE) {
          await bulkInsertHistoryTicks(client, ticks.slice(i, i + BULK_INSERT_BATCH_SIZE))
        }
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      insertedSummaries.push({
        instrument,
        insertedTicks: ticks.length
      })
    } catch (error) {
      failedInstruments.push({
        instrument,
        error: error.message
      })
    }
  }

  if (insertedSummaries.length > 0) {
    logger.info('MT5 history bootstrap inserted ticks.', {
      source: path.basename(HISTORY_EXPORT_FILE),
      eligibleInstrumentCount: bootstrapInstruments.length,
      instrumentCount: insertedSummaries.length,
      totalInsertedTicks: insertedSummaries.reduce((sum, entry) => sum + (entry.insertedTicks || 0), 0),
      instruments: insertedSummaries
    })
  }

  if (skippedConfiguredInstruments.length > 0) {
    logger.info('MT5 history bootstrap skipped configured instruments that are not present in the MT5 export.', {
      source: path.basename(HISTORY_EXPORT_FILE),
      eligibleInstrumentCount: bootstrapInstruments.length,
      skippedConfiguredCount: skippedConfiguredInstruments.length,
      sample: skippedConfiguredInstruments.slice(0, 12),
      truncated: skippedConfiguredInstruments.length > 12
    })
  }

  if (extraExportInstruments.length > 0) {
    logger.info('MT5 history export contains symbols that are not configured on the platform; ignored for bootstrap.', {
      source: path.basename(HISTORY_EXPORT_FILE),
      extraExportCount: extraExportInstruments.length,
      sample: extraExportInstruments.slice(0, 12),
      truncated: extraExportInstruments.length > 12
    })
  }

  if (failedInstruments.length > 0) {
    logger.warn('MT5 history bootstrap failed for some instruments.', {
      source: path.basename(HISTORY_EXPORT_FILE),
      failedCount: failedInstruments.length,
      failures: failedInstruments
    })
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
  applyTenantMarkupToPriceRow,
  fetchAndStorePrices,
  getCurrentPrices,
  getCurrentPricesForTenant,
  getPriceFeedRuntimeStatus,
  getPriceForTenant,
  syncDedicatedPriceFeedWatchers,
  subscribeSymbols,
  stopPriceFeedWatchers,
  watchPriceFeed,
  pruneOldPriceHistory,
  ensurePriceHistoryInfrastructure,
  bootstrapHistoricalPriceHistory,
  syncHourlyPriceHistory,
  INSTRUMENTS
}
