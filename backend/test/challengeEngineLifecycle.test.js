const test = require('node:test')
const assert = require('node:assert/strict')
const pool = require('../db')
const { runChallengeEngine } = require('../challengeEngine')

// runChallengeEngine() is the only exported entry point — expireAccount/
// failAccount/passAccount are private, so these tests drive the full sweep
// (matching promotePassedAccount's own coverage in progressionService.test.js
// for the "pass" path, and adding the "fail on drawdown breach" / "expire on
// time limit" paths that were previously untested).

const ACTIVE_ACCOUNTS_QUERY = /FROM accounts\s+WHERE status = 'active'\s+AND account_type IN/
const FULL_ACCOUNT_LOCK_QUERY = /SELECT \* FROM accounts WHERE id = \$1 AND status = 'active' FOR UPDATE SKIP LOCKED/

function makeMockClient(handlers = []) {
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, values)
      }
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return { rows: [{ id: values?.[0] }] }
      }
      return { rows: [] }
    },
    release() {}
  }
}

// db.js exports the Pool instance itself, so `pool` is one mutable object shared
// by every module. Overwriting its methods without putting them back leaks the
// catch-all `{ rows: [] }` mock into whatever runs next under
// --test-isolation=none, which is how unrelated suites ended up logging
// "[violation-engine] Failed to record violation".
const REAL_POOL_QUERY = pool.query
const REAL_POOL_CONNECT = pool.connect
test.after(() => {
  pool.query = REAL_POOL_QUERY
  pool.connect = REAL_POOL_CONNECT
})

function installPoolMock({ account, queryHandlers = [], connectHandlers = [] }) {
  const calls = []
  pool.query = async (sql, values) => {
    calls.push({ sql, values })
    // services/feedHealth.js asks for MAX(updated_at) before the engine will
    // enforce anything, and treats an unanswerable feed as UNHEALTHY — which is
    // the correct fail-safe in production and a silent "0 assertions ran" here.
    // Answered before the per-test handlers because every test in this file is
    // about what the engine does with a WORKING feed; the breaker itself is
    // covered separately.
    if (/MAX\(updated_at\)/i.test(sql)) {
      return { rows: [{ newest: new Date() }] }
    }
    if (ACTIVE_ACCOUNTS_QUERY.test(sql)) return { rows: [account] }
    for (const [pattern, handler] of queryHandlers) {
      if (pattern.test(sql)) return handler(sql, values)
    }
    return { rows: [] }
  }
  pool.connect = async () => makeMockClient([
    [FULL_ACCOUNT_LOCK_QUERY, () => ({ rows: [account] })],
    ...connectHandlers
  ])
  return calls
}

function baseAccount(overrides = {}) {
  const now = new Date()
  return {
    id: 'acc-ce-1', user_id: 'user-ce-1', account_type: 'phase1', status: 'active',
    current_balance: '10000', starting_balance: '10000', peak_balance: '10000',
    max_drawdown_pct: '10', profit_target: '1000', account_size: '10000',
    phase_end_date: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000), // 20 days out
    phase_start_date: now, created_at: now,
    challenge_model_slug: null, daily_drawdown_pct: null,
    min_trading_days: 0, consistency_max_day_pct: null,
    ...overrides
  }
}

test('runChallengeEngine expires an account whose phase_end_date has passed', async () => {
  const account = baseAccount({
    phase_end_date: new Date(Date.now() - 60 * 60 * 1000) // 1 hour in the past
  })
  const client = makeMockClient()
  installPoolMock({ account })
  pool.connect = async () => client

  await runChallengeEngine(null)

  const expireCall = client.calls.find(c => /UPDATE accounts SET status = 'expired'/.test(c.sql))
  assert.ok(expireCall, 'expected the account to be marked expired')
  assert.equal(expireCall.values[0], 'acc-ce-1')
})

test('runChallengeEngine fails an account whose balance has breached the drawdown floor', async () => {
  // starting_balance 10000, max_drawdown_pct 10 -> floor 9000. Balance well below it.
  const account = baseAccount({ current_balance: '8000' })
  const client = makeMockClient([
    [FULL_ACCOUNT_LOCK_QUERY, () => ({ rows: [{ ...account, current_balance: '8000' }] })]
  ])
  installPoolMock({ account })
  pool.connect = async () => client

  await runChallengeEngine(null)

  const failCall = client.calls.find(c => /UPDATE accounts SET status = 'failed'/.test(c.sql))
  assert.ok(failCall, 'expected the account to be marked failed on drawdown breach')
  assert.equal(failCall.values[0], 'acc-ce-1')
})

test('runChallengeEngine rolls back the account failure transaction when a trade close fails', async () => {
  const account = baseAccount({ current_balance: '8000' })
  const client = makeMockClient([
    [FULL_ACCOUNT_LOCK_QUERY, () => ({ rows: [{ ...account, current_balance: '8000' }] })],
    [/SELECT \* FROM trades WHERE account_id = \$1 AND status = 'open'/, () => ({
      rows: [{
        id: 'trade-ce-rollback',
        instrument: 'EURUSD',
        direction: 'buy',
        open_price: '1.10000',
        lot_size: '1',
        commission: '7'
      }]
    })],
    [/UPDATE trades SET[\s\S]*close_reason/i, () => {
      throw new Error('forced trade settlement failure')
    }]
  ])
  installPoolMock({ account })
  pool.connect = async () => client

  await runChallengeEngine(null)

  assert.ok(client.calls.some(c => /ROLLBACK/.test(c.sql)), 'the failed settlement must roll back')
  assert.equal(client.calls.find(c => /UPDATE accounts SET status = 'failed'/.test(c.sql)), undefined,
    'the account status must not change outside the rolled-back transaction')
  assert.equal(client.calls.find(c => /COMMIT/.test(c.sql)), undefined,
    'a failed settlement must never commit a partial account failure')
})

