const test = require('node:test')
const assert = require('node:assert/strict')

const {
  toFiniteNumber,
  computeTradeDurationMinutes,
  percentile,
  calculateCoefficientOfVariation,
  toScoreGrade,
  buildRiskConsistencyScore,
  buildPerformanceBreakdown
} = require('../services/tradeAnalytics')

// These builders drive GET /api/trades/analytics. They lived inside
// routes/trades.js and could only be exercised through an authenticated HTTP
// request; extracting them to services/tradeAnalytics.js made them reachable
// directly, so the scoring maths is pinned here.

test('toFiniteNumber falls back for values that are not finite', () => {
  assert.equal(toFiniteNumber('2.5'), 2.5)
  assert.equal(toFiniteNumber(null), 0)
  assert.equal(toFiniteNumber('abc'), 0)
  assert.equal(toFiniteNumber(undefined, 7), 7)
  assert.ok(Number.isNaN(toFiniteNumber('nope', NaN)))
})

test('computeTradeDurationMinutes returns null unless both timestamps are usable', () => {
  assert.equal(
    computeTradeDurationMinutes({
      open_time: '2026-08-14T10:00:00Z',
      close_time: '2026-08-14T11:30:00Z'
    }),
    90
  )
  assert.equal(computeTradeDurationMinutes({ open_time: '2026-08-14T10:00:00Z' }), null)
  assert.equal(computeTradeDurationMinutes({}), null)
  // A close before the open is data corruption, not a negative duration.
  assert.equal(
    computeTradeDurationMinutes({
      open_time: '2026-08-14T11:00:00Z',
      close_time: '2026-08-14T10:00:00Z'
    }),
    null
  )
})

test('percentile clamps to the bounds of the sample', () => {
  const sorted = [1, 2, 3, 4, 5]
  assert.equal(percentile(sorted, 0), 1)
  assert.equal(percentile(sorted, 0.5), 3)
  assert.equal(percentile(sorted, 1), 5)
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile(null, 0.5), null)
})

test('calculateCoefficientOfVariation is zero when there is nothing to vary', () => {
  assert.equal(calculateCoefficientOfVariation([5, 5, 5, 5]), 0)
  assert.equal(calculateCoefficientOfVariation([4]), 0, 'a single sample has no spread')
  assert.equal(calculateCoefficientOfVariation([]), 0)
  // Mean of zero would divide by zero; guarded to 0 instead.
  assert.equal(calculateCoefficientOfVariation([-2, 2]), 0)
  assert.ok(calculateCoefficientOfVariation([1, 10]) > 0.5)
})

test('toScoreGrade maps each score band to its letter', () => {
  assert.equal(toScoreGrade(90), 'A')
  assert.equal(toScoreGrade(85), 'A', 'band edges are inclusive')
  assert.equal(toScoreGrade(70), 'B')
  assert.equal(toScoreGrade(55), 'C')
  assert.equal(toScoreGrade(40), 'D')
  assert.equal(toScoreGrade(0), 'E')
})

test('buildRiskConsistencyScore rewards uniform sizing with stops set', () => {
  const disciplined = Array.from({ length: 5 }, () => ({
    instrument: 'EURUSD',
    lot_size: 1,
    open_price: 1.1,
    stop_loss: 1.09
  }))

  const result = buildRiskConsistencyScore(disciplined)

  assert.equal(result.metrics.stop_loss_usage_pct, 100)
  assert.equal(result.metrics.lot_size_cv, 0)
  assert.equal(result.metrics.planned_risk_cv, 0)
  assert.equal(result.score, 100)
  assert.equal(result.grade, 'A')
})

test('buildRiskConsistencyScore penalises erratic sizing and missing stops', () => {
  const erratic = [
    { instrument: 'EURUSD', lot_size: 0.1, open_price: 1.1, stop_loss: 1.099 },
    { instrument: 'EURUSD', lot_size: 5, open_price: 1.1, stop_loss: 1.05 },
    { instrument: 'EURUSD', lot_size: 0.5, open_price: 1.1 }, // no stop loss
    { instrument: 'EURUSD', lot_size: 12, open_price: 1.1 }   // no stop loss
  ]

  const result = buildRiskConsistencyScore(erratic)

  assert.equal(result.metrics.stop_loss_usage_pct, 50)
  assert.ok(result.metrics.lot_size_cv > 0, 'lot sizes vary')
  assert.ok(result.score < 100)
  assert.ok(result.components.stop_loss_usage < 100)
})

test('buildRiskConsistencyScore handles an empty sample without dividing by zero', () => {
  const result = buildRiskConsistencyScore([])
  assert.equal(result.metrics.stop_loss_usage_pct, 0)
  assert.equal(result.components.stop_loss_usage, 0)
  assert.ok(Number.isFinite(result.score))
})

test('buildPerformanceBreakdown aggregates wins, losses and P&L per bucket', () => {
  const trades = [
    { instrument: 'EURUSD', demo_pnl: 100, open_time: '2026-08-14T10:00:00Z', close_time: '2026-08-14T10:30:00Z' },
    { instrument: 'EURUSD', demo_pnl: -40, open_time: '2026-08-14T11:00:00Z', close_time: '2026-08-14T12:30:00Z' },
    { instrument: 'XAUUSD', demo_pnl: 250 }
  ]

  const rows = buildPerformanceBreakdown(trades, (trade) => ({ key: trade.instrument, label: trade.instrument }))
  const byKey = Object.fromEntries(rows.map((row) => [row.key, row]))

  assert.equal(byKey.EURUSD.trades, 2)
  assert.equal(byKey.EURUSD.wins, 1)
  assert.equal(byKey.EURUSD.losses, 1)
  assert.equal(byKey.EURUSD.total_pnl, 60)
  assert.equal(byKey.EURUSD.avg_pnl, 30)
  assert.equal(byKey.EURUSD.win_rate, 50)
  assert.equal(byKey.EURUSD.avg_hold_mins, 60, '30 and 90 minutes average to 60')

  assert.equal(byKey.XAUUSD.trades, 1)
  assert.equal(byKey.XAUUSD.total_pnl, 250)
  assert.equal(byKey.XAUUSD.avg_hold_mins, null, 'no timestamps means no hold-time sample')

  // Sorted by total_pnl descending once the order key ties.
  assert.equal(rows[0].key, 'XAUUSD')
})

test('buildPerformanceBreakdown buckets unlabelled trades under "unknown"', () => {
  const rows = buildPerformanceBreakdown([{ demo_pnl: 10 }], () => null)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, 'unknown')
  assert.equal(rows[0].label, 'Unknown')
})
