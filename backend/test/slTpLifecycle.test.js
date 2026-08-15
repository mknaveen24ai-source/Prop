const test = require('node:test')
const assert = require('node:assert/strict')
const pool = require('../db')
const { checkSLTP } = require('../services/tradeEngine')

// test/tradeEngine.test.js covers the BUY stop-loss path, the min-hold guard
// and the concurrency guard. This file covers the rest of the trigger matrix,
// which is where the money is: take-profit, the SELL side (which closes at ASK,
// not BID, and whose comparisons invert), and the no-trigger cases that must
// leave a position alone. A sign error in any of these pays or charges a trader
// the wrong amount without ever throwing.
//
// Same mocking approach as the existing engine tests: swap the shared `pool`
// singleton, then assert on the SQL the engine issued.

const OPEN_TRADES_QUERY = /FROM trades t\s+JOIN accounts a ON t\.account_id = a\.id\s+WHERE t\.status = 'open'\s+AND \(/

// Well clear of the 60s default min hold time.
const OPEN_TIME = new Date(Date.now() - 10 * 60 * 1000)

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
        return { rows: [{ id: values?.[0], status: 'active' }] }
      }
      return { rows: [] }
    },
    release() {}
  }
}

function installPoolMock({ trades = [], price, connectClient = null } = {}) {
  pool.query = async (sql) => {
    if (OPEN_TRADES_QUERY.test(sql)) return { rows: trades }
    if (/FROM price_feed\b/i.test(sql)) return { rows: [price] }
    return { rows: [] }
  }
  pool.connect = async () => connectClient || makeMockClient()
}

function priceRow(bid, ask) {
  return { instrument: 'EURUSD', bid: String(bid), ask: String(ask), updated_at: new Date() }
}

function trade(overrides = {}) {
  return {
    id: 'trade-1', account_id: 'acc-1', instrument: 'EURUSD', direction: 'buy',
    lot_size: '1', open_price: '1.10000', stop_loss: null, take_profit: null,
    status: 'open', open_time: OPEN_TIME, demo_trade_id: null, commission: '0',
    user_id: 'user-1', ...overrides
  }
}

function closeCall(client) {
  return client.calls.find((c) => /UPDATE trades SET/.test(c.sql) && /status = 'closed'/.test(c.sql))
}

function balanceCall(client) {
  return client.calls.find((c) => /UPDATE accounts SET/.test(c.sql) && /current_balance = current_balance/.test(c.sql))
}

// ─── Take profit ─────────────────────────────────────────────────────────────

test('a BUY take-profit closes at the bid and credits the gain', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ take_profit: '1.10400' })],
    price: priceRow('1.10500', '1.10520'),
    connectClient: client
  })

  await checkSLTP(null)

  const close = closeCall(client)
  assert.ok(close, 'expected the trade to close')
  assert.equal(close.values[0], 1.10500, 'a BUY closes at the BID')
  assert.equal(close.values[2], 'Take Profit')
  // (1.10500 - 1.10000) * 1 lot * 100,000 = +500
  assert.equal(close.values[1], 500)
  assert.equal(balanceCall(client).values[0], 500)
})

test('a SELL take-profit closes at the ask and credits the gain', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ direction: 'sell', take_profit: '1.09600' })],
    price: priceRow('1.09480', '1.09500'),
    connectClient: client
  })

  await checkSLTP(null)

  const close = closeCall(client)
  assert.ok(close, 'a SELL take-profit triggers when price falls TO or BELOW the target')
  assert.equal(close.values[0], 1.09500, 'a SELL closes at the ASK')
  // (1.10000 - 1.09500) * 1 lot * 100,000 = +500
  assert.equal(close.values[1], 500)
})

// ─── Stop loss, sell side ────────────────────────────────────────────────────

test('a SELL stop-loss triggers when the ask rises to it and debits the loss', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ direction: 'sell', stop_loss: '1.10400' })],
    price: priceRow('1.10480', '1.10500'),
    connectClient: client
  })

  await checkSLTP(null)

  const close = closeCall(client)
  assert.ok(close)
  assert.equal(close.values[2], 'Stop Loss')
  assert.equal(close.values[0], 1.10500)
  // (1.10000 - 1.10500) * 1 lot * 100,000 = -500
  assert.equal(close.values[1], -500)
  assert.equal(balanceCall(client).values[0], -500)
})

