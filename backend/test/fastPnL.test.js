const test = require('node:test')
const assert = require('node:assert/strict')

const { calculatePnL } = require('../utils/pnlCalculator')
const {
  fastPnL,
  directionSign,
  contractSizeFor,
  closePriceFor,
  isSLTriggered,
  isTPTriggered,
  isPendingTriggered,
  DIRECTION_BUY,
  DIRECTION_SELL
} = require('../utils/fastPnL')
const { INSTRUMENTS } = require('../constants')

// The engine's whole safety argument rests on fastPnL being a faithful mirror of
// calculatePnL: the float pass only decides *which* accounts and trades to look
// at, and Decimal decides what actually happens to them. If the two ever
// disagreed by enough to change a threshold comparison, the fast path would
// start missing breaches the interval engine would have caught (or flagging ones
// it wouldn't), and the confirm step would silently absorb the difference
// instead of surfacing it. These tests are what keep the two in step.

const TOLERANCE = 0.01

function agree(direction, openPrice, closePrice, lots, instrument, commission) {
  const precise = calculatePnL(direction, openPrice, closePrice, lots, instrument, commission)
  const fast = fastPnL(
    directionSign(direction),
    openPrice,
    closePrice,
    lots,
    contractSizeFor(instrument),
    commission
  )
  return { precise, fast, delta: Math.abs(precise - fast) }
}

test('fastPnL agrees with calculatePnL across every instrument, both directions', () => {
  for (const instrument of INSTRUMENTS) {
    for (const direction of ['buy', 'sell']) {
      const openPrice = 1.10000
      const closePrice = 1.10500
      const { precise, fast, delta } = agree(direction, openPrice, closePrice, 0.5, instrument, 3.5)
      assert.ok(
        delta < TOLERANCE,
        `${instrument} ${direction}: Decimal=${precise} float=${fast} delta=${delta}`
      )
    }
  }
})

test('fastPnL agrees with calculatePnL across lot sizes and price magnitudes', () => {
  const cases = [
    // [instrument, open, close, lots, commission]
    ['EURUSD', 1.08420, 1.08435, 0.01, 0],
    ['EURUSD', 1.08420, 1.07920, 10, 35],
    ['EURUSD', 1.23456, 1.23455, 0.02, 0.07],
    ['XAUUSD', 2015.55, 2019.85, 0.5, 4.5],
    ['XAUUSD', 1999.99, 1999.98, 0.01, 0.03],
    ['XAGUSD', 24.315, 24.290, 2, 6],
  ].filter(([instrument]) => INSTRUMENTS.includes(instrument))

  assert.ok(cases.length > 0, 'expected at least one known instrument to test')

  for (const [instrument, open, close, lots, commission] of cases) {
    for (const direction of ['buy', 'sell']) {
      const { precise, fast, delta } = agree(direction, open, close, lots, instrument, commission)
      assert.ok(
        delta < TOLERANCE,
        `${instrument} ${direction} ${lots} lots: Decimal=${precise} float=${fast} delta=${delta}`
      )
    }
  }
})

test('fastPnL signs match: a BUY gains when price rises, a SELL gains when it falls', () => {
  const cs = contractSizeFor('EURUSD')
  assert.ok(fastPnL(DIRECTION_BUY, 1.1000, 1.1050, 1, cs, 0) > 0)
  assert.ok(fastPnL(DIRECTION_BUY, 1.1000, 1.0950, 1, cs, 0) < 0)
  assert.ok(fastPnL(DIRECTION_SELL, 1.1000, 1.0950, 1, cs, 0) > 0)
  assert.ok(fastPnL(DIRECTION_SELL, 1.1000, 1.1050, 1, cs, 0) < 0)
})

test('commission is subtracted, not added, for both directions', () => {
  const cs = contractSizeFor('EURUSD')
  const withoutCommission = fastPnL(DIRECTION_BUY, 1.1000, 1.1050, 1, cs, 0)
  const withCommission = fastPnL(DIRECTION_BUY, 1.1000, 1.1050, 1, cs, 7)
  assert.equal(+(withoutCommission - withCommission).toFixed(6), 7)
})

test('contractSizeFor falls back to the standard FX lot for an unknown instrument', () => {
  assert.equal(contractSizeFor('NOT_A_REAL_SYMBOL'), 100000)
})

test('closePriceFor uses bid for BUY and ask for SELL', () => {
  const price = { bid: 1.10000, ask: 1.10020 }
  assert.equal(closePriceFor(DIRECTION_BUY, price), 1.10000)
  assert.equal(closePriceFor(DIRECTION_SELL, price), 1.10020)
})

test('SL/TP predicates match the interval engine comparisons', () => {
  // BUY: stop below, target above.
  assert.equal(isSLTriggered(DIRECTION_BUY, 1.0950, 1.0950), true, 'BUY stop triggers at the level')
  assert.equal(isSLTriggered(DIRECTION_BUY, 1.0950, 1.0949), true)
  assert.equal(isSLTriggered(DIRECTION_BUY, 1.0950, 1.0951), false)
  assert.equal(isTPTriggered(DIRECTION_BUY, 1.1050, 1.1050), true, 'BUY target triggers at the level')
  assert.equal(isTPTriggered(DIRECTION_BUY, 1.1050, 1.1049), false)

  // SELL: mirrored.
  assert.equal(isSLTriggered(DIRECTION_SELL, 1.1050, 1.1050), true)
  assert.equal(isSLTriggered(DIRECTION_SELL, 1.1050, 1.1049), false)
  assert.equal(isTPTriggered(DIRECTION_SELL, 1.0950, 1.0950), true)
  assert.equal(isTPTriggered(DIRECTION_SELL, 1.0950, 1.0951), false)
})

test('a null SL or TP never triggers', () => {
  assert.equal(isSLTriggered(DIRECTION_BUY, null, 0.0001), false)
  assert.equal(isTPTriggered(DIRECTION_SELL, null, 999999), false)
})

test('pending-order triggers match the interval engine comparisons', () => {
  const price = { bid: 1.10000, ask: 1.10020 }

  // Limits fill when price comes back to the level; stops when it runs through.
  assert.equal(isPendingTriggered('buy_limit', 1.10030, price), true, 'ask at or below the limit')
  assert.equal(isPendingTriggered('buy_limit', 1.10010, price), false)
  assert.equal(isPendingTriggered('buy_stop', 1.10010, price), true, 'ask at or above the stop')
  assert.equal(isPendingTriggered('buy_stop', 1.10030, price), false)
  assert.equal(isPendingTriggered('sell_limit', 1.09990, price), true, 'bid at or above the limit')
  assert.equal(isPendingTriggered('sell_limit', 1.10010, price), false)
  assert.equal(isPendingTriggered('sell_stop', 1.10010, price), true, 'bid at or below the stop')
  assert.equal(isPendingTriggered('sell_stop', 1.09990, price), false)

  assert.equal(isPendingTriggered('market', 1.1, price), false, 'unknown order type never triggers')
  assert.equal(isPendingTriggered('buy_limit', null, price), false)
})
