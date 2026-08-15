const test = require('node:test')
const assert = require('node:assert/strict')
const pool = require('../db')
const { checkSLTP } = require('../services/tradeEngine')

// A trade can be closed from two places at once: the SL/TP engine and a manual
// POST /api/trades/close. Both wrap the close in a transaction that first takes
// the row with FOR UPDATE SKIP LOCKED. If that guard were dropped, the losing
// racer would still write its own UPDATE and the account would be credited the
// PnL twice.
//
// SKIP LOCKED (rather than a plain FOR UPDATE) is the specific choice under
// test: it makes the loser return zero rows immediately instead of blocking
// until the winner commits and then closing an already-closed trade.

const OPEN_TRADES_QUERY = /FROM trades t\s+JOIN accounts a ON t\.account_id = a\.id\s+WHERE t\.status = 'open'\s+AND \(/
const OPEN_TIME = new Date(Date.now() - 10 * 60 * 1000)

const TRIGGERED_TRADE = {
  id: 'trade-race', account_id: 'acc-1', instrument: 'EURUSD', direction: 'buy',
  lot_size: '1', open_price: '1.10500', stop_loss: '1.10100', take_profit: null,
  status: 'open', open_time: OPEN_TIME, demo_trade_id: null, commission: '0',
  user_id: 'user-1'
}
const PRICE = { instrument: 'EURUSD', bid: '1.10000', ask: '1.10020', updated_at: new Date() }

/**
 * @param lockRows what the FOR UPDATE SKIP LOCKED probe returns. [] models
 *   another worker already holding the row.
 */
function makeMockClient({ lockRows = [{ id: 'trade-race' }] } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) return { rows: lockRows }
      return { rows: [] }
    },
    release() {}
  }
}

function installPoolMock(client) {
  pool.query = async (sql) => {
    if (OPEN_TRADES_QUERY.test(sql)) return { rows: [TRIGGERED_TRADE] }
    if (/FROM price_feed\b/i.test(sql)) return { rows: [PRICE] }
    return { rows: [] }
  }
  pool.connect = async () => client
}

function sqlList(client) {
  return client.calls.map((c) => c.sql)
}

function has(client, pattern) {
  return sqlList(client).some((sql) => pattern.test(sql))
}

test('the winner of the lock closes the trade and writes the balance once', async () => {
  const client = makeMockClient({ lockRows: [{ id: 'trade-race' }] })
  installPoolMock(client)

  await checkSLTP(null)

  const closes = client.calls.filter((c) => /UPDATE trades SET/.test(c.sql) && /status = 'closed'/.test(c.sql))
  const balances = client.calls.filter((c) => /UPDATE accounts SET/.test(c.sql))
  assert.equal(closes.length, 1)
  assert.equal(balances.length, 1)
  assert.ok(has(client, /COMMIT/))
})

test('the loser of the lock writes nothing and rolls back', async () => {
  // Zero rows back from SKIP LOCKED means another worker holds this trade.
  const client = makeMockClient({ lockRows: [] })
  installPoolMock(client)

  await checkSLTP(null)

  assert.equal(has(client, /UPDATE trades SET/), false, 'must not close a trade it did not lock')
  assert.equal(has(client, /UPDATE accounts SET/), false, 'and must not touch the balance')
  assert.ok(has(client, /ROLLBACK/), 'the transaction must be rolled back')
  assert.equal(has(client, /COMMIT/), false)
})

test('the lock probe re-checks status = open, so an already-closed trade is skipped', async () => {
  // Belt and braces alongside SKIP LOCKED: if the winner committed between the
  // batch SELECT and this probe, the row no longer matches and returns nothing.
  const client = makeMockClient({ lockRows: [] })
  installPoolMock(client)

  await checkSLTP(null)

  const lock = client.calls.find((c) => /FOR UPDATE SKIP LOCKED/i.test(c.sql))
  assert.ok(lock, 'expected a lock probe')
  assert.match(lock.sql, /status = 'open'/)
  assert.deepEqual(lock.values, ['trade-race'])
})

test('the lock is taken before any write, inside the transaction', async () => {
  const client = makeMockClient({ lockRows: [{ id: 'trade-race' }] })
  installPoolMock(client)

  await checkSLTP(null)

  const order = sqlList(client)
  const begin = order.findIndex((s) => /BEGIN/.test(s))
  const lock = order.findIndex((s) => /FOR UPDATE SKIP LOCKED/i.test(s))
  const write = order.findIndex((s) => /UPDATE trades SET/.test(s))

  assert.ok(begin >= 0 && lock > begin, 'lock must be taken inside the transaction')
  assert.ok(write > lock, 'no write may precede the lock')
})

test('two engine passes over the same trade close it only once', async () => {
  // Models the real sequence: the first pass wins the row, the second finds it
  // locked. Exactly one balance write must reach the account.
  let lockAttempts = 0
  const calls = []
  const client = {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) {
        lockAttempts += 1
        return { rows: lockAttempts === 1 ? [{ id: 'trade-race' }] : [] }
      }
      return { rows: [] }
    },
    release() {}
  }
  installPoolMock(client)

  await checkSLTP(null)
  await checkSLTP(null)

  assert.equal(lockAttempts, 2, 'both passes should have attempted the lock')
  const balances = calls.filter((c) => /UPDATE accounts SET/.test(c.sql))
  assert.equal(balances.length, 1, 'the PnL must be credited exactly once')
})

test('a failure mid-transaction rolls back rather than leaving a half-close', async () => {
  // The balance update throwing after the trade row was already marked closed
  // is the dangerous shape: without a rollback the trade reads as closed while
  // the trader never received the PnL.
  const calls = []
  const client = {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) return { rows: [{ id: 'trade-race' }] }
      if (/UPDATE accounts SET/.test(sql)) throw new Error('deadlock detected')
      return { rows: [] }
    },
    release() {}
  }
  installPoolMock(client)

  await checkSLTP(null)

  const sqls = calls.map((c) => c.sql)
  assert.ok(sqls.some((s) => /ROLLBACK/.test(s)), 'expected a rollback')
  assert.equal(sqls.some((s) => /COMMIT/.test(s)), false, 'must not commit a half-applied close')
})

test('a client is released even when the transaction fails', async () => {
  let released = 0
  const client = {
    calls: [],
    async query(sql, values) {
      this.calls.push({ sql, values })
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) return { rows: [{ id: 'trade-race' }] }
      if (/UPDATE trades SET/.test(sql)) throw new Error('connection lost')
      return { rows: [] }
    },
    release() { released += 1 }
  }
  installPoolMock(client)

  await checkSLTP(null)

  assert.equal(released, 1, 'leaking a client here would drain the pool under load')
})
