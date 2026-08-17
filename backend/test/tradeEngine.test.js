const test = require('node:test')
const assert = require('node:assert/strict')
const pool = require('../db')
// The engine moved out of routes/trades.js into services/tradeEngine.js — these
// assertions are unchanged from when they covered the route-file version, which
// is the point: they are the evidence the extraction preserved behaviour.
const {
  checkSLTP,
  checkPendingOrders,
  checkFloatingDrawdown
} = require('../services/tradeEngine')

// ─── Shared mock helpers ────────────────────────────────────────────────────
// Every DB call in the engines ultimately goes through the shared `pool`
// singleton (pool.query / pool.connect), the same pattern test/affiliates.test.js
// uses. A generic router keeps the mocks focused on the query shapes each test
// actually cares about; anything unmatched falls back to an empty result set,
// which every code path here treats as "nothing to do" rather than throwing.

const PRICE_FEED_ROW = { instrument: 'EURUSD', bid: '1.10000', ask: '1.10020', updated_at: new Date() }

function makeMockClient(handlers = []) {
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, values)
      }
      // Generic lock query default: echo back the id being locked so the
      // caller's "not found / already locked" branch is never hit by mistake.
      if (/FOR UPDATE SKIP LOCKED/i.test(sql)) {
        return { rows: [{ id: values?.[0], status: 'active' }] }
      }
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
    if (/FROM price_feed\b/i.test(sql)) {
      return { rows: [PRICE_FEED_ROW] }
    }
    return { rows: [] }
  }
  pool.connect = async () => connectClient || makeMockClient()
  return calls
}

// Both of these select open trades joined to active accounts — checkSLTP gained
// the a.status filter it was missing — so they are told apart by what only one
// of them asks for: checkSLTP by its SL/TP predicate, checkFloatingDrawdown by
// the trailing-drawdown columns it needs.
const OPEN_TRADES_QUERY = /FROM trades t\s+JOIN accounts a[\s\S]*t\.stop_loss IS NOT NULL/
const DRAWDOWN_QUERY = /a\.eod_peak_equity, a\.eod_trailing_floor[\s\S]*FROM trades t\s+JOIN accounts a/
const PENDING_ORDERS_QUERY = /FROM trades t\s+JOIN accounts a ON t\.account_id = a\.id\s+WHERE t\.status = 'pending'/

test('checkSLTP closes a BUY trade when price falls to the stop loss and records the correct PnL', async () => {
  const openTime = new Date(Date.now() - 10 * 60 * 1000) // 10 min ago — clears min-hold-time
  const trade = {
    id: 'trade-1', account_id: 'acc-1', instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', open_price: '1.10500', stop_loss: '1.10100', take_profit: null,
    status: 'open', open_time: openTime, demo_trade_id: null, commission: '0', user_id: 'user-1'
  }
  const client = makeMockClient()
  const calls = installPoolMock({
    queryHandlers: [
      [OPEN_TRADES_QUERY, () => ({ rows: [trade] })],
      [/FROM price_feed\b/i, () => ({ rows: [{ instrument: 'EURUSD', bid: '1.10000', ask: '1.10020', updated_at: new Date() }] })]
    ],
    connectClient: client
  })

  const emitted = []
  const io = { to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) }

  await checkSLTP(io)

  const closeCall = client.calls.find(c => /UPDATE trades SET/.test(c.sql) && /status = 'closed'/.test(c.sql))
  assert.ok(closeCall, 'expected the trade to be closed')
  assert.equal(closeCall.values[0], 1.10000, 'should close at the BID price for a BUY trade')
  assert.equal(closeCall.values[2], 'Stop Loss')
  // (1.10000 - 1.10500) * 1 lot * 100,000 contract size = -500
  assert.equal(closeCall.values[1], -500)

  const balanceCall = client.calls.find(c => /UPDATE accounts SET/.test(c.sql) && /current_balance = current_balance/.test(c.sql))
  assert.ok(balanceCall, 'expected the account balance to be adjusted')
  assert.equal(balanceCall.values[0], -500)

  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].room, 'user-1')
  assert.equal(emitted[0].payload.pnl, -500)
  assert.ok(calls.length > 0)
})

test('checkSLTP does not close a trade that breached SL before the min-hold-time elapses', async () => {
  const openTime = new Date(Date.now() - 5 * 1000) // 5 seconds ago — under the 60s default min hold
  const trade = {
    id: 'trade-2', account_id: 'acc-1', instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', open_price: '1.10500', stop_loss: '1.10100', take_profit: null,
    status: 'open', open_time: openTime, demo_trade_id: null, commission: '0', user_id: 'user-1'
  }
  const client = makeMockClient()
  installPoolMock({
    queryHandlers: [[OPEN_TRADES_QUERY, () => ({ rows: [trade] })]],
    connectClient: client
  })

  await checkSLTP(null)

  const closeCall = client.calls.find(c => /UPDATE trades SET/.test(c.sql))
  assert.equal(closeCall, undefined, 'trade should not be closed before min hold time elapses')
})

test('checkSLTP concurrency guard: a second call while one is running issues no queries', async () => {
  let releaseGate
  const gate = new Promise((resolve) => { releaseGate = resolve })
  let sltpQueryCount = 0

  pool.query = async (sql) => {
    if (OPEN_TRADES_QUERY.test(sql)) {
      sltpQueryCount++
      await gate
    }
    return { rows: [] }
  }
  pool.connect = async () => makeMockClient()

  const firstCall = checkSLTP(null)
  // Give the first call a tick to reach (and block on) the openTrades query.
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(sltpQueryCount, 1, 'first call should have reached its main query')

  await checkSLTP(null) // should return immediately — guard is active
  assert.equal(sltpQueryCount, 1, 'second concurrent call must not issue its own query')

  releaseGate()
  await firstCall
})

