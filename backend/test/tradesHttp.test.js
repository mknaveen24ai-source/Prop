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

const USER_ID = '11111111-1111-4111-8111-111111111112'
const ACCOUNT_ID = 'acc-http-1'
const authToken = jwt.sign(
  { userId: USER_ID, email: 'trader-http@example.com', tv: 1 },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
)
const authHeader = `Bearer ${authToken}`

const PRICE_ROW = { instrument: 'EURUSD', bid: '1.10000', ask: '1.10020', updated_at: new Date() }

// /open and /close both refuse to trade when the market is shut, so without a
// fixed clock this file passes Mon–Fri and fails every weekend on the real
// calendar. Pin it to a Wednesday midday for any test that drives those routes.
// Only Date is mocked — timers still run, so supertest is unaffected — and
// marketHours.test.js is untouched because it always passes an explicit `now`.
const MARKET_OPEN_UTC = new Date('2026-04-15T12:00:00.000Z') // Wednesday

function pinMarketOpen(t) {
  t.mock.timers.enable({ apis: ['Date'], now: MARKET_OPEN_UTC })
}

function baseAccount(overrides = {}) {
  const now = new Date()
  return {
    id: ACCOUNT_ID, user_id: USER_ID, account_size: '10000', current_balance: '10000',
    starting_balance: '10000', peak_balance: '10000', status: 'active', account_type: 'phase1',
    phase_end_date: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
    scaling_multiplier: null, challenge_model_slug: null,
    // Joined from users by the account-lock query — the funded-stage KYC gate
    // in routes/trades/open.js reads it.
    kyc_status: 'approved',
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
      return { rows: [{ token_version: 1, is_banned: false }] }
    }
    if (/FROM price_feed\b/i.test(sql)) return { rows: [PRICE_ROW] }
    // FIX (H-03): trades:open always takes an idempotency claim now. It did not
    // before — a request without the header skipped the guard entirely, which
    // is how a retried POST opened a second position.
    if (/idempotency_requests/i.test(sql)) {
      return /INSERT INTO idempotency_requests/i.test(sql)
        ? { rows: [{ id: 1 }] }
        : { rows: [] }
    }
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

test('POST /api/trades/open opens a market trade and returns the created trade', async (t) => {
  pinMarketOpen(t)

  const account = baseAccount()
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
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
    // FIX (H-03): trades:open is a strict idempotency scope now. Without this
    // header the request is rejected rather than running with no replay
    // protection, which is how a retried POST opened a second position.
    .set('Idempotency-Key', 'test-open-market-1')
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 201)
  assert.equal(res.body.trade.status, 'open')
  assert.equal(res.body.trade.instrument, 'EURUSD')
  assert.equal(res.body.trade.open_price, '1.1002', 'a BUY market order should open at the ASK price')

  const insertCall = client.calls.find(c => /INSERT INTO trades/.test(c.sql))
  assert.ok(insertCall)
  assert.deepEqual(insertCall.values.slice(4, 10), ['1', '1.1002', null, null, '3', 0])
  assert.ok(client.calls.some(c => c.sql === 'COMMIT'))
})

test('POST /api/trades/open rolls back when the trade insert fails', async (t) => {
  pinMarketOpen(t)

  const account = baseAccount()
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
    [/SELECT\s+\(SELECT 1 FROM trades/, () => ({ rows: [{
      opposite_open: null,
      same_direction_open: null,
      last_closed_setup: null,
      open_or_pending_count: 0,
      open_trades: []
    }] })],
    [/INSERT INTO trades[\s\S]*RETURNING \*/, () => { throw new Error('forced insert failure') }]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .set('Idempotency-Key', 'test-open-rollback-1')
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 500)
  assert.ok(client.calls.some(c => /INSERT INTO trades/.test(c.sql)))
  assert.ok(client.calls.some(c => c.sql === 'ROLLBACK'))
  assert.equal(client.calls.some(c => c.sql === 'COMMIT'), false)
})

