const test = require('node:test')
const assert = require('node:assert/strict')

const {
  VALID_CHART_TIMEFRAME_LABELS,
  getChartTimeframeMinutes
} = require('../utils/chartTimeframes')

test('chart timeframe catalog exposes the requested terminal intervals', () => {
  assert.deepEqual(VALID_CHART_TIMEFRAME_LABELS, ['1M', '3M', '5M', '15M', '30M', '1H', '2H', '4H'])
})

test('chart timeframe lookup resolves minute counts for short and higher intervals', () => {
  assert.equal(getChartTimeframeMinutes('1M'), 1)
  assert.equal(getChartTimeframeMinutes('3M'), 3)
  assert.equal(getChartTimeframeMinutes('30M'), 30)
  assert.equal(getChartTimeframeMinutes('2H'), 120)
  assert.equal(getChartTimeframeMinutes('4H'), 240)
  assert.equal(getChartTimeframeMinutes('bogus'), null)
})
