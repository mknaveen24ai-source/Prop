const crypto = require('crypto')
// directPool, not the main pool: these are SESSION-scoped locks held across the
// whole job, and a transaction pooler (PgBouncer) would hand each statement a
// different backend — the unlock would miss and the lock would leak. See the
// directPool comment in db.js.
const { directPool: pool } = require('../db')
const logger = require('./logger')

function getAdvisoryLockPair(name) {
  const digest = crypto.createHash('sha1').update(String(name || '')).digest()
  return [digest.readInt32BE(0), digest.readInt32BE(4)]
}

async function withAdvisoryLock(name, fn) {
  const [lockKeyA, lockKeyB] = getAdvisoryLockPair(name)
  const client = await pool.connect()
  let acquired = false

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      [lockKeyA, lockKeyB]
    )
    acquired = result.rows[0]?.acquired === true
    if (!acquired) {
      return false
    }

    await fn()
    return true
  } finally {
    if (acquired) {
      await client.query(
        'SELECT pg_advisory_unlock($1, $2)',
        [lockKeyA, lockKeyB]
      ).catch((error) => {
        logger.warn('[advisory_lock] unlock failed:', {
          lock: name,
          error: error.message
        })
      })
    }
    client.release()
  }
}

module.exports = {
  getAdvisoryLockPair,
  withAdvisoryLock
}