test('POST /api/trades/open creates both OCO pending legs with decimal-string values', async (t) => {
  pinMarketOpen(t)

  const account = baseAccount()
  let insertCount = 0
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
    [/SELECT\s+\(SELECT 1 FROM trades/, () => ({ rows: [{
      opposite_open: null,
      same_direction_open: null,
      last_closed_setup: null,
      open_or_pending_count: 0,
      open_trades: []
    }] })],
    [/INSERT INTO trades[\s\S]*RETURNING \*/, (_sql, values) => {
      insertCount += 1
      return {
        rows: [{
          id: `pending-${insertCount}`,
          account_id: values[0],
          demo_trade_id: values[1],
          instrument: values[2],
          direction: values[3],
          lot_size: values[4],
          status: 'pending',
          stop_loss: values[5],
          take_profit: values[6],
          order_type: values[7],
          pending_price: values[8],
          commission: values[9],
          oco_group_id: values[10]
        }]
      }
    }]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .set('Idempotency-Key', 'test-open-oco-1')
    .send({
      account_id: ACCOUNT_ID,
      instrument: 'EURUSD',
      direction: 'buy',
      lots: '0.25',
      order_type: 'buy_limit',
      pending_price: '1.09',
      oco_sibling: { order_type: 'sell_stop', pending_price: '1.08' }
    })

  assert.equal(res.status, 201)
  assert.equal(res.body.trade_id, 'pending-1')
  assert.equal(res.body.oco_sibling_trade_id, 'pending-2')
  const inserts = client.calls.filter(c => /INSERT INTO trades/.test(c.sql))
  assert.equal(inserts.length, 2)
  assert.deepEqual(inserts[0].values.slice(4, 10), ['0.25', null, null, 'buy_limit', '1.09', '0.75'])
  assert.deepEqual(inserts[1].values.slice(4, 10), ['0.25', null, null, 'sell_stop', '1.08', '0.75'])
  assert.equal(inserts[0].values[10], inserts[1].values[10])
  assert.equal(client.calls.filter(c => /INSERT INTO trade_logs/.test(c.sql)).length, 2)
  assert.ok(client.calls.some(c => c.sql === 'COMMIT'))
})

test('POST /api/trades/open rejects an unknown account with 400', async (t) => {
  pinMarketOpen(t)

  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [] })]
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

// ── Funded-stage KYC gate ────────────────────────────────────────────────────
// KYC moved out of the purchase path (routes/accounts.js POST /create) and onto
// the funded trading path. These pin both halves of that rule: a funded account
// without approved KYC cannot open, and an EVALUATION account is unaffected —
// the whole point of the move was that buying and trading a challenge no longer
// waits on a human review.

test('POST /api/trades/open blocks a funded account whose KYC is not approved', async (t) => {
  pinMarketOpen(t)

  const account = baseAccount({ account_type: 'funded', kyc_status: 'pending', phase_end_date: null })
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
    [/FROM trade_logs\s+WHERE account_id = \$1/, ZERO_COUNT],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, ZERO_LOTS],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status IN \('open', 'pending'\)/, ZERO_COUNT]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 403)
  assert.equal(res.body.code, 'KYC_REQUIRED_FOR_FUNDED')
  assert.equal(client.calls.find(c => /INSERT INTO trades/.test(c.sql)), undefined)
  assert.ok(client.calls.some(c => c.sql === 'ROLLBACK'))
})

test('POST /api/trades/open allows an evaluation account with unapproved KYC', async (t) => {
  pinMarketOpen(t)

  const account = baseAccount({ account_type: 'phase1', kyc_status: 'pending' })
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
    [/FROM trade_logs\s+WHERE account_id = \$1/, ZERO_COUNT],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, ZERO_LOTS],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status IN \('open', 'pending'\)/, ZERO_COUNT],
    [/INSERT INTO trades[\s\S]*RETURNING \*/, (sql, values) => ({
      rows: [{
        id: 'trade-kyc-eval', account_id: values[0], demo_trade_id: values[1],
        instrument: values[2], direction: values[3], lot_size: values[4],
        open_price: values[5], status: 'open'
      }]
    })]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .set('Idempotency-Key', 'test-open-kyc-eval-1')
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 201)
})

// ── Unlimited leverage ───────────────────────────────────────────────────────
// The margin/equity check this file used to pin is gone: leverage is unlimited,
// calculateMargin() returns 0, and an account may open any size regardless of
// equity. These two replace it — the first proves the old refusal really is
// gone, the second proves the fat-finger ceiling that replaced it still bites.

