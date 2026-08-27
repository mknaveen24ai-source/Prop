import { Pool } from 'pg'
import type { PoolClient, PoolConfig } from 'pg'
import { ROLE } from './config/role'
import './loadEnv'
import logger = require('./utils/logger')

interface AppPool extends Pool {
  __rawQuery: Pool['query']
}

interface DatabasePool extends AppPool {
  readPool: AppPool
  directPool: AppPool
  hasDedicatedReadReplica: () => boolean
}

function poolConfig(connectionString: string | undefined, config: PoolConfig): PoolConfig {
  return connectionString === undefined ? config : { ...config, connectionString }
}

function withRawQuery(poolInstance: Pool): AppPool {
  return Object.assign(poolInstance, {
    __rawQuery: poolInstance.query.bind(poolInstance)
  })
}

const isNodeTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test')

// Pool sizing note: moving the trade engine in-memory *reduced* steady-state
// connection demand rather than raising it — the hot path no longer queries at
// all, and closures are batched. 60 leaves generous headroom for HTTP, sockets
// and the fallback loops on a single instance; going much higher would mostly
// buy idle sockets and a longer stall if something leaked.
//
// connectionTimeoutMillis and statement_timeout were previously unset, so a
// wedged connection or a runaway query could hang indefinitely.

/**
 * Default write-pool size for this process's role.
 *
 * A gateway serves sockets and nothing else. Its only recurring query is the
 * five-minute session re-check per socket (services/socketService.js), so 60
 * connections would be 55 idle ones — and idle connections are not free: every
 * replica multiplies them against the same `max_connections`, which is the
 * ceiling that actually bites when you scale out.
 *
 * `all` keeps 60 exactly as before, so a deploy that does not set ROLE is
 * unchanged.
 */
function defaultWritePoolMax(): number {
  return ROLE === 'gateway' ? 10 : 60
}

const pool = withRawQuery(new Pool(poolConfig(process.env.DATABASE_URL, {
  allowExitOnIdle: true,
  max: Number(process.env.DB_POOL_MAX) || defaultWritePoolMax(),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000
})))

pool.on('connect', (client: PoolClient) => {
  client.on('error', (err) => {
    logger.error('PostgreSQL client error:', { error: err.message })
  })
})

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', { error: err.message })
})

if (!isNodeTest && process.env.DATABASE_URL) {
  pool.connect((err, client, release) => {
    if (err) {
      logger.error('Database connection error:', { error: err })
    } else {
      logger.http('Database connection established')
      if (typeof release === 'function') release()
      else if (client && typeof client.release === 'function') client.release()
    }
  })
}

// ─── Read pool ────────────────────────────────────────────────────────────────
// Heavy analytics and public stats compete with trading for connections: a
// leaderboard scan holding a connection for two seconds is two seconds a trade
// close cannot have one. Routing those reads through a separate pool bounds
// that contention even on a single database, and points them at a replica the
// moment READ_DATABASE_URL is set.
//
// Safe with no replica configured — it falls back to DATABASE_URL, so this is
// just a second, smaller pool against the same server.
//
// Writes must never come here. Against a real replica they would fail outright,
// and against the primary they would silently escape the sizing this split
// exists to enforce. Anything transactional (pool.connect + BEGIN), any
// INSERT/UPDATE/DELETE, and both engines stay on `pool`.
const readPool = withRawQuery(new Pool(poolConfig(process.env.READ_DATABASE_URL || process.env.DATABASE_URL, {
  allowExitOnIdle: true,
  max: Number(process.env.DB_READ_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Deliberately longer than the write pool's 30s: these are the reports that
  // legitimately take a while, and killing them at 30s would just mean an admin
  // page that never loads.
  statement_timeout: 60000
})))

readPool.on('connect', (client: PoolClient) => {
  client.on('error', (err) => {
    logger.error('PostgreSQL read client error:', { error: err.message })
  })
})

readPool.on('error', (err) => {
  logger.error('PostgreSQL read pool error:', { error: err.message })
})

// ─── Direct pool ──────────────────────────────────────────────────────────────
// For SESSION-scoped state that must survive across statements — specifically
// utils/advisoryLock.js, which takes pg_try_advisory_lock, runs a scheduler
// job, and only then unlocks.
//
// This exists because of PgBouncer. In transaction pooling mode each statement
// may land on a different server connection, so a session-level lock would be
// taken on one backend, the job would run against others, and the unlock would
// be issued against a connection that never held it: the lock leaks for the
// life of that server connection and the mutual exclusion protecting the
// challenge/competition engines silently stops working.
//
// Transaction-scoped locks (pg_advisory_xact_lock, used everywhere else) are
// safe through a transaction pooler and do NOT need this pool — they are
// already inside BEGIN/COMMIT, which pins a connection.
//
// Point DIRECT_DATABASE_URL at Postgres itself, bypassing any pooler. Without
// PgBouncer this is simply DATABASE_URL and the distinction costs nothing.
//
// Sizing: withAdvisoryLock holds one connection for the WHOLE job, not just the
// lock acquisition, so this needs one connection per job that can be in flight
// at once — not one per job that exists. schedulerService starts fourteen, and
// their cadences coincide: at t=30s the challenge, competition, referral-season,
// SL/TP, pending-order, drawdown, news and notification jobs all fire together.
// At max=5 the overflow blocked for connectionTimeoutMillis and then threw, and
// runLockedSchedulerJob's .catch swallowed it — so the challenge engine silently
// skipped runs under exactly the load where it matters most.
const directPool = withRawQuery(new Pool(poolConfig(process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL, {
  allowExitOnIdle: true,
  max: Number(process.env.DB_DIRECT_POOL_MAX) || 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
  // No statement_timeout: this pool holds a lock while a scheduler job runs,
  // and the job's own queries are governed by their own pools.
})))

directPool.on('error', (err) => {
  logger.error('PostgreSQL direct pool error:', { error: err.message })
})

/** True when a distinct replica is configured, rather than the primary reused. */
function hasDedicatedReadReplica(): boolean {
  return Boolean(process.env.READ_DATABASE_URL)
    && process.env.READ_DATABASE_URL !== process.env.DATABASE_URL
}

const databasePool: DatabasePool = Object.assign(pool, {
  readPool,
  directPool,
  hasDedicatedReadReplica
})

export = databasePool
