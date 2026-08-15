const { Pool } = require('pg')
const logger = require('./utils/logger')
require('./loadEnv')

const isNodeTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test')

// Pool sizing note: moving the trade engine in-memory *reduced* steady-state
// connection demand rather than raising it — the hot path no longer queries at
// all, and closures are batched. 60 leaves generous headroom for HTTP, sockets
// and the fallback loops on a single instance; going much higher would mostly
// buy idle sockets and a longer stall if something leaked.
//
// connectionTimeoutMillis and statement_timeout were previously unset, so a
// wedged connection or a runaway query could hang indefinitely.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle: true,
  max: Number(process.env.DB_POOL_MAX) || 60,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000
})

pool.on('connect', (client) => {
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

pool.__rawQuery = pool.query.bind(pool)

module.exports = pool
