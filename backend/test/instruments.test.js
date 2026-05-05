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
} = require('../constants')

test('instrument catalog exposes the full 32-symbol rollout', () => {
  assert.equal(INSTRUMENTS.length, 32)
  assert.equal(new Set(INSTRUMENTS).size, 32)
  assert.equal(FOREX_INSTRUMENTS.length, 28)
  assert.deepEqual(COMMODITY_INSTRUMENTS, ['XAUUSD', 'XAGUSD'])
  assert.deepEqual(INDEX_INSTRUMENTS, ['US30', 'NAS100'])
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
  const nas100 = getInstrumentConfig('NAS100')

  assert.equal(eurCad?.group, 'forex')
  assert.equal(gbpJpy?.group, 'forex')
  assert.equal(gbpJpy?.decimals, 3)
  assert.equal(nas100?.group, 'index')
  assert.equal(nas100?.leverage, 10)
})
