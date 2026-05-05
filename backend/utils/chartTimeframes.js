const CHART_TIMEFRAMES = Object.freeze({
  '1M': 1,
  '3M': 3,
  '5M': 5,
  '15M': 15,
  '30M': 30,
  '1H': 60,
  '2H': 120,
  '4H': 240
})

const VALID_CHART_TIMEFRAME_LABELS = Object.freeze(Object.keys(CHART_TIMEFRAMES))

function getChartTimeframeMinutes(label) {
  return CHART_TIMEFRAMES[String(label || '').toUpperCase()] || null
}

module.exports = {
  CHART_TIMEFRAMES,
  VALID_CHART_TIMEFRAME_LABELS,
  getChartTimeframeMinutes
}
