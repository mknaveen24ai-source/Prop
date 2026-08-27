import type { JsonValue } from '@propfirm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { z } from 'zod'
import { jsonValueSchema, parseExternal } from '../validation/unknown'
import pool = require('../db')
import logger = require('./logger')
import { ensureTenantSettingsInfrastructure } from './tenantSettings'

type NumericInput = string | number
type Queryable = Pick<Pool | PoolClient, 'query'>

interface PriceFeedSourceRow extends QueryResultRow {
  id: string
  source_key: string
  source_name: string
  source_type: string
  dwx_path: string | null
  status: string
  is_shared_default: boolean
  last_seen_at: Date | string | null
  last_error_at: Date | string | null
  error_message: string | null
  metadata_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

interface StoredPriceRow extends QueryResultRow {
  instrument: string
  bid: string
  ask: string
  updated_at: Date | string
}

interface PriceFeedConfigRow extends QueryResultRow {
  feed_name: string
  feed_mode: string
  source_key: string
  dwx_path: string | null
  fallback_to_shared: boolean
  spread_markup_points_json: unknown
  is_active: boolean
  metadata_json: unknown
  created_at: Date | string
  updated_at: Date | string
}

interface PriceInput {
  instrument: string
  bid: NumericInput
  ask: NumericInput
}

interface PricePoint {
  bid: number
  ask: number
  updated_at: Date | string
  age_ms: number
  stale: boolean
}

type PriceMap = Record<string, PricePoint>

interface TenantFeedConfig extends Record<string, unknown> {
  tenant_id: null
  feed_mode: string
  source_key: string
  fallback_to_shared: boolean
  effective_source_key: string
  effective_feed_mode: string
}

interface HeartbeatOptions {
  status?: string
  force?: boolean
}

const priceInputSchema: z.ZodType<PriceInput> = z.object({
  instrument: z.string().trim().min(1),
  bid: z.union([z.string().trim().min(1), z.number().finite()]),
  ask: z.union([z.string().trim().min(1), z.number().finite()])
})

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isQueryable(value: unknown): value is Queryable {
  return typeof value === 'object'
    && value !== null
    && 'query' in value
    && typeof value.query === 'function'
}

function parsePriceRows(input: unknown): PriceInput[] {
  return parseExternal(z.array(priceInputSchema), input, 'tenant feed price rows')
}

const SHARED_FEED_SOURCE_KEY = 'shared'
const FEED_STALE_MS = 15 * 1000
const FEED_HEARTBEAT_PERSIST_INTERVAL_MS = Math.max(1000, parseInt(process.env.FEED_HEARTBEAT_PERSIST_INTERVAL_MS || '10000', 10) || 10000)
const FEED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS = Math.max(1000, parseInt(process.env.FEED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS || '15000', 10) || 15000)

let tenantFeedInfrastructurePromise: Promise<void> | null = null
const lastHeartbeatPersistedAt = new Map<string, number>()
const lastHeartbeatPersistedStatus = new Map<string, string>()
const lastSourceHourlyPersistedAt = new Map<string, number>()
const heartbeatPersistPromises = new Map<string, Promise<void>>()
const sourceHourlyPersistPromises = new Map<string, Promise<void>>()

async function ensureTenantFeedInfrastructure(): Promise<void> {
  if (tenantFeedInfrastructurePromise) return tenantFeedInfrastructurePromise

  tenantFeedInfrastructurePromise = (async () => {
    await ensureTenantSettingsInfrastructure()

    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_feed_sources (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_name TEXT NOT NULL,
        source_type TEXT NOT NULL DEFAULT 'shared_env',
        dwx_path TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_shared_default BOOLEAN NOT NULL DEFAULT FALSE,
        last_seen_at TIMESTAMPTZ,
        last_error_at TIMESTAMPTZ,
        error_message TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_price_feed_sources_status ON price_feed_sources(status, source_type)`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_feed_source_prices (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL REFERENCES price_feed_sources(source_key) ON DELETE CASCADE,
        instrument TEXT NOT NULL,
        bid NUMERIC NOT NULL,
        ask NUMERIC NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source_key, instrument)
      )
    `)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_price_feed_source_prices_source_updated
       ON price_feed_source_prices(source_key, updated_at DESC)`
    )
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_feed_source_history (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL REFERENCES price_feed_sources(source_key) ON DELETE CASCADE,
        instrument TEXT NOT NULL,
        bid NUMERIC NOT NULL,
        ask NUMERIC NOT NULL,
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_price_feed_source_history_source_instrument_recorded_at
       ON price_feed_source_history(source_key, instrument, recorded_at DESC)`
    )
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_price_feed_source_history_source_instrument_recorded_at_cover
       ON price_feed_source_history(source_key, instrument, recorded_at DESC) INCLUDE (bid, ask)`
    )
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_feed_source_history_1h (
        id BIGSERIAL PRIMARY KEY,
        source_key TEXT NOT NULL REFERENCES price_feed_sources(source_key) ON DELETE CASCADE,
        instrument TEXT NOT NULL,
        bucket_time TIMESTAMPTZ NOT NULL,
        open NUMERIC NOT NULL,
        high NUMERIC NOT NULL,
        low NUMERIC NOT NULL,
        close NUMERIC NOT NULL,
        ticks INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (source_key, instrument, bucket_time)
      )
    `)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_price_feed_source_history_1h_source_instrument_bucket
       ON price_feed_source_history_1h(source_key, instrument, bucket_time DESC)`
    )

    // Single global feed config row — replaces the old per-tenant tenant_price_feeds table.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS price_feed_config (
        feed_name TEXT PRIMARY KEY DEFAULT 'default',
        feed_mode TEXT NOT NULL DEFAULT 'shared',
        source_key TEXT NOT NULL DEFAULT 'shared',
        dwx_path TEXT,
        fallback_to_shared BOOLEAN NOT NULL DEFAULT TRUE,
        spread_markup_points_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    await pool.query(
      `INSERT INTO price_feed_sources (source_key, source_name, source_type, status, is_shared_default, metadata_json)
       VALUES ($1, 'Platform Shared Feed', 'shared_env', 'active', TRUE, '{}'::jsonb)
       ON CONFLICT (source_key)
       DO UPDATE SET
         source_name = EXCLUDED.source_name,
         source_type = EXCLUDED.source_type,
         is_shared_default = TRUE,
         updated_at = NOW()`,
      [SHARED_FEED_SOURCE_KEY]
    )
  })().catch((error: unknown) => {
    tenantFeedInfrastructurePromise = null
    logger.error('[price-feed-config] Failed to ensure infrastructure:', { error: errorMessage(error) })
    throw error
  })

  return tenantFeedInfrastructurePromise
}

function normalizeFeedMode(value: unknown, fallback = 'shared'): string {
  const normalized = String(value || fallback).trim().toLowerCase()
  return ['shared', 'dedicated'].includes(normalized) ? normalized : fallback
}

async function listActivePriceFeedSources(): Promise<PriceFeedSourceRow[]> {
  await ensureTenantFeedInfrastructure()
  const result = await pool.query<PriceFeedSourceRow>(
    `SELECT *
       FROM price_feed_sources
      WHERE status IN ('active', 'degraded')
      ORDER BY is_shared_default DESC, source_name ASC, id ASC`
  )
  return result.rows
}

async function listManagedPriceFeedSources(): Promise<PriceFeedSourceRow[]> {
  await ensureTenantFeedInfrastructure()
  const result = await pool.query<PriceFeedSourceRow>(
    `SELECT *
       FROM price_feed_sources
      WHERE source_type IN ('shared_env', 'dwx_path')
      ORDER BY is_shared_default DESC, source_name ASC, id ASC`
  )
  return result.rows
}

async function getPriceFeedSource(sourceKey: unknown): Promise<PriceFeedSourceRow | null> {
  await ensureTenantFeedInfrastructure()
  const normalizedSourceKey = String(sourceKey || '').trim().toLowerCase()
  if (!normalizedSourceKey) return null
  const result = await pool.query<PriceFeedSourceRow>(
    `SELECT * FROM price_feed_sources WHERE source_key = $1 LIMIT 1`,
    [normalizedSourceKey]
  )
  return result.rows[0] || null
}

async function markPriceFeedSourceHeartbeat(
  sourceKey: unknown,
  options: HeartbeatOptions = {}
): Promise<void> {
  await ensureTenantFeedInfrastructure()
  const normalizedSourceKey = String(sourceKey || '').trim().toLowerCase()
  const nextStatus = String(options.status || 'active').trim().toLowerCase() || 'active'
  const force = options.force === true
  const inFlightPromise = heartbeatPersistPromises.get(normalizedSourceKey)
  if (inFlightPromise) {
    return inFlightPromise
  }
  const now = Date.now()
  const previousWriteAt = lastHeartbeatPersistedAt.get(normalizedSourceKey) || 0
  const previousStatus = lastHeartbeatPersistedStatus.get(normalizedSourceKey) || null

  if (!force && previousStatus === nextStatus && (now - previousWriteAt) < FEED_HEARTBEAT_PERSIST_INTERVAL_MS) {
    return
  }
  lastHeartbeatPersistedAt.set(normalizedSourceKey, now)
  const heartbeatPromise = pool.query(
    `UPDATE price_feed_sources
        SET status = $2,
            error_message = NULL,
            last_seen_at = NOW(),
            updated_at = NOW()
      WHERE source_key = $1`,
    [normalizedSourceKey, nextStatus]
  ).then(() => {
    lastHeartbeatPersistedStatus.set(normalizedSourceKey, nextStatus)
  }).catch((error: unknown) => {
    lastHeartbeatPersistedAt.set(normalizedSourceKey, previousWriteAt)
    if (previousStatus) {
      lastHeartbeatPersistedStatus.set(normalizedSourceKey, previousStatus)
    } else {
      lastHeartbeatPersistedStatus.delete(normalizedSourceKey)
    }
    throw error
  }).finally(() => {
    heartbeatPersistPromises.delete(normalizedSourceKey)
  })
  heartbeatPersistPromises.set(normalizedSourceKey, heartbeatPromise)
  return heartbeatPromise
}

async function markPriceFeedSourceError(sourceKey: unknown, message: unknown): Promise<void> {
  await ensureTenantFeedInfrastructure()
  const normalizedSourceKey = String(sourceKey || '').trim().toLowerCase()
  await pool.query(
    `UPDATE price_feed_sources
        SET status = 'error',
            error_message = $2,
            last_error_at = NOW(),
            updated_at = NOW()
      WHERE source_key = $1`,
    [normalizedSourceKey, String(message || 'Unknown price feed error')]
  )
  lastHeartbeatPersistedAt.set(normalizedSourceKey, Date.now())
  lastHeartbeatPersistedStatus.set(normalizedSourceKey, 'error')
}

async function upsertSourcePrices(sourceKey: unknown, input: unknown = []): Promise<void> {
  await ensureTenantFeedInfrastructure()
  if (!Array.isArray(input) || input.length === 0) return
  const priceRows = parsePriceRows(input)

  const values: unknown[] = []
  const placeholders: string[] = []

  priceRows.forEach((row, index) => {
    const offset = index * 4
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, NOW())`)
    values.push(sourceKey, row.instrument, row.bid, row.ask)
  })

  await pool.query(
    `INSERT INTO price_feed_source_prices (source_key, instrument, bid, ask, updated_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (source_key, instrument)
     DO UPDATE SET
       bid = EXCLUDED.bid,
       ask = EXCLUDED.ask,
       updated_at = NOW()`,
    values
  )

  await markPriceFeedSourceHeartbeat(sourceKey)
}

