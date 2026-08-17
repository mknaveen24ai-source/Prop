'use strict'
/**
 * Process role
 * ─────────────────────────────────────────────────────────────────────────────
 * One codebase, four ways to run it. The role decides which of the three
 * workloads a process takes on — it does not change any behaviour within them.
 *
 * ── Why this exists ──
 *
 * The trade index (utils/tradeIndex.js) lives in process memory and is read
 * *synchronously* from inside the tick's scan loop. That is the entire reason a
 * 100K-trade tick costs ~11.5ms instead of thousands of sequential network
 * round trips, and it is also why the engine can only ever be ONE process.
 *
 * But one process cannot serve 10,000 websockets: `io.emit` of a full price map
 * to every socket is bytes-out linear in connections, and that saturates a
 * single Node process long before CPU does.
 *
 * Those two facts are not in conflict — they just mean the engine and the socket
 * fan-out belong in different processes. That is all a role is.
 *
 * ── The roles ──
 *
 *   all      (default) Everything in one process. Exactly today's behaviour,
 *                      which is why it is the default: a deploy that does not
 *                      set ROLE changes nothing.
 *
 *   engine   Owns the trade index, the schedulers and the price pipeline.
 *            Exactly one of these may run. Serves /api/health and the metrics
 *            endpoints so it stays observable, but takes no client sockets and
 *            mounts no public routes — it should not be in the load balancer's
 *            pool at all.
 *
 *   gateway  Socket.IO only. No index, no schedulers, no price pipeline. This
 *            is the role you add machines of when more traders log in.
 *
 *   api      HTTP routes only. Stateless, so it scales on CPU like any other
 *            web tier.
 *
 * ── Adding a role is not enough on its own ──
 *
 * Running more than one process against the same database is only safe because
 * the singleton work is already guarded: every scheduler job runs under
 * `runLockedSchedulerJob` (services/schedulerService.js), and every trade close
 * takes `FOR UPDATE SKIP LOCKED` inside a transaction. This module decides who
 * *attempts* the work; those guards decide who *wins*. Do not remove either on
 * the assumption that the other is sufficient.
 */

const VALID_ROLES = ['all', 'engine', 'gateway', 'api']

function resolveRole() {
  const raw = String(process.env.ROLE || 'all').trim().toLowerCase()
  if (!raw) return 'all'
  if (!VALID_ROLES.includes(raw)) {
    // Throwing here rather than falling back: a typo'd ROLE that silently
    // becomes 'all' would put a second trade index on a gateway machine, and the
    // symptom (two engines disagreeing about floating PnL) is far away from the
    // cause.
    throw new Error(
      `Invalid ROLE '${raw}'. Expected one of: ${VALID_ROLES.join(', ')}.`
    )
  }
  return raw
}

const ROLE = resolveRole()

/** Owns the trade index, the schedulers and the price feed pipeline. */
function runsEngine() {
  return ROLE === 'engine' || ROLE === 'all'
}

/** Accepts client Socket.IO connections. */
function servesSockets() {
  return ROLE === 'gateway' || ROLE === 'all'
}

/** Mounts the full public/admin HTTP surface. */
function servesHttp() {
  return ROLE === 'api' || ROLE === 'all'
}

/**
 * True when the engine must reach traders through Redis rather than its own
 * `io`, because the sockets are on other machines.
 *
 * In `all` this is false and the engine emits directly, which is both cheaper
 * and exactly what it does today.
 */
function publishesRealtimeOverRedis() {
  return ROLE === 'engine'
}

function describe() {
  return {
    role: ROLE,
    engine: runsEngine(),
    sockets: servesSockets(),
    http: servesHttp(),
    realtimeOverRedis: publishesRealtimeOverRedis()
  }
}

module.exports = {
  ROLE,
  VALID_ROLES,
  runsEngine,
  servesSockets,
  servesHttp,
  publishesRealtimeOverRedis,
  describe
}
