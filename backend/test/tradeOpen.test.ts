import assert from 'node:assert/strict'
import test from 'node:test'
import openRouter = require('../routes/trades/open')

void test('open-trade rows map to JSON-safe public records', () => {
  const mapped = openRouter.__test__.mapTradeMutationRecord({
    id: 'trade-1',
    open_price: '1.1002',
    open_time: new Date('2026-08-27T00:00:00.000Z'),
    metadata: { strategy: 'breakout' },
    omitted: undefined,
    invalid_number: Number.NaN
  })
  assert.deepEqual(mapped, {
    id: 'trade-1',
    open_price: '1.1002',
    open_time: '2026-08-27T00:00:00.000Z',
    metadata: { strategy: 'breakout' },
    invalid_number: null
  })
})

void test('positive-number normalization preserves valid legacy string and numeric inputs', () => {
  const normalize = openRouter.__test__.normalizePositiveNumber
  assert.equal(normalize('1.25'), 1.25)
  assert.equal(normalize(2), 2)
  assert.equal(normalize(''), null)
  assert.equal(normalize('-1'), null)
  assert.equal(normalize({ value: 1 }), null)
})

void test('open retains authentication, limiter, and named handler order', () => {
  const stack = (openRouter as unknown as {
    stack: Array<{
      route?: { path: string; stack: Array<{ name: string }> }
    }>
  }).stack
  const route = stack.find((layer) => layer.route?.path === '/open')
  assert.ok(route)
  assert.deepEqual(route.route?.stack.map((handler) => handler.name), [
    'authenticateToken',
    '<anonymous>',
    'openTradeHandler'
  ])
})
