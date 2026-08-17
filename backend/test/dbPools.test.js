const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
require('../loadEnv')
const pool = require('../db')
const { readPool, directPool, hasDedicatedReadReplica } = require('../db')

// Three pools, each with a job:
//
//   pool        writes, transactions, both engines
//   readPool    heavy read-only reports (analytics, transparency, leaderboard)
//   directPool  session-scoped advisory locks, bypassing any pooler
//
// The separation only pays off if it is respected, and the failure modes are
// quiet: a write sent to a replica fails at runtime, and a session lock taken
// through PgBouncer leaks silently. These tests pin the wiring.

test('the three pools are distinct objects', () => {
  assert.notEqual(pool, readPool)
  assert.notEqual(pool, directPool)
  assert.notEqual(readPool, directPool)
})

test('the read pool is sized smaller than the write pool', () => {
  // It exists to bound analytics contention, not to double total capacity.
  assert.ok(readPool.options.max < pool.options.max, 'read pool should not out-size the write pool')
})

test('the read pool allows longer statements than the write pool', () => {
  // Reports legitimately take a while; killing them at the write pool's 30s
  // would just mean an admin page that never loads.
  assert.ok(
    readPool.options.statement_timeout > pool.options.statement_timeout,
    'read pool needs a longer statement_timeout'
  )
})

test('the direct pool can cover every advisory-locked scheduler job at once', () => {
  // withAdvisoryLock holds a connection for the WHOLE job, not just the lock
  // acquisition, so the pool needs one per job that can be in flight together —
  // and their cadences coincide, so that is all of them.
  //
  // The bound is derived from the source rather than hardcoded: this previously
  // asserted `max <= 10` against a pool of 5 while thirteen jobs used it, so the
  // test passed while the overflow timed out and runLockedSchedulerJob's .catch
  // swallowed it. The challenge engine silently skipped runs under load.
  const src = read('services/schedulerService.js')
  const lockNames = new Set(
    [...src.matchAll(/runLockedSchedulerJob\(\s*'([^']+)'/g)].map((m) => m[1])
  )

  assert.ok(lockNames.size > 0, 'expected to find advisory-locked jobs to size against')
  assert.ok(
    directPool.options.max >= lockNames.size,
    `direct pool max is ${directPool.options.max} but ${lockNames.size} advisory-locked jobs share it; ` +
    'the overflow blocks for connectionTimeoutMillis and is then swallowed as a skipped run'
  )
})

test('the direct pool stays far smaller than the write pool', () => {
  // The other half of the sizing. It bypasses PgBouncer, so every connection
  // here is a real backend against max_connections — it must not drift into
  // being a second general-purpose pool.
  assert.ok(
    directPool.options.max < pool.options.max / 2,
    'direct pool should stay a fraction of the write pool'
  )
})

test('the direct pool sets no statement_timeout', () => {
  // It holds a lock for the duration of a scheduler job; a timeout here would
  // kill the lock-holding session mid-job.
  assert.equal(directPool.options.statement_timeout, undefined)
})

test('all pools fall back to DATABASE_URL when no replica or pooler is configured', () => {
  // The default single-database deployment must keep working untouched.
  if (!process.env.READ_DATABASE_URL) {
    assert.equal(readPool.options.connectionString, process.env.DATABASE_URL)
  }
  if (!process.env.DIRECT_DATABASE_URL) {
    assert.equal(directPool.options.connectionString, process.env.DATABASE_URL)
  }
})

test('hasDedicatedReadReplica is false unless a distinct replica URL is set', () => {
  const original = process.env.READ_DATABASE_URL
  try {
    delete process.env.READ_DATABASE_URL
    assert.equal(hasDedicatedReadReplica(), false)

    process.env.READ_DATABASE_URL = process.env.DATABASE_URL
    assert.equal(hasDedicatedReadReplica(), false, 'the same URL is not a replica')

    process.env.READ_DATABASE_URL = 'postgresql://replica/other'
    assert.equal(hasDedicatedReadReplica(), true)
  } finally {
    if (original === undefined) delete process.env.READ_DATABASE_URL
    else process.env.READ_DATABASE_URL = original
  }
})

// ─── Wiring guards ───────────────────────────────────────────────────────────

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8')
}

test('advisoryLock uses the direct pool, not the pooled one', () => {
  // If this regresses, session advisory locks silently stop excluding once
  // PgBouncer is enabled and the scheduler jobs can double-run.
  const src = read('utils/advisoryLock.js')
  assert.match(src, /directPool/)
  assert.match(src, /pg_try_advisory_lock/)
})

test('the read-only route files use the read pool', () => {
  for (const file of ['routes/adminAnalytics.js', 'routes/transparency.js']) {
    assert.match(read(file), /readPool/, `${file} should read from readPool`)
  }
})

test('the read-only route files issue no writes', () => {
  // Routing a write to readPool would fail outright against a real replica.
  for (const file of ['routes/adminAnalytics.js', 'routes/transparency.js']) {
    const src = read(file)
    assert.equal(/INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM/i.test(src), false, `${file} must stay read-only`)
    assert.equal(/pool\.connect\(/.test(src), false, `${file} must not open transactions on the read pool`)
  }
})

test('the trade engine and challenge engine stay on the write pool', () => {
  for (const file of ['services/tradeEngine.js', 'challengeEngine.js']) {
    assert.equal(/readPool/.test(read(file)), false, `${file} must not read from a replica`)
  }
})
