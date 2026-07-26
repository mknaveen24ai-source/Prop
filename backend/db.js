const { Pool } = require('pg')
const logger = require('./utils/logger')
require('./loadEnv')

const isNodeTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle: true,
  max: 35,
  idleTimeoutMillis: 30000
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
