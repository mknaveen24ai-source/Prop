'use strict'
/**
 * Price Broadcast Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns the tenant-aware price broadcasting pipeline that was previously
 * inline in server.js (lines ~1304–1443).
 *
 * Exports:
 *   startPriceFeedPipeline(io, timerHelpers) — starts the full pipeline
 *   emitTenantPriceUpdates(rawPrices)        — broadcast to per-tenant rooms
 */

const logger = require('../utils/logger')
const pool = require('../db')
const { runWithSystemDbContext } = require('../utils/dbContext')
const {
  fetchAndStorePrices,
  getCurrentPrices,
  getCurrentPricesForTenant,
  syncDedicatedPriceFeedWatchers,
  subscribeSymbols,
  pruneOldPriceHistory,
  ensurePriceHistoryInfrastructure,
  bootstrapHistoricalPriceHistory,
  syncHourlyPriceHistory,
  watchPriceFeed
} = require('../priceFeed')
const {
  ensureTenantSettingsInfrastructure
} = require('../utils/tenantSettings')

// ─── Module-level state ───────────────────────────────────────────────────────
let lastEmittedPricesHash = ''
let lastWatcherEmitAt = 0
let tenantPriceBroadcastCache = new Map()
let cachedPriceBroadcastTenantIds = []
let cachedPriceBroadcastTenantIdsAt = 0
let _io = null // set by startPriceFeedPipeline

// ─── Internal helpers ─────────────────────────────────────────────────────────
async function getPriceBroadcastTenantIds() {
  if ((Date.now() - cachedPriceBroadcastTenantIdsAt) < 30 * 1000 && cachedPriceBroadcastTenantIds.length > 0) {
    return cachedPriceBroadcastTenantIds
  }
  const result = await pool.query(
    `SELECT id FROM tenants WHERE status IN ('active', 'default', 'trial', 'pending', 'paused')`
  )
  cachedPriceBroadcastTenantIds = result.rows
    .map((row) => parseInt(row.id, 10))
    .filter((id) => Number.isFinite(id) && id > 0)
  cachedPriceBroadcastTenantIdsAt = Date.now()
  return cachedPriceBroadcastTenantIds
}

async function emitTenantPriceUpdates(rawPrices) {
  return runWithSystemDbContext(async () => {
    const io = _io
    if (!io) return
    const tenantIds = await getPriceBroadcastTenantIds()
    const nextCache = new Map()
    await Promise.all(
      tenantIds.map(async (tenantId) => {
        const tenantPrices = await getCurrentPricesForTenant(tenantId, rawPrices)
        const tenantHash = JSON.stringify(tenantPrices)
        nextCache.set(String(tenantId), tenantHash)
        if (tenantHash !== tenantPriceBroadcastCache.get(String(tenantId))) {
          io.to(`prices:tenant:${tenantId}`).emit('price_update', tenantPrices)
          io.to(`admin:tenant:${tenantId}`).emit('price_update', tenantPrices)
        }
      })
    )
    tenantPriceBroadcastCache = nextCache
  })
}

async function runInitialPriceFeedMaintenance() {
  try {
    await runWithSystemDbContext(async () => {
      await bootstrapHistoricalPriceHistory()
      await pruneOldPriceHistory()
    })
  } catch (error) {
    logger.error('Price history init error:', { error: error.message })
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Start the full price feed pipeline, including watcher and fallback polling.
 * @param {import('socket.io').Server} io
 * @param {{ registerTrackedInterval: Function, registerTrackedTimeout: Function }} timerHelpers
 */
async function startPriceFeedPipeline(io, timerHelpers) {
  _io = io
  const { registerTrackedInterval, registerTrackedTimeout } = timerHelpers

  await runWithSystemDbContext(async () => {
    try {
      await ensurePriceHistoryInfrastructure()
      await ensureTenantSettingsInfrastructure()
      subscribeSymbols()
      await fetchAndStorePrices()
      await syncDedicatedPriceFeedWatchers(() => {
        emitTenantPriceUpdates().catch((error) => {
          logger.error('Tenant price broadcast error:', { error: error.message })
        })
      })
    } catch (error) {
      logger.error('Failed to start price feed pipeline:', { error: error.message })
    }
  })

  // Deferred price history maintenance (runs asap, not blocking startup)
  registerTrackedTimeout(() => {
    runInitialPriceFeedMaintenance().catch((error) => {
      logger.error('Deferred price history init error:', { error: error.message })
    })
  }, 0)

  // Recurring maintenance
  registerTrackedInterval(pruneOldPriceHistory, 24 * 60 * 60 * 1000)
  registerTrackedInterval(syncHourlyPriceHistory, 30 * 60 * 1000)
  registerTrackedInterval(() => {
    syncDedicatedPriceFeedWatchers(() => {
      emitTenantPriceUpdates().catch((error) => {
        logger.error('Tenant price broadcast error:', { error: error.message })
      })
    }).catch((error) => {
      logger.error('Dedicated price feed sync error:', { error: error.message })
    })
  }, 30 * 1000)

  // FIX (BUG-M6): Track last emitted prices to avoid broadcasting identical data
  // every second. Only emit when at least one price has actually changed.
  watchPriceFeed(function (prices) {
    lastWatcherEmitAt = Date.now()
    const hash = JSON.stringify(prices)
    if (hash !== lastEmittedPricesHash) {
      lastEmittedPricesHash = hash
      io.emit('price_update', prices)
      io.to('admin:super').emit('price_update', prices)
      emitTenantPriceUpdates(prices).catch((error) => {
        logger.error('Tenant price broadcast error:', { error: error.message })
      })
    }
  })

  // Fallback polling — every 1 s to ensure prices stay fresh if watcher fails
  registerTrackedInterval(async function () {
    try {
      if ((Date.now() - lastWatcherEmitAt) < 1500) return
      const fetchResult = await fetchAndStorePrices()
      if (fetchResult?.liveFeedAvailable === false || fetchResult?.updated !== true) return
      const prices = fetchResult.prices || await getCurrentPrices()
      if (Object.keys(prices).length > 0) {
        const hash = JSON.stringify(prices)
        if (hash !== lastEmittedPricesHash) {
          lastEmittedPricesHash = hash
          io.emit('price_update', prices)
          io.to('admin:super').emit('price_update', prices)
          emitTenantPriceUpdates(prices).catch((error) => {
            logger.error('Tenant price broadcast error:', { error: error.message })
          })
        }
      }
    } catch (error) {
      logger.error('Price fallback interval error:', { error: error.message })
    }
  }, 1000)

  logger.info('[priceBroadcast] Price feed pipeline started')
}

module.exports = {
  startPriceFeedPipeline,
  emitTenantPriceUpdates,
  getPriceBroadcastTenantIds
}
