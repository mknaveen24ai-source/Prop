const test = require('node:test')
const assert = require('node:assert/strict')

const pool = require('../db')
const priceCache = require('../utils/priceCache')
const tradeIndex = require('../utils/tradeIndex')
const tradeEngine = require('../services/tradeEngine')
const { calculatePnL } = require('../utils/pnlCalculator')

// Covers the event-driven path's two load-bearing claims:
//
//   1. A tick scans only the trades on instruments that actually moved. This is
//      the entire reason 100K trades is affordable — if it ever regressed to
//      scanning everything, the tick cost would go back to being proportional to
//      total open trades and the design would be pointless.
//
//   2. Float detects, Decimal confirms. The float scan may flag an account, but
//      nothing happens to it until the Decimal recomputation agrees. A test that
//      makes the two disagree must see the account left alone.

const originalQuery = pool.query
const originalConnect = pool.connect

function price(bid, ask = bid + 0.0002) {
  return { bid, ask, updated_at: new Date(), age_ms: 0, stale: false }
}

function accountRow(overrides = {}) {
  return {
    id: 'acc-1',
    user_id: 'user-1',
    status: 'active',
    account_type: 'phase1',
    challenge_model_slug: null,
    current_balance: '100000',
    starting_balance: '100000',
    peak_balance: '100000',
    account_size: '100000',
    profit_target: '10000',
    scaling_multiplier: '1',
    phase_end_date: null,
    eod_peak_equity: null,
    eod_trailing_floor: null,
    max_drawdown_pct: '10',
    daily_drawdown_pct: null,
    ...overrides
  }
}

function tradeRow(id, instrument, overrides = {}) {
  return {
    id,
    account_id: 'acc-1',
    instrument,
    direction: 'buy',
    lot_size: '1',
    open_price: '1.10000',
    stop_loss: null,
    take_profit: null,
    commission: '0',
    open_time: new Date(Date.now() - 60 * 60 * 1000), // an hour old — past min hold
    ...overrides
  }
}

test.beforeEach(() => {
  tradeIndex.__reset()
  priceCache.__reset()
  pool.query = async () => ({ rows: [], rowCount: 0 })
  pool.connect = async () => ({ async query() { return { rows: [], rowCount: 0 } }, release() {} })
})

test.after(() => {
  pool.query = originalQuery
  pool.connect = originalConnect
  tradeIndex.__reset()
  priceCache.__reset()
})

test('a tick scans only the trades on instruments that moved', async () => {
  tradeIndex.upsertAccount(accountRow())
  for (let i = 0; i < 30; i++) tradeIndex.addTrade(tradeRow(`eur-${i}`, 'EURUSD'))
  for (let i = 0; i < 70; i++) tradeIndex.addTrade(tradeRow(`xau-${i}`, 'XAUUSD', { open_price: '2000' }))
  tradeIndex.__setReadyForTest(true)

  priceCache.__setPricesForTest({ EURUSD: price(1.10100), XAUUSD: price(2001, 2001.2) })

  const result = await tradeEngine.onPriceTick(null, ['EURUSD'])

  assert.equal(tradeIndex.getTradeCount(), 100)
  assert.equal(result.scanned, 30, 'only the EURUSD book should have been walked')
})

test('floating PnL covers every open position, not just the ones that moved', async () => {
  // The incremental delta bookkeeping is easy to get wrong in exactly this
  // shape: an account holding two instruments where only one ticks must still
  // report equity across both.
  tradeIndex.upsertAccount(accountRow())
  tradeIndex.addTrade(tradeRow('eur-1', 'EURUSD'))
  tradeIndex.addTrade(tradeRow('xau-1', 'XAUUSD', { open_price: '2000' }))
  tradeIndex.__setReadyForTest(true)

  priceCache.__setPricesForTest({ EURUSD: price(1.10000), XAUUSD: price(2000, 2000.2) })
  tradeEngine.reseedFloatingPnl()

  // XAUUSD moves first, then EURUSD. After the second tick both contributions
  // must still be present.
  priceCache.__setPricesForTest({ EURUSD: price(1.10000), XAUUSD: price(2010, 2010.2) })
  await tradeEngine.onPriceTick(null, ['XAUUSD'])

  priceCache.__setPricesForTest({ EURUSD: price(1.10100), XAUUSD: price(2010, 2010.2) })
  const result = await tradeEngine.onPriceTick(null, ['EURUSD'])

  const expectedGold = calculatePnL('buy', 2000, 2010, 1, 'XAUUSD', 0)
  const expectedEur = calculatePnL('buy', 1.10000, 1.10100, 1, 'EURUSD', 0)
  const snapshot = result.equity.find((entry) => entry.accountId === 'acc-1')

  assert.ok(snapshot, 'the account should appear in the tick equity snapshot')
  assert.ok(
    Math.abs(snapshot.floatingPnl - (expectedGold + expectedEur)) < 0.01,
    `expected ${expectedGold + expectedEur}, got ${snapshot.floatingPnl}`
  )
})

