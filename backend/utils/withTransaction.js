/**
 * Transaction helpers.
 *
 * Every transaction in this codebase was hand-written as
 * `pool.connect()` → `BEGIN` → … → `COMMIT`/`ROLLBACK` → `release()` in a
 * `finally` — 57 sites across 35 files. The shape is easy to get subtly wrong:
 * a `release()` outside `finally` leaks a connection on throw, and a `ROLLBACK`
 * that itself throws (a dead connection) masks the original error.
 *
 * These two helpers are for new code and for sites migrated as they are
 * touched. Existing hand-written transactions are not being rewritten
 * wholesale — that churn buys nothing on its own.
 *
 * Sibling of utils/advisoryLock.js, which wraps the other connection-scoped
 * pattern in this codebase.
 */

const pool = require('../db')

/**
 * Run `fn` inside a transaction, committing on return and rolling back on throw.
 *
 * The callback receives the pinned client, so it can be passed straight to the
 * domain aggregates (which all take an already-open transaction client).
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ db?: object }} [opts] alternate pool, mainly for tests
 * @returns {Promise<T>}
 */
async function withTransaction(fn, opts = {}) {
  const db = opts.db || pool
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    // A failed ROLLBACK must not replace the error that caused it — that error
    // is the one describing what actually went wrong.
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Borrow a connection without opening a transaction — for callers that need
 * several statements on one connection (session state, advisory locks) but no
 * atomicity.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @param {{ db?: object }} [opts]
 * @returns {Promise<T>}
 */
async function withClient(fn, opts = {}) {
  const db = opts.db || pool
  const client = await db.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

module.exports = { withTransaction, withClient }