test('runChallengeEngine leaves an account active when balance stays above the drawdown floor and below profit target', async () => {
  const account = baseAccount({ current_balance: '9800' }) // within the 9000 floor, under the 1000 profit target
  const client = makeMockClient()
  installPoolMock({ account })
  pool.connect = async () => client

  await runChallengeEngine(null)

  assert.equal(client.calls.find(c => /UPDATE accounts SET status = 'failed'/.test(c.sql)), undefined)
  assert.equal(client.calls.find(c => /UPDATE accounts SET status = 'passed'/.test(c.sql)), undefined)
  assert.equal(client.calls.find(c => /UPDATE accounts SET status = 'expired'/.test(c.sql)), undefined)
})

test('runChallengeEngine passes an account that hit its profit target and raises a promotion review', async () => {
  // Passing no longer creates the next account. It marks the source passed and
  // queues a review for an admin to approve in /admin/promotion-reviews, which
  // is what actually creates the phase2/phase3/funded account. The assertion
  // that NO account row is inserted here is the point of the test.
  //
  // starting_balance 10000, profit_target 1000 -> current_balance 11000 clears it, no open trades.
  const account = baseAccount({ current_balance: '11000' })
  const openTradesCountHandler = [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status = 'open'/, () => ({ rows: [{ count: '0' }] })]
  const client = makeMockClient([
    [FULL_ACCOUNT_LOCK_QUERY, () => ({ rows: [{ ...account, current_balance: '11000' }] })],
    openTradesCountHandler,
    [/INSERT INTO account_promotion_reviews/i, (sql, values) => ({
      rows: [{ id: 77, source_account_id: values[0], from_account_type: values[2], target_account_type: values[3], status: 'pending' }]
    })]
  ])
  // processAccount checks the open-trade count via the plain pool (not the tx
  // client) before ever calling passAccount, so it needs the same handler.
  installPoolMock({ account, queryHandlers: [openTradesCountHandler] })
  pool.connect = async () => client

  await runChallengeEngine(null)

  const passCall = client.calls.find(c => /UPDATE accounts SET status = 'passed'/.test(c.sql))
  assert.ok(passCall, 'expected the source account to be marked passed')
  assert.equal(passCall.values[0], 'acc-ce-1')

  const reviewInsert = client.calls.find(c => /INSERT INTO account_promotion_reviews/i.test(c.sql))
  assert.ok(reviewInsert, 'expected a pending promotion review to be raised')
  assert.equal(reviewInsert.values[0], 'acc-ce-1', 'review points at the source account')
  assert.equal(reviewInsert.values[2], 'phase1', 'from_account_type')
  // baseAccount carries no challenge_model_slug, so the legacy ladder applies.
  assert.equal(reviewInsert.values[3], 'phase2', 'target_account_type resolved up front')

  const accountInsert = client.calls.find(c => /INSERT INTO accounts[\s\S]*RETURNING id/i.test(c.sql))
  assert.equal(accountInsert, undefined, 'the next account must wait for admin approval')

  assert.ok(client.calls.some(c => /COMMIT/.test(c.sql)), 'expected the pass to commit')
})

test('runChallengeEngine explains a qualifying-days hold instead of returning in silence', async () => {
  // The consistency hold always emitted a socket message; the qualifying-days
  // hold twenty lines above it returned bare. A trader who hit their target on
  // day three saw the target met and then nothing at all — no counter, no
  // message, no reason — which the examination named as one of the three
  // support tickets the platform would field forever.
  const account = {
    id: 'acc-holds', user_id: 'user-holds', account_type: 'phase1', status: 'active',
    starting_balance: '100000', current_balance: '116000', peak_balance: '116000',
    profit_target: '16000', max_drawdown_pct: '4', account_size: '100000',
    phase_end_date: new Date(Date.now() + 30 * 86400000),
    min_trading_days: 5, min_daily_profit_pct: '0.75',
    consistency_max_day_pct: null, challenge_model_slug: null,
    daily_drawdown_pct: null, eod_peak_equity: null, eod_trailing_floor: null
  }

  installPoolMock({
    account,
    queryHandlers: [
      // countQualifyingTradingDays — 2 of the 5 this model requires. It counts
      // days FINISHED UP by min_daily_profit_pct, not days traded, and returns
      // the tally as `days`.
      [/SELECT COUNT\(\*\) AS days/i, () => ({ rows: [{ days: '2' }] })],
      [/FROM trades WHERE account_id = \$1 AND status = 'open'/, () => ({ rows: [{ count: '0' }] })]
    ]
  })

  const emitted = []
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) }

  await runChallengeEngine(io)

  const hold = emitted.find((e) => e.payload?.event === 'trading_days_hold')
  assert.ok(hold, 'expected the qualifying-days hold to explain itself')
  assert.equal(hold.room, 'user-holds')
  assert.match(hold.payload.message, /3 more qualifying days/)
  assert.match(hold.payload.message, /2 of 5/)
  assert.match(hold.payload.message, /0\.75%/, 'the rule is not "a day you traded" — state the bar')

  assert.equal(emitted.find((e) => /passed/.test(e.payload?.event || '')), undefined,
    'the account must not pass while the hold is in force')
})
