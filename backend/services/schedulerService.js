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

// ─── Engine cadences ──────────────────────────────────────────────────────────
// Under ENGINE_MODE=event the price tick itself drives SL/TP, pending fills and
// drawdown, so these loops stop being the engine and become a safety net: they
// keep their advisory locks and their full Decimal logic, but run rarely enough
// to cost almost nothing. Anything the fast path misses still self-heals within
// one fallback period.
//
// Under ENGINE_MODE=interval (the default) every cadence is exactly what it was.
const INTERVAL_CADENCES = {
  checkSLTP: 500,
  checkPendingOrders: 500,
  // FIX (HIGH #12): Reduced from 500ms to 1000ms to lower database query volume
  // under heavy load with many active accounts.
  checkFloatingDrawdown: 1000
}
const EVENT_FALLBACK_CADENCES = {
  checkSLTP: 5000,
  checkPendingOrders: 5000,
  checkFloatingDrawdown: 10000
}
const PEAK_EQUITY_FLUSH_MS = 1000
const INDEX_RECONCILE_MS = 30000

/**
 * What the operator ASKED for. Not the same thing as what the engine is
 * actually doing — see startAllSchedulers' eventEngineArmed option.
 */
function isEventMode() {
  return String(process.env.ENGINE_MODE || 'interval').trim().toLowerCase() === 'event'
}

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
  return withAdvisoryLock(lockName, fn).catch((error) => {
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
 *   runCompetitionEngine: Function,
 *   runReferralSeasonEngine: Function,
 *   tickCompetitionBots: Function,
 *   checkNewsForceClose: Function,
 *   weekendForceCloseByTenant: Function,
 *   pruneOldPriceHistory: Function,
 *   syncHourlyPriceHistory: Function,
 *   syncDedicatedPriceFeedWatchers: Function,
 *   processQueuedNotifications: Function,
 * }} deps
 * @param {{ eventEngineArmed?: boolean }} [options]
 *   Whether the event engine ACTUALLY armed, from priceBroadcast.isEngineEnabled().
 *   Omitted, it falls back to the ENGINE_MODE env var, which is what the operator
 *   asked for rather than what happened — see the demotion guard below.
 */
