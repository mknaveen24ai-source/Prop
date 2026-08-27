import assert from 'node:assert/strict'
import test from 'node:test'
import modifyRouter = require('../routes/trades/modify')

void test('database mutation rows are converted to JSON-safe public records', () => {
  const mapped = modifyRouter.__test__.mapMutationRecord({
    id: 'trade-1',
    opened_at: new Date('2026-08-27T00:00:00.000Z'),
    tags: ['swing', { risk: 'low' }],
    optional_value: undefined,
    invalid_number: Number.NaN
  })
  assert.deepEqual(mapped, {
    id: 'trade-1',
    opened_at: '2026-08-27T00:00:00.000Z',
    tags: ['swing', { risk: 'low' }],
    invalid_number: null
  })
})

void test('level validation preserves market-side and minimum-distance errors', () => {
  const validate = modifyRouter.__test__.validateLevel
  assert.match(validate(1.101, 1.1, 0.0001, true, 'Stop loss') || '', /below/)
  assert.match(validate(1.09995, 1.1, 0.0001, true, 'Stop loss') || '', /at least/)
  assert.equal(validate(1.099, 1.1, 0.0001, true, 'Stop loss'), null)
})

void test('both modify routes retain auth, limiter, and named handler order', () => {
  const stack = (modifyRouter as unknown as {
    stack: Array<{
      route?: { path: string; stack: Array<{ name: string }> }
    }>
  }).stack
  const expected = new Map([
    ['/modify-pending', 'modifyPendingHandler'],
    ['/modify', 'modifyTradeHandler']
  ])
  for (const layer of stack) {
    const path = layer.route?.path
    if (!path || !expected.has(path)) continue
    assert.deepEqual(layer.route?.stack.map((handler) => handler.name), [
      'authenticateToken',
      '<anonymous>',
      expected.get(path)
    ])
    expected.delete(path)
  }
  assert.deepEqual([...expected.keys()], [])
})
