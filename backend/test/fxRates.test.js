const test = require('node:test')
const assert = require('node:assert/strict')

const priceCache = require('../utils/priceCache')
const {
  FxRateUnavailableError,
  getRateSnapshot,
  getUsdRate,
  getUsdRateForInstrument,
  isUsdQuoted
} = require('../utils/fxRates')
const { calculatePnL } = require('../utils/pnlCalculator')
const { fastPnL, directionSign, contractSizeFor, DIRECTION_BUY } = require('../utils/fastPnL')

// Representative rates. USDJPY at 150 is the case from the audit: it is where
// the missing conversion cost ~150x.
const FEED = {
  USDJPY: { bid: 150.00, ask: 150.02 },
  USDCHF: { bid: 0.9000, ask: 0.9001 },
  USDCAD: { bid: 1.3500, ask: 1.3501 },
  GBPUSD: { bid: 1.2700, ask: 1.2701 },
  AUDUSD: { bid: 0.6500, ask: 0.6501 },
  NZDUSD: { bid: 0.6000, ask: 0.6001 },
  EURUSD: { bid: 1.1000, ask: 1.1001 }
}

function withFeed(fn) {
  priceCache.__setPricesForTest(FEED)
  try { return fn() } finally { priceCache.__reset() }
}

function withFxEnabled(fn) {
  const previous = process.env.FX_CONVERSION_ENABLED
  process.env.FX_CONVERSION_ENABLED = 'true'
  try { return withFeed(fn) } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate derivation
// ─────────────────────────────────────────────────────────────────────────────

test('USD is the identity rate and never touches the price cache', () => {
  assert.equal(getUsdRate('USD'), 1)
  assert.equal(getUsdRate('usd'), 1)
})

test('USD/QUOTE pairs invert, QUOTE/USD pairs do not', () => {
  withFeed(() => {
    // USDJPY = 150 means 1 JPY is worth 1/150 USD.
    assert.equal(getUsdRate('JPY'), 1 / 150)
    assert.equal(getUsdRate('CHF'), 1 / 0.9)
    assert.equal(getUsdRate('CAD'), 1 / 1.35)
    // GBPUSD = 1.27 means 1 GBP is worth 1.27 USD outright.
    assert.equal(getUsdRate('GBP'), 1.27)
    assert.equal(getUsdRate('AUD'), 0.65)
    assert.equal(getUsdRate('NZD'), 0.6)
    assert.equal(getUsdRate('EUR'), 1.1)
  })
})

test('rates read the bid, so a tenant ask markup cannot skew them', () => {
  // applyTenantMarkupToPriceRow (priceFeed.js) adds the tenant's spread markup
  // to the ASK only. A mid-price rate would fold that markup into a conversion
  // rate that should be identical for every tenant.
  priceCache.__setPricesForTest({ GBPUSD: { bid: 1.27, ask: 1.99 } })
  try {
    assert.equal(getUsdRate('GBP'), 1.27)
  } finally {
    priceCache.__reset()
  }
})

test('HKD uses the configured peg, not the feed', () => {
  const previous = process.env.HKD_USD_PEGGED_RATE
  try {
    delete process.env.HKD_USD_PEGGED_RATE
    assert.equal(getUsdRate('HKD'), 1 / 7.8, 'defaults to the 7.80 peg')

    process.env.HKD_USD_PEGGED_RATE = '7.75'
    assert.equal(getUsdRate('HKD'), 1 / 7.75)

    process.env.HKD_USD_PEGGED_RATE = 'not-a-number'
    assert.throws(() => getUsdRate('HKD'), FxRateUnavailableError)
  } finally {
    if (previous === undefined) delete process.env.HKD_USD_PEGGED_RATE
    else process.env.HKD_USD_PEGGED_RATE = previous
  }
})

test('fails closed rather than defaulting to 1', () => {
  // Defaulting to 1 on a missing rate IS the bug this module exists to fix.
  priceCache.__reset()
  assert.throws(() => getUsdRate('JPY'), FxRateUnavailableError)
  assert.throws(() => getUsdRate('ZWL'), FxRateUnavailableError)
  assert.throws(() => getUsdRate(''), FxRateUnavailableError)

  priceCache.__setPricesForTest({ USDJPY: { bid: 0, ask: 0 } })
  try {
    assert.throws(() => getUsdRate('JPY'), FxRateUnavailableError)
  } finally {
    priceCache.__reset()
  }
})

test('every instrument resolves to a rate when the feed is up', () => {
  withFxEnabled(() => {
    const previous = process.env.HKD_USD_PEGGED_RATE
    delete process.env.HKD_USD_PEGGED_RATE
    try {
      for (const symbol of ['EURUSD', 'USDJPY', 'JP225', 'HK50', 'UK100', 'DE40', 'AUS200', 'XAUUSD', 'US500']) {
        const rate = getUsdRateForInstrument(symbol)
        assert.ok(Number.isFinite(rate) && rate > 0, `${symbol} resolved to ${rate}`)
      }
    } finally {
      if (previous !== undefined) process.env.HKD_USD_PEGGED_RATE = previous
    }
  })
})

test('isUsdQuoted matches the catalogue', () => {
  assert.equal(isUsdQuoted('EURUSD'), true)
  assert.equal(isUsdQuoted('XAUUSD'), true)
  assert.equal(isUsdQuoted('US500'), true)
  assert.equal(isUsdQuoted('USDJPY'), false)
  assert.equal(isUsdQuoted('JP225'), false)
})

test('getRateSnapshot reports availability per currency without throwing', () => {
  withFeed(() => {
    const snapshot = getRateSnapshot()
    assert.equal(snapshot.USD.available, true)
    assert.equal(snapshot.JPY.available, true)
    assert.ok(snapshot.JPY.rate > 0)
  })
  priceCache.__reset()
  const cold = getRateSnapshot()
  assert.equal(cold.JPY.available, false)
  assert.ok(cold.JPY.reason.includes('USDJPY'))
  assert.equal(cold.USD.available, true, 'USD never depends on the feed')
})

// ─────────────────────────────────────────────────────────────────────────────
// Grandfathering
// ─────────────────────────────────────────────────────────────────────────────

test('with FX conversion off, every instrument values at rate 1', () => {
  const previous = process.env.FX_CONVERSION_ENABLED
  delete process.env.FX_CONVERSION_ENABLED
  try {
    withFeed(() => {
      // Reproduces the pre-fix behaviour exactly, so positions opened under the
      // old maths are not revalued underneath the trader by a deploy.
      assert.equal(getUsdRateForInstrument('USDJPY'), 1)
      assert.equal(getUsdRateForInstrument('JP225'), 1)
      assert.equal(getUsdRateForInstrument('EURUSD'), 1)
    })
  } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// The regression this whole audit started from
// ─────────────────────────────────────────────────────────────────────────────

test('1 lot USDJPY moving 10 pips is worth ~$67, not $10,000', () => {
  withFxEnabled(() => {
    // Buy 1 lot at 150.00, close at 150.10 — a 10-pip move.
    const pnl = calculatePnL('buy', 150.00, 150.10, 1, 'USDJPY', 0)

    // 0.10 * 1 * 100,000 = 10,000 JPY. At 150 JPY/USD that is ~$66.67.
    assert.ok(Math.abs(pnl - 66.67) < 0.01, `expected ~$66.67, got $${pnl}`)

    // The bug: this used to return 10,000, which alone passes the 10% profit
    // target on a $100,000 evaluation account.
    assert.ok(pnl < 100, 'must not book the yen figure as dollars')
  })
})

test('a USD-quoted instrument is unchanged by the fix', () => {
  withFxEnabled(() => {
    // 0.0050 * 1 * 100,000 = $500, and EURUSD is already USD-quoted.
    assert.equal(calculatePnL('buy', 1.1000, 1.1050, 1, 'EURUSD', 0), 500)
  })
})

test('commission is in USD and is not scaled by the rate', () => {
  withFxEnabled(() => {
    const gross = calculatePnL('buy', 150.00, 150.10, 1, 'USDJPY', 0)
    const net = calculatePnL('buy', 150.00, 150.10, 1, 'USDJPY', 3)
    // A $3 commission must cost exactly $3, not $3 * (1/150) or $3 * 150.
    assert.ok(Math.abs((gross - net) - 3) < 0.001, `commission moved PnL by ${gross - net}`)
  })
})

test('an explicit usdRate overrides the live lookup', () => {
  const previous = process.env.FX_CONVERSION_ENABLED
  delete process.env.FX_CONVERSION_ENABLED
  try {
    // Works even with conversion disabled and no feed — this is the seam the
    // tests and any historical revaluation use.
    assert.equal(calculatePnL('buy', 150.00, 150.10, 1, 'USDJPY', 0, 1 / 150), 66.67)
  } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Parity: the float fast path must agree with the Decimal path per currency
// ─────────────────────────────────────────────────────────────────────────────

test('fastPnL and calculatePnL agree for every currency class', () => {
  withFxEnabled(() => {
    const cases = [
      ['EURUSD', 1.1000, 1.1050],   // USD
      ['USDJPY', 150.00, 150.40],   // JPY, inverted
      ['USDCHF', 0.9000, 0.9040],   // CHF, inverted
      ['USDCAD', 1.3500, 1.3560],   // CAD, inverted
      ['EURGBP', 0.8500, 0.8540],   // GBP, direct
      ['EURAUD', 1.6500, 1.6560],   // AUD, direct
      ['EURNZD', 1.8000, 1.8070],   // NZD, direct
      ['DE40',   18000, 18050],     // EUR, direct, contractSize 1
      ['JP225',  39000, 39100]      // JPY, inverted, contractSize 1
    ]

    for (const [instrument, open, close] of cases) {
      const lots = 1.5
      const commission = 4.5
      const rate = getUsdRateForInstrument(instrument)

      const decimal = calculatePnL('buy', open, close, lots, instrument, commission)
      const float = fastPnL(
        directionSign('buy'), open, close, lots, contractSizeFor(instrument), commission, rate
      )

      assert.ok(
        Math.abs(decimal - float) < 0.01,
        `${instrument}: Decimal ${decimal} vs float ${float}`
      )
    }
  })
})

test('fastPnL defaults to rate 1 so an un-migrated caller cannot silently convert', () => {
  const withRate = fastPnL(DIRECTION_BUY, 150.0, 150.1, 1, 100000, 0, 1 / 150)
  const withoutRate = fastPnL(DIRECTION_BUY, 150.0, 150.1, 1, 100000, 0)
  assert.ok(Math.abs(withRate - 66.666) < 0.01)
  // Tolerance, not equality: fastPnL returns unrounded native float by design
  // (the "float detects, Decimal confirms" contract in utils/fastPnL.js), so
  // this lands on 9999.999999999432 rather than exactly 10000.
  assert.ok(Math.abs(withoutRate - 10000) < 0.01, 'omitting the rate is the old, unconverted result')
})
