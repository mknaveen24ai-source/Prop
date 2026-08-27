import fs from 'node:fs'
import path from 'node:path'
import type { PoolClient, QueryResultRow } from 'pg'
import { z } from 'zod'
import pool = require('./db')
import './loadEnv'
import logger = require('./utils/logger')
import { getTenantFeedConfig, getTenantSettings } from './services/tenantPolicyService'
import { parseExternal, parseUnknownJson } from './validation/unknown'
import { getInstrumentSpreadMarkup } from './utils/tenantSettings'
import {
  SHARED_FEED_SOURCE_KEY,
  appendSourcePriceHistory,
  ensureTenantFeedInfrastructure,
  getCurrentPriceForSource,
  getCurrentPricesForSource,
  listManagedPriceFeedSources,
  markPriceFeedSourceError,
  markPriceFeedSourceHeartbeat,
  upsertSourcePrices
} from './utils/tenantFeeds'
import type {
  PriceFeedSourceRow,
  PriceInput,
  PriceMap
} from './utils/tenantFeeds'

interface ConstantsApi {
  INSTRUMENTS: readonly string[]
  DEFAULT_SPREADS: Readonly<Record<string, number>>
  getPointMultiplier: (instrument: string) => number
  getPriceDecimals: (instrument: string) => number
}

interface MetricsApi {
  recordPriceFeedIngest: (result: string, durationMs: number) => void
}

interface SourceFiles {
  marketDataFile: string | null
  commandsFile: string | null
  historyExportFile: string | null
}

interface SourceRuntimeState extends Record<string, unknown> {
  source_key: string
}

interface WatcherState {
  watcher: fs.FSWatcher | null
  retryTimer: NodeJS.Timeout | null
  close: () => void
}

interface ThrottledLogEntry {
  loggedAt: number
  signature: string
}

interface PriceFetchResult {
  updated: boolean
  liveFeedAvailable: boolean
  reason?: string
  prices?: PriceMap
  error?: string
}

interface Mt5Bar extends Record<string, unknown> {
  t?: unknown
  o?: unknown
  h?: unknown
  l?: unknown
  c?: unknown
  s?: unknown
}

type Mt5HistoryExport = Record<string, Mt5Bar[]>

interface HistoryTick {
  instrument: string
  bid: number
  ask: number
  recorded_at: number
}

interface StoredPriceRow extends QueryResultRow {
  instrument: string
  bid: string
  ask: string
  updated_at: Date | string
}

interface HistoryStatsRow extends QueryResultRow {
  instrument: string
  count: number | string
  min_recorded_at: Date | string | null
}

interface InsertedSummary {
  instrument: string
  insertedTicks: number
}

interface FailedInstrument {
  instrument: string
  error: string
}

interface TenantPricePoint extends Record<string, unknown> {
  bid: number
  ask: number
  tenant_markup_points?: number
}

type TenantPriceMap = Record<string, TenantPricePoint>

class PriceUnavailableError extends Error {
  override name = 'PriceUnavailableError'
  readonly code = 'PRICE_NOT_AVAILABLE'
}

type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'debug'
type PriceUpdateCallback = (prices: PriceMap) => void
type DedicatedPriceCallback = (sourceKey: string) => void | Promise<void>

const { INSTRUMENTS, DEFAULT_SPREADS, getPointMultiplier, getPriceDecimals } = require('./constants') as ConstantsApi
const { recordPriceFeedIngest } = require('./utils/prometheusMetrics') as MetricsApi

const mt5PriceDataSchema = z.record(z.string(), z.object({
  bid: z.unknown(),
  ask: z.unknown()
}).passthrough())
const mt5HistoryExportSchema: z.ZodType<Mt5HistoryExport> = z.record(
  z.string(),
  z.array(z.object({
    t: z.unknown().optional(),
    o: z.unknown().optional(),
    h: z.unknown().optional(),
    l: z.unknown().optional(),
    c: z.unknown().optional(),
    s: z.unknown().optional()
  }).passthrough())
)
const priceLikeSchema = z.object({
  bid: z.union([z.string(), z.number().finite()]),
  ask: z.union([z.string(), z.number().finite()])
}).passthrough()
const priceMapInputSchema = z.record(z.string(), priceLikeSchema)

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  return typeof value.code === 'string' ? value.code : undefined
}

