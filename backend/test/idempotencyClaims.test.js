const test = require('node:test')
const assert = require('node:assert/strict')

const pool = require('../db')
const {
  beginIdempotentRequest,
  isStrictScope,
  STRICT_SCOPES
} = require('../utils/idempotency')

// Replay protection on payouts, trade opens and account creation. The failure
// modes here are all "a duplicate gets through" or "a legitimate retry is
// refused forever", neither of which surfaces as an error anywhere.

const originalQuery = pool.query

test.afterEach(() => {
  pool.query = originalQuery
})

test('a missing key fails closed on money scopes and stays opt-in elsewhere', async () => {
  for (const scope of STRICT_SCOPES) {
    const result = await beginIdempotentRequest(null, { scope, idempotencyKey: null })
    assert.equal(result.required, true, `${scope} must refuse a request with no Idempotency-Key`)
    assert.equal(result.enabled, false)
  }

  const lenient = await beginIdempotentRequest(null, { scope: 'something:else', idempotencyKey: null })
  assert.equal(lenient.enabled, false)
  assert.equal(lenient.required, undefined, 'non-money scopes keep the old opt-in behaviour')
  assert.equal(isStrictScope('payouts:request'), true)
})

test('the claim is taken with ON CONFLICT, not SELECT-then-INSERT', async () => {
  // The old shape was: SELECT (miss) then INSERT. Two concurrent requests with
  // the same key both missed and both inserted, and the second hit the unique
  // index — surfacing as a 500 on a withdrawal endpoint, which is exactly the
  // response that makes a client retry.
  const statements = []
  pool.query = async (sql) => {
    statements.push(sql)
    return { rows: [{ id: 42 }] }
  }

  const result = await beginIdempotentRequest(null, {
    scope: 'payouts:request',
    actorId: 'user-1',
    idempotencyKey: 'key-1'
  })

  assert.equal(result.claimId, 42)
  assert.equal(statements.length, 1, 'winning the claim must be a single atomic statement')
  assert.match(statements[0], /INSERT INTO idempotency_requests/i)
  assert.match(
    statements[0], /ON CONFLICT \(scope, idempotency_key, COALESCE\(actor_id, ''\)\) DO NOTHING/i,
    'the conflict target must match migration 035\'s expression index exactly'
  )
})

test('losing the race to a completed claim replays its stored response', async () => {
  pool.query = async (sql) => {
    if (/INSERT INTO/i.test(sql)) return { rows: [] }   // conflict — someone else has it
    return {
      rows: [{
        id: 7,
        status: 'completed',
        response_status: 201,
        response_body_json: { message: 'Payout request submitted successfully' }
      }]
    }
  }

  const result = await beginIdempotentRequest(null, {
    scope: 'payouts:request',
    actorId: 'user-1',
    idempotencyKey: 'key-1'
  })

  assert.equal(result.replay, true)
  assert.equal(result.responseStatus, 201)
  assert.equal(result.responseBody.message, 'Payout request submitted successfully')
})

test('losing the race to an in-flight claim reports in-progress, never a duplicate', async () => {
  pool.query = async (sql) => {
    if (/INSERT INTO/i.test(sql)) return { rows: [] }
    return { rows: [{ id: 7, status: 'started', response_status: null, response_body_json: {} }] }
  }

  const result = await beginIdempotentRequest(null, {
    scope: 'payouts:request',
    actorId: 'user-1',
    idempotencyKey: 'key-1'
  })

  assert.equal(result.inProgress, true)
  assert.equal(result.claimId, undefined, 'an in-flight duplicate must not receive a claim of its own')
})

test('a claim that vanished mid-check is treated as in-flight, not as a free pass', async () => {
  // The reaper or a concurrent rollback can delete the row between the INSERT
  // and the SELECT. Reporting "no claim, go ahead" there would let a second
  // withdrawal through; asking the caller to retry cannot.
  pool.query = async () => ({ rows: [] })

  const result = await beginIdempotentRequest(null, {
    scope: 'payouts:request',
    actorId: 'user-1',
    idempotencyKey: 'key-1'
  })

  assert.equal(result.inProgress, true)
  assert.equal(result.claimId, undefined)
})
