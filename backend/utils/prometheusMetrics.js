'use strict'
/**
 * Prometheus exposition.
 * ─────────────────────────────────────────────────────────────────────────────
 * The bespoke /api/metrics endpoint (utils/performance.js) stays as it is —
 * the admin UI consumes its JSON shape. This module adds a scrapeable
 * text-format endpoint alongside it rather than replacing it.
 *
 * Request timing is recorded by the same middleware that already feeds
 * performance.js, so there is one measurement point, not two.
 *
 * Route labels come from the matched Express route (req.route.path), never the
 * raw URL. Labelling by URL would mint a new time series per account id and
 * blow up cardinality within a day of real traffic.
 */

const client = require('prom-client')
const logger = require('./logger')

const register = new client.Registry()
register.setDefaultLabels({ app: 'propfirm' })
client.collectDefaultMetrics({ register })

// ─── HTTP ────────────────────────────────────────────────────────────────────

const httpRequestDuration = new client.Histogram({
  name: 'propfirm_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  // Tuned for this app: most reads land under 100ms, and anything past 5s is
  // already a problem rather than something needing resolution.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register]
})

const httpRequestTotal = new client.Counter({
  name: 'propfirm_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
})

// ─── Trade engine ────────────────────────────────────────────────────────────

const engineTickDuration = new client.Histogram({
  name: 'propfirm_engine_tick_duration_seconds',
  help: 'Trade engine tick duration in seconds',
  labelNames: ['tick_type'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register]
})

// ─── Price feed ──────────────────────────────────────────────────────────────
// Time spent turning a DWX file change into a usable price map: the stat, the
// read, the parse, and the throttled Postgres persistence when it is due.
//
// This sits IN FRONT of the engine tick — the same await chain that ends in
// onPriceTick — so it is added directly to every stop-loss reaction time, and
// until now it was the one part of that path with no measurement at all.
//
// Read it against propfirm_engine_tick_duration_seconds. If ingest p99 is a
// small fraction of the tick, the feed is not the problem and moving it to its
// own process would buy isolation but not latency. If it is comparable or
// larger, the file parse is the thing to fix first.
const priceFeedIngestDuration = new client.Histogram({
  name: 'propfirm_price_feed_ingest_duration_seconds',
  help: 'Time to read, parse and persist one DWX price file change',
  labelNames: ['outcome'],
  buckets: [0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register]
})

// ─── WebSocket ───────────────────────────────────────────────────────────────

const websocketConnections = new client.Gauge({
  name: 'propfirm_websocket_connections',
  help: 'Currently connected Socket.IO clients',
  registers: [register]
})

// ─── Gauges sampled at scrape time ───────────────────────────────────────────
// Collected lazily via collect() so nothing is computed unless a scrape asks.

const dbPoolTotal = new client.Gauge({
  name: 'propfirm_db_pool_connections_total',
  help: 'Total clients in the database pool',
  registers: [register]
})
const dbPoolIdle = new client.Gauge({
  name: 'propfirm_db_pool_connections_idle',
  help: 'Idle clients in the database pool',
  registers: [register]
})
const dbPoolWaiting = new client.Gauge({
  name: 'propfirm_db_pool_waiting',
  help: 'Requests queued waiting for a database connection',
  registers: [register]
})
const openTradesGauge = new client.Gauge({
  name: 'propfirm_open_trades',
  help: 'Open trades currently tracked by the engine index',
  registers: [register]
})
const pendingOrdersGauge = new client.Gauge({
  name: 'propfirm_pending_orders',
  help: 'Pending orders currently tracked by the engine index',
  registers: [register]
})
const activeAccountsGauge = new client.Gauge({
  name: 'propfirm_active_accounts',
  help: 'Accounts currently tracked by the engine index',
  registers: [register]
})
const priceFeedAge = new client.Gauge({
  name: 'propfirm_price_feed_age_seconds',
  help: 'Seconds since the last price tick',
  registers: [register]
})

