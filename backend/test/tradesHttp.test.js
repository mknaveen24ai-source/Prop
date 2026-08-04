const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const request = require('supertest')
require('../loadEnv')
const pool = require('../db')
const { router: tradesRouter } = require('../routes/trades')

// HTTP-level coverage for the two most money-critical endpoints. No supertest/
// route-testing pattern existed in this repo before — everything else mocks
// the shared `pool` singleton the way test/affiliates.test.js and
// test/tradeEngine.test.js already do, then drives the real Express router
// through supertest instead of calling exported functions directly.

const app = express()
app.use(express.json())
app.use('/api/trades', tradesRouter)

const USER_ID = 'user-http-1'
const ACCOUNT_ID = 'acc-http-1'
const authToken = jwt.sign({ userId: USER_ID, tv: 0 }, process.env.JWT_SECRET)
const authHeader = `Bearer ${authToken}`

const PRICE_ROW = { instrument: 'EURUSD', bid: '1.10000', ask: '1.10020', updated_at: new Date() }

function baseAccount(overrides = {}) {
  const now = new Date()
  return {
    id: ACCOUNT_ID, user_id: USER_ID, account_size: '10000', current_balance: '10000',
    starting_balance: '10000', peak_balance: '10000', status: 'active', account_type: 'phase1',
    phase_end_date: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
    scaling_multiplier: null, challenge_model_slug: null,
    ...overrides
  }
}

function makeMockClient(handlers = []) {
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, values)
      }
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) return { rows: [{ id: values?.[0] }] }
      return { rows: [] }
    },
    release() {}
  }
}

function installPoolMock({ queryHandlers = [], connectClient = null } = {}) {
  const calls = []
  pool.query = async (sql, values) => {
    calls.push({ sql, values })
    for (const [pattern, handler] of queryHandlers) {
      if (pattern.test(sql)) return handler(sql, values)
    }
    if (/SELECT token_version, is_banned FROM users/.test(sql)) {
      return { rows: [{ token_version: 0, is_banned: false }] }
    }
    if (/FROM price_feed\b/i.test(sql)) return { rows: [PRICE_ROW] }
    return { rows: [] }
  }
  pool.connect = async () => connectClient || makeMockClient()
  return calls
}

const ZERO_COUNT = () => ({ rows: [{ count: 0 }] })
const ZERO_LOTS = () => ({ rows: [{ total_lots: 0 }] })

test('POST /api/trades/open rejects with 401 when no auth token is supplied', async () => {
  installPoolMock({})
  const res = await request(app).post('/api/trades/open').send({
    account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1
  })
  assert.equal(res.status, 401)
})

test('POST /api/trades/open opens a market trade and returns the created trade', async () => {
  const account = baseAccount()
  const client = makeMockClient([
    [/FROM accounts WHERE id = \$1 AND user_id = \$2 AND status = 'active' FOR UPDATE/, () => ({ rows: [account] })],
    [/FROM trade_logs\s+WHERE account_id = \$1/, ZERO_COUNT],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, ZERO_LOTS],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status IN \('open', 'pending'\)/, ZERO_COUNT],
    [/INSERT INTO trades[\s\S]*RETURNING \*/, (sql, values) => ({
      rows: [{
        id: 'trade-http-1', account_id: values[0], demo_trade_id: values[1],
        instrument: values[2], direction: values[3], lot_size: values[4],
        open_price: values[5], status: 'open'
      }]
    })]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 201)
  assert.equal(res.body.trade.status, 'open')
  assert.equal(res.body.trade.instrument, 'EURUSD')
  assert.equal(res.body.trade.open_price, 1.1002, 'a BUY market order should open at the ASK price')

  const insertCall = client.calls.find(c => /INSERT INTO trades/.test(c.sql))
  assert.ok(insertCall)
  assert.ok(client.calls.some(c => c.sql === 'COMMIT'))
})

test('POST /api/trades/open rejects an unknown account with 400', async () => {
  const client = makeMockClient([
    [/FROM accounts WHERE id = \$1 AND user_id = \$2 AND status = 'active' FOR UPDATE/, () => ({ rows: [] })]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .send({ account_id: 'not-mine', instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /not found or not active/)
  assert.ok(client.calls.some(c => c.sql === 'ROLLBACK'))
})

test('POST /api/trades/open rejects insufficient equity for the requested margin', async () => {
  // account_size stays at 10000 so the exposure cap (which scales off account_size)
  // easily allows 5 lots — only current_balance (equity) is starved, so this
  // isolates the margin/equity check from the separate exposure-cap check.
  const account = baseAccount({ current_balance: '10', starting_balance: '10', peak_balance: '10' })
  const client = makeMockClient([
    [/FROM accounts WHERE id = \$1 AND user_id = \$2 AND status = 'active' FOR UPDATE/, () => ({ rows: [account] })],
    [/FROM trade_logs\s+WHERE account_id = \$1/, ZERO_COUNT],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, ZERO_LOTS],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status IN \('open', 'pending'\)/, ZERO_COUNT]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Insufficient equity/)
  assert.equal(client.calls.find(c => /INSERT INTO trades/.test(c.sql)), undefined)
})

test('POST /api/trades/close closes an open trade and applies the PnL to the account balance', async () => {
  const openTime = new Date(Date.now() - 10 * 60 * 1000)
  const openTrade = {
    id: 'trade-http-2', account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', open_price: '1.09500', open_time: openTime, status: 'open',
    commission: '0', original_commission: '0', user_id: USER_ID, account_type: 'phase1'
  }
  const client = makeMockClient([
    [/FOR UPDATE SKIP LOCKED/i, () => ({ rows: [openTrade] })]
  ])
  installPoolMock({
    connectClient: client,
    queryHandlers: [
      [/FROM trades t\s+JOIN accounts a ON t\.account_id = a\.id\s+WHERE t\.id = \$1 AND t\.status = 'open'/, () => ({ rows: [openTrade] })]
    ]
  })

  const res = await request(app)
    .post('/api/trades/close')
    .set('Authorization', authHeader)
    .send({ trade_id: 'trade-http-2' })

  assert.equal(res.status, 200)
  // BUY closes at BID (1.10000): (1.10000 - 1.09500) * 1 lot * 100,000 = 500
  assert.equal(res.body.pnl, 500)
  assert.equal(res.body.close_price, 1.1)

  const closeCall = client.calls.find(c => /UPDATE trades SET/.test(c.sql) && /status = 'closed'/.test(c.sql))
  assert.ok(closeCall)
  const balanceCall = client.calls.find(c => /UPDATE accounts SET/.test(c.sql) && /current_balance = current_balance/.test(c.sql))
  assert.ok(balanceCall)
  assert.equal(balanceCall.values[0], 500)
})

test('POST /api/trades/close returns 403 when the trade belongs to another user', async () => {
  const openTrade = {
    id: 'trade-http-3', account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', open_price: '1.09500', open_time: new Date(), status: 'open',
    commission: '0', user_id: 'someone-else', account_type: 'phase1'
  }
  installPoolMock({
    queryHandlers: [
      [/FROM trades t\s+JOIN accounts a ON t\.account_id = a\.id\s+WHERE t\.id = \$1 AND t\.status = 'open'/, () => ({ rows: [openTrade] })]
    ]
  })

  const res = await request(app)
    .post('/api/trades/close')
    .set('Authorization', authHeader)
    .send({ trade_id: 'trade-http-3' })

  assert.equal(res.status, 403)
})
