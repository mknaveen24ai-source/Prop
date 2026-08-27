import { createHash } from 'node:crypto'
import type { QueryResultRow } from 'pg'
// directPool, not the main pool: these are SESSION-scoped locks held across the
// whole job, and a transaction pooler (PgBouncer) would hand each statement a
// different backend — the unlock would miss and the lock would leak. See the
// directPool comment in db.js.
import databasePool = require('../db')
import logger = require('./logger')

interface AdvisoryLockRow extends QueryResultRow {
  acquired: boolean
}

type LockedOperation = () => Promise<void>

const pool = databasePool.directPool

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function getAdvisoryLockPair(name: unknown): readonly [number, number] {
  const digest = createHash('sha1').update(String(name || '')).digest()
  return [digest.readInt32BE(0), digest.readInt32BE(4)] as const
}

async function withAdvisoryLock(name: string, fn: LockedOperation): Promise<boolean> {
  const [lockKeyA, lockKeyB] = getAdvisoryLockPair(name)
  const client = await pool.connect()
  let acquired = false

  try {
    const result = await client.query<AdvisoryLockRow>(
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
      ).catch((error: unknown) => {
        logger.warn('[advisory_lock] unlock failed:', {
          lock: name,
          error: errorMessage(error)
        })
      })
    }
    client.release()
  }
}

export {
  getAdvisoryLockPair,
  withAdvisoryLock
}
