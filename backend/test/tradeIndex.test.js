const test = require('node:test')
const assert = require('node:assert/strict')

const tradeIndex = require('../utils/tradeIndex')
const { directionSign, contractSizeFor } = require('../utils/fastPnL')

// The index is authoritative for the hot path, so a leak here is not a
// performance bug — it is an account being judged on positions it does not hold,
// or not judged on positions it does. The reconcile every 30s is a safety net,
// not a licence for the incremental paths to be sloppy.
//
// These tests exercise the in-memory mutations only; fullReconcileFromDB is
// covered by the engine's integration path.

const ACCOUNT_ROW = {
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
  daily_drawdown_pct: '5'
}

function tradeRow(overrides = {}) {
  return {
    id: 'trade-1',
    account_id: 'acc-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1',
    open_price: '1.10000',
    stop_loss: '1.09000',
    take_profit: '1.11000',
    commission: '3',
    open_time: new Date(),
    ...overrides
  }
}

function pendingRow(overrides = {}) {
  return {
    id: 'order-1',
    account_id: 'acc-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1',
    order_type: 'buy_limit',
    pending_price: '1.09500',
    oco_group_id: null,
    ...overrides
  }
}

test.beforeEach(() => {
  tradeIndex.__reset()
  tradeIndex.upsertAccount(ACCOUNT_ROW)
})

test('a trade is reachable by id and by instrument, and is attributed to its account', () => {
  tradeIndex.addTrade(tradeRow())

  assert.equal(tradeIndex.getTradeCount(), 1)
  assert.ok(tradeIndex.getTrade('trade-1'))
  assert.equal(tradeIndex.getTradesByInstrument('EURUSD').size, 1)
  assert.ok(tradeIndex.getAccountEntry('acc-1').tradeIds.has('trade-1'))
})

test('entries pre-resolve direction, contract size and numeric levels for the hot loop', () => {
  const entry = tradeIndex.addTrade(tradeRow({ direction: 'sell', instrument: 'XAUUSD' }))

  assert.equal(entry.sign, directionSign('sell'))
  assert.equal(entry.contractSize, contractSizeFor('XAUUSD'))
  assert.equal(typeof entry.openPrice, 'number')
  assert.equal(typeof entry.stopLoss, 'number')
  assert.equal(typeof entry.takeProfit, 'number')
  assert.equal(typeof entry.lots, 'number')
})

test('a missing stop loss or take profit is null, not NaN', () => {
  const entry = tradeIndex.addTrade(tradeRow({ stop_loss: null, take_profit: null }))
  assert.equal(entry.stopLoss, null)
  assert.equal(entry.takeProfit, null)
})

test('removing a trade leaves no orphan in any of the three maps', () => {
  tradeIndex.addTrade(tradeRow())
  tradeIndex.removeTrade('trade-1')

  assert.equal(tradeIndex.getTradeCount(), 0)
  assert.equal(tradeIndex.getTrade('trade-1'), null)
  assert.equal(tradeIndex.getTradesByInstrument('EURUSD').size, 0)
  assert.equal(tradeIndex.getAccountEntry('acc-1').tradeIds.has('trade-1'), false)
})

test('floating PnL accumulates per account and is withdrawn on close', () => {
  const first = tradeIndex.addTrade(tradeRow({ id: 'trade-1' }))
  const second = tradeIndex.addTrade(tradeRow({ id: 'trade-2' }))

  tradeIndex.applyTradePnl(first, 100)
  tradeIndex.applyTradePnl(second, -40)
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), 60)

  // Re-pricing the same trade replaces its contribution rather than adding to it.
  tradeIndex.applyTradePnl(first, 150)
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), 110)

  tradeIndex.removeTrade('trade-1')
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), -40)
})

test('re-indexing an existing trade does not double-count its floating PnL', () => {
  // This is the partial-close and modify-SL/TP path: the same trade id is added
  // again with new values. Without withdrawing the previous entry's
  // contribution the account would carry the position twice.
  const entry = tradeIndex.addTrade(tradeRow())
  tradeIndex.applyTradePnl(entry, 500)
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), 500)

  const reindexed = tradeIndex.addTrade(tradeRow({ lot_size: '0.5' }))
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), 0, 'stale contribution must be withdrawn')

  tradeIndex.applyTradePnl(reindexed, 250)
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), 250)
  assert.equal(tradeIndex.getTradeCount(), 1, 're-indexing must not duplicate the trade')
})

test('changing a trade instrument moves it between buckets without leaving a ghost', () => {
  tradeIndex.addTrade(tradeRow())
  tradeIndex.addTrade(tradeRow({ instrument: 'XAUUSD' }))

  assert.equal(tradeIndex.getTradesByInstrument('EURUSD').size, 0)
  assert.equal(tradeIndex.getTradesByInstrument('XAUUSD').size, 1)
  assert.equal(tradeIndex.getTradeCount(), 1)
})

