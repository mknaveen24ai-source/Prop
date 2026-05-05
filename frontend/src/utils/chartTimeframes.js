export const CHART_TIMEFRAMES = Object.freeze([
  { label: '1M', minutes: 1 },
  { label: '3M', minutes: 3 },
  { label: '5M', minutes: 5 },
  { label: '15M', minutes: 15 },
  { label: '30M', minutes: 30 },
  { label: '1H', minutes: 60 },
  { label: '2H', minutes: 120 },
  { label: '4H', minutes: 240 }
])

export const DEFAULT_CHART_TIMEFRAME = '5M'

export function getChartTimeframeMinutes(label) {
  const match = CHART_TIMEFRAMES.find((timeframe) => timeframe.label === label)
  return match ? match.minutes : null
}
