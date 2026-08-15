const test = require('node:test')
const assert = require('node:assert/strict')

const {
  INSTRUMENTS,
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  INDEX_INSTRUMENTS,
  getInstrumentConfig,
  getPriceDecimals,
  getInputStepString,
  getPipSize,
  INSTRUMENT_DEFINITIONS,
  USD_QUOTED_INSTRUMENTS,
  getTradableInstruments,
  isTradableInstrument,
} = require('../constants')

test('instrument catalog exposes the full 45-symbol rollout', () => {
  assert.equal(INSTRUMENTS.length, 45)
  assert.equal(new Set(INSTRUMENTS).size, 45)
  assert.equal(FOREX_INSTRUMENTS.length, 28)
  assert.deepEqual(COMMODITY_INSTRUMENTS, ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD'])
  assert.deepEqual(INDEX_INSTRUMENTS, ['US30', 'USTEC', 'US500', 'UK100', 'AUS200', 'JP225', 'HK50', 'DE40', 'FRA40', 'EUSTX50'])
})

test('JPY, commodity, and index metadata use the intended precision rules', () => {
  assert.equal(getPriceDecimals('EURUSD'), 5)
  assert.equal(getInputStepString('EURUSD'), '0.00001')
  assert.equal(getPipSize('EURUSD'), 0.0001)

  assert.equal(getPriceDecimals('USDJPY'), 3)
  assert.equal(getInputStepString('USDJPY'), '0.001')
  assert.equal(getPipSize('USDJPY'), 0.01)

  assert.equal(getPriceDecimals('XAUUSD'), 2)
  assert.equal(getInputStepString('XAUUSD'), '0.01')
  assert.equal(getPriceDecimals('US30'), 1)
  assert.equal(getInputStepString('US30'), '0.1')
})

test('catalog includes cross-pair and index configuration', () => {
  const eurCad = getInstrumentConfig('EURCAD')
  const gbpJpy = getInstrumentConfig('GBPJPY')
  const ustec = getInstrumentConfig('USTEC')

  assert.equal(eurCad?.group, 'forex')
  assert.equal(gbpJpy?.group, 'forex')
  assert.equal(gbpJpy?.decimals, 3)
  assert.equal(ustec?.group, 'index')
  assert.equal(ustec?.leverage, 100)
})

// ─────────────────────────────────────────────────────────────────────────────
// C-01 containment
// ─────────────────────────────────────────────────────────────────────────────
// calculatePnL() computes priceDiff * lots * contractSize and books it as USD.
// That product is denominated in the instrument's QUOTE currency, so it is only
// correct where the quote currency is USD — the JPY pairs and JP225 are out by
// roughly 150x. Until FX conversion lands, only USD-quoted instruments may be
// opened. These tests guard both halves of that: the restriction itself, and
// the fact that it must not shrink the catalogue the price feed subscribes to.

test('every instrument declares a quote currency', () => {
  for (const definition of INSTRUMENT_DEFINITIONS) {
    assert.ok(
      /^[A-Z]{3}$/.test(definition.quoteCurrency || ''),
      `${definition.symbol} has no valid quoteCurrency`
    )
  }
})

test('forex quote currency is the second half of the symbol', () => {
  for (const symbol of FOREX_INSTRUMENTS) {
    assert.equal(getInstrumentConfig(symbol).quoteCurrency, symbol.slice(3), symbol)
  }
})

test('non-forex quote currencies match where each contract actually settles', () => {
  const expected = {
    XAUUSD: 'USD', XAGUSD: 'USD', XPTUSD: 'USD', XPDUSD: 'USD',
    XTIUSD: 'USD', XBRUSD: 'USD', XNGUSD: 'USD',
    US30: 'USD', USTEC: 'USD', US500: 'USD',
    UK100: 'GBP', AUS200: 'AUD', JP225: 'JPY', HK50: 'HKD',
    DE40: 'EUR', FRA40: 'EUR', EUSTX50: 'EUR'
  }
  for (const [symbol, currency] of Object.entries(expected)) {
    assert.equal(getInstrumentConfig(symbol).quoteCurrency, currency, symbol)
  }
})

test('exactly 14 instruments are USD-quoted, and they are the safe ones', () => {
  assert.deepEqual([...USD_QUOTED_INSTRUMENTS], [
    'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD',
    'XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD',
    'XTIUSD', 'XBRUSD', 'XNGUSD',
    'US30', 'USTEC', 'US500'
  ])
  assert.equal(INSTRUMENTS.length - USD_QUOTED_INSTRUMENTS.length, 31)
})

test('with FX conversion off, only USD-quoted instruments may be opened', () => {
  const previous = process.env.FX_CONVERSION_ENABLED
  delete process.env.FX_CONVERSION_ENABLED
  try {
    assert.equal(getTradableInstruments().length, 14)
    // The instruments that motivated this containment.
    assert.equal(isTradableInstrument('USDJPY'), false)
    assert.equal(isTradableInstrument('JP225'), false)
    assert.equal(isTradableInstrument('HK50'), false)
    assert.equal(isTradableInstrument('EURGBP'), false)
    // The ones that were always arithmetically correct.
    assert.equal(isTradableInstrument('EURUSD'), true)
    assert.equal(isTradableInstrument('XAUUSD'), true)
    assert.equal(isTradableInstrument('US500'), true)
    // Case-insensitive, matching the sanitiser in routes/trades/open.js.
    assert.equal(isTradableInstrument('eurusd'), true)
  } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
  }
})

test('FX_CONVERSION_ENABLED=true restores the full catalogue', () => {
  const previous = process.env.FX_CONVERSION_ENABLED
  process.env.FX_CONVERSION_ENABLED = 'true'
  try {
    assert.equal(getTradableInstruments().length, 45)
    assert.equal(isTradableInstrument('USDJPY'), true)
  } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
  }
})

test('containment does not shrink the price-feed subscription list', () => {
  // priceFeed.js subscribes from INSTRUMENTS. If the containment filtered this
  // list, positions already open on a restricted instrument would have no price
  // to close against, and the USDJPY/USDCHF/USDCAD quotes needed as FX rate
  // sources would stop arriving.
  const previous = process.env.FX_CONVERSION_ENABLED
  delete process.env.FX_CONVERSION_ENABLED
  try {
    assert.equal(INSTRUMENTS.length, 45)
    for (const rateSource of ['USDJPY', 'USDCHF', 'USDCAD', 'EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD']) {
      assert.ok(INSTRUMENTS.includes(rateSource), `${rateSource} must stay subscribed`)
    }
  } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
  }
})
