import assert from 'node:assert/strict'
import test from 'node:test'
import traderIntelligenceRouter = require('../routes/admin/traderIntelligence')

void test('trader picker query normalization preserves search truncation and legacy limit fallback', () => {
  const normalize = traderIntelligenceRouter.__test__.normalizeTraderListQuery
  assert.deepEqual(normalize({ q: 'alice', limit: '25' }), { search: 'alice', limit: 25 })
  assert.deepEqual(normalize({ q: 'x'.repeat(120), limit: 'invalid' }), {
    search: 'x'.repeat(100),
    limit: 50
  })
  assert.deepEqual(normalize({ q: ['alice'], limit: ['10'] }), { search: '', limit: 50 })
})

void test('trader intelligence routes retain exact authentication and super-admin guards', () => {
  const stack = (traderIntelligenceRouter as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ name: string }> } }>
  }).stack
  const expected = new Map([
    ['/trader-intelligence/risk', ['authenticateAdmin', 'requireSuperAdmin', 'riskIntelligenceHandler']],
    ['/trader-intelligence/traders', ['authenticateAdmin', 'traderListHandler']],
    ['/trader-intelligence/trader/:userId', ['authenticateAdmin', 'traderDetailHandler']]
  ])
  for (const layer of stack) {
    const path = layer.route?.path
    if (!path || !expected.has(path)) continue
    assert.deepEqual(layer.route?.stack.map((handler) => handler.name), expected.get(path))
    expected.delete(path)
  }
  assert.deepEqual([...expected.keys()], [])
})