test('a tick with no moved instruments does no work', async () => {
  tradeIndex.upsertAccount(accountRow())
  tradeIndex.addTrade(tradeRow('eur-1', 'EURUSD'))
  tradeIndex.__setReadyForTest(true)
  priceCache.__setPricesForTest({ EURUSD: price(1.10000) })

  assert.equal(await tradeEngine.onPriceTick(null, []), null)
  assert.equal(await tradeEngine.onPriceTick(null, null), null)
})

test('the event path stays inert until the index has been built', async () => {
  // Acting on a half-built index would mean judging accounts on trades the
  // engine cannot see, so it must decline rather than guess.
  tradeIndex.upsertAccount(accountRow())
  tradeIndex.addTrade(tradeRow('eur-1', 'EURUSD'))
  priceCache.__setPricesForTest({ EURUSD: price(1.10000) })

  assert.equal(tradeIndex.isReady(), false)
  assert.equal(await tradeEngine.onPriceTick(null, ['EURUSD']), null)
})

test('a drawdown breach is not acted on when the Decimal confirmation disagrees', async () => {
  // The float scan sees a catastrophic loss and flags the account. The
  // confirmation query then reports a healthy account with no open trades, so
  // equity is well above the floor and nothing should happen.
  tradeIndex.upsertAccount(accountRow())
  tradeIndex.addTrade(tradeRow('eur-1', 'EURUSD', { lot_size: '50' }))
  tradeIndex.__setReadyForTest(true)

  priceCache.__setPricesForTest({ EURUSD: price(1.10000) })
  tradeEngine.reseedFloatingPnl()

  let failAttempted = false
  pool.connect = async () => ({
    async query(sql) {
      if (/UPDATE accounts SET status = 'failed'/.test(sql)) failAttempted = true
      return { rows: [], rowCount: 0 }
    },
    release() {}
  })
  pool.query = async (sql) => {
    if (/FROM accounts WHERE id = \$1 AND status = 'active'/.test(sql)) {
      return { rows: [accountRow()] }
    }
    // No open trades → confirmed floating PnL is 0 → equity is the full balance.
    if (/FROM trades WHERE account_id = \$1 AND status = 'open'/.test(sql)) {
      return { rows: [] }
    }
    if (/FROM price_feed\b/i.test(sql)) return { rows: [] }
    return { rows: [], rowCount: 0 }
  }

  // Crash the price so the float pass sees equity far under the floor.
  priceCache.__setPricesForTest({ EURUSD: price(1.00000) })
  const result = await tradeEngine.onPriceTick(null, ['EURUSD'])

  assert.ok(result, 'the tick should still run')
  assert.equal(failAttempted, false, 'no account may be failed on a float reading alone')
})

test('overlapping ticks coalesce instead of double-counting', async () => {
  tradeIndex.upsertAccount(accountRow())
  tradeIndex.addTrade(tradeRow('eur-1', 'EURUSD'))
  tradeIndex.__setReadyForTest(true)
  priceCache.__setPricesForTest({ EURUSD: price(1.10000) })
  tradeEngine.reseedFloatingPnl()

  priceCache.__setPricesForTest({ EURUSD: price(1.10100) })
  const first = tradeEngine.onPriceTick(null, ['EURUSD'])
  const second = tradeEngine.onPriceTick(null, ['EURUSD'])

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.ok(firstResult, 'the first tick runs')
  assert.equal(secondResult, null, 'the overlapping tick is folded into the running one')

  // The account's floating PnL must reflect one position, not two applications
  // of the same delta.
  const expected = calculatePnL('buy', 1.10000, 1.10100, 1, 'EURUSD', 0)
  assert.ok(Math.abs(tradeIndex.getFloatingPnl('acc-1') - expected) < 0.01)
})

test('a failed peak-equity flush is re-queued rather than dropped', async () => {
  // These are the trailing-drawdown floors. Dropping a raise on a transient DB
  // error leaves it in memory only, so after the next restart the index reloads
  // the older, LOWER floor — and an account that should have breached does not.
  // The failure is silent by construction, which is why it needs a test.
  tradeIndex.upsertAccount(accountRow())
  tradeIndex.addTrade(tradeRow('eur-1', 'EURUSD'))
  tradeIndex.__setReadyForTest(true)

  priceCache.__setPricesForTest({ EURUSD: price(1.10000) })
  tradeEngine.reseedFloatingPnl()

  // A move into profit raises equity above the starting balance, which is what
  // makes resolveEffectiveFloor report a new peak and mark the account dirty.
  priceCache.__setPricesForTest({ EURUSD: price(1.20000) })
  await tradeEngine.onPriceTick(null, ['EURUSD'])

  pool.query = async () => { throw new Error('connection terminated') }
  assert.equal(await tradeEngine.flushDirtyPeaks(), 0, 'a failed flush writes nothing')

  // The retry must still carry the account. Before the fix _dirtyPeaks was
  // cleared before the write, so this second flush had nothing to send and
  // returned without ever issuing a query.
  let flushed = null
  pool.query = async (sql, params) => {
    flushed = { sql, params }
    return { rows: [], rowCount: 1 }
  }
  const written = await tradeEngine.flushDirtyPeaks()

  assert.equal(written, 1, 'the re-queued update must reach the database on retry')
  assert.ok(flushed, 'the retry must issue a query')
  assert.ok(
    flushed.params[0].includes('acc-1'),
    'the re-queued batch must still name the account whose floor moved'
  )
})
