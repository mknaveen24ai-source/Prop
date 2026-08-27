type ChartTimeframeLabel = '1M' | '3M' | '5M' | '15M' | '30M' | '1H' | '2H' | '4H'

const CHART_TIMEFRAMES: Readonly<Record<ChartTimeframeLabel, number>> = Object.freeze({
  '1M': 1,
  '3M': 3,
  '5M': 5,
  '15M': 15,
  '30M': 30,
  '1H': 60,
  '2H': 120,
  '4H': 240
})

const VALID_CHART_TIMEFRAME_LABELS: readonly ChartTimeframeLabel[] = Object.freeze(
  Object.keys(CHART_TIMEFRAMES) as ChartTimeframeLabel[]
)

function isChartTimeframeLabel(value: string): value is ChartTimeframeLabel {
  return Object.prototype.hasOwnProperty.call(CHART_TIMEFRAMES, value)
}

function getChartTimeframeMinutes(label: unknown): number | null {
  const normalized = String(label || '').toUpperCase()
  return isChartTimeframeLabel(normalized) ? CHART_TIMEFRAMES[normalized] : null
}

const chartTimeframes = {
  CHART_TIMEFRAMES,
  VALID_CHART_TIMEFRAME_LABELS,
  getChartTimeframeMinutes
}

export = chartTimeframes
