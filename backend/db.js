const { Pool } = require('pg')
const logger = require('./utils/logger')
require('dotenv').config()

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
})

pool.connect((err, client, release) => {
  if (err) {
    logger.error('Database connection error:', { error: err })
  } else {
    logger.http('Database connection established')
    if (typeof release === 'function') release()
    else if (client && typeof client.release === 'function') client.release()
  }
})

module.exports = pool
