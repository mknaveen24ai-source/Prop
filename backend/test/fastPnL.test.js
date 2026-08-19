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

// Rates are passed EXPLICITLY to both sides rather than resolved from the feed.
//
// Two reasons, and the second is the point of this file. First, rates live in
// the server's in-process price cache, so under FX_CONVERSION_ENABLED=true
// calculatePnL throws FxRateUnavailableError in a bare test process — correct
// fail-closed behaviour that would otherwise just break the suite.
//
// Second and more important: leaving the rate implicit meant parity was only
// ever asserted at rate 1. That is exactly the blind spot utils/fastPnL.js warns
// about — "a confirm step only catches what the two implementations disagree
// about" — and it is how C-01 stayed invisible, because BOTH functions shared
// the same wrong assumption. Asserting agreement only on the unconverted path
// leaves the converted path, which is now the production path for 31 of 45
// instruments, untested on both sides at once.
const RATES_UNDER_TEST = [
  1,          // USD-quoted: the common case
  1 / 158.47, // JPY: the largest divergence, and the one C-01 got wrong
  1.1664,     // EUR
  0.7237,     // CAD
  1 / 7.8     // HKD, pegged
]

function agree(direction, openPrice, closePrice, lots, instrument, commission, usdRate = 1) {
  const precise = calculatePnL(direction, openPrice, closePrice, lots, instrument, commission, usdRate)
  const fast = fastPnL(
    directionSign(direction),
    openPrice,
    closePrice,
    lots,
    contractSizeFor(instrument),
    commission,
    usdRate
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

test('fastPnL agrees with calculatePnL at every conversion rate, not just 1', () => {
  for (const instrument of INSTRUMENTS) {
    for (const direction of ['buy', 'sell']) {
      for (const usdRate of RATES_UNDER_TEST) {
        const { precise, fast, delta } = agree(direction, 1.10000, 1.10500, 0.5, instrument, 3.5, usdRate)
        assert.ok(
          delta < TOLERANCE,
          `${instrument} ${direction} @rate ${usdRate}: Decimal=${precise} float=${fast} delta=${delta}`
        )
      }
    }
  }
})

test('commission is subtracted after conversion on both paths', () => {
  // If either implementation scaled commission by the rate, the two would still
  // agree with each other while both being wrong. Pinning the absolute value is
  // what catches that: a $7 fee must cost $7 whatever the instrument settles in.
  const usdRate = 1 / 158.47
  const withFee = agree('buy', 150.0, 150.1, 1, 'USDJPY', 7, usdRate)
  const withoutFee = agree('buy', 150.0, 150.1, 1, 'USDJPY', 0, usdRate)

  assert.ok(Math.abs((withoutFee.precise - withFee.precise) - 7) < 0.01,
    `Decimal path: fee moved PnL by ${withoutFee.precise - withFee.precise}, expected 7`)
  assert.ok(Math.abs((withoutFee.fast - withFee.fast) - 7) < 0.01,
    `float path: fee moved PnL by ${withoutFee.fast - withFee.fast}, expected 7`)
})

test('a JPY position books roughly 1/158th of its quote-currency amount', () => {
  // The concrete C-01 regression, stated as a number rather than as parity.
  // 1 lot over 10 pips is 10,000 JPY; at ~158 JPY/USD that is ~$63, not $10,000.
  const usdRate = 1 / 158.47
  const { precise } = agree('buy', 150.0, 150.1, 1, 'USDJPY', 0, usdRate)
  assert.ok(precise > 55 && precise < 75, `expected roughly $63, got $${precise}`)
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