test('POST /api/trades/open allows a position far larger than account equity', async (t) => {
  pinMarketOpen(t)

  // $10 of equity on a $10,000 account. Under the old margin rule 1 lot of
  // EURUSD reserved $1,000 and this was refused; with no margin requirement it
  // must now fill.
  const account = baseAccount({ current_balance: '10', starting_balance: '10', peak_balance: '10' })
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
    [/FROM trade_logs\s+WHERE account_id = \$1/, ZERO_COUNT],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, ZERO_LOTS],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status IN \('open', 'pending'\)/, ZERO_COUNT],
    [/INSERT INTO trades[\s\S]*RETURNING \*/, (sql, values) => ({
      rows: [{
        id: 'trade-unlimited-1', account_id: values[0], demo_trade_id: values[1],
        instrument: values[2], direction: values[3], lot_size: values[4],
        open_price: values[5], status: 'open'
      }]
    })]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .set('Idempotency-Key', 'test-open-unlimited-1')
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 1 })

  assert.equal(res.status, 201)
})

test('POST /api/trades/open refuses an order past the notional fat-finger ceiling', async (t) => {
  pinMarketOpen(t)

  // $10,000 account, 500x default ceiling => $5,000,000 of notional allowed.
  // 100 lots of EURUSD at ~1.08 is ~$10.8m, comfortably past it — the shape of
  // a trader who meant 1 lot and typed 100.
  const account = baseAccount()
  const client = makeMockClient([
    [/FROM accounts a\s+JOIN users u[\s\S]*FOR UPDATE OF a/, () => ({ rows: [account] })],
    [/FROM trade_logs\s+WHERE account_id = \$1/, ZERO_COUNT],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, ZERO_LOTS],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id = \$1 AND status IN \('open', 'pending'\)/, ZERO_COUNT]
  ])
  installPoolMock({ connectClient: client })

  const res = await request(app)
    .post('/api/trades/open')
    .set('Authorization', authHeader)
    .set('Idempotency-Key', 'test-open-notional-1')
    .send({ account_id: ACCOUNT_ID, instrument: 'EURUSD', direction: 'buy', lots: 100 })

  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'NOTIONAL_CEILING')
  assert.equal(client.calls.find(c => /INSERT INTO trades/.test(c.sql)), undefined)
})

test('POST /api/trades/close closes an open trade and applies the PnL to the account balance', async (t) => {
  pinMarketOpen(t)

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
  // PostgreSQL NUMERIC parameters remain exact decimal strings during the TS migration.
  assert.equal(balanceCall.values[0], '500')
})

test('POST /api/trades/close returns 403 when the trade belongs to another user', async (t) => {
  pinMarketOpen(t)

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

// ─── PATCH /api/trades/modify ────────────────────────────────────────────────
// SL/TP levels used to be validated against the ENTRY price, which made the
// most common risk-management action on the platform impossible: a BUY in
// profit could not move its stop above entry to lock the gain in, because
// `sl >= open_price` rejected it. These pin the rule that replaced it —
// a stop belongs on the losing side of the CURRENT market, wherever entry was.
//
// PRICE_ROW is bid 1.10000 / ask 1.10020, so a long is measured against
// 1.10000 and a short against 1.10020 (a position closes at the bid when long
// and the ask when short). EURUSD's minimum distance is 0.0001.

function openTrade(overrides = {}) {
  return {
    id: 501, account_id: ACCOUNT_ID, user_id: USER_ID, instrument: 'EURUSD',
    direction: 'buy', lot_size: '1.00', open_price: '1.09000', status: 'open',
    stop_loss: null, take_profit: null, commission: '0', open_time: new Date(),
    ...overrides
  }
}

function installModifyMock(trade) {
  return installPoolMock({
    queryHandlers: [
      [/FROM trades t\s+JOIN accounts a/i, () => ({ rows: [trade] })],
      [/UPDATE trades SET/i, (_sql, values) => ({ rowCount: 1, rows: [{ ...trade, stop_loss: values[0] }] })]
    ]
  })
}

test('PATCH /api/trades/modify lets a BUY in profit trail its stop above entry', async (t) => {
  pinMarketOpen(t)
  const calls = installModifyMock(openTrade({ open_price: '1.09000' }))

  // Entry 1.09000, market 1.10000. A stop at 1.09500 is above entry (locking in
  // profit) and still below the market — the case the old rule rejected outright.
  const res = await request(app)
    .patch('/api/trades/modify')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, stop_loss: 1.09500 })

  assert.equal(res.status, 200, `expected the trail to be accepted, got ${res.status}: ${JSON.stringify(res.body)}`)
  const update = calls.find((call) => /UPDATE trades SET/i.test(call.sql))
  assert.equal(update.values[0], '1.095', 'persisted stop loss remains a decimal string')
})

