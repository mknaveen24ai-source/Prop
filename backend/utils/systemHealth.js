'use strict'
/**
 * System health snapshot.
 * ─────────────────────────────────────────────────────────────────────────────
 * One call that answers "is anything degraded right now?" across every
 * subsystem that can fail independently: the database pool, Redis, the price
 * feed, the trade engine, the email queue and the WebSocket layer.
 *
 * Two rules this file follows:
 *
 * 1. Every probe is individually guarded. A health endpoint that 500s because
 *    one subsystem is down is useless precisely when it is needed, so a failed
 *    probe reports status 'error' for that section and the rest still render.
 *
 * 2. Nothing here writes. It is safe to poll on an interval from an admin page.
 */

const pool = require('../db')
const logger = require('./logger')

const STATUS = { OK: 'ok', WARN: 'warn', ERROR: 'error', UNKNOWN: 'unknown' }

// A pool with clients queued is the earliest visible sign of saturation: the
// queries have not failed yet, they are waiting for a connection.
const POOL_WAITING_WARN = 1
// The feed is polled roughly once a second; a few seconds of silence is a
// blip, half a minute means the bridge is gone.
const PRICE_STALE_WARN_MS = 5_000
const PRICE_STALE_ERROR_MS = 30_000
const ENGINE_TICK_WARN_MS = 30_000

async function guard(name, probe) {
  try {
    return await probe()
  } catch (error) {
    logger.warn(`[systemHealth] ${name} probe failed:`, { error: error.message })
    return { status: STATUS.ERROR, error: error.message }
  }
}

function databaseHealth() {
  // node-postgres exposes these counters directly on the pool.
  const total = pool.totalCount ?? null
  const idle = pool.idleCount ?? null
  const waiting = pool.waitingCount ?? null
  const max = pool.options?.max ?? null

  let status = STATUS.OK
  if (waiting !== null && waiting >= POOL_WAITING_WARN) status = STATUS.WARN
  if (max && total !== null && total >= max && waiting > 0) status = STATUS.ERROR

  return { status, total, idle, waiting, max }
}

async function databaseLatency() {
  const start = Date.now()
  await pool.query('SELECT 1')
  return { status: STATUS.OK, latencyMs: Date.now() - start }
}

async function redisHealth() {
  const { getCacheStats } = require('./tokenCache')
  const stats = await getCacheStats()
  // getCacheStats reports 'unavailable' when Redis was never configured, which
  // is a supported deployment shape (tokenCache falls back to the database), so
  // it is not an error — just not in use.
  if (stats.status === 'active') return { status: STATUS.OK, connected: true }
  if (stats.status === 'unavailable') {
    return { status: STATUS.OK, connected: false, note: 'Redis not configured; token cache falls back to the database' }
  }
  return { status: STATUS.WARN, connected: false, error: stats.error || null }
}

function priceFeedHealth() {
  const priceCache = require('./priceCache')
  const ageMs = priceCache.getPriceCacheAgeMs()
  const hasPrices = priceCache.hasPrices()

  if (ageMs === null) {
    return { status: STATUS.WARN, ageMs: null, hasPrices, note: 'no tick received since start' }
  }
  let status = STATUS.OK
  if (ageMs > PRICE_STALE_ERROR_MS) status = STATUS.ERROR
  else if (ageMs > PRICE_STALE_WARN_MS) status = STATUS.WARN

  return { status, ageMs, hasPrices, stale: priceCache.isStale() }
}

function tradeEngineHealth() {
  const { getEngineStats } = require('../services/tradeEngine')
  const stats = getEngineStats() || {}
  const mode = process.env.ENGINE_MODE || 'interval'

  // lastReconcileAt is the freshest engine heartbeat available without adding
  // new bookkeeping to the hot path.
  const lastReconcileAt = stats.lastReconcileAt || null
  const sinceReconcileMs = lastReconcileAt ? Date.now() - new Date(lastReconcileAt).getTime() : null

  let status = STATUS.OK
  if (!stats.ready) status = STATUS.WARN
  if (mode === 'event' && sinceReconcileMs !== null && sinceReconcileMs > ENGINE_TICK_WARN_MS) {
    status = STATUS.WARN
  }

  return {
    status,
    mode,
    ready: Boolean(stats.ready),
    openTrades: stats.trades ?? null,
    pendingOrders: stats.pending ?? null,
    accounts: stats.accounts ?? null,
    dirtyPeaks: stats.dirtyPeaks ?? null,
    priceCacheAgeMs: stats.priceCacheAgeMs ?? null,
    lastReconcileAt,
    sinceReconcileMs
  }
}