if (!process.env.DWX_PATH) {
  logger.error('DWX_PATH is not set in your .env file.', {
    message: 'Price feed will not work until DWX_PATH is configured.',
    example: 'DWX_PATH=C:/Users/YOU/AppData/Roaming/MetaQuotes/.../DWX'
  })
}

const DWX_PATH = process.env.DWX_PATH || ''

function resolveDwXPathFile(envKey: string, dwxPath: string, fileName: string): string | null {
  const override = String(process.env[envKey] || '').trim()
  if (override) return path.normalize(override)
  return dwxPath ? path.join(dwxPath, fileName) : null
}

const MARKET_DATA_FILE = resolveDwXPathFile('DWX_MARKET_DATA_FILE', DWX_PATH, 'DWX_Market_Data.txt')
const COMMANDS_FILE = resolveDwXPathFile('DWX_COMMANDS_FILE', DWX_PATH, 'DWX_Commands_0.txt')
const HISTORY_EXPORT_FILE = resolveDwXPathFile('DWX_HISTORY_EXPORT_FILE', DWX_PATH, 'DWX_History_Export.json')
function buildSourceFiles(dwxPath: unknown): SourceFiles {
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

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10)
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
let sharedHourlyPersistPromise: Promise<unknown> | null = null
let sharedFetchInFlightPromise: Promise<PriceFetchResult> | null = null
let sharedCurrentPricePersistPromise: Promise<unknown> | null = null
let lastProcessedSharedMarketDataSignature: string | null = null
let lastProcessedSharedRealtimePrices: PriceMap | null = null
const LOG_INTERVAL_MS = 60 * 1000
const sharedWatcherState: Omit<WatcherState, 'close'> = {
  watcher: null,
  retryTimer: null
}
const dedicatedSourceWatchers = new Map<string, WatcherState>()
const throttledLogState = new Map<string, ThrottledLogEntry>()
const sourceRuntimeState = new Map<string, SourceRuntimeState>()

