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

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { Pool, QueryResultRow } from 'pg'
import type { Server } from 'socket.io'
import type { emitAdminEvent as emitAdminEventFunction } from '../utils/realtime'
import { withAdvisoryLock } from '../utils/advisoryLock'
import logger = require('../utils/logger')

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type SchedulerResult = void | Promise<unknown>
type PlainJob = () => SchedulerResult
type IoJob = (io: TypedServer | null) => SchedulerResult

interface SchedulerDependencies {
  checkSLTP: IoJob
  checkPendingOrders: IoJob
  checkFloatingDrawdown: IoJob
  runChallengeEngine: IoJob
  runCompetitionEngine: IoJob
  runReferralSeasonEngine?: IoJob
  tickCompetitionBots?: PlainJob
  checkNewsForceClose: PlainJob
  weekendForceCloseByTenant: PlainJob
  flatByCloseForAccounts?: PlainJob
  pruneOldPriceHistory: PlainJob
  syncHourlyPriceHistory: PlainJob
  syncDedicatedPriceFeedWatchers: PlainJob
  processQueuedNotifications?: IoJob
  runAccountLinkingScan?: PlainJob
  pruneIdentitySignals?: PlainJob
  reapIdempotencyClaims?: PlainJob
}

interface SchedulerOptions {
  eventEngineArmed?: boolean
}

interface TradeEngineSchedulerApi {
  flushDirtyPeaks: () => Promise<unknown>
  reconcileIndex: () => Promise<unknown>
}

interface PayoutSlaRow extends QueryResultRow {
  id: string | number
  account_id: string | number
  amount_requested: string | null
  age_hours: string | number
}

interface PayoutSlaConfig {
  REVIEW_HOURS: number
}

interface ConstantsApi {
  PAYOUT_SLA: PayoutSlaConfig
}

interface RealtimeApi {
  emitAdminEvent: typeof emitAdminEventFunction
}

interface AnalyticsRollupsApi {
  refreshAnalyticsRollups: () => Promise<unknown>
}

const { refreshAnalyticsRollups } = require('./analytics/rollups') as AnalyticsRollupsApi

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
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isEventMode(): boolean {
  return String(process.env.ENGINE_MODE || 'interval').trim().toLowerCase() === 'event'
}

// ─── Timer registry ───────────────────────────────────────────────────────────
const trackedIntervals = new Set<NodeJS.Timeout>()
const trackedTimeouts = new Set<NodeJS.Timeout>()

function registerTrackedInterval(fn: PlainJob, intervalMs: number): NodeJS.Timeout {
  const handle = setInterval(() => {
    void fn()
  }, intervalMs)
  trackedIntervals.add(handle)
  return handle
}

function registerTrackedTimeout(fn: PlainJob, delayMs: number): NodeJS.Timeout {
  const handle = setTimeout(() => {
    trackedTimeouts.delete(handle)
    void fn()
  }, delayMs)
  trackedTimeouts.add(handle)
  return handle
}

