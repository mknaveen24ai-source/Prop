import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient, QueryResult } from 'pg'
import databasePool = require('../db')
import { getAdvisoryLockPair, withAdvisoryLock } from '../utils/advisoryLock'

interface Harness {
  calls: string[]
  restore: () => void
}

function installLockClient(acquired: boolean): Harness {
  const calls: string[] = []
  const client = {
    async query(sql: string): Promise<QueryResult<{ acquired: boolean }>> {
      calls.push(sql)
      return {
        rows: [{ acquired }],
        command: '',
        rowCount: 1,
        oid: 0,
        fields: []
      }
    },
    release(): void {
      calls.push('RELEASE')
    }
  } as unknown as PoolClient
  const previousConnect = databasePool.directPool.connect
  databasePool.directPool.connect = (async () => client) as typeof databasePool.directPool.connect
  return {
    calls,
    restore: () => {
      databasePool.directPool.connect = previousConnect
    }
  }
}

void test('advisory lock keys are deterministic signed 32-bit pairs', () => {
  const first = getAdvisoryLockPair('challenge-engine')
  const second = getAdvisoryLockPair('challenge-engine')
  assert.deepEqual(first, second)
  assert.equal(first.length, 2)
  for (const value of first) {
    assert.ok(Number.isInteger(value))
    assert.ok(value >= -2_147_483_648 && value <= 2_147_483_647)
  }
})

void test('withAdvisoryLock skips work when another owner holds the lock', async () => {
  const harness = installLockClient(false)
  let ran = false
  try {
    const acquired = await withAdvisoryLock('scheduler', async () => {
      ran = true
    })
    assert.equal(acquired, false)
    assert.equal(ran, false)
    assert.deepEqual(harness.calls, [
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      'RELEASE'
    ])
  } finally {
    harness.restore()
  }
})

void test('withAdvisoryLock always unlocks and releases after successful work', async () => {
  const harness = installLockClient(true)
  try {
    const acquired = await withAdvisoryLock('scheduler', async () => {
      harness.calls.push('CALLBACK')
    })
    assert.equal(acquired, true)
    assert.deepEqual(harness.calls, [
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      'CALLBACK',
      'SELECT pg_advisory_unlock($1, $2)',
      'RELEASE'
    ])
  } finally {
    harness.restore()
  }
})

void test('withAdvisoryLock unlocks and releases when protected work throws', async () => {
  const harness = installLockClient(true)
  try {
    await assert.rejects(
      withAdvisoryLock('scheduler', async () => {
        harness.calls.push('CALLBACK')
        throw new Error('job failed')
      }),
      /job failed/
    )
    assert.deepEqual(harness.calls, [
      'SELECT pg_try_advisory_lock($1, $2) AS acquired',
      'CALLBACK',
      'SELECT pg_advisory_unlock($1, $2)',
      'RELEASE'
    ])
  } finally {
    harness.restore()
  }
})
