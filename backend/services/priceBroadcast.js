'use strict'
/**
 * Price Broadcast Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns the price broadcasting pipeline that was previously inline in
 * server.js (lines ~1304-1443), and — under ENGINE_MODE=event — is now also the
 * trigger for the trade engine.
 *
 * The watcher callback used to do one thing: emit prices to clients. The engine
 * ran on its own timers and re-read everything from Postgres. Now the tick that
 * carries the new price is the same tick that acts on it, which is what takes
 * SL/TP and drawdown reaction from 500-1500ms down to ~50-80ms.
 *
 * Exports:
 *   startPriceFeedPipeline(io, timerHelpers) — starts the full pipeline
 */

const logger = require('../utils/logger')
const priceCache = require('../utils/priceCache')
const tradeEngine = require('./tradeEngine')
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
let lastWatcherEmitAt = 0
let _io = null // set by startPriceFeedPipeline
let _engineEnabled = false

// Equity pushes are throttled per user. A busy feed can tick several times a
// second; the dashboard only needs to feel live, and re-rendering KPI cards more
// often than this is wasted work on both ends.
const EQUITY_PUSH_INTERVAL_MS = 500
const _lastEquityPushAt = new Map()

function engineMode() {
  return String(process.env.ENGINE_MODE || 'interval').trim().toLowerCase()
}

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

/**
 * Push live equity to the traders whose numbers moved.
 *
 * The dashboard previously had to re-fetch to see balance, drawdown or profit
 * progress change. These snapshots come straight out of the engine tick, so
 * there is no extra query behind them.
 */
function pushEquityUpdates(io, snapshots) {
  if (!io || !snapshots || snapshots.length === 0) return
  const now = Date.now()

  for (const snapshot of snapshots) {
    const lastPush = _lastEquityPushAt.get(snapshot.accountId) || 0
    if ((now - lastPush) < EQUITY_PUSH_INTERVAL_MS) continue
    _lastEquityPushAt.set(snapshot.accountId, now)

    const drawdownUsedPct = snapshot.startingBalance > 0
      ? ((snapshot.startingBalance - snapshot.equity) / snapshot.startingBalance) * 100
      : 0
    const profitTarget = snapshot.profitTarget > 0
      ? snapshot.profitTarget
      : snapshot.startingBalance * 0.10

    io.to(String(snapshot.userId)).emit('equity_update', {
      account_id: snapshot.accountId,
      equity: snapshot.equity,
      floating_pnl: snapshot.floatingPnl,
      current_balance: snapshot.currentBalance,
      drawdown_floor: snapshot.floor,
      drawdown_used_pct: Math.max(0, drawdownUsedPct),
      daily_drawdown_used_pct: snapshot.dailyLossPct,
      daily_drawdown_limit_pct: snapshot.dailyDrawdownPct,
      profit_remaining: Math.max(0, profitTarget - (snapshot.equity - snapshot.startingBalance))
    })
  }

  // Bound the throttle map — accounts churn as challenges pass and fail.
  if (_lastEquityPushAt.size > 50000) {
    for (const [accountId, at] of _lastEquityPushAt) {
      if ((now - at) > 60000) _lastEquityPushAt.delete(accountId)
    }
  }
}

/**
 * Ingest a tick: update the cache, broadcast, then run the engine.
 *
 * Only instruments whose bid or ask actually moved are reported as changed. That
 * replaces the old JSON.stringify hash comparison (same "don't re-broadcast
 * identical data" guarantee, without serialising the whole map every tick) and
 * is also what lets the engine scan a few thousand trades instead of all of them.
 */
async function handlePriceTick(io, basePrices) {
  const changed = await priceCache.updatePrices(basePrices)
  if (changed.length === 0) return

  io.emit('price_update', priceCache.getAllPrices())

  if (!_engineEnabled) return
  try {
    const result = await tradeEngine.onPriceTick(io, changed)
    if (result) pushEquityUpdates(io, result.equity)
  } catch (error) {
    logger.error('[priceBroadcast] engine tick error:', { error: error.message })
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

  // Seed the cache before anything can read from it.
  await priceCache.updatePrices(await getCurrentPrices().catch(() => null))

  // Build the trade index from the database BEFORE arming the event path. Acting
  // on a partially-populated index would mean judging accounts on trades we
  // cannot see, so until this resolves the interval fallbacks are the only path.
  if (engineMode() === 'event') {
    try {
      const summary = await tradeEngine.initializeEngine()
      _engineEnabled = true
      logger.info('[priceBroadcast] event-driven engine armed', summary)
    } catch (error) {
      _engineEnabled = false
      logger.error('[priceBroadcast] engine init failed — staying on interval engine:', { error: error.message })
    }
  } else {
    logger.info('[priceBroadcast] ENGINE_MODE=interval — event-driven engine disabled')
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
  // every second. Only emit when at least one price has actually changed —
  // now decided per instrument by the price cache.
  watchPriceFeed(function (prices) {
    lastWatcherEmitAt = Date.now()
    handlePriceTick(io, prices).catch((error) => {
      logger.error('Price watcher tick error:', { error: error.message })
    })
  })

  // Fallback polling — every 1 s to ensure prices stay fresh if watcher fails
  registerTrackedInterval(async function () {
    try {
      if ((Date.now() - lastWatcherEmitAt) < 1500) return
      const fetchResult = await fetchAndStorePrices()
      if (fetchResult?.liveFeedAvailable === false || fetchResult?.updated !== true) return
      const prices = fetchResult.prices || await getCurrentPrices()
      if (Object.keys(prices).length > 0) {
        await handlePriceTick(io, prices)
      }
    } catch (error) {
      logger.error('Price fallback interval error:', { error: error.message })
    }
  }, 1000)

  logger.info('[priceBroadcast] Price feed pipeline started')
}

function isEngineEnabled() {
  return _engineEnabled
}

module.exports = {
  startPriceFeedPipeline,
  isEngineEnabled,
  pushEquityUpdates
}