async function upsertSourceHourlyTicks(sourceKey: unknown, input: unknown = []): Promise<void> {
  if (!Array.isArray(input) || input.length === 0) return
  const priceRows = parsePriceRows(input)

  const normalizedSourceKey = String(sourceKey || '').trim().toLowerCase()
  const inFlightPromise = sourceHourlyPersistPromises.get(normalizedSourceKey)
  if (inFlightPromise) {
    return inFlightPromise
  }
  const nowMs = Date.now()
  const previousWriteAt = lastSourceHourlyPersistedAt.get(normalizedSourceKey) || 0
  if ((nowMs - previousWriteAt) < FEED_HOURLY_ROLLUP_PERSIST_INTERVAL_MS) {
    return
  }
  lastSourceHourlyPersistedAt.set(normalizedSourceKey, nowMs)

  const now = new Date()
  const bucket = new Date(now)
  bucket.setUTCMinutes(0, 0, 0)

  const placeholders: string[] = []
  const values: unknown[] = []

  priceRows.forEach((row, index) => {
    const offset = index * 7
    placeholders.push(
      `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, 1, NOW())`
    )
    values.push(normalizedSourceKey, row.instrument, bucket.toISOString(), row.bid, row.bid, row.bid, row.bid)
  })

  const rollupPromise = pool.query(
    `INSERT INTO price_feed_source_history_1h
       (source_key, instrument, bucket_time, open, high, low, close, ticks, updated_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (source_key, instrument, bucket_time)
     DO UPDATE SET
       high = GREATEST(price_feed_source_history_1h.high, EXCLUDED.high),
       low = LEAST(price_feed_source_history_1h.low, EXCLUDED.low),
       close = EXCLUDED.close,
       ticks = price_feed_source_history_1h.ticks + 1,
       updated_at = NOW()`,
    values
  ).then(() => {}).catch((error: unknown) => {
    lastSourceHourlyPersistedAt.set(normalizedSourceKey, previousWriteAt)
    throw error
  }).finally(() => {
    sourceHourlyPersistPromises.delete(normalizedSourceKey)
  })
  sourceHourlyPersistPromises.set(normalizedSourceKey, rollupPromise)
  return rollupPromise
}