function setSourceRuntimeState(
  sourceKey: unknown,
  patch: Record<string, unknown> = {}
): SourceRuntimeState {
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

function getPriceFeedRuntimeStatus(
  sourceKey: unknown = null
): Record<string, SourceRuntimeState> | SourceRuntimeState | null {
  if (!sourceKey) {
    return Object.fromEntries(
      [...sourceRuntimeState.entries()].map(([key, value]) => [key, { ...value }])
    )
  }

  const normalizedSourceKey = String(sourceKey || SHARED_FEED_SOURCE_KEY).trim().toLowerCase() || SHARED_FEED_SOURCE_KEY
  const runtime = sourceRuntimeState.get(normalizedSourceKey)
  return runtime ? { ...runtime } : null
}

function logThrottled(
  level: LogLevel,
  key: string,
  message: string,
  meta: Record<string, unknown> = {},
  intervalMs = FEED_WARNING_INTERVAL_MS
): boolean {
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

function canReadFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

function canWriteOrCreateFile(filePath: string): boolean {
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

function clearSharedWatcherRetryTimer(): void {
  if (sharedWatcherState.retryTimer) {
    clearTimeout(sharedWatcherState.retryTimer)
    sharedWatcherState.retryTimer = null
  }
}

function scheduleSharedWatcherRetry(fn: () => void, delayMs: number): void {
  clearSharedWatcherRetryTimer()
  sharedWatcherState.retryTimer = setTimeout(() => {
    sharedWatcherState.retryTimer = null
    fn()
  }, delayMs)
}

function closeWatcherHandle(watcher: fs.FSWatcher | null): void {
  if (!watcher) return
  try {
    watcher.close()
  } catch {}
}

function ensureDedicatedWatcherState(sourceKey: unknown): WatcherState {
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

function scheduleDedicatedWatcherRetry(sourceKey: unknown, fn: () => void, delayMs: number): void {
  const watcherState = ensureDedicatedWatcherState(sourceKey)
  if (watcherState.retryTimer) {
    clearTimeout(watcherState.retryTimer)
  }
  watcherState.retryTimer = setTimeout(() => {
    watcherState.retryTimer = null
    fn()
  }, delayMs)
}

function stopPriceFeedWatchers(): void {
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

/**
 * Readable-check for the per-tick path, in one async syscall.
 *
 * Replaces `fs.existsSync(p) || !canReadFile(p)` — two blocking syscalls where
 * access(R_OK) already answers both questions. canReadFile stays for the watcher
 * ATTACH paths, which are synchronous by shape and run once rather than per tick.
 */
async function isReadableFile(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Size+mtime fingerprint used to skip re-parsing an unchanged feed file.
 *
 * Async because this runs on every tick. fs.statSync here blocked the event loop
 * that is simultaneously serving every connected socket — cheap per call, and
 * directly in the path the sub-100ms target is measured along.
 */
async function getFileChangeSignature(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.stat(filePath)
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return null
  }
}

function buildRealtimePriceMap(
  priceRows: readonly PriceInput[] = [],
  updatedAt: Date | string = new Date()
): PriceMap {
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

/**
 * Read a DWX file, retrying past the EBUSY window while MT5 rewrites it.
 *
 * The retry loop is why this exists: the terminal truncates and rewrites the
 * market data file in place, so a read landing mid-write fails with EBUSY on
 * Windows rather than returning a partial file.
 *
 * Uses fs.promises.readFile, not readFileSync. The old version returned a
 * Promise while doing a BLOCKING read inside it — the shape said async and the
 * behaviour was not, which is the kind of thing that never shows up in a
 * profile of this function and shows up as latency jitter everywhere else. It
 * runs on the fs.watch callback, i.e. once per price tick, on the event loop
 * that is also serving every socket.
 */
async function readDWXFileSafe(
  filePath: string,
  maxRetries = 3,
  delayMs = 50
): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8')
      return raw.trim()
    } catch (error: unknown) {
      if (errorCode(error) !== 'EBUSY') throw error
      if (attempt >= maxRetries) return null
      await new Promise((resolve) => { setTimeout(resolve, delayMs) })
    }
  }
}

function parseMt5ExportTimestampMs(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed > 1e12 ? Math.floor(parsed) : Math.floor(parsed * 1000)
}

async function loadMt5HistoryExport(): Promise<Mt5HistoryExport | null> {
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
    const parsed = parseExternal(
      mt5HistoryExportSchema,
      parseUnknownJson(raw),
      'MT5 history export'
    )
    if (Object.keys(parsed).length === 0) {
      logger.info('MT5 history export is empty; using stored/live MT5 data only for charts.', {
        file: HISTORY_EXPORT_FILE
      })
      return null
    }
    return parsed
  } catch (error: unknown) {
    logger.warn('Failed to read MT5 history export for chart bootstrap.', {
      file: HISTORY_EXPORT_FILE,
      error: errorMessage(error)
    })
    return null
  }
}

function buildMt5HistoryTicks(
  instrument: string,
  bar: Mt5Bar,
  fallbackSpread: number
): HistoryTick[] {
  const time = parseMt5ExportTimestampMs(bar?.t)
  const open = parseFloat(String(bar.o ?? ''))
  const high = parseFloat(String(bar.h ?? ''))
  const low = parseFloat(String(bar.l ?? ''))
  const close = parseFloat(String(bar.c ?? ''))

  if (!time || [open, high, low, close].some((value) => Number.isNaN(value))) {
    return []
  }

  const spreadCandidate = parseFloat(String(bar.s ?? ''))
  const spread = Number.isFinite(spreadCandidate) ? spreadCandidate : fallbackSpread

  return [
    { instrument, bid: open, ask: open + spread, recorded_at: time },
    { instrument, bid: high, ask: high + spread, recorded_at: time + 15 * 1000 },
    { instrument, bid: low, ask: low + spread, recorded_at: time + 30 * 1000 },
    { instrument, bid: close, ask: close + spread, recorded_at: time + 59 * 1000 }
  ]
}

function extractPriceRows(raw: string | null): PriceInput[] {
  if (!raw || raw === '{}') return []

  let data: z.infer<typeof mt5PriceDataSchema>
  try {
    data = parseExternal(mt5PriceDataSchema, parseUnknownJson(raw), 'MT5 market data')
  } catch (error: unknown) {
    logger.warn('Price feed: malformed JSON from MT5, skipping tick:', { error: errorMessage(error) })
    return []
  }

  const rows: PriceInput[] = []
  for (const instrument of INSTRUMENTS) {
    const priceData = data[instrument]
    if (!priceData) continue

    const bid = parseFloat(String(priceData.bid))
    const ask = parseFloat(String(priceData.ask))
    if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) continue
    rows.push({ instrument, bid, ask })
  }

  return rows
}

async function ensurePriceHistoryInfrastructure(): Promise<void> {
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
  } catch (error: unknown) {
    logger.error('Price history infrastructure setup failed:', { error: errorMessage(error) })
    throw error
  }
}

