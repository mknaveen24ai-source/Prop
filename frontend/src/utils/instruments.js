import { decimalToNumber, toDecimal } from './finance.js'

const FOREX_MAJORS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD',
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
  'NZDCHF',
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

function buildForexDefinition(symbol, subCategory) {
  const isJpy = symbol.endsWith('JPY')

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
  }
}

export const INSTRUMENT_DEFINITIONS = [
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
  },
]

export const INSTRUMENT_CATALOG = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = Object.freeze({ ...instrument })
    return acc
  }, {})
)

const PRIORITY_INSTRUMENTS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD',
  'XAUUSD', 'XAGUSD',
  'US30', 'USTEC', 'US500', 'DE40', 'UK100',
]

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
  FOREX_MAJORS: Object.freeze([...FOREX_MAJORS]),
  FOREX_MINORS: Object.freeze([...FOREX_MINORS]),
  COMMODITY_METALS: Object.freeze([...COMMODITY_METALS]),
  ENERGIES: Object.freeze([...ENERGIES]),
  INDICES_SPOT: Object.freeze([...INDICES_SPOT]),
  INDICES_MAJOR: Object.freeze([...INDICES_MAJOR]),
})

export const TRADABLE_INSTRUMENTS_SUMMARY = '28 forex pairs + 4 metals + 3 energies + 10 global indices'

// Maps this platform's instrument codes to TradingView's public widget
// tickers (OANDA feed — the standard free/no-key data source their embed
// widget resolves). Forex pairs match 1:1; the commodity/index/energy
// tickers are best-effort and worth a manual spot-check against
// TradingView's symbol search since this environment can't verify them live.
export const TRADINGVIEW_SYMBOL_MAP = Object.freeze({
  ...FOREX_INSTRUMENTS.reduce((acc, symbol) => {
    acc[symbol] = `OANDA:${symbol}`
    return acc
  }, {}),
  XAUUSD: 'OANDA:XAUUSD',
  XAGUSD: 'OANDA:XAGUSD',
  XPTUSD: 'TVC:PLATINUM',
  XPDUSD: 'TVC:PALLADIUM',
  XTIUSD: 'TVC:USOIL',
  XBRUSD: 'TVC:UKOIL',
  XNGUSD: 'TVC:NATURALGAS',
  US30: 'OANDA:US30USD',
  USTEC: 'OANDA:NAS100USD',
  US500: 'SP:SPX',
  UK100: 'SPREADEX:UK100',
  AUS200: 'ASX:XJO',
  JP225: 'TVC:NI225',
  HK50: 'TVC:HSI',
  DE40: 'XETR:DAX',
  FRA40: 'EURONEXT:PX1',
  EUSTX50: 'TVC:SX5E',
})

export function getTradingViewSymbol(instrument) {
  return TRADINGVIEW_SYMBOL_MAP[instrument] || `OANDA:${instrument}`
}

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
  const leverage = toDecimal(LEVERAGE[instrument] || 100)
  return decimalToNumber(
    toDecimal(lots).mul(contractSize).div(leverage).toDecimalPlaces(2),
    2
  )
}

export function getSpreadPoints(spreadAbs, instrument) {
  return spreadAbs * getPointMultiplier(instrument)
}
