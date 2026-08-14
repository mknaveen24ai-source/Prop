const FOREX_MAJORS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD'
]

const FOREX_MINORS = [
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

const FOREX_INSTRUMENTS = [...FOREX_MAJORS, ...FOREX_MINORS]
const COMMODITY_METALS = ['XAUUSD', 'XAGUSD', 'XPTUSD', 'XPDUSD']
const ENERGIES = ['XTIUSD', 'XBRUSD', 'XNGUSD']
const INDICES_SPOT = ['US30', 'USTEC', 'US500', 'UK100', 'AUS200', 'JP225', 'HK50']
const INDICES_MAJOR = ['DE40', 'FRA40', 'EUSTX50']

const COMMODITY_INSTRUMENTS = [...COMMODITY_METALS]
const INDEX_INSTRUMENTS = [...INDICES_SPOT, ...INDICES_MAJOR]

// Flat 1:100 leverage across every instrument (IC Markets demo default).
const LEVERAGE_FLAT = 100

function splitForexSymbol(symbol) {
  return [symbol.slice(0, 3), symbol.slice(3)]
}

function buildForexDefinition(symbol, subCategory) {
  const [base, quote] = splitForexSymbol(symbol)
  const isJpy = quote === 'JPY'

  return {
    symbol,
    group: 'forex',
    subCategory,
    contractSize: 100000,
    leverage: LEVERAGE_FLAT,
    decimals: isJpy ? 3 : 5,
    step: isJpy ? 0.001 : 0.00001,
    pipSize: isJpy ? 0.01 : 0.0001,
    minDistance: isJpy ? 0.01 : 0.0001,
    pointMultiplier: isJpy ? 1000 : 100000,
    wideSpreadThreshold: 4.5,
    quickMoveThreshold: 20,
    marketDataSymbol: `${base}/${quote}`,
    defaultSpread: isJpy ? 0.012 : 0.00012
  }
}

// NOTE: marketDataSymbol values below (Twelve Data feed convention) for the
// newly added metals/energies/indices are best-effort placeholders and need
// a manual spot-check, same caveat as the existing TradingView map on the
// frontend — this environment can't verify third-party symbol conventions live.
const INSTRUMENT_DEFINITIONS = [
  ...FOREX_MAJORS.map((symbol) => buildForexDefinition(symbol, 'major')),
  ...FOREX_MINORS.map((symbol) => buildForexDefinition(symbol, 'minor')),
  {
    symbol: 'XAUUSD',
    group: 'commodity',
    subCategory: 'metal',
    contractSize: 100,
    leverage: LEVERAGE_FLAT,
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
    subCategory: 'metal',
    contractSize: 5000,
    leverage: LEVERAGE_FLAT,
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
    symbol: 'XPTUSD',
    group: 'commodity',
    subCategory: 'metal',
    contractSize: 100,
    leverage: LEVERAGE_FLAT,
    decimals: 2,
    step: 0.01,
    pipSize: 0.01,
    minDistance: 0.5,
    pointMultiplier: 100,
    wideSpreadThreshold: 80,
    quickMoveThreshold: 120,
    marketDataSymbol: 'XPT/USD',
    defaultSpread: 0.5
  },
  {
    symbol: 'XPDUSD',
    group: 'commodity',
    subCategory: 'metal',
    contractSize: 100,
    leverage: LEVERAGE_FLAT,
    decimals: 2,
    step: 0.01,
    pipSize: 0.01,
    minDistance: 0.5,
    pointMultiplier: 100,
    wideSpreadThreshold: 80,
    quickMoveThreshold: 120,
    marketDataSymbol: 'XPD/USD',
    defaultSpread: 0.6
  },
  {
    symbol: 'XTIUSD',
    group: 'energy',
    subCategory: 'energy',
    contractSize: 1000,
    leverage: LEVERAGE_FLAT,
    decimals: 2,
    step: 0.01,
    pipSize: 0.01,
    minDistance: 0.05,
    pointMultiplier: 100,
    wideSpreadThreshold: 6,
    quickMoveThreshold: 25,
    marketDataSymbol: 'WTI/USD',
    defaultSpread: 0.04
  },
  {
    symbol: 'XBRUSD',
    group: 'energy',
    subCategory: 'energy',
    contractSize: 1000,
    leverage: LEVERAGE_FLAT,
    decimals: 2,
    step: 0.01,
    pipSize: 0.01,
    minDistance: 0.05,
    pointMultiplier: 100,
    wideSpreadThreshold: 6,
    quickMoveThreshold: 25,
    marketDataSymbol: 'BRENT/USD',
    defaultSpread: 0.04
  },
  {
    symbol: 'XNGUSD',
    group: 'energy',
    subCategory: 'energy',
    contractSize: 10000,
    leverage: LEVERAGE_FLAT,
    decimals: 3,
    step: 0.001,
    pipSize: 0.001,
    minDistance: 0.005,
    pointMultiplier: 1000,
    wideSpreadThreshold: 6,
    quickMoveThreshold: 25,
    marketDataSymbol: 'NATGAS/USD',
    defaultSpread: 0.005
  },
  {
    symbol: 'US30',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
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
    symbol: 'USTEC',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 50,
    quickMoveThreshold: 50,
    marketDataSymbol: 'NDX',
    defaultSpread: 1.5
  },
  {
    symbol: 'US500',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 25,
    marketDataSymbol: 'SPX',
    defaultSpread: 0.6
  },
  {
    symbol: 'UK100',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 25,
    marketDataSymbol: 'UKX',
    defaultSpread: 1
  },
  {
    symbol: 'AUS200',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 25,
    marketDataSymbol: 'AS51',
    defaultSpread: 2
  },
  {
    symbol: 'JP225',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 0,
    step: 1,
    pipSize: 1,
    minDistance: 5,
    pointMultiplier: 1,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 30,
    marketDataSymbol: 'NKY',
    defaultSpread: 8
  },
  {
    symbol: 'HK50',
    group: 'index',
    subCategory: 'spot',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 0,
    step: 1,
    pipSize: 1,
    minDistance: 5,
    pointMultiplier: 1,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 30,
    marketDataSymbol: 'HSI',
    defaultSpread: 8
  },
  {
    symbol: 'DE40',
    group: 'index',
    subCategory: 'major',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 30,
    marketDataSymbol: 'DE40',
    defaultSpread: 1.2
  },
  {
    symbol: 'FRA40',
    group: 'index',
    subCategory: 'major',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 25,
    marketDataSymbol: 'PX1',
    defaultSpread: 1
  },
  {
    symbol: 'EUSTX50',
    group: 'index',
    subCategory: 'major',
    contractSize: 1,
    leverage: LEVERAGE_FLAT,
    decimals: 1,
    step: 0.1,
    pipSize: 0.1,
    minDistance: 1,
    pointMultiplier: 10,
    wideSpreadThreshold: 20,
    quickMoveThreshold: 25,
    marketDataSymbol: 'SX5E',
    defaultSpread: 1
  }
]

const INSTRUMENT_CATALOG = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = Object.freeze({ ...instrument })
    return acc
  }, {})
)

const INSTRUMENTS = Object.freeze(INSTRUMENT_DEFINITIONS.map((instrument) => instrument.symbol))

const INSTRUMENT_GROUPS = Object.freeze({
  FOREX_MAJORS: Object.freeze([...FOREX_MAJORS]),
  FOREX_MINORS: Object.freeze([...FOREX_MINORS]),
  COMMODITY_METALS: Object.freeze([...COMMODITY_METALS]),
  ENERGIES: Object.freeze([...ENERGIES]),
  INDICES_SPOT: Object.freeze([...INDICES_SPOT]),
  INDICES_MAJOR: Object.freeze([...INDICES_MAJOR])
})

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
  FOREX_MAJORS,
  FOREX_MINORS,
  COMMODITY_METALS,
  ENERGIES,
  INDICES_SPOT,
  INDICES_MAJOR,
  INSTRUMENT_GROUPS,
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
