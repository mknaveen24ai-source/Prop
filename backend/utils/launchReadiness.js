const pool = require('../db')
const { metrics } = require('./performance')
const { getCacheStats } = require('./tokenCache')
const {
  FEED_STALE_MS,
  SHARED_FEED_SOURCE_KEY,
  getPriceFeedSource
} = require('./tenantFeeds')
const { getTenantFeedConfig } = require('../services/tenantPolicyService')
const {
  getCurrentPrices,
  getCurrentPricesForTenant,
  getPriceFeedRuntimeStatus,
  INSTRUMENTS
} = require('../priceFeed')

function parsePositiveInt(value, fallback) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const LAUNCH_FEED_STALE_MS = parsePositiveInt(process.env.LAUNCH_FEED_STALE_MS, FEED_STALE_MS)
const HEALTH_5XX_WINDOW_MS = parsePositiveInt(process.env.HEALTH_5XX_WINDOW_MS, 5 * 60 * 1000)
const HEALTH_5XX_WARNING_THRESHOLD = parsePositiveInt(process.env.HEALTH_5XX_WARNING_THRESHOLD, 10)

function normalizeInstrumentList(values = []) {
  if (!Array.isArray(values)) return []
  return [...new Set(
    values
      .map((value) => String(value || '').trim().toUpperCase())
      .filter(Boolean)
      .filter((value) => INSTRUMENTS.includes(value))
  )]
}