async function appendSourcePriceHistory(sourceKey: unknown, input: unknown = []): Promise<void> {
  await ensureTenantFeedInfrastructure()
  if (!Array.isArray(input) || input.length === 0) return
  const priceRows = parsePriceRows(input)

  const placeholders: string[] = []
  const values: unknown[] = []

  priceRows.forEach((row, index) => {
    const offset = index * 4
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, NOW())`)
    values.push(sourceKey, row.instrument, row.bid, row.ask)
  })

  await pool.query(
    `INSERT INTO price_feed_source_history (source_key, instrument, bid, ask, recorded_at)
     VALUES ${placeholders.join(', ')}`,
    values
  )

  await upsertSourceHourlyTicks(sourceKey, priceRows)
}

async function getCurrentPricesForSource(sourceKey: unknown): Promise<PriceMap> {
  await ensureTenantFeedInfrastructure()
  const normalizedSourceKey = String(sourceKey || SHARED_FEED_SOURCE_KEY).trim().toLowerCase()
  if (normalizedSourceKey === SHARED_FEED_SOURCE_KEY) {
    const result = await pool.query<StoredPriceRow>('SELECT instrument, bid, ask, updated_at FROM price_feed')
    return buildPriceMap(result.rows)
  }

  const result = await pool.query<StoredPriceRow>(
    `SELECT instrument, bid, ask, updated_at
       FROM price_feed_source_prices
      WHERE source_key = $1`,
    [normalizedSourceKey]
  )
  return buildPriceMap(result.rows)
}

async function getCurrentPriceForSource(
  sourceKey: unknown,
  instrument: unknown
): Promise<PricePoint | null> {
  const prices = await getCurrentPricesForSource(sourceKey)
  return prices[String(instrument || '').trim().toUpperCase()] || null
}

function buildPriceMap(rows: readonly StoredPriceRow[] = []): PriceMap {
  const now = Date.now()
  return Object.fromEntries(
    rows.map((row) => {
      const ageMs = now - new Date(row.updated_at).getTime()
      return [row.instrument, {
        bid: Number(row.bid),
        ask: Number(row.ask),
        updated_at: row.updated_at,
        age_ms: ageMs,
        stale: ageMs > 5000
      }]
    })
  )
}

// Returns the single global feed config (dedicated MT5 feed vs. shared feed,
// spread markup). Kept as an async function returning a tenant-shaped object
// (tenant_id always null) so downstream consumers didn't need restructuring.
async function getTenantPriceFeedConfig(): Promise<TenantFeedConfig> {
  await ensureTenantFeedInfrastructure()

  const result = await pool.query<PriceFeedConfigRow>(
    `SELECT * FROM price_feed_config WHERE feed_name = 'default' AND is_active = TRUE LIMIT 1`
  )

  const row = result.rows[0]
  if (!row) {
    return {
      tenant_id: null,
      feed_mode: 'shared',
      source_key: SHARED_FEED_SOURCE_KEY,
      fallback_to_shared: true,
      effective_source_key: SHARED_FEED_SOURCE_KEY,
      effective_feed_mode: 'shared'
    }
  }

  const feedMode = normalizeFeedMode(row.feed_mode, 'shared')
  const sourceKey = String(row.source_key || SHARED_FEED_SOURCE_KEY).trim().toLowerCase()
  const fallbackToShared = row.fallback_to_shared !== false
  let effectiveSourceKey = feedMode === 'dedicated' ? sourceKey : SHARED_FEED_SOURCE_KEY
  let effectiveFeedMode = feedMode

  if (feedMode === 'dedicated') {
    const source = await getPriceFeedSource(sourceKey)
    const lastSeenAt = source?.last_seen_at ? new Date(source.last_seen_at).getTime() : 0
    const isStale = !lastSeenAt || (Date.now() - lastSeenAt) > FEED_STALE_MS
    if (!source || source.status === 'error' || isStale) {
      if (fallbackToShared) {
        effectiveSourceKey = SHARED_FEED_SOURCE_KEY
        effectiveFeedMode = 'shared_fallback'
      }
    }
  }

  return {
    ...row,
    tenant_id: null,
    feed_mode: feedMode,
    source_key: sourceKey,
    fallback_to_shared: fallbackToShared,
    effective_source_key: effectiveSourceKey,
    effective_feed_mode: effectiveFeedMode
  }
}

async function upsertTenantPriceFeedConfig(
  clientOrPool: unknown,
  input: unknown = {}
): Promise<void> {
  await ensureTenantFeedInfrastructure()
  const db = isQueryable(clientOrPool) ? clientOrPool : pool
  const config = parseExternal(
    z.record(z.string(), z.unknown()),
    input,
    'tenant price feed config'
  )

  const existingConfigResult = await db.query<PriceFeedConfigRow>(
    `SELECT * FROM price_feed_config WHERE feed_name = 'default' LIMIT 1`
  )
  const existingConfig = existingConfigResult.rows[0] || null

  const feedMode = normalizeFeedMode(config.feed_mode, existingConfig?.feed_mode || 'shared')
  const sourceKey = String(
    config.source_key
    || existingConfig?.source_key
    || (feedMode === 'dedicated' ? 'default' : SHARED_FEED_SOURCE_KEY)
  )
    .trim()
    .toLowerCase() || SHARED_FEED_SOURCE_KEY
  const fallbackToShared = config.fallback_to_shared !== undefined
    ? config.fallback_to_shared !== false
    : existingConfig?.fallback_to_shared !== false
  const hasExplicitSpreadMarkup = config.spread_markup_points_json !== undefined
  const rawSpreadMarkupPointsJson = hasExplicitSpreadMarkup
    ? config.spread_markup_points_json
    : existingConfig?.spread_markup_points_json ?? null
  const rawMetadataJson = config.metadata_json !== undefined
    ? config.metadata_json
    : (existingConfig?.metadata_json || {})
  const spreadMarkupPointsJson: JsonValue = parseExternal(
    jsonValueSchema,
    rawSpreadMarkupPointsJson,
    'price feed spread markup JSON'
  )
  const metadataJson: JsonValue = parseExternal(
    jsonValueSchema,
    rawMetadataJson,
    'price feed metadata JSON'
  )
  const dwxPath = config.dwx_path !== undefined
    ? (String(config.dwx_path || '').trim() || null)
    : (existingConfig?.dwx_path || null)

  if (feedMode === 'dedicated') {
    await db.query(
      `INSERT INTO price_feed_sources (source_key, source_name, source_type, dwx_path, status, is_shared_default, metadata_json, updated_at)
       VALUES ($1, $2, 'dwx_path', $3, 'active', FALSE, $4::jsonb, NOW())
       ON CONFLICT (source_key)
       DO UPDATE SET
         source_name = EXCLUDED.source_name,
         source_type = 'dwx_path',
         dwx_path = EXCLUDED.dwx_path,
         status = 'active',
         metadata_json = COALESCE(price_feed_sources.metadata_json, '{}'::jsonb) || EXCLUDED.metadata_json,
         updated_at = NOW()`,
      [sourceKey, String(config.source_name || 'Dedicated Feed').trim() || 'Dedicated Feed', dwxPath, JSON.stringify(metadataJson)]
    )
  }

  await db.query(
    `INSERT INTO price_feed_config
      (feed_name, feed_mode, dwx_path, spread_markup_points_json, is_active, metadata_json, source_key, fallback_to_shared, updated_at)
     VALUES ('default', $1, $2, $3::jsonb, TRUE, $4::jsonb, $5, $6, NOW())
     ON CONFLICT (feed_name)
     DO UPDATE SET
       feed_mode = EXCLUDED.feed_mode,
       dwx_path = EXCLUDED.dwx_path,
       spread_markup_points_json = EXCLUDED.spread_markup_points_json,
       is_active = TRUE,
       metadata_json = EXCLUDED.metadata_json,
       source_key = EXCLUDED.source_key,
       fallback_to_shared = EXCLUDED.fallback_to_shared,
       updated_at = NOW()`,
    [
      feedMode,
      dwxPath,
      JSON.stringify(spreadMarkupPointsJson),
      JSON.stringify(metadataJson),
      sourceKey,
      fallbackToShared
    ]
  )
}

export {
  FEED_STALE_MS,
  SHARED_FEED_SOURCE_KEY,
  ensureTenantFeedInfrastructure,
  getCurrentPriceForSource,
  getCurrentPricesForSource,
  getPriceFeedSource,
  getTenantPriceFeedConfig,
  listActivePriceFeedSources,
  listManagedPriceFeedSources,
  markPriceFeedSourceError,
  markPriceFeedSourceHeartbeat,
  normalizeFeedMode,
  appendSourcePriceHistory,
  upsertSourcePrices,
  upsertTenantPriceFeedConfig
}

export type {
  PriceFeedSourceRow,
  PriceInput,
  PriceMap,
  PricePoint,
  TenantFeedConfig
}