async function upsertHourlyTicks(priceRows: readonly PriceInput[] = []): Promise<unknown> {
  if (priceRows.length === 0) return

  if (sharedHourlyPersistPromise) {
    return sharedHourlyPersistPromise
  }

  const nowMs = Date.now()
  if ((nowMs - lastSharedHourlyPersistedAt) < SHARED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS) {
    return
  }
  const previousPersistedAt = lastSharedHourlyPersistedAt
  lastSharedHourlyPersistedAt = nowMs

  const placeholders: string[] = []
  const values: unknown[] = []

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
  ).catch((error: unknown) => {
    lastSharedHourlyPersistedAt = previousPersistedAt
    throw error
  }).finally(() => {
    sharedHourlyPersistPromise = null
  })

  return sharedHourlyPersistPromise
}

function subscribeSymbols(): boolean {
  return subscribeSymbolsForFile(COMMANDS_FILE, 'shared')
}

function subscribeSymbolsForFile(commandsFile: string | null, sourceKey = 'shared'): boolean {
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
  } catch (error: unknown) {
    const isPermissionError = ['EPERM', 'EACCES'].includes(errorCode(error) || '')
    const message = errorMessage(error)
    setSourceRuntimeState(sourceKey, {
      command_channel_configured: true,
      command_channel_writable: false,
      commands_file_present: fs.existsSync(commandsFile),
      last_failure_at: new Date().toISOString(),
      last_reason: 'command_channel_write_failed',
      last_error: message
    })
    logThrottled(
      isPermissionError ? 'warn' : 'error',
      `dwx:${sourceKey}:commands:error`,
      isPermissionError
        ? 'DWX command channel is not writable; shared feed will remain in read-only mode.'
        : 'DWX command channel write failed.',
      { sourceKey, commandsFile, error: message }
    )
    return false
  }
}

