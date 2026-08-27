import assert from 'node:assert/strict'
import test from 'node:test'
import { BoundaryValidationError } from '../validation/unknown'
import {
  beginIdempotentRequest,
  completeIdempotentRequest
} from '../utils/idempotency'

void test('replayed JSONB remains unknown until it validates as JSON', async () => {
  let queryCount = 0
  const db = {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      queryCount += 1
      if (/INSERT INTO idempotency_requests/u.test(sql)) return { rows: [] }
      return {
        rows: [{
          id: '1',
          status: 'completed',
          response_status: 200,
          response_body_json: { unsafe: undefined }
        }]
      }
    }
  }

  await assert.rejects(
    beginIdempotentRequest(db, {
      scope: 'payouts:request',
      actorId: 'user-1',
      idempotencyKey: 'key-1'
    }),
    BoundaryValidationError
  )
  assert.equal(queryCount, 2)
})

void test('completed idempotency responses are validated before persistence', async () => {
  let queried = false
  const db = {
    async query(): Promise<{ rows: unknown[] }> {
      queried = true
      return { rows: [] }
    }
  }

  await assert.rejects(
    completeIdempotentRequest(db, 'claim-1', 201, { invalid: BigInt(1) }),
    BoundaryValidationError
  )
  assert.equal(queried, false)
})