// ─── No trigger ──────────────────────────────────────────────────────────────

test('a position sitting between its stop and its target is left alone', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ stop_loss: '1.09500', take_profit: '1.10500' })],
    price: priceRow('1.10000', '1.10020'),
    connectClient: client
  })

  await checkSLTP(null)

  assert.equal(closeCall(client), undefined, 'neither level was reached')
  assert.equal(balanceCall(client), undefined, 'and no balance was written')
})

test('a BUY is not stopped out by an ask that dips below the stop while the bid holds', async () => {
  // A BUY is valued on the BID. Comparing the ask here would close the position
  // early and hand the trader a loss they never actually took.
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ stop_loss: '1.09990' })],
    price: priceRow('1.10000', '1.09980'),
    connectClient: client
  })

  await checkSLTP(null)

  assert.equal(closeCall(client), undefined)
})

// ─── Precedence and accounting ───────────────────────────────────────────────

test('stop loss wins when both levels are satisfied by one tick', async () => {
  // Only reachable with inverted levels — a BUY whose stop sits ABOVE its
  // target, which the order routes should reject but which has existed in the
  // table before now. With correctly ordered levels (SL < TP for a BUY) no
  // single price can satisfy both. The engine checks SL first; pinning that
  // keeps the safer of the two branches winning if the checks are ever
  // reordered.
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ direction: 'buy', stop_loss: '1.10500', take_profit: '1.10400' })],
    price: priceRow('1.10450', '1.10470'), // <= SL and >= TP simultaneously
    connectClient: client
  })

  await checkSLTP(null)

  const close = closeCall(client)
  assert.ok(close)
  assert.equal(close.values[2], 'Stop Loss')
})

test('commission is deducted from the realised PnL', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ take_profit: '1.10400', commission: '7' })],
    price: priceRow('1.10500', '1.10520'),
    connectClient: client
  })

  await checkSLTP(null)

  // 500 gross - 7 commission
  assert.equal(closeCall(client).values[1], 493)
  assert.equal(balanceCall(client).values[0], 493)
})

test('a winning close raises peak_balance in the same statement as the balance', async () => {
  // peak_balance drives the trailing drawdown floor. If it were updated in a
  // separate statement, a crash between the two would leave the floor computed
  // against a stale peak.
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ take_profit: '1.10400' })],
    price: priceRow('1.10500', '1.10520'),
    connectClient: client
  })

  await checkSLTP(null)

  const balance = balanceCall(client)
  assert.match(balance.sql, /peak_balance\s*=\s*GREATEST\(peak_balance, current_balance \+ \$1\)/)
})

test('fractional lots scale the PnL proportionally', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ lot_size: '0.25', take_profit: '1.10400' })],
    price: priceRow('1.10500', '1.10520'),
    connectClient: client
  })

  await checkSLTP(null)

  // (1.10500 - 1.10000) * 0.25 * 100,000 = 125
  assert.equal(closeCall(client).values[1], 125)
})

test('a trade whose instrument has no price this tick is skipped, not closed at zero', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [trade({ instrument: 'GBPUSD', stop_loss: '1.10500' })],
    price: priceRow('1.10000', '1.10020'), // EURUSD only
    connectClient: client
  })

  await checkSLTP(null)

  assert.equal(closeCall(client), undefined, 'a missing price must never be read as 0')
})

test('each triggered trade in a batch is closed independently', async () => {
  const client = makeMockClient()
  installPoolMock({
    trades: [
      trade({ id: 'trade-a', take_profit: '1.10400' }),
      trade({ id: 'trade-b', account_id: 'acc-2', lot_size: '2', take_profit: '1.10400' })
    ],
    price: priceRow('1.10500', '1.10520'),
    connectClient: client
  })

  await checkSLTP(null)

  const closes = client.calls.filter((c) => /UPDATE trades SET/.test(c.sql) && /status = 'closed'/.test(c.sql))
  assert.equal(closes.length, 2)
  assert.equal(closes[0].values[1], 500)
  assert.equal(closes[1].values[1], 1000)
})