function startAllSchedulers(io, deps, options = {}) {
  const {
    checkSLTP,
    checkPendingOrders,
    checkFloatingDrawdown,
    runChallengeEngine,
    runCompetitionEngine,
    runReferralSeasonEngine,
    tickCompetitionBots,
    checkNewsForceClose,
    weekendForceCloseByTenant,
    flatByCloseForAccounts,
    pruneOldPriceHistory,
    syncHourlyPriceHistory,
    syncDedicatedPriceFeedWatchers,
    processQueuedNotifications,
    runAccountLinkingScan,
    pruneIdentitySignals,
    reapIdempotencyClaims
  } = deps

  // ── Trading engine ──────────────────────────────────────────────────────────
  //
  // Cadence follows what the engine IS doing, not what ENGINE_MODE asked for.
  //
  // These two used to be the same value, and the gap between them was the whole
  // bug: startPriceFeedPipeline sets _engineEnabled = false if initializeEngine()
  // throws (a bad index build, an unreachable database at boot), but the env var
  // still said `event`. The loops were therefore demoted to the 5s/5s/10s safety
  // net at the exact moment they became the ONLY path — so stop-loss reaction
  // silently went from 50-80ms to five seconds, with one log line as the only
  // signal anywhere.
  //
  // Falling back to the env var when the caller passes nothing keeps the old
  // behaviour for any caller that has not been updated (today: the tests).
  const eventEngineArmed = options.eventEngineArmed === undefined
    ? isEventMode()
    : Boolean(options.eventEngineArmed)

  if (isEventMode() && !eventEngineArmed) {
    // Loud, and phrased so the consequence is in the message rather than left to
    // be inferred from the cadence numbers.
    logger.error(
      '[schedulerService] ENGINE_MODE=event but the event engine did NOT arm. ' +
      'Falling back to the full interval cadences so stop-loss reaction stays at ' +
      `${INTERVAL_CADENCES.checkSLTP}ms instead of degrading to ` +
      `${EVENT_FALLBACK_CADENCES.checkSLTP}ms. Investigate the engine init failure logged above.`
    )
  }

  const cadences = eventEngineArmed ? EVENT_FALLBACK_CADENCES : INTERVAL_CADENCES

  registerTrackedInterval(function () {
    runLockedSchedulerJob('jobs:check_sltp', 'check_sltp', () => checkSLTP(io))
  }, cadences.checkSLTP)

  registerTrackedInterval(function () {
    runLockedSchedulerJob('jobs:check_pending_orders', 'check_pending_orders', () => checkPendingOrders(io))
  }, cadences.checkPendingOrders)

  registerTrackedInterval(function () {
    runLockedSchedulerJob('jobs:check_floating_drawdown', 'check_floating_drawdown', () => checkFloatingDrawdown(io))
  }, cadences.checkFloatingDrawdown)

  // ── Event-engine upkeep ─────────────────────────────────────────────────────
  // Gated on "armed", not on the env var: reconcileIndex against an index that
  // was never built is noise at best, and flushDirtyPeaks has nothing to flush
  // when no tick is running.
  if (eventEngineArmed) {
    const tradeEngine = require('./tradeEngine')

    // Peak equity / locked floors accumulated by the tick, written as one bulk
    // statement instead of an UPDATE per account per tick.
    registerTrackedInterval(function () {
      tradeEngine.flushDirtyPeaks().catch((error) => {
        logger.error('[scheduler:peak_equity_flush] execution error:', { error: error.message })
      })
    }, PEAK_EQUITY_FLUSH_MS)

    // Drift guard. Logs whatever it corrects — in steady state this should find
    // nothing, and a non-zero count means an incremental sync path is missing.
    registerTrackedInterval(function () {
      tradeEngine.reconcileIndex().catch((error) => {
        logger.error('[scheduler:trade_index_reconcile] execution error:', { error: error.message })
      })
    }, INDEX_RECONCILE_MS)

    logger.info('[schedulerService] event engine armed — trading loops demoted to safety fallbacks', cadences)
  }

  // ── Challenge engine ────────────────────────────────────────────────────────
  // Run once immediately on startup, then every 30 s
  runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
  }, 30000)

  // ── Competition engine ───────────────────────────────────────────────────────
  // Run once immediately on startup, then every 30 s — same cadence as the
  // challenge engine, since both drive account status off similar deadlines.
  runLockedSchedulerJob('jobs:competition_engine', 'competition_engine', () => runCompetitionEngine(io))
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:competition_engine', 'competition_engine', () => runCompetitionEngine(io))
  }, 30000)

  // ── Referral season engine ──────────────────────────────────────────────────
  // Same cadence as the competition engine — both are lightweight period
  // state machines (upcoming/active/completed) with no per-tick trading work.
  if (runReferralSeasonEngine) {
    runLockedSchedulerJob('jobs:referral_season_engine', 'referral_season_engine', () => runReferralSeasonEngine(io))
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:referral_season_engine', 'referral_season_engine', () => runReferralSeasonEngine(io))
    }, 30000)
  }

  // ── Competition bot P&L tick ─────────────────────────────────────────────────
  // Slower than the 30s challenge/competition cadence so bot leaderboard
  // movement reads as gradual, not jumpy.
  if (tickCompetitionBots) {
    runLockedSchedulerJob('jobs:competition_bot_tick', 'competition_bot_tick', tickCompetitionBots)
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:competition_bot_tick', 'competition_bot_tick', tickCompetitionBots)
    }, 60000)
  }

  // ── News force close ────────────────────────────────────────────────────────
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:news_force_close', 'news_force_close', checkNewsForceClose)
  }, 10000)

  // ── Weekend force close ─────────────────────────────────────────────────────
  registerTrackedInterval(() => {
    runLockedSchedulerJob('jobs:weekend_force_close', 'weekend_force_close', weekendForceCloseByTenant)
  }, 60 * 1000)

  // ── Daily flat-by-close (futures-style daily settlement) ───────────────────
  if (flatByCloseForAccounts) {
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:flat_by_close', 'flat_by_close', flatByCloseForAccounts)
    }, 60 * 1000)
  }

  // ── Notification delivery ───────────────────────────────────────────────────
  if (processQueuedNotifications) {
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:notification_delivery', 'notification_delivery', () => processQueuedNotifications(io))
    }, 20 * 1000)
  }

  // ── Account sharing / passing-service detection ─────────────────────────────
  // A batch analytic over identity_signals and recent trades, not a hot path —
  // 15 minutes is well inside the window in which an admin would act on a
  // finding, and keeps the pairwise simultaneity scoring off the trading loop.
  if (runAccountLinkingScan) {
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:account_linking', 'account_linking', runAccountLinkingScan)
    }, 15 * 60 * 1000)
  }

  // ── Idempotency claim reaper ────────────────────────────────────────────────
  // Two jobs in one: delete claims abandoned by a process that died mid-request
  // (without this a crashed payout permanently 409s every retry of that key —
  // a trader who can never resubmit their withdrawal), and expire completed
  // claims, which nothing ever deleted. Hourly is far tighter than the 15-minute
  // stale threshold and the 7-day retention both need.
  if (reapIdempotencyClaims) {
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:idempotency_reap', 'idempotency_reap', reapIdempotencyClaims)
    }, 60 * 60 * 1000)
  }

  // identity_signals grows with every login and trade; nothing older than the
  // 30-day detection lookback is ever read.
  if (pruneIdentitySignals) {
    registerTrackedInterval(() => {
      runLockedSchedulerJob('jobs:identity_signal_prune', 'identity_signal_prune', pruneIdentitySignals)
    }, 24 * 60 * 60 * 1000)
  }

  // ── Price feed maintenance ──────────────────────────────────────────────────
  registerTrackedInterval(pruneOldPriceHistory, 24 * 60 * 60 * 1000)
  registerTrackedInterval(syncHourlyPriceHistory, 30 * 60 * 1000)
  registerTrackedInterval(() => {
    syncDedicatedPriceFeedWatchers().catch((error) => {
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
  startAllSchedulers,
  isEventMode,
  INTERVAL_CADENCES,
  EVENT_FALLBACK_CADENCES
}
