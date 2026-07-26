'use strict'
/**
 * Price Broadcast Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns the price broadcasting pipeline that was previously inline in
 * server.js (lines ~1304-1443).
 *
 * Exports:
 *   startPriceFeedPipeline(io, timerHelpers) — starts the full pipeline
 */

const logger = require('../utils/logger')
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
let _io = null // set by startPriceFeedPipeline

async function emitDedicatedFeedPriceUpdate() {
  if (!_io) return
  try {
    const prices = await getCurrentPricesForTenant()
    _io.emit('price_update', prices)
  } catch (error) {
    logger.error('Dedicated feed price broadcast error:', { error: error.message })
  }
}

async function runInitialPriceFeedMaintenance() {
  try {
    await bootstrapHistoricalPriceHistory()
    await pruneOldPriceHistory()
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

  try {
    await ensurePriceHistoryInfrastructure()
    await ensureTenantSettingsInfrastructure()
    subscribeSymbols()
    await fetchAndStorePrices()
    await syncDedicatedPriceFeedWatchers(emitDedicatedFeedPriceUpdate)
  } catch (error) {
    logger.error('Failed to start price feed pipeline:', { error: error.message })
  }

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
    syncDedicatedPriceFeedWatchers(emitDedicatedFeedPriceUpdate).catch((error) => {
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
        }
      }
    } catch (error) {
      logger.error('Price fallback interval error:', { error: error.message })
    }
  }, 1000)

  logger.info('[priceBroadcast] Price feed pipeline started')
}

module.exports = {
  startPriceFeedPipeline
}
