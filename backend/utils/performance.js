/**
 * Performance monitoring middleware for PropFirm backend
 * Tracks request duration, memory usage, and slow queries
 * Provides real-time performance metrics
 */

const logger = require('./logger')

// Performance metrics storage
const metrics = {
  requests: {
    total: 0,
    byEndpoint: {},
    byMethod: {},
    byStatusCode: {},
    errorResponses: [],
    slowRequests: []
  },
  database: {
    queries: 0,
    slowQueries: [],
    avgQueryTime: 0,
    totalQueryTime: 0
  },
  memory: {
    samples: [],
    peakRss: 0,
    peakHeapUsed: 0
  },
  startTime: Date.now()
}

// Configuration
const SLOW_REQUEST_THRESHOLD = 500 // ms
const SLOW_QUERY_THRESHOLD = 200 // ms

// Runtime-adjustable so the threshold can be tightened during an investigation
// or loosened during a known-slow backfill without a redeploy. Seeded from the
// environment; admin settings can push a new value in via
// setSlowQueryThreshold. Not read from platform_settings per query for the
// obvious reason -- that lookup is itself a query.
let _slowQueryThresholdMs = Number(process.env.SLOW_QUERY_THRESHOLD_MS) || SLOW_QUERY_THRESHOLD

function getSlowQueryThreshold() {
  return _slowQueryThresholdMs
}

function setSlowQueryThreshold(ms) {
  const parsed = Number(ms)
  if (!Number.isFinite(parsed) || parsed <= 0) return _slowQueryThresholdMs
  _slowQueryThresholdMs = parsed
  return _slowQueryThresholdMs
}

// First stack frame outside this file — the code that actually issued the
// query. Cheap enough at the slow-query rate; never called on the fast path.
function callerFrame() {
  const stack = new Error().stack || ''
  const frames = stack.split('\n').slice(2)
  for (const frame of frames) {
    if (frame.includes('performance.js')) continue
    return frame.trim().slice(0, 200)
  }
  return null
}
const MEMORY_SAMPLE_INTERVAL = 60000 // 1 minute

// Memory monitoring
const memoryMonitor = setInterval(() => {
  const memUsage = process.memoryUsage()
  metrics.memory.samples.push({
    timestamp: Date.now(),
    rss: memUsage.rss,
    heapUsed: memUsage.heapUsed,
    heapTotal: memUsage.heapTotal,
    external: memUsage.external
  })

  // Keep last 60 samples (1 hour)
  if (metrics.memory.samples.length > 60) {
    metrics.memory.samples = metrics.memory.samples.slice(-60)
  }

  // Track peak usage
  metrics.memory.peakRss = Math.max(metrics.memory.peakRss, memUsage.rss)
  metrics.memory.peakHeapUsed = Math.max(metrics.memory.peakHeapUsed, memUsage.heapUsed)
}, MEMORY_SAMPLE_INTERVAL)
if (typeof memoryMonitor.unref === 'function') {
  memoryMonitor.unref()
}

/**
 * Performance monitoring middleware
 * Logs slow requests and tracks metrics
 */
function performanceMonitor(req, res, next) {
  const start = Date.now()
  const endpoint = req.path
  const method = req.method

  metrics.requests.total++
  metrics.requests.byMethod[method] = (metrics.requests.byMethod[method] || 0) + 1
  metrics.requests.byEndpoint[endpoint] = (metrics.requests.byEndpoint[endpoint] || 0) + 1

  res.on('finish', () => {
    const duration = Date.now() - start
    const statusCode = res.statusCode

    metrics.requests.byStatusCode[statusCode] = (metrics.requests.byStatusCode[statusCode] || 0) + 1

    if (statusCode >= 500) {
      metrics.requests.errorResponses.push({
        method,
        endpoint,
        statusCode,
        timestamp: new Date().toISOString(),
        timestampMs: Date.now()
      })

      if (metrics.requests.errorResponses.length > 100) {
        metrics.requests.errorResponses = metrics.requests.errorResponses.slice(-100)
      }
    }

    // Track slow requests
    if (duration > SLOW_REQUEST_THRESHOLD) {
      const slowReq = {
        method,
        endpoint,
        duration,
        statusCode,
        timestamp: new Date().toISOString(),
        userAgent: req.get('User-Agent'),
        ip: req.ip
      }

      metrics.requests.slowRequests.push(slowReq)

      // Keep only last 100 slow requests
      if (metrics.requests.slowRequests.length > 100) {
        metrics.requests.slowRequests = metrics.requests.slowRequests.slice(-100)
      }

      logger.warn(`[PERFORMANCE] Slow request: ${method} ${endpoint} took ${duration}ms`, {
        duration,
        endpoint,
        method,
        statusCode
      })
    }
  })

  next()
}

