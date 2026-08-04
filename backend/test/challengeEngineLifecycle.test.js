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

function installPoolMock({ account, queryHandlers = [], connectHandlers = [] }) {
  const calls = []
  pool.query = async (sql, values) => {
    calls.push({ sql, values })
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

test('runChallengeEngine passes an account that hit its profit target and creates the next-phase account', async () => {
  // starting_balance 10000, profit_target 1000 -> current_balance 11000 clears it, no open trades.
  const account = baseAccount({ current_balance: '11000' })
  const sequences = new Map()
  const openTradesCountHandler = [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status = 'open'/, () => ({ rows: [{ count: '0' }] })]
  const client = makeMockClient([
    [FULL_ACCOUNT_LOCK_QUERY, () => ({ rows: [{ ...account, current_balance: '11000' }] })],
    openTradesCountHandler,
    [/INSERT INTO account_id_sequences/i, (sql, values) => {
      const category = values[0]
      const next = (sequences.get(category) || 0) + 1
      sequences.set(category, next)
      return { rows: [{ last_value: next }] }
    }],
    [/INSERT INTO accounts[\s\S]*RETURNING id/i, () => ({ rows: [{ id: 'new-phase2-account' }] })]
  ])
  // processAccount checks the open-trade count via the plain pool (not the tx
  // client) before ever calling passAccount, so it needs the same handler.
  installPoolMock({ account, queryHandlers: [openTradesCountHandler] })
  pool.connect = async () => client

  await runChallengeEngine(null)

  const passCall = client.calls.find(c => /UPDATE accounts SET status = 'passed'/.test(c.sql))
  assert.ok(passCall, 'expected the source account to be marked passed')
  assert.equal(passCall.values[0], 'acc-ce-1')

  const promotionInsert = client.calls.find(c => /INSERT INTO accounts[\s\S]*RETURNING id/i.test(c.sql))
  assert.ok(promotionInsert, 'expected the next-phase account to be created')
})
