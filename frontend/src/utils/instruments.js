import { decimalToNumber, toDecimal } from './finance.js'

const FOREX_INSTRUMENTS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD',
  'EURGBP',
  'EURJPY',
  'GBPJPY',
  'AUDJPY',
  'CADJPY',
  'CHFJPY',
  'NZDJPY',
  'EURAUD',
  'EURCAD',
  'EURCHF',
  'EURNZD',
  'GBPAUD',
  'GBPCAD',
  'GBPCHF',
  'GBPNZD',
  'AUDCAD',
  'AUDCHF',
  'AUDNZD',
  'CADCHF',
  'NZDCAD',
  'NZDCHF',
]

const COMMODITY_INSTRUMENTS = ['XAUUSD', 'XAGUSD']
const INDEX_INSTRUMENTS = ['US30', 'NAS100']

function buildForexDefinition(symbol) {
  const isJpy = symbol.endsWith('JPY')

  return {
    symbol,
    group: 'forex',
    contractSize: 100000,
    leverage: 30,
    decimals: isJpy ? 3 : 5,
    step: isJpy ? 0.001 : 0.00001,
    pipSize: isJpy ? 0.01 : 0.0001,
    minDistance: isJpy ? 0.01 : 0.0001,
    pointMultiplier: isJpy ? 1000 : 100000,
  }
}

export const INSTRUMENT_DEFINITIONS = [
  ...FOREX_INSTRUMENTS.map(buildForexDefinition),
  {
    symbol: 'XAUUSD',
    group: 'commodity',
    contractSize: 100,
    leverage: 10,
    decimals: 2,
    step: 0.01,
    pipSize: 0.1,
    minDistance: 0.5,
    pointMultiplier: 100,
  },
  {
    symbol: 'XAGUSD',
    group: 'commodity',
    contractSize: 5000,
    leverage: 10,
    decimals: 2,
    step: 0.01,
    pipSize: 0.01,
    minDistance: 0.5,
    pointMultiplier: 100,
  },
  {
    symbol: 'US30',
    group: 'index',
    contractSize: 1,
    leverage: 10,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
  },
  {
    symbol: 'NAS100',
    group: 'index',
    contractSize: 1,
    leverage: 10,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
  },
]

export const INSTRUMENT_CATALOG = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = Object.freeze({ ...instrument })
    return acc
  }, {})
)

const PRIORITY_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'XAUUSD', 'XAGUSD', 'US30', 'NAS100']

export const SUPPORTED_INSTRUMENTS = Object.freeze([
  ...PRIORITY_INSTRUMENTS,
  ...INSTRUMENT_DEFINITIONS
    .map((instrument) => instrument.symbol)
    .filter((symbol) => !PRIORITY_INSTRUMENTS.includes(symbol)),
])
export const CONTRACT_SIZES = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.contractSize
    return acc
  }, {})
)
export const LEVERAGE = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.leverage
    return acc
  }, {})
)
export const INSTRUMENT_GROUPS = Object.freeze({
  FOREX: Object.freeze([...FOREX_INSTRUMENTS]),
  COMMODITIES: Object.freeze([...COMMODITY_INSTRUMENTS]),
  INDICES: Object.freeze([...INDEX_INSTRUMENTS]),
})

export const TRADABLE_INSTRUMENTS_SUMMARY = '28 forex pairs + XAUUSD, XAGUSD, US30, NAS100'

export function getAvailableInstrumentList(prices, fallback = []) {
  const livePrices = prices && typeof prices === 'object' ? prices : {}
  const availableSet = new Set(
    Object.entries(livePrices)
      .filter(([, value]) => {
        const bid = Number(value?.bid)
        const ask = Number(value?.ask)
        return Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0
      })
      .map(([symbol]) => String(symbol || '').toUpperCase())
      .filter((symbol) => SUPPORTED_INSTRUMENTS.includes(symbol))
  )

  if (availableSet.size === 0) {
    return [...fallback]
  }

  return SUPPORTED_INSTRUMENTS.filter((symbol) => availableSet.has(symbol))
}

export function getInstrumentConfig(symbol) {
  return INSTRUMENT_CATALOG[String(symbol || '').toUpperCase()] || null
}

export function getPriceDecimals(symbol) {
  return getInstrumentConfig(symbol)?.decimals ?? 5
}

export function getInputStep(symbol) {
  return getInstrumentConfig(symbol)?.step ?? 0.00001
}

export function getInputStepString(symbol) {
  const decimals = getPriceDecimals(symbol)
  return getInputStep(symbol).toFixed(decimals)
}

export function getPointMultiplier(symbol) {
  return getInstrumentConfig(symbol)?.pointMultiplier ?? 100000
}

export function getPipSize(symbol) {
  return getInstrumentConfig(symbol)?.pipSize ?? 0.0001
}

export function getMinDistance(symbol) {
  return getInstrumentConfig(symbol)?.minDistance ?? getPipSize(symbol)
}

export function formatPrice(value, symbol) {
  const decimalValue = toDecimal(value, null)
  if (decimalValue === null) return ''
  return decimalValue.toDecimalPlaces(getPriceDecimals(symbol)).toFixed(getPriceDecimals(symbol))
}

export function roundPrice(value, symbol) {
  return decimalToNumber(
    toDecimal(value).toDecimalPlaces(getPriceDecimals(symbol)),
    getPriceDecimals(symbol)
  )
}

export function calculatePnL(direction, openPrice, currentPrice, lots, instrument, commission = 0) {
  const contractSize = toDecimal(CONTRACT_SIZES[instrument] || 100000)
  const open = toDecimal(openPrice)
  const current = toDecimal(currentPrice)
  const quantity = toDecimal(lots)
  const fees = toDecimal(commission)
  const priceDiff = direction === 'buy'
    ? current.minus(open)
    : open.minus(current)
  return decimalToNumber(
    priceDiff.mul(quantity).mul(contractSize).minus(fees).toDecimalPlaces(2),
    2
  )
}

export function calculateMargin(instrument, lots) {
  const contractSize = toDecimal(CONTRACT_SIZES[instrument] || 100000)
  const leverage = toDecimal(LEVERAGE[instrument] || 30)
  return decimalToNumber(
    toDecimal(lots).mul(contractSize).div(leverage).toDecimalPlaces(2),
    2
  )
}

export function getSpreadPoints(spreadAbs, instrument) {
  return spreadAbs * getPointMultiplier(instrument)
}
