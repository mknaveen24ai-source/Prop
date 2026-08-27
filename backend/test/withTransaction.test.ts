import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { withClient, withTransaction } from '../utils/withTransaction'

interface FakeClientOptions {
  rollbackError?: Error
}

function transactionHarness(options: FakeClientOptions = {}): {
  calls: string[]
  client: PoolClient
  db: Pick<Pool, 'connect'>
} {
  const calls: string[] = []
  const client = {
    async query(sql: string): Promise<QueryResult<never>> {
      calls.push(sql)
      if (sql === 'ROLLBACK' && options.rollbackError) throw options.rollbackError
      return { rows: [], command: '', rowCount: 0, oid: 0, fields: [] }
    },
    release(): void {
      calls.push('RELEASE')
    }
  } as unknown as PoolClient
  const db = {
    async connect(): Promise<PoolClient> {
      calls.push('CONNECT')
      return client
    }
  } as unknown as Pick<Pool, 'connect'>
  return { calls, client, db }
}

void test('withTransaction commits and releases the pinned client', async () => {
  const { calls, db } = transactionHarness()

  const result = await withTransaction(async () => {
    calls.push('CALLBACK')
    return 'committed'
  }, { db })

  assert.equal(result, 'committed')
  assert.deepEqual(calls, ['CONNECT', 'BEGIN', 'CALLBACK', 'COMMIT', 'RELEASE'])
})

void test('withTransaction rolls back and releases when the callback fails', async () => {
  const original = new Error('business failure')
  const { calls, db } = transactionHarness()

  await assert.rejects(
    withTransaction(async () => {
      calls.push('CALLBACK')
      throw original
    }, { db }),
    (error: unknown) => error === original
  )

  assert.deepEqual(calls, ['CONNECT', 'BEGIN', 'CALLBACK', 'ROLLBACK', 'RELEASE'])
})

void test('a rollback failure never masks the original transaction error', async () => {
  const original = new Error('original failure')
  const { calls, db } = transactionHarness({ rollbackError: new Error('rollback failed') })

  await assert.rejects(
    withTransaction(async () => {
      throw original
    }, { db }),
    (error: unknown) => error === original
  )

  assert.deepEqual(calls, ['CONNECT', 'BEGIN', 'ROLLBACK', 'RELEASE'])
})

void test('a non-Error callback throw is narrowed into an Error with its cause preserved', async () => {
  const { db } = transactionHarness()

  await assert.rejects(
    withTransaction(async () => {
      // Deliberately exercise the JavaScript interop boundary where legacy
      // callbacks can still reject with a non-Error value during migration.
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- required non-Error compatibility test
      throw 'non-error failure'
    }, { db }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, 'Transaction callback threw a non-Error value')
      assert.equal(error.cause, 'non-error failure')
      return true
    }
  )
})

void test('withClient pins and releases a connection without transaction statements', async () => {
  const { calls, client, db } = transactionHarness()

  const result = await withClient(async (received) => {
    assert.equal(received, client)
    calls.push('CALLBACK')
    return 42
  }, { db })

  assert.equal(result, 42)
  assert.deepEqual(calls, ['CONNECT', 'CALLBACK', 'RELEASE'])
})