/** Express middleware. Records duration and count for every request. */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint()

  res.on('finish', () => {
    try {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9
      // req.route is only populated once a route has matched; unmatched
      // requests collapse to a single 'unmatched' series instead of one per
      // probed URL, which is what a scanner would otherwise create.
      const route = req.route?.path
        ? `${req.baseUrl || ''}${req.route.path}`
        : (res.statusCode === 404 ? 'unmatched' : (req.baseUrl || 'other'))
      const labels = { method: req.method, route, status_code: String(res.statusCode) }
      httpRequestDuration.observe(labels, seconds)
      httpRequestTotal.inc(labels)
    } catch (error) {
      logger.warn('[prometheus] failed to record request metrics:', { error: error.message })
    }
  })

  next()
}

/** Called by the engine after each tick. Never allowed to break a tick. */
function recordEngineTick(tickType, durationMs) {
  try {
    engineTickDuration.observe({ tick_type: String(tickType) }, durationMs / 1000)
  } catch { /* metrics must never break the engine */ }
}

/**
 * Record one price-feed ingest.
 *
 * @param {string} outcome 'updated' when a new map was produced, otherwise the
 *   reason it was not ('unchanged', 'no_price_rows', 'market_data_error', ...).
 *   Labelled because an ingest that bails early is cheap and would otherwise
 *   drag the useful percentile down.
 * @param {number} durationMs
 */
function recordPriceFeedIngest(outcome, durationMs) {
  try {
    priceFeedIngestDuration.observe({ outcome: String(outcome) }, durationMs / 1000)
  } catch { /* metrics must never break the feed */ }
}

function setWebsocketConnections(count) {
  try {
    if (typeof count === 'number') websocketConnections.set(count)
  } catch { /* ignore */ }
}

/** Samples the point-in-time gauges. Called on scrape, not on a timer. */
// Set by services/tradeEngine.js at load. Kept as a plain function reference
// rather than a require() so the metrics module has no dependency on the engine
// (M-12).
let _engineStatsSource = null

function registerEngineStatsSource(fn) {
  _engineStatsSource = typeof fn === 'function' ? fn : null
}

function refreshGauges() {
  try {
    const pool = require('../db')
    dbPoolTotal.set(pool.totalCount ?? 0)
    dbPoolIdle.set(pool.idleCount ?? 0)
    dbPoolWaiting.set(pool.waitingCount ?? 0)
  } catch { /* pool not ready */ }

  // FIX (M-12): this used to `require('../services/tradeEngine')` here, which
  // closed a cycle — tradeEngine requires this module for recordEngineTick, and
  // this module required tradeEngine back. Node tolerates it by handing out a
  // half-built export object, so the cycle is survivable but it makes both
  // modules untestable in isolation and the failure mode is load-order
  // dependent.
  //
  // Inverted to registration: the engine hands its stats reader in (see
  // registerEngineStatsSource, called from services/tradeEngine.js), so the
  // dependency now runs one way only.
  try {
    const stats = (_engineStatsSource && _engineStatsSource()) || {}
    openTradesGauge.set(stats.trades ?? 0)
    pendingOrdersGauge.set(stats.pending ?? 0)
    activeAccountsGauge.set(stats.accounts ?? 0)
  } catch { /* engine not initialised */ }

  try {
    const priceCache = require('./priceCache')
    const ageMs = priceCache.getPriceCacheAgeMs()
    // -1 distinguishes "never received a tick" from "received one 0s ago".
    priceFeedAge.set(ageMs === null ? -1 : ageMs / 1000)
  } catch { /* ignore */ }

  try {
    const { getConnectedSocketCount } = require('./realtime')
    const connected = getConnectedSocketCount()
    if (connected !== null) websocketConnections.set(connected)
  } catch { /* ignore */ }
}

async function getMetricsText() {
  refreshGauges()
  return register.metrics()
}

module.exports = {
  registerEngineStatsSource,
  register,
  metricsMiddleware,
  recordEngineTick,
  recordPriceFeedIngest,
  setWebsocketConnections,
  refreshGauges,
  getMetricsText,
  contentType: register.contentType
}