async function persistSharedPriceRows(priceRows: readonly PriceInput[]): Promise<void> {
  if (priceRows.length === 0) return

  const historyPlaceholders: string[] = []
  const historyValues: unknown[] = []
  const nowMs = Date.now()
  const shouldPersistCurrentPrices = (nowMs - lastSharedCurrentPricePersistedAt) >= SHARED_CURRENT_PRICE_PERSIST_INTERVAL_MS

  priceRows.forEach((row, index) => {
    const historyOffset = index * 3
    historyPlaceholders.push(`($${historyOffset + 1}, $${historyOffset + 2}, $${historyOffset + 3}, NOW())`)
    historyValues.push(row.instrument, row.bid, row.ask)
  })

  if (shouldPersistCurrentPrices) {
    if (!sharedCurrentPricePersistPromise) {
      const currentPricePlaceholders: string[] = []
      const currentPriceValues: unknown[] = []

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
      ).catch((error: unknown) => {
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

async function fetchAndStorePrices(): Promise<PriceFetchResult> {
  if (sharedFetchInFlightPromise) {
    return sharedFetchInFlightPromise
  }

  const ingestStartedAt = process.hrtime.bigint()
  const run: Promise<PriceFetchResult> = (async () => {
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
    if (!(await isReadableFile(MARKET_DATA_FILE))) {
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

    const fileSignature = await getFileChangeSignature(MARKET_DATA_FILE)
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
  } catch (error: unknown) {
    const message = errorMessage(error)
    await markPriceFeedSourceError(SHARED_FEED_SOURCE_KEY, message).catch(() => {})
    setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
      live_feed_available: false,
      market_data_configured: true,
      last_fetch_at: new Date().toISOString(),
      last_failure_at: new Date().toISOString(),
      last_reason: 'market_data_error',
      last_error: message
    })
    logThrottled('error', 'dwx:shared:market:error', 'Shared MT5 price feed error.', {
      sourceKey: SHARED_FEED_SOURCE_KEY,
      marketDataFile: MARKET_DATA_FILE,
      error: message
    })
    return { updated: false, liveFeedAvailable: false, reason: 'market_data_error', error: message }
  }
  })()

  // Measured around the whole chain — stat, read, parse, and the throttled
  // persistence — because that is exactly the work that happens before the
  // engine sees a new price. It is the one segment of the stop-loss reaction
  // path that was never on a graph, and it decides whether moving the feed into
  // its own process would buy latency or only isolation.
  //
  // Observed on `run` rather than on the returned promise, and with BOTH
  // handlers supplied, so this branch can never reject: an unhandled rejection
  // from a metrics chain would be a fine way to take down the feed for the sake
  // of a histogram.
  void run.then(
    (result) => recordPriceFeedIngest(
      result?.reason || (result?.updated ? 'updated' : 'unknown'),
      Number(process.hrtime.bigint() - ingestStartedAt) / 1e6
    ),
    () => recordPriceFeedIngest('threw', Number(process.hrtime.bigint() - ingestStartedAt) / 1e6)
  )

  // Callers get the settle-and-clear promise, exactly as before.
  sharedFetchInFlightPromise = run.finally(() => {
    sharedFetchInFlightPromise = null
  })

  return sharedFetchInFlightPromise
}

async function getCurrentPrices(): Promise<PriceMap> {
  try {
    const result = await pool.query<StoredPriceRow>('SELECT * FROM price_feed')
    const prices: PriceMap = {}
    const now = Date.now()
    let staleCount = 0
    const sharedRuntime = getPriceFeedRuntimeStatus(SHARED_FEED_SOURCE_KEY)
    const lastSuccessAt = sharedRuntime?.last_success_at
    const lastSuccessAtMs = typeof lastSuccessAt === 'string'
      ? new Date(lastSuccessAt).getTime()
      : null
    const watcherAttached = sharedRuntime?.watcher_attached === true

    result.rows.forEach(function(row: StoredPriceRow): void {
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
  } catch (error: unknown) {
    logger.error('getCurrentPrices error:', { error: errorMessage(error) })
    return {}
  }
}

function hasExplicitSpreadMarkupOverride(rawValue: unknown): boolean {
  if (!rawValue) return false

  let parsed: unknown = rawValue
  if (typeof parsed === 'string') {
    try {
      parsed = parseUnknownJson(parsed)
    } catch {
      return false
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  return Object.entries(parsed).some(([, value]) => Number.isFinite(Number(value)))
}

function buildEffectiveSpreadSettings(
  tenantSettings: Record<string, string>,
  feedConfig: Record<string, unknown>
): Record<string, string> {
  if (!hasExplicitSpreadMarkupOverride(feedConfig.spread_markup_points_json)) {
    return tenantSettings
  }
  return {
    ...tenantSettings,
    spread_markup_points_json: typeof feedConfig.spread_markup_points_json === 'string'
      ? feedConfig.spread_markup_points_json
      : JSON.stringify(feedConfig.spread_markup_points_json)
  }
}

function applyTenantMarkupToPriceRow(
  instrument: string,
  input: unknown,
  settings: Record<string, string> | null = null
): TenantPricePoint | null {
  if (!input) return null
  const row = parseExternal(priceLikeSchema, input, 'tenant price row')
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

async function getCurrentPricesForTenant(basePrices: unknown = null): Promise<TenantPriceMap> {
  const feedConfig = await getTenantFeedConfig()
  const parsedBasePrices = basePrices === null
    ? null
    : priceMapInputSchema.safeParse(basePrices)
  const prices = feedConfig.effective_source_key === SHARED_FEED_SOURCE_KEY && parsedBasePrices?.success
    ? parsedBasePrices.data
    : await getCurrentPricesForSource(feedConfig.effective_source_key || SHARED_FEED_SOURCE_KEY)
  const settings = buildEffectiveSpreadSettings(
    await getTenantSettings(['spread_markup_points_json']),
    feedConfig
  )
  const adjusted: TenantPriceMap = {}
  for (const [instrument, row] of Object.entries(prices)) {
    const price = applyTenantMarkupToPriceRow(instrument, row, settings)
    if (price) adjusted[instrument] = price
  }
  return adjusted
}

async function getPriceForTenant(instrument: unknown, basePrices: unknown = null): Promise<TenantPricePoint> {
  const normalizedInstrument = String(instrument || '').trim().toUpperCase()
  if (!normalizedInstrument) {
    throw new Error('Instrument is required')
  }

  const feedConfig = await getTenantFeedConfig()
  const parsedBasePrices = basePrices === null
    ? null
    : priceMapInputSchema.safeParse(basePrices)
  const cachedPrice = parsedBasePrices?.success ? parsedBasePrices.data[normalizedInstrument] : undefined
  const basePrice = feedConfig.effective_source_key === SHARED_FEED_SOURCE_KEY && cachedPrice
    ? cachedPrice
    : await getCurrentPriceForSource(feedConfig.effective_source_key || SHARED_FEED_SOURCE_KEY, normalizedInstrument)
  if (!basePrice) {
    throw new PriceUnavailableError('Price not available')
  }

  const settings = buildEffectiveSpreadSettings(
    await getTenantSettings(['spread_markup_points_json']),
    feedConfig
  )
  const adjusted = applyTenantMarkupToPriceRow(normalizedInstrument, basePrice, settings)
  if (!adjusted) throw new PriceUnavailableError('Price not available')
  return adjusted
}

function watchPriceFeed(callback: PriceUpdateCallback): void {
  const marketDataFile = MARKET_DATA_FILE
  if (!marketDataFile) {
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
  const configuredMarketDataFile: string = marketDataFile

  let watcher = sharedWatcherState.watcher || null

  function attachWatcher(): void {
    if (sharedWatcherState.watcher) {
      return
    }

    if (!fs.existsSync(configuredMarketDataFile) || !canReadFile(configuredMarketDataFile)) {
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        watcher_attached: false,
        market_data_configured: true,
        market_data_readable: false,
        last_reason: 'watcher_market_data_missing'
      })
      logThrottled('warn', 'dwx:shared:watcher:missing', 'DWX market data file not found, watcher will retry.', {
        sourceKey: SHARED_FEED_SOURCE_KEY,
        marketDataFile: configuredMarketDataFile,
        retryInMs: 5000
      })
      scheduleSharedWatcherRetry(attachWatcher, 5000)
      return
    }

    try {
      clearSharedWatcherRetryTimer()
      watcher = fs.watch(configuredMarketDataFile, (eventType): void => {
        void (async (): Promise<void> => {
          if (eventType === 'change') {
            const fetchResult = await fetchAndStorePrices()
            if (callback && fetchResult.updated) {
              const loggerRef = require('./utils/logger') as typeof logger
              try {
                callback(fetchResult.prices || await getCurrentPrices())
              } catch (callbackError: unknown) {
                loggerRef.error('Price feed callback error:', {
                  error: errorMessage(callbackError),
                  stack: callbackError instanceof Error ? callbackError.stack : undefined
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
        })().catch((error: unknown) => {
          logger.error('Price watcher event failed:', { error: errorMessage(error) })
        })
      })

      watcher.on('error', (error: Error) => {
        setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
          watcher_attached: false,
          last_failure_at: new Date().toISOString(),
          last_reason: 'watcher_error',
          last_error: error.message
        })
        logThrottled('error', 'dwx:shared:watcher:error', 'Price feed watcher error; restarting watcher.', {
          sourceKey: SHARED_FEED_SOURCE_KEY,
          error: error.message,
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
    } catch (error: unknown) {
      const message = errorMessage(error)
      setSourceRuntimeState(SHARED_FEED_SOURCE_KEY, {
        watcher_attached: false,
        last_failure_at: new Date().toISOString(),
        last_reason: 'watcher_attach_failed',
        last_error: message
      })
      logThrottled('error', 'dwx:shared:watcher:attach-error', 'Failed to attach MT5 price feed watcher; retrying.', {
        sourceKey: SHARED_FEED_SOURCE_KEY,
        error: message,
        retryInMs: 5000
      })
      scheduleSharedWatcherRetry(attachWatcher, 5000)
    }
  }

  attachWatcher()
}

async function fetchAndStoreDedicatedSourcePrices(source: PriceFeedSourceRow): Promise<void> {
  const sourceKey = String(source?.source_key || '').trim().toLowerCase()
  const files = buildSourceFiles(source?.dwx_path)
  const marketDataFile = files.marketDataFile
  if (!sourceKey || !marketDataFile) return

  try {
    if (!(await isReadableFile(marketDataFile))) {
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
        marketDataFile
      })
      return
    }

    const raw = await readDWXFileSafe(marketDataFile)
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
  } catch (error: unknown) {
    const message = errorMessage(error)
    await markPriceFeedSourceError(sourceKey, message).catch(() => {})
    setSourceRuntimeState(sourceKey, {
      live_feed_available: false,
      market_data_configured: true,
      last_fetch_at: new Date().toISOString(),
      last_failure_at: new Date().toISOString(),
      last_reason: 'market_data_error',
      last_error: message
    })
    logThrottled('error', `dwx:${sourceKey}:market:error`, 'Dedicated price feed error.', {
      sourceKey,
      marketDataFile: files.marketDataFile,
      error: message
    })
  }
}

function attachDedicatedSourceWatcher(
  source: PriceFeedSourceRow,
  callback: DedicatedPriceCallback
): void {
  const sourceKey = String(source?.source_key || '').trim().toLowerCase()
  const files = buildSourceFiles(source?.dwx_path)
  const marketDataFile = files.marketDataFile
  if (!sourceKey || !marketDataFile) return
  const configuredMarketDataFile: string = marketDataFile

  const watcherState = ensureDedicatedWatcherState(sourceKey)
  let watcher = watcherState.watcher || null

  const attach = (): void => {
    if (watcherState.watcher) {
      return
    }

    if (!fs.existsSync(configuredMarketDataFile) || !canReadFile(configuredMarketDataFile)) {
      setSourceRuntimeState(sourceKey, {
        watcher_attached: false,
        market_data_configured: true,
        market_data_readable: false,
        last_reason: 'watcher_market_data_missing'
      })
      logThrottled('warn', `dwx:${sourceKey}:watcher:missing`, 'Dedicated DWX market data file not found, watcher will retry.', {
        sourceKey,
        marketDataFile: configuredMarketDataFile,
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
      watcher = fs.watch(configuredMarketDataFile, (eventType): void => {
        void (async (): Promise<void> => {
          if (eventType === 'change') {
            await fetchAndStoreDedicatedSourcePrices(source)
            if (callback) await callback(sourceKey)
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
        })().catch((error: unknown) => {
          logger.error('Dedicated watcher event failed:', { sourceKey, error: errorMessage(error) })
        })
      })

      watcher.on('error', (error: Error): void => {
        void markPriceFeedSourceError(sourceKey, error.message).catch(() => {})
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
    } catch (error: unknown) {
      const message = errorMessage(error)
      void markPriceFeedSourceError(sourceKey, message).catch(() => {})
      setSourceRuntimeState(sourceKey, {
        watcher_attached: false,
        last_failure_at: new Date().toISOString(),
        last_reason: 'watcher_attach_failed',
        last_error: message
      })
      scheduleDedicatedWatcherRetry(sourceKey, attach, 5000)
    }
  }

  attach()
}

async function syncDedicatedPriceFeedWatchers(
  callback: DedicatedPriceCallback = () => {}
): Promise<void> {
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

async function bulkInsertHistoryTicks(
  client: PoolClient,
  rows: readonly HistoryTick[]
): Promise<void> {
  if (!rows.length) return
  const values: unknown[] = []
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

async function bootstrapHistoricalPriceHistory(): Promise<void> {
  const exportData = await loadMt5HistoryExport()
  const historyExportFile = HISTORY_EXPORT_FILE
  if (!exportData || !historyExportFile) return

  const lookbackStartMs = Date.now() - (Math.max(PRICE_HISTORY_RETAIN_DAYS, PRICE_HISTORY_BOOTSTRAP_DAYS) * 24 * 60 * 60 * 1000)
  const normalizedExportData: Mt5HistoryExport = {}
  for (const [instrument, bars] of Object.entries(exportData)) {
    const normalizedInstrument = String(instrument || '').trim().toUpperCase()
    if (normalizedInstrument) normalizedExportData[normalizedInstrument] = bars
  }
  const exportInstrumentSet = new Set(Object.keys(normalizedExportData))
  const bootstrapInstruments = INSTRUMENTS.filter((instrument) => exportInstrumentSet.has(instrument))
  const skippedConfiguredInstruments = INSTRUMENTS.filter((instrument) => !exportInstrumentSet.has(instrument))
  const extraExportInstruments = Object.keys(normalizedExportData).filter((instrument) => !INSTRUMENTS.includes(instrument))
  const insertedSummaries: InsertedSummary[] = []
  const failedInstruments: FailedInstrument[] = []

  if (bootstrapInstruments.length === 0) {
    logger.info('MT5 history export does not contain any platform-configured instruments; skipping bootstrap.', {
      source: path.basename(historyExportFile),
      exportSymbolCount: exportInstrumentSet.size
    })
    return
  }

  const historyStatsResult = await pool.query<HistoryStatsRow>(
    `SELECT instrument, COUNT(*)::int AS count, MIN(recorded_at) AS min_recorded_at
       FROM price_feed_history
      WHERE instrument = ANY($1::text[])
      GROUP BY instrument`,
    [bootstrapInstruments]
  )
  const historyStatsByInstrument = new Map<string, { count: number; minRecordedAt: Date | string | null }>(
    historyStatsResult.rows.map((row) => [
      String(row.instrument || '').trim().toUpperCase(),
      {
        count: parseInt(String(row.count), 10) || 0,
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
      const ticks: HistoryTick[] = []

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
      } catch (error: unknown) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }

      insertedSummaries.push({
        instrument,
        insertedTicks: ticks.length
      })
    } catch (error: unknown) {
      failedInstruments.push({
        instrument,
        error: errorMessage(error)
      })
    }
  }

  if (insertedSummaries.length > 0) {
    logger.info('MT5 history bootstrap inserted ticks.', {
      source: path.basename(historyExportFile),
      eligibleInstrumentCount: bootstrapInstruments.length,
      instrumentCount: insertedSummaries.length,
      totalInsertedTicks: insertedSummaries.reduce((sum, entry) => sum + (entry.insertedTicks || 0), 0),
      instruments: insertedSummaries
    })
  }

  if (skippedConfiguredInstruments.length > 0) {
    logger.info('MT5 history bootstrap skipped configured instruments that are not present in the MT5 export.', {
      source: path.basename(historyExportFile),
      eligibleInstrumentCount: bootstrapInstruments.length,
      skippedConfiguredCount: skippedConfiguredInstruments.length,
      sample: skippedConfiguredInstruments.slice(0, 12),
      truncated: skippedConfiguredInstruments.length > 12
    })
  }

  if (extraExportInstruments.length > 0) {
    logger.info('MT5 history export contains symbols that are not configured on the platform; ignored for bootstrap.', {
      source: path.basename(historyExportFile),
      extraExportCount: extraExportInstruments.length,
      sample: extraExportInstruments.slice(0, 12),
      truncated: extraExportInstruments.length > 12
    })
  }

  if (failedInstruments.length > 0) {
    logger.warn('MT5 history bootstrap failed for some instruments.', {
      source: path.basename(historyExportFile),
      failedCount: failedInstruments.length,
      failures: failedInstruments
    })
  }
}

async function syncHourlyPriceHistory(): Promise<void> {
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
  } catch (error: unknown) {
    logger.error('Hourly rollup sync failed:', { error: errorMessage(error) })
  }
}

async function pruneOldPriceHistory(): Promise<void> {
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

    if ((rawResult.rowCount || 0) > 0 || (hourlyResult.rowCount || 0) > 0) {
      logger.info('Price history pruned:', {
        rawDeleted: rawResult.rowCount,
        rawDays: PRICE_HISTORY_RETAIN_DAYS,
        hourlyDeleted: hourlyResult.rowCount,
        hourlyDays: PRICE_HISTORY_1H_RETAIN_DAYS
      })
    }
  } catch (error: unknown) {
    logger.error('Price history pruning error:', { error: errorMessage(error) })
  }
}

export {
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
