import assert from 'node:assert/strict'
import test from 'node:test'
import router = require('../routes/adminTradingEconomics')

void test('tiered trading-economics maps preserve valid numeric and numeric-string values', () => {
  const value = {
    challenge: { EURUSD: '4.5', '*': 3 },
    funded: { XAUUSD: 0 },
    competition: {}
  }
  assert.deepEqual(router.__test__.validateTieredMap(value, 'commission_per_lot'), value)
})

void test('tiered trading-economics maps reject unknown tiers and instruments', () => {
  assert.throws(
    () => router.__test__.validateTieredMap({ retail: { EURUSD: 1 } }, 'commission'),
    /unknown tier "retail"/
  )
  assert.throws(
    () => router.__test__.validateTieredMap({ funded: { INVALID: 1 } }, 'commission'),
    /unknown instrument "INVALID"/
  )
})

void test('tiered trading-economics maps reject malformed and negative values', () => {
  assert.throws(
    () => router.__test__.validateTieredMap([], 'slippage'),
    /must be an object keyed by tier/
  )
  assert.throws(
    () => router.__test__.validateTieredMap({ funded: { EURUSD: -0.1 } }, 'slippage'),
    /must be a non-negative number/
  )
  assert.throws(
    () => router.__test__.validateTieredMap({ funded: { EURUSD: 'bad' } }, 'slippage'),
    /must be a non-negative number/
  )
})