test('checkPendingOrders cancels a pending order when its account is no longer active', async () => {
  const order = {
    id: 'order-1', account_id: 'acc-3', instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', order_type: 'buy_limit', pending_price: '1.09000', status: 'pending',
    user_id: 'user-3', current_balance: '10000', peak_balance: '10000',
    account_status: 'failed', account_size: '10000', phase_end_date: null,
    account_type: 'phase1', scaling_multiplier: null, oco_group_id: null
  }
  const cancelCalls = []
  installPoolMock({
    queryHandlers: [
      [PENDING_ORDERS_QUERY, () => ({ rows: [order] })],
      [/UPDATE trades SET\s+status = 'cancelled'/, (sql, values) => { cancelCalls.push(values); return { rows: [] } }]
    ]
  })

  await checkPendingOrders(null)

  assert.equal(cancelCalls.length, 1)
  assert.equal(cancelCalls[0][1], 'order-1')
  assert.match(cancelCalls[0][0], /Account inactive/)
})

// Pinned to a Wednesday midday rather than skipped when the real calendar says
// the market is shut: a conditional skip means this fill path goes uncovered
// every weekend, silently. Only Date is mocked, so timers still run.
test('checkPendingOrders fills a buy_limit order once the ask price reaches the limit price', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-15T12:00:00.000Z') })

  const order = {
    id: 'order-2', account_id: 'acc-4', instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', order_type: 'buy_limit', pending_price: '1.10020', status: 'pending',
    user_id: 'user-4', current_balance: '10000', peak_balance: '10000',
    account_status: 'active', account_size: '10000', phase_end_date: null,
    account_type: 'phase1', scaling_multiplier: null, oco_group_id: null
  }
  const client = makeMockClient([
    [/SELECT current_balance FROM accounts/, () => ({ rows: [{ current_balance: '10000' }] })],
    [/COALESCE\(SUM\(lot_size\), 0\) as total_lots/, () => ({ rows: [{ total_lots: '0' }] })],
    [/SELECT COUNT\(\*\) FROM trades WHERE account_id/, () => ({ rows: [{ count: '0' }] })]
  ])
  installPoolMock({
    queryHandlers: [[PENDING_ORDERS_QUERY, () => ({ rows: [order] })]],
    connectClient: client
  })

  await checkPendingOrders(null)

  const openCall = client.calls.find(c => /UPDATE trades SET/.test(c.sql) && /status = 'open'/.test(c.sql))
  assert.ok(openCall, 'expected the pending order to be triggered into an open position')
  assert.equal(openCall.values[0], 1.10020, 'buy_limit should fill at the ask price')
})

test('checkFloatingDrawdown fails an account once equity falls below the trailing drawdown floor', async () => {
  const account = {
    id: 'acc-5', account_id: 'acc-5', instrument: 'EURUSD', direction: 'sell',
    lot_size: '1', open_price: '1.10000', stop_loss: null, take_profit: null,
    status: 'open', open_time: new Date(), demo_trade_id: null,
    user_id: 'user-5', current_balance: '10000', starting_balance: '10000', peak_balance: '10000',
    max_drawdown_pct: '10', account_type: 'phase1', profit_target: '1000', account_size: '10000',
    acc_starting: '10000', eod_peak_equity: null, eod_trailing_floor: null,
    challenge_model_slug: null, daily_drawdown_pct: null
  }
  const client = makeMockClient()
  installPoolMock({
    queryHandlers: [
      [DRAWDOWN_QUERY, () => ({ rows: [account] })],
      // Sell trade: closes at ASK. 1.11500 vs open 1.10000 = -1500 on 1 lot.
      [/FROM price_feed\b/i, () => ({ rows: [{ instrument: 'EURUSD', bid: '1.11480', ask: '1.11500', updated_at: new Date() }] })]
    ],
    connectClient: client
  })

  await checkFloatingDrawdown(null)

  const failCall = client.calls.find(c => /UPDATE accounts SET status = 'failed'/.test(c.sql))
  assert.ok(failCall, 'expected the account to be marked failed once equity breached the drawdown floor')
  assert.equal(failCall.values[0], 'acc-5')
})

test('checkFloatingDrawdown leaves an account untouched while equity stays above the drawdown floor', async () => {
  const account = {
    id: 'acc-6', account_id: 'acc-6', instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', open_price: '1.10000', stop_loss: null, take_profit: null,
    status: 'open', open_time: new Date(), demo_trade_id: null,
    user_id: 'user-6', current_balance: '10000', starting_balance: '10000', peak_balance: '10000',
    max_drawdown_pct: '10', account_type: 'phase1', profit_target: '1000', account_size: '10000',
    acc_starting: '10000', eod_peak_equity: null, eod_trailing_floor: null,
    challenge_model_slug: null, daily_drawdown_pct: null
  }
  const client = makeMockClient()
  installPoolMock({
    queryHandlers: [
      [DRAWDOWN_QUERY, () => ({ rows: [account] })],
      // Buy trade closes at BID; a small favorable move keeps equity well above the 9000 floor.
      [/FROM price_feed\b/i, () => ({ rows: [{ instrument: 'EURUSD', bid: '1.10050', ask: '1.10070', updated_at: new Date() }] })]
    ],
    connectClient: client
  })

  await checkFloatingDrawdown(null)

  const failCall = client.calls.find(c => /UPDATE accounts SET status = 'failed'/.test(c.sql))
  assert.equal(failCall, undefined, 'account should not be failed while equity is above the floor')
})