function clearTrackedTimers(): void {
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
function runLockedSchedulerJob(
  lockName: string,
  label: string,
  fn: PlainJob
): Promise<boolean | void> {
  return withAdvisoryLock(lockName, async () => {
    await fn()
  }).catch((error: unknown) => {
    logger.error(`[scheduler:${label}] execution error:`, { error: errorMessage(error) })
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
function startAllSchedulers(
  io: TypedServer | null,
  deps: SchedulerDependencies,
  options: SchedulerOptions = {}
): void {
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
    void runLockedSchedulerJob('jobs:check_sltp', 'check_sltp', () => checkSLTP(io))
  }, cadences.checkSLTP)

  registerTrackedInterval(function () {
    void runLockedSchedulerJob('jobs:check_pending_orders', 'check_pending_orders', () => checkPendingOrders(io))
  }, cadences.checkPendingOrders)

  registerTrackedInterval(function () {
    void runLockedSchedulerJob('jobs:check_floating_drawdown', 'check_floating_drawdown', () => checkFloatingDrawdown(io))
  }, cadences.checkFloatingDrawdown)

  // ── Event-engine upkeep ─────────────────────────────────────────────────────
  // Gated on "armed", not on the env var: reconcileIndex against an index that
  // was never built is noise at best, and flushDirtyPeaks has nothing to flush
  // when no tick is running.
  if (eventEngineArmed) {
    const tradeEngine = require('./tradeEngine') as TradeEngineSchedulerApi

    // Peak equity / locked floors accumulated by the tick, written as one bulk
    // statement instead of an UPDATE per account per tick.
    registerTrackedInterval(function () {
      void tradeEngine.flushDirtyPeaks().catch((error: unknown) => {
        logger.error('[scheduler:peak_equity_flush] execution error:', { error: errorMessage(error) })
      })
    }, PEAK_EQUITY_FLUSH_MS)

    // Drift guard. Logs whatever it corrects — in steady state this should find
    // nothing, and a non-zero count means an incremental sync path is missing.
    registerTrackedInterval(function () {
      void tradeEngine.reconcileIndex().catch((error: unknown) => {
        logger.error('[scheduler:trade_index_reconcile] execution error:', { error: errorMessage(error) })
      })
    }, INDEX_RECONCILE_MS)

    logger.info('[schedulerService] event engine armed — trading loops demoted to safety fallbacks', cadences)
  }

  // ── Challenge engine ────────────────────────────────────────────────────────
  // Run once immediately on startup, then every 30 s
  void runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
  registerTrackedInterval(() => {
    void runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
  }, 30000)

  // ── Competition engine ───────────────────────────────────────────────────────
  // Run once immediately on startup, then every 30 s — same cadence as the
  // challenge engine, since both drive account status off similar deadlines.
  void runLockedSchedulerJob('jobs:competition_engine', 'competition_engine', () => runCompetitionEngine(io))
  registerTrackedInterval(() => {
    void runLockedSchedulerJob('jobs:competition_engine', 'competition_engine', () => runCompetitionEngine(io))
  }, 30000)

  // ── Referral season engine ──────────────────────────────────────────────────
  // Same cadence as the competition engine — both are lightweight period
  // state machines (upcoming/active/completed) with no per-tick trading work.
  if (runReferralSeasonEngine) {
    void runLockedSchedulerJob('jobs:referral_season_engine', 'referral_season_engine', () => runReferralSeasonEngine(io))
    registerTrackedInterval(() => {
      void runLockedSchedulerJob('jobs:referral_season_engine', 'referral_season_engine', () => runReferralSeasonEngine(io))
    }, 30000)
  }

  // ── Competition bot P&L tick ─────────────────────────────────────────────────
  // Slower than the 30s challenge/competition cadence so bot leaderboard
  // movement reads as gradual, not jumpy.
  if (tickCompetitionBots) {
    void runLockedSchedulerJob('jobs:competition_bot_tick', 'competition_bot_tick', tickCompetitionBots)
    registerTrackedInterval(() => {
      void runLockedSchedulerJob('jobs:competition_bot_tick', 'competition_bot_tick', tickCompetitionBots)
    }, 60000)
  }

  // ── News force close ────────────────────────────────────────────────────────
  registerTrackedInterval(() => {
    void runLockedSchedulerJob('jobs:news_force_close', 'news_force_close', checkNewsForceClose)
  }, 10000)

  // ── Weekend force close ─────────────────────────────────────────────────────
  registerTrackedInterval(() => {
    void runLockedSchedulerJob('jobs:weekend_force_close', 'weekend_force_close', weekendForceCloseByTenant)
  }, 60 * 1000)

  // ── Daily flat-by-close (futures-style daily settlement) ───────────────────
  if (flatByCloseForAccounts) {
    registerTrackedInterval(() => {
      void runLockedSchedulerJob('jobs:flat_by_close', 'flat_by_close', flatByCloseForAccounts)
    }, 60 * 1000)
  }

  // ── Notification delivery ───────────────────────────────────────────────────
  if (processQueuedNotifications) {
    registerTrackedInterval(() => {
      void runLockedSchedulerJob('jobs:notification_delivery', 'notification_delivery', () => processQueuedNotifications(io))
    }, 20 * 1000)
  }

  // ── Account sharing / passing-service detection ─────────────────────────────
  // A batch analytic over identity_signals and recent trades, not a hot path —
  // 15 minutes is well inside the window in which an admin would act on a
  // finding, and keeps the pairwise simultaneity scoring off the trading loop.
  if (runAccountLinkingScan) {
    registerTrackedInterval(() => {
      void runLockedSchedulerJob('jobs:account_linking', 'account_linking', runAccountLinkingScan)
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
      void runLockedSchedulerJob('jobs:idempotency_reap', 'idempotency_reap', reapIdempotencyClaims)
    }, 60 * 60 * 1000)
  }

  // identity_signals grows with every login and trade; nothing older than the
  // 30-day detection lookback is ever read.
  if (pruneIdentitySignals) {
    registerTrackedInterval(() => {
      void runLockedSchedulerJob('jobs:identity_signal_prune', 'identity_signal_prune', pruneIdentitySignals)
    }, 24 * 60 * 60 * 1000)
  }

  // ── Analytics rollups (migration 039) ───────────────────────────────────────
  // Feeds the two admin intelligence pages. Purely a reporting artefact: it
  // reads closed trades and settled money, never anything the trading engine is
  // mid-write on, so it can safely run on the same process without contending
  // with the hot path. Ten minutes is well inside the tolerance of every
  // consumer (the pages themselves poll at 5s/60s but read the LIVE tables for
  // anything that has to be up to the second — the rollups only back cohort,
  // survival and benchmarking questions, where a ten-minute-old answer and a
  // current one are the same answer).
  //
  // Runs once at startup so a freshly deployed instance has populated rollups
  // rather than eight empty tabs until the first interval fires.
  void runLockedSchedulerJob('jobs:analytics_rollups', 'analytics_rollups', refreshAnalyticsRollups)
  registerTrackedInterval(() => {
    void runLockedSchedulerJob('jobs:analytics_rollups', 'analytics_rollups', refreshAnalyticsRollups)
  }, 10 * 60 * 1000)

  // ── Payout SLA watch ────────────────────────────────────────────────────────
  // The platform now publishes a commitment (reviewed within 24h, paid within
  // 48h) in place of the "weekly payout cycles" it advertised but never ran. A
  // published SLA nobody watches is just a different false claim, so this is the
  // mechanism behind it: it alerts ops on any pending request that has aged past
  // the review window. Hourly — the SLA is measured in days, and a tighter
  // cadence would only repeat the same alarm.
  void runLockedSchedulerJob('jobs:payout_sla_watch', 'payout_sla_watch', checkPayoutSla)
  registerTrackedInterval(() => {
    void runLockedSchedulerJob('jobs:payout_sla_watch', 'payout_sla_watch', checkPayoutSla)
  }, 60 * 60 * 1000)

  // ── Price feed maintenance ──────────────────────────────────────────────────
  registerTrackedInterval(pruneOldPriceHistory, 24 * 60 * 60 * 1000)
  registerTrackedInterval(syncHourlyPriceHistory, 30 * 60 * 1000)
  registerTrackedInterval(() => {
    void Promise.resolve(syncDedicatedPriceFeedWatchers()).catch((error: unknown) => {
      logger.error('Dedicated price feed sync error:', { error: errorMessage(error) })
    })
  }, 30 * 1000)

  logger.info('[schedulerService] All schedulers started')
}

/**
 * Alert ops on payout requests that have outlived the published review SLA.
 *
 * Edge-triggered per request via the alerted set, so a request that ages past
 * the window raises one alarm rather than one an hour until somebody acts —
 * the same reasoning as the feed-health breaker's transition logging.
 */
const _slaAlerted = new Set<string>()

async function checkPayoutSla(): Promise<number> {
  const pool = require('../db') as Pool
  const { PAYOUT_SLA } = require('../constants') as ConstantsApi
  const { emitAdminEvent } = require('../utils/realtime') as RealtimeApi

  const result = await pool.query<PayoutSlaRow>(
    `SELECT id, account_id, amount_requested,
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 AS age_hours
       FROM payouts
      WHERE status = 'pending'
        AND created_at < NOW() - ($1 || ' hours')::interval
      ORDER BY created_at ASC`,
    [String(PAYOUT_SLA.REVIEW_HOURS)]
  )

  const stillPending = new Set<string>()
  for (const row of result.rows) {
    stillPending.add(String(row.id))
    if (_slaAlerted.has(String(row.id))) continue
    _slaAlerted.add(String(row.id))
    logger.warn('[payout-sla] Payout request has aged past the review SLA', {
      payoutId: String(row.id),
      accountId: String(row.account_id),
      ageHours: Math.round(Number(row.age_hours)),
      slaHours: PAYOUT_SLA.REVIEW_HOURS
    })
    emitAdminEvent('payout_sla_breached', {
      payout_id: row.id,
      account_id: row.account_id,
      amount_requested: row.amount_requested,
      age_hours: Math.round(Number(row.age_hours)),
      sla_hours: PAYOUT_SLA.REVIEW_HOURS
    })
  }

  // Forget anything that has been actioned, so a re-opened request can alert again.
  for (const id of _slaAlerted) {
    if (!stillPending.has(id)) _slaAlerted.delete(id)
  }

  return result.rows.length
}

export {
  checkPayoutSla,
  registerTrackedInterval,
  registerTrackedTimeout,
  clearTrackedTimers,
  runLockedSchedulerJob,
  startAllSchedulers,
  isEventMode,
  INTERVAL_CADENCES,
  EVENT_FALLBACK_CADENCES
}