function getRequiredLaunchInstruments() {
  const configured = String(process.env.LAUNCH_REQUIRED_INSTRUMENTS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const fallback = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD']
  const required = normalizeInstrumentList(configured.length > 0 ? configured : fallback)
  return required
}

function summarizeFeedSnapshot(prices = {}, options = {}) {
  const staleMs = parsePositiveInt(options.staleMs, LAUNCH_FEED_STALE_MS)
  const requiredInstruments = normalizeInstrumentList(options.requiredInstruments || [])
  const now = Date.now()
  const instruments = {}
  const availableInstruments = Object.keys(prices || {})
  let healthySymbolCount = 0
  let staleSymbolCount = 0

  for (const [instrument, value] of Object.entries(prices || {})) {
    const updatedAt = value?.updated_at || null
    const ageMs = Number.isFinite(Number(value?.age_ms))
      ? Number(value.age_ms)
      : (updatedAt ? now - new Date(updatedAt).getTime() : Number.POSITIVE_INFINITY)
    const healthy = Number.isFinite(ageMs) && ageMs <= staleMs

    if (healthy) healthySymbolCount += 1
    else staleSymbolCount += 1

    instruments[instrument] = {
      age_seconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
      healthy,
      updated_at: updatedAt
    }
  }

  const missingRequiredInstruments = requiredInstruments.filter((instrument) => {
    const row = instruments[instrument]
    return !row || row.healthy !== true
  })

  let status = 'healthy'
  let message = 'Price feed operational'

  if (availableInstruments.length === 0) {
    status = 'unhealthy'
    message = 'No live prices are currently available'
  } else if (missingRequiredInstruments.length > 0) {
    status = 'unhealthy'
    message = `Launch-critical instruments are missing or stale: ${missingRequiredInstruments.join(', ')}`
  } else if (staleSymbolCount > 0) {
    status = 'degraded'
    message = 'Price feed is delayed for one or more non-critical instruments'
  }

  return {
    healthy: status === 'healthy',
    launch_ready: status === 'healthy',
    status,
    message,
    stale_threshold_seconds: Math.round(staleMs / 1000),
    symbol_count: availableInstruments.length,
    healthy_symbol_count: healthySymbolCount,
    stale_symbol_count: staleSymbolCount,
    supported_instruments: normalizeInstrumentList(availableInstruments),
    required_launch_instruments: requiredInstruments,
    missing_launch_instruments: missingRequiredInstruments,
    instruments
  }
}

function sanitizeRuntimeState(runtime = null) {
  if (!runtime) return null

  return {
    source_key: runtime.source_key || null,
    command_channel_configured: runtime.command_channel_configured === true,
    command_channel_writable: runtime.command_channel_writable === true,
    watcher_attached: runtime.watcher_attached === true,
    live_feed_available: runtime.live_feed_available === true,
    symbol_count: Number.isFinite(Number(runtime.symbol_count)) ? Number(runtime.symbol_count) : 0,
    last_fetch_at: runtime.last_fetch_at || null,
    last_success_at: runtime.last_success_at || null,
    last_failure_at: runtime.last_failure_at || null,
    last_reason: runtime.last_reason || null,
    last_error: runtime.last_error || null
  }
}

async function getFeedHealthForTenant(tenantId = null) {
  const normalizedTenantId = parseInt(tenantId, 10)
  const scopedTenantId = Number.isFinite(normalizedTenantId) && normalizedTenantId > 0 ? normalizedTenantId : null
  const feedConfig = scopedTenantId
    ? await getTenantFeedConfig(scopedTenantId, { forceRefresh: true })
    : {
        tenant_id: null,
        feed_mode: 'shared',
        source_key: SHARED_FEED_SOURCE_KEY,
        effective_source_key: SHARED_FEED_SOURCE_KEY,
        effective_feed_mode: 'shared',
        fallback_to_shared: true
      }
  const prices = scopedTenantId
    ? await getCurrentPricesForTenant(scopedTenantId)
    : await getCurrentPrices()
  const requiredLaunchInstruments = getRequiredLaunchInstruments()
  const summary = summarizeFeedSnapshot(prices, {
    staleMs: LAUNCH_FEED_STALE_MS,
    requiredInstruments: requiredLaunchInstruments
  })

  const effectiveSourceKey = String(feedConfig.effective_source_key || SHARED_FEED_SOURCE_KEY).trim().toLowerCase()
  const source = await getPriceFeedSource(effectiveSourceKey)
  const runtime = sanitizeRuntimeState(getPriceFeedRuntimeStatus(effectiveSourceKey))
  const sourceLastSeenAt = source?.last_seen_at || runtime?.last_success_at || null
  const sourceAgeMs = sourceLastSeenAt ? Date.now() - new Date(sourceLastSeenAt).getTime() : Number.POSITIVE_INFINITY
  const sourceHealthy = Number.isFinite(sourceAgeMs) && sourceAgeMs <= LAUNCH_FEED_STALE_MS
  const fallbackActive = feedConfig.feed_mode === 'dedicated' && feedConfig.effective_feed_mode === 'shared_fallback'

  let status = summary.status
  let message = summary.message
  if (!sourceHealthy) {
    status = 'unhealthy'
    message = 'Price feed source heartbeat is stale'
  } else if (summary.status === 'healthy' && fallbackActive) {
    status = 'degraded'
    message = 'Dedicated feed is currently using shared fallback'
  }

  return {
    ...summary,
    healthy: status === 'healthy',
    launch_ready: status === 'healthy',
    status,
    message,
    tenant_id: scopedTenantId,
    feed_mode: feedConfig.feed_mode || 'shared',
    effective_feed_mode: feedConfig.effective_feed_mode || 'shared',
    source_key: effectiveSourceKey,
    fallback_active: fallbackActive,
    source_status: source?.status || null,
    source_last_seen_at: source?.last_seen_at || null,
    source_age_seconds: Number.isFinite(sourceAgeMs) ? Math.round(sourceAgeMs / 1000) : null,
    source_healthy: sourceHealthy,
    runtime
  }
}

async function getDatabaseHealth() {
  try {
    const query = typeof pool.__rawQuery === 'function'
      ? pool.__rawQuery.bind(pool)
      : pool.query.bind(pool)
    await query('SELECT 1')
    return { healthy: true, status: 'healthy' }
  } catch (error) {
    return {
      healthy: false,
      status: 'unhealthy',
      error: error.message
    }
  }
}

async function getRedisHealth() {
  const stats = await getCacheStats()
  if (stats.status === 'active') {
    return { healthy: true, status: 'healthy' }
  }
  if (stats.status === 'unavailable') {
    return { healthy: false, status: 'warning', message: stats.message }
  }
  return {
    healthy: false,
    status: 'warning',
    error: stats.error || 'Redis cache unavailable'
  }
}

function getRecent5xxCount() {
  const now = Date.now()
  const rows = Array.isArray(metrics.requests?.errorResponses)
    ? metrics.requests.errorResponses
    : []
  return rows.filter((entry) => (now - entry.timestampMs) <= HEALTH_5XX_WINDOW_MS).length
}

async function getLaunchHealthStatus(tenantId = null) {
  const [database, redis, feed] = await Promise.all([
    getDatabaseHealth(),
    getRedisHealth(),
    getFeedHealthForTenant(tenantId)
  ])

  const memory = process.memoryUsage()
  const heapUsagePercent = memory.heapTotal > 0
    ? Number(((memory.heapUsed / memory.heapTotal) * 100).toFixed(2))
    : 0
  const recent5xxCount = getRecent5xxCount()
  const alerts = []
  let status = 'healthy'

  if (!database.healthy) {
    status = 'unhealthy'
    alerts.push('database_unavailable')
  }
  if (feed.status === 'unhealthy') {
    status = 'unhealthy'
    alerts.push('price_feed_unhealthy')
  }
  if (redis.healthy !== true && status !== 'unhealthy') {
    status = 'warning'
    alerts.push('redis_unavailable')
  }
  if (recent5xxCount >= HEALTH_5XX_WARNING_THRESHOLD && status === 'healthy') {
    status = 'warning'
    alerts.push('high_5xx_rate')
  }
  if (feed.status === 'degraded' && status === 'healthy') {
    status = 'warning'
    alerts.push('price_feed_degraded')
  }
  if (heapUsagePercent > 90 && status === 'healthy') {
    status = 'warning'
    alerts.push('high_memory_usage')
  }

  return {
    status,
    launch_ready: status === 'healthy',
    alerts,
    memory: {
      heapUsagePercent,
      rss: `${(memory.rss / 1024 / 1024).toFixed(2)} MB`
    },
    uptime: Date.now() - metrics.startTime,
    checks: {
      database,
      redis,
      price_feed: feed,
      http: {
        recent_5xx_count: recent5xxCount,
        warning_threshold: HEALTH_5XX_WARNING_THRESHOLD,
        window_seconds: Math.round(HEALTH_5XX_WINDOW_MS / 1000)
      }
    }
  }
}

module.exports = {
  LAUNCH_FEED_STALE_MS,
  getFeedHealthForTenant,
  getLaunchHealthStatus,
  getRequiredLaunchInstruments,
  summarizeFeedSnapshot
}
