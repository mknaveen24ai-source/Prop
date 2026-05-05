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
  'NZDCHF'
]

const COMMODITY_INSTRUMENTS = ['XAUUSD', 'XAGUSD']
const INDEX_INSTRUMENTS = ['US30', 'NAS100']

function splitForexSymbol(symbol) {
  return [symbol.slice(0, 3), symbol.slice(3)]
}

function buildForexDefinition(symbol) {
  const [, quote] = splitForexSymbol(symbol)
  const isJpy = quote === 'JPY'

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
    wideSpreadThreshold: 4.5,
    quickMoveThreshold: 20,
    marketDataSymbol: `${symbol.slice(0, 3)}/${quote}`,
    defaultSpread: isJpy ? 0.012 : 0.00012
  }
}

const INSTRUMENT_DEFINITIONS = [
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
    wideSpreadThreshold: 80,
    quickMoveThreshold: 120,
    marketDataSymbol: 'XAU/USD',
    defaultSpread: 0.3
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
    wideSpreadThreshold: 80,
    quickMoveThreshold: 120,
    marketDataSymbol: 'XAG/USD',
    defaultSpread: 0.03
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
    wideSpreadThreshold: 50,
    quickMoveThreshold: 50,
    marketDataSymbol: 'DJI',
    defaultSpread: 2
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
    wideSpreadThreshold: 50,
    quickMoveThreshold: 50,
    marketDataSymbol: 'NDX',
    defaultSpread: 1.5
  }
]

const INSTRUMENT_CATALOG = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = Object.freeze({ ...instrument })
    return acc
  }, {})
)

const INSTRUMENTS = Object.freeze(INSTRUMENT_DEFINITIONS.map((instrument) => instrument.symbol))

const CONTRACT_SIZES = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.contractSize
    return acc
  }, {})
)

const LEVERAGE = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.leverage
    return acc
  }, {})
)

const TWELVE_DATA_SYMBOLS = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.marketDataSymbol
    return acc
  }, {})
)

const DEFAULT_SPREADS = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.defaultSpread
    return acc
  }, {})
)

function getInstrumentConfig(symbol) {
  return INSTRUMENT_CATALOG[String(symbol || '').toUpperCase()] || null
}

function getPriceDecimals(symbol) {
  return getInstrumentConfig(symbol)?.decimals ?? 5
}

function getInputStep(symbol) {
  return getInstrumentConfig(symbol)?.step ?? 0.00001
}

function getInputStepString(symbol) {
  const decimals = getPriceDecimals(symbol)
  return getInputStep(symbol).toFixed(decimals)
}

function getPipSize(symbol) {
  return getInstrumentConfig(symbol)?.pipSize ?? 0.0001
}

function getMinDistance(symbol) {
  return getInstrumentConfig(symbol)?.minDistance ?? getPipSize(symbol)
}

function getPointMultiplier(symbol) {
  return getInstrumentConfig(symbol)?.pointMultiplier ?? 100000
}

function getSpreadPoints(spreadAbs, symbol) {
  return spreadAbs * getPointMultiplier(symbol)
}

function getWideSpreadThreshold(symbol) {
  return getInstrumentConfig(symbol)?.wideSpreadThreshold ?? 4.5
}

function getQuickMoveThreshold(symbol) {
  return getInstrumentConfig(symbol)?.quickMoveThreshold ?? 20
}

function roundPrice(value, symbol) {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  if (!Number.isFinite(parsed)) return parsed
  return parseFloat(parsed.toFixed(getPriceDecimals(symbol)))
}

function formatPrice(value, symbol) {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  if (!Number.isFinite(parsed)) return ''
  return parsed.toFixed(getPriceDecimals(symbol))
}

module.exports = {
  INSTRUMENT_DEFINITIONS,
  INSTRUMENT_CATALOG,
  INSTRUMENTS,
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  INDEX_INSTRUMENTS,
  CONTRACT_SIZES,
  LEVERAGE,
  TWELVE_DATA_SYMBOLS,
  DEFAULT_SPREADS,
  getInstrumentConfig,
  getPriceDecimals,
  getInputStep,
  getInputStepString,
  getPipSize,
  getMinDistance,
  getPointMultiplier,
  getSpreadPoints,
  getWideSpreadThreshold,
  getQuickMoveThreshold,
  roundPrice,
  formatPrice
}
