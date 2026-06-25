'use strict'
/**
 * Scheduler Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns all timer bookkeeping (registerTrackedInterval / registerTrackedTimeout /
 * clearTrackedTimers) and every production setInterval scheduler that was
 * previously inline in server.js.
 *
 * Usage (in server.js):
 *   const { startAllSchedulers, clearTrackedTimers, registerTrackedInterval, registerTrackedTimeout } = require('./services/schedulerService')
 *   startAllSchedulers(io, { checkSLTP, checkPendingOrders, checkFloatingDrawdown, runChallengeEngine, checkNewsForceClose, weekendForceCloseByTenant })
 */

const logger = require('../utils/logger')
const { withAdvisoryLock } = require('../utils/advisoryLock')
const { runWithSystemDbContext } = require('../utils/dbContext')

// ─── Timer registry ───────────────────────────────────────────────────────────
const trackedIntervals = new Set()
const trackedTimeouts = new Set()

function registerTrackedInterval(fn, intervalMs) {
  const handle = setInterval(fn, intervalMs)
  trackedIntervals.add(handle)
  return handle
}

function registerTrackedTimeout(fn, delayMs) {
  const handle = setTimeout(() => {
    trackedTimeouts.delete(handle)
    fn()
  }, delayMs)
  trackedTimeouts.add(handle)
  return handle
}

function clearTrackedTimers() {
  for (const handle of trackedIntervals) {
    clearInterval(handle)
  }
  trackedIntervals.clear()

  for (const handle of trackedTimeouts) {
    clearTimeout(handle)
  }
  trackedTimeouts.clear()
}

// ─── Locked job runner ────────────────────────────────────────────────────────
function runLockedSchedulerJob(lockName, label, fn) {
  return withAdvisoryLock(lockName, () => runWithSystemDbContext(fn)).catch((error) => {
    logger.error(`[scheduler:${label}] execution error:`, { error: error.message })
  })
}

// ─── Start all schedulers ─────────────────────────────────────────────────────
/**
 * @param {import('socket.io').Server} io
 * @param {{
 *   checkSLTP: Function,
 *   checkPendingOrders: Function,
 *   checkFloatingDrawdown: Function,
 *   runChallengeEngine: Function,
 *   checkNewsForceClose: Function,
 *   weekendForceCloseByTenant: Function,
 *   pruneOldPriceHistory: Function,
 *   syncHourlyPriceHistory: Function,
 *   syncDedicatedPriceFeedWatchers: Function,
 *   emitTenantPriceUpdates: Function,
 * }} deps
 */
function startAllSchedulers(io, deps) {
  const {
    checkSLTP,
    checkPendingOrders,
    checkFloatingDrawdown,
    runChallengeEngine,
    checkNewsForceClose,
    weekendForceCloseByTenant,
    pruneOldPriceHistory,
    syncHourlyPriceHistory,
    syncDedicatedPriceFeedWatchers,
    emitTenantPriceUpdates
  } = deps

  // ── Trading engine ──────────────────────────────────────────────────────────
  registerTrackedInterval(function () {
    runLockedSchedulerJob('jobs:check_sltp', 'check_sltp', () => checkSLTP(io))
  }, 500)

  registerTrackedInterval(function () {
    runLockedSchedulerJob('jobs:check_pending_orders', 'check_pending_orders', () => checkPendingOrders(io))
  }, 500)

  // FIX (HIGH #12): Reduced from 500ms to 1000ms to lower database query volume
  // under heavy load with many active accounts.
  registerTrackedInterval(function () {
    runLockedSchedulerJob('jobs:check_floating_drawdown', 'check_floating_drawdown', () => checkFloatingDrawdown(io))
  }, 1000)

  // ── Challenge engine ────────────────────────────────────────────────────────
  // Run once immediately on startup, then every 30 s
  runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
  }, 30000)

  // ── News force close ────────────────────────────────────────────────────────
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:news_force_close', 'news_force_close', checkNewsForceClose)
  }, 10000)

  // ── Weekend force close ─────────────────────────────────────────────────────
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:weekend_force_close', 'weekend_force_close', weekendForceCloseByTenant)
  }, 60 * 1000)

  // ── Price feed maintenance ──────────────────────────────────────────────────
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

  logger.info('[schedulerService] All schedulers started')
}

module.exports = {
  registerTrackedInterval,
  registerTrackedTimeout,
  clearTrackedTimers,
  runLockedSchedulerJob,
  startAllSchedulers
}
