const test = require('node:test')
const assert = require('node:assert/strict')

const { buildViolationKey } = require('../services/violationEngine')

test('buildViolationKey normalizes casing and spacing', () => {
  const key = buildViolationKey([' Drawdown Breach ', 'ACC-1', 'User 7', '', 'XAUUSD'])
  assert.equal(key, 'drawdown_breach|acc-1|user_7||xauusd')
})

test('buildViolationKey is stable for missing values', () => {
  const key = buildViolationKey(['rapid_opposing_trades', null, undefined])
  assert.equal(key, 'rapid_opposing_trades||')
})