/**
 * Database query performance wrapper
 * Wraps pool.query to track query performance
 */
function wrapDatabaseQuery(pool) {
  const originalQuery = pool.query.bind(pool)

  pool.query = async function(sql, params) {
    const start = Date.now()
    metrics.database.queries++

    try {
      const result = await originalQuery(sql, params)
      const duration = Date.now() - start

      metrics.database.totalQueryTime += duration

      // Track slow queries
      if (duration > getSlowQueryThreshold()) {
        const slowQuery = {
          sql: sql.slice(0, 200), // Truncate long SQL
          duration,
          timestamp: new Date().toISOString(),
          paramCount: params ? params.length : 0,
          rowCount: result?.rowCount ?? result?.rows?.length ?? null,
          caller: callerFrame()
        }

        metrics.database.slowQueries.push(slowQuery)

        // Keep only last 50 slow queries
        if (metrics.database.slowQueries.length > 50) {
          metrics.database.slowQueries = metrics.database.slowQueries.slice(-50)
        }

        // rowCount and caller are what make these actionable: "slow" alone does
        // not distinguish a missing index from a query legitimately returning
        // 200k rows, and the SQL on its own rarely identifies which of several
        // call sites issued it.
        logger.warn(`[PERFORMANCE] Slow database query: ${duration}ms`, {
          duration,
          sql: sql.slice(0, 200),
          rowCount: slowQuery.rowCount,
          caller: slowQuery.caller
        })
      }

      return result
    } catch (error) {
      const duration = Date.now() - start
      logger.error(`[PERFORMANCE] Failed query: ${duration}ms`, {
        duration,
        sql: sql.slice(0, 100),
        error: error.message
      })
      throw error
    }
  }
}

/**
 * Get current performance metrics
 */
function getMetrics() {
  const uptime = Date.now() - metrics.startTime
  const memUsage = process.memoryUsage()
  const uptimeSeconds = uptime > 0 ? uptime / 1000 : 0
  const avgQueryTime = metrics.database.queries > 0
    ? metrics.database.totalQueryTime / metrics.database.queries
    : 0

  return {
    uptime: {
      milliseconds: uptime,
      hours: Math.floor(uptime / (1000 * 60 * 60)),
      minutes: Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60))
    },
    requests: {
      total: metrics.requests.total,
      perSecond: uptimeSeconds > 0 ? (metrics.requests.total / uptimeSeconds).toFixed(2) : '0.00',
      slowCount: metrics.requests.slowRequests.length,
      byMethod: metrics.requests.byMethod,
      byStatusCode: metrics.requests.byStatusCode,
      recent5xxCount: metrics.requests.errorResponses.filter((entry) => entry.statusCode >= 500).length,
      topEndpoints: Object.entries(metrics.requests.byEndpoint)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .reduce((obj, [key, val]) => ({ ...obj, [key]: val }), {})
    },
    database: {
      queries: metrics.database.queries,
      totalQueries: metrics.database.queries,
      avgQueryTime: avgQueryTime.toFixed(2),
      slowQueryCount: metrics.database.slowQueries.length,
      recentSlowQueries: metrics.database.slowQueries.slice(-10)
    },
    memory: {
      current: {
        rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`
      },
      peak: {
        rss: `${(metrics.memory.peakRss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(metrics.memory.peakHeapUsed / 1024 / 1024).toFixed(2)} MB`
      },
      samples: metrics.memory.samples.slice(-5) // Last 5 samples
    },
    slowRequests: metrics.requests.slowRequests.slice(-20) // Last 20 slow requests
  }
}

/**
 * Reset performance metrics
 */
function resetMetrics() {
  metrics.requests.total = 0
  metrics.requests.byEndpoint = {}
  metrics.requests.byMethod = {}
  metrics.requests.byStatusCode = {}
  metrics.requests.errorResponses = []
  metrics.requests.slowRequests = []
  metrics.database.queries = 0
  metrics.database.slowQueries = []
  metrics.database.totalQueryTime = 0
  metrics.database.avgQueryTime = 0
  metrics.memory.samples = []
  metrics.memory.peakRss = 0
  metrics.memory.peakHeapUsed = 0
  metrics.startTime = Date.now()
}

/**
 * Health check endpoint
 * Returns performance status
 */
function getHealthStatus() {
  const memUsage = process.memoryUsage()
  const heapUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100

  return {
    status: heapUsagePercent > 90 ? 'warning' : 'healthy',
    memory: {
      heapUsagePercent: heapUsagePercent.toFixed(2),
      rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`
    },
    uptime: Date.now() - metrics.startTime
  }
}

module.exports = {
  performanceMonitor,
  wrapDatabaseQuery,
  getMetrics,
  resetMetrics,
  getHealthStatus,
  getSlowQueryThreshold,
  setSlowQueryThreshold,
  metrics
}
