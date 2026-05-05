const { describe, it } = require('node:test')
const assert = require('node:assert')

const { summarizeFeedSnapshot } = require('../utils/launchReadiness')

describe('Launch Readiness Feed Summary', () => {
  it('marks feed unhealthy when required launch instruments are missing', () => {
    const summary = summarizeFeedSnapshot({
      EURUSD: { age_ms: 1000, updated_at: new Date().toISOString() }
    }, {
      staleMs: 5000,
      requiredInstruments: ['EURUSD', 'XAUUSD']
    })

    assert.strictEqual(summary.status, 'unhealthy')
    assert.deepStrictEqual(summary.missing_launch_instruments, ['XAUUSD'])
    assert.strictEqual(summary.launch_ready, false)
  })

  it('marks feed degraded when only non-critical instruments are stale', () => {
    const now = new Date().toISOString()
    const summary = summarizeFeedSnapshot({
      EURUSD: { age_ms: 1000, updated_at: now },
      GBPUSD: { age_ms: 9000, updated_at: now }
    }, {
      staleMs: 5000,
      requiredInstruments: ['EURUSD']
    })

    assert.strictEqual(summary.status, 'degraded')
    assert.strictEqual(summary.healthy, false)
    assert.strictEqual(summary.launch_ready, false)
  })
})