test('PATCH /api/trades/modify-pending validates and persists decimal strings', async (t) => {
  pinMarketOpen(t)
  const pendingTrade = openTrade({
    status: 'pending',
    order_type: 'buy_limit',
    pending_price: '1.09900'
  })
  const calls = installPoolMock({
    queryHandlers: [
      [/FROM trades t\s+JOIN accounts a[\s\S]*t\.status = 'pending'/i, () => ({ rows: [pendingTrade] })],
      [/UPDATE trades SET/i, (_sql, values) => ({ rowCount: 1, rows: [{ ...pendingTrade, pending_price: values[0] }] })]
    ]
  })

  const res = await request(app)
    .patch('/api/trades/modify-pending')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, pending_price: 1.09910 })

  assert.equal(res.status, 200, JSON.stringify(res.body))
  const update = calls.find((call) => /UPDATE trades SET/i.test(call.sql))
  assert.equal(update.values[0], '1.0991')
})

test('PATCH /api/trades/modify still rejects a BUY stop above the market', async (t) => {
  pinMarketOpen(t)
  installModifyMock(openTrade({ open_price: '1.09000' }))

  // 1.10500 is through the market — it would stop the trade out on the next tick.
  const res = await request(app)
    .patch('/api/trades/modify')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, stop_loss: 1.10500 })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /below the current market price/)
})

test('PATCH /api/trades/modify lets a SELL in profit trail its stop below entry', async (t) => {
  pinMarketOpen(t)
  installModifyMock(openTrade({ direction: 'sell', open_price: '1.11000' }))

  // Short from 1.11000, market (ask) 1.10020. A stop at 1.10500 is below entry
  // and above the market: in profit, and correctly placed.
  const res = await request(app)
    .patch('/api/trades/modify')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, stop_loss: 1.10500 })

  assert.equal(res.status, 200, `expected the trail to be accepted, got ${res.status}: ${JSON.stringify(res.body)}`)
})

test('PATCH /api/trades/modify rejects a stop parked inside the minimum distance', async (t) => {
  pinMarketOpen(t)
  installModifyMock(openTrade({ open_price: '1.09000' }))

  // 0.00005 below the market — under EURUSD's 0.0001 minimum.
  const res = await request(app)
    .patch('/api/trades/modify')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, stop_loss: 1.09995 })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /at least/)
})

test('PATCH /api/trades/modify refuses breakeven on a losing trade', async (t) => {
  pinMarketOpen(t)
  installModifyMock(openTrade({ open_price: '1.11000' }))

  // Long from 1.11000 with the market at 1.10000: the trade is down, so entry
  // sits ABOVE the market. The old code skipped validation for this flag
  // entirely and set the stop to entry, closing the position immediately at a
  // loss — the opposite of what "move to breakeven" promises.
  const res = await request(app)
    .patch('/api/trades/modify')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, move_to_breakeven: true })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /not far enough in profit/)
})

test('PATCH /api/trades/modify refuses to validate without a live price', async (t) => {
  pinMarketOpen(t)
  // GBPUSD has no row in the feed, so there is nothing to measure against.
  installModifyMock(openTrade({ instrument: 'GBPUSD' }))

  const res = await request(app)
    .patch('/api/trades/modify')
    .set('Authorization', authHeader)
    .send({ trade_id: 501, stop_loss: 1.20000 })

  assert.equal(res.status, 503)
  assert.match(res.body.error, /Live price unavailable/)
})