test('resetFloatingPnl zeroes both the per-trade and per-account totals', () => {
  const entry = tradeIndex.addTrade(tradeRow())
  tradeIndex.applyTradePnl(entry, 900)

  tradeIndex.resetFloatingPnl()
  assert.equal(tradeIndex.getFloatingPnl('acc-1'), 0)
  assert.equal(tradeIndex.getTrade('trade-1').lastPnl, 0)
})

test('pending orders index and de-index symmetrically', () => {
  tradeIndex.addPending(pendingRow())
  assert.equal(tradeIndex.getPendingCount(), 1)
  assert.equal(tradeIndex.getPendingByInstrument('EURUSD').size, 1)
  assert.ok(tradeIndex.getAccountEntry('acc-1').pendingIds.has('order-1'))

  tradeIndex.removePending('order-1')
  assert.equal(tradeIndex.getPendingCount(), 0)
  assert.equal(tradeIndex.getPendingByInstrument('EURUSD').size, 0)
  assert.equal(tradeIndex.getAccountEntry('acc-1').pendingIds.has('order-1'), false)
})

test('removing an account takes its trades and pending orders with it', () => {
  tradeIndex.addTrade(tradeRow({ id: 'trade-1' }))
  tradeIndex.addTrade(tradeRow({ id: 'trade-2', instrument: 'XAUUSD' }))
  tradeIndex.addPending(pendingRow({ id: 'order-1' }))
  tradeIndex.addPending(pendingRow({ id: 'order-2', instrument: 'XAUUSD' }))

  tradeIndex.removeAccount('acc-1')

  assert.equal(tradeIndex.getAccountCount(), 0)
  assert.equal(tradeIndex.getTradeCount(), 0, 'no orphaned trades')
  assert.equal(tradeIndex.getPendingCount(), 0, 'no orphaned pending orders')
  assert.equal(tradeIndex.getTradesByInstrument('EURUSD').size, 0)
  assert.equal(tradeIndex.getPendingByInstrument('XAUUSD').size, 0)
})

test('the cached daily realised PnL accumulates and survives a same-day re-read', () => {
  tradeIndex.applyRealizedPnl('acc-1', -250)
  tradeIndex.applyRealizedPnl('acc-1', -100)
  assert.equal(tradeIndex.getTodayRealizedPnl('acc-1'), -350)
})

test('the cached daily realised PnL resets when the UTC day rolls over', () => {
  tradeIndex.applyRealizedPnl('acc-1', -500)
  assert.equal(tradeIndex.getTodayRealizedPnl('acc-1'), -500)

  // Simulate the account having last been touched yesterday.
  tradeIndex.getAccountEntry('acc-1').realizedDayKey -= 24 * 60 * 60 * 1000
  assert.equal(tradeIndex.getTodayRealizedPnl('acc-1'), 0, 'yesterday\'s losses must not count against today')

  tradeIndex.applyRealizedPnl('acc-1', -75)
  assert.equal(tradeIndex.getTodayRealizedPnl('acc-1'), -75, 'the rollover resets rather than accumulating')
})

test('peak equity and locked floor only ever ratchet upward', () => {
  tradeIndex.setPeakEquity('acc-1', 105000, 95000)
  tradeIndex.setPeakEquity('acc-1', 101000, 90000)

  const account = tradeIndex.getAccountEntry('acc-1')
  assert.equal(account.eodPeakEquity, 105000)
  assert.equal(account.eodTrailingFloor, 95000)
})

test('upserting an account preserves its accumulated in-memory state', () => {
  const entry = tradeIndex.addTrade(tradeRow())
  tradeIndex.applyTradePnl(entry, 400)
  tradeIndex.applyRealizedPnl('acc-1', -120)

  // A balance refresh must not wipe the running totals or the trade links.
  tradeIndex.upsertAccount({ ...ACCOUNT_ROW, current_balance: '99880' })

  const account = tradeIndex.getAccountEntry('acc-1')
  assert.equal(account.currentBalance, 99880)
  assert.equal(account.floatingPnl, 400)
  assert.equal(account.todayRealizedPnl, -120)
  assert.ok(account.tradeIds.has('trade-1'))
})

test('updateAccountBalance ratchets the peak balance with it', () => {
  tradeIndex.updateAccountBalance('acc-1', 104000)
  const account = tradeIndex.getAccountEntry('acc-1')
  assert.equal(account.currentBalance, 104000)
  assert.equal(account.peakBalance, 104000)

  tradeIndex.updateAccountBalance('acc-1', 102000)
  assert.equal(account.currentBalance, 102000)
  assert.equal(account.peakBalance, 104000, 'peak does not fall back')
})

test('mutations for an unknown trade or account are no-ops rather than throws', () => {
  assert.equal(tradeIndex.removeTrade('nope'), false)
  assert.equal(tradeIndex.removePending('nope'), false)
  assert.equal(tradeIndex.removeAccount('nope'), false)
  assert.equal(tradeIndex.getTodayRealizedPnl('nope'), 0)
  assert.equal(tradeIndex.getFloatingPnl('nope'), 0)
  assert.doesNotThrow(() => tradeIndex.updateAccountBalance('nope', 1))
  assert.doesNotThrow(() => tradeIndex.applyTradePnl(null, 5))
})