async function emailQueueHealth() {
  const { getDeadLetterStats } = require('./emailQueue')
  const [queued, dead] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'retry')::int   AS retrying,
         COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
         MAX(sent_at)                                    AS last_sent_at
       FROM email_jobs`
    ),
    getDeadLetterStats()
  ])
  const row = queued.rows[0] || {}

  // Dead letters mean mail is being dropped, so they outrank a backlog.
  let status = STATUS.OK
  if ((row.pending || 0) > 500) status = STATUS.WARN
  if ((dead.dead_last_24h || 0) > 0) status = STATUS.WARN
  if ((dead.dead_last_24h || 0) > 25) status = STATUS.ERROR

  return {
    status,
    pending: row.pending || 0,
    retrying: row.retrying || 0,
    sending: row.sending || 0,
    lastSentAt: row.last_sent_at || null,
    ...dead
  }
}

function websocketHealth() {
  const { getConnectedSocketCount } = require('./realtime')
  const connected = getConnectedSocketCount()
  if (connected === null) {
    return { status: STATUS.UNKNOWN, connected: null, note: 'Socket.IO not registered in this process' }
  }
  return { status: STATUS.OK, connected }
}

function processHealth() {
  const mem = process.memoryUsage()
  const heapUsedPct = (mem.heapUsed / mem.heapTotal) * 100
  const cpu = process.cpuUsage()

  return {
    status: heapUsedPct > 90 ? STATUS.WARN : STATUS.OK,
    uptimeSeconds: Math.round(process.uptime()),
    heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
    heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(1),
    heapUsedPct: +heapUsedPct.toFixed(1),
    rssMb: +(mem.rss / 1024 / 1024).toFixed(1),
    cpuUserMs: Math.round(cpu.user / 1000),
    cpuSystemMs: Math.round(cpu.system / 1000),
    nodeVersion: process.version,
    pid: process.pid
  }
}

// Worst wins, so the top-level badge can never look healthier than its parts.
const SEVERITY = { [STATUS.OK]: 0, [STATUS.UNKNOWN]: 0, [STATUS.WARN]: 1, [STATUS.ERROR]: 2 }

function rollUp(sections) {
  let worst = STATUS.OK
  for (const section of Object.values(sections)) {
    const severity = SEVERITY[section?.status] ?? 0
    if (severity > SEVERITY[worst]) worst = section.status
  }
  return worst
}

async function getSystemHealth() {
  const [database, databasePing, redis, emailQueue] = await Promise.all([
    guard('database', async () => databaseHealth()),
    guard('databasePing', databaseLatency),
    guard('redis', redisHealth),
    guard('emailQueue', emailQueueHealth)
  ])

  const sections = {
    database: { ...database, ...(databasePing.latencyMs !== undefined ? { latencyMs: databasePing.latencyMs } : {}) },
    redis,
    priceFeed: await guard('priceFeed', async () => priceFeedHealth()),
    tradeEngine: await guard('tradeEngine', async () => tradeEngineHealth()),
    emailQueue,
    websocket: await guard('websocket', async () => websocketHealth()),
    process: processHealth()
  }

  // A failed ping is a database problem even if the pool counters look fine.
  if (databasePing.status === STATUS.ERROR) {
    sections.database.status = STATUS.ERROR
    sections.database.error = databasePing.error
  }

  return {
    status: rollUp(sections),
    generatedAt: new Date().toISOString(),
    sections
  }
}

module.exports = { getSystemHealth, STATUS }
