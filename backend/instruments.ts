interface RawInstrumentDefinition {
  symbol: string
  group: string
  subCategory: string
  quoteCurrency?: string
  contractSize: number
  leverage: number
  decimals: number
  step: number
  pipSize: number
  minDistance: number
  pointMultiplier: number
  wideSpreadThreshold: number
  quickMoveThreshold: number
  marketDataSymbol: string
  defaultSpread: number
}

interface InstrumentDefinition extends RawInstrumentDefinition {
  quoteCurrency: string
}

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

function splitForexSymbol(symbol: string): [string, string] {
  return [symbol.slice(0, 3), symbol.slice(3)]
}

function buildForexDefinition(symbol: string, subCategory: string): RawInstrumentDefinition {
  const [base, quote] = splitForexSymbol(symbol)
  const isJpy = quote === 'JPY'

  return {
    symbol,
    group: 'forex',
    subCategory,
    // The currency a price move is denominated in. PnL = priceDiff * lots *
    // contractSize lands in THIS currency, not USD — see utils/pnlCalculator.js
    // and the C-01 note below.
    quoteCurrency: quote,
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
// Quote currency for everything that is not forex. The symbol does not encode
// it: JP225 settles in JPY, DE40 in EUR, HK50 in HKD. Metals, energies and the
// US indices genuinely are USD-quoted.
const NON_FOREX_QUOTE_CURRENCIES: Readonly<Record<string, string>> = {
  XAUUSD: 'USD', XAGUSD: 'USD', XPTUSD: 'USD', XPDUSD: 'USD',
  XTIUSD: 'USD', XBRUSD: 'USD', XNGUSD: 'USD',
  US30:   'USD', USTEC:  'USD', US500:  'USD',
  UK100:  'GBP',
  AUS200: 'AUD',
  JP225:  'JPY',
  HK50:   'HKD',
  DE40:   'EUR', FRA40:  'EUR', EUSTX50: 'EUR'
}

const RAW_INSTRUMENT_DEFINITIONS: RawInstrumentDefinition[] = [
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

const INSTRUMENT_DEFINITIONS: InstrumentDefinition[] = RAW_INSTRUMENT_DEFINITIONS.map((definition) => ({
  ...definition,
  quoteCurrency: definition.quoteCurrency
    || NON_FOREX_QUOTE_CURRENCIES[definition.symbol]
    || 'USD'
}))

const INSTRUMENT_CATALOG: Readonly<Record<string, Readonly<InstrumentDefinition>>> = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = Object.freeze({ ...instrument })
    return acc
  }, {} as Record<string, Readonly<InstrumentDefinition>>)
)

// Everything the platform knows about. Deliberately NOT filtered by the C-01
// containment below: the price feed subscribes from this list (priceFeed.js
// SUBSCRIBE_SYMBOLS), and cutting it would (a) strand any position already open
// on a restricted instrument with no price to close against, and (b) remove the
// very USDJPY/USDCHF/USDCAD quotes the FX conversion work needs as rate sources.
const INSTRUMENTS = Object.freeze(INSTRUMENT_DEFINITIONS.map((instrument) => instrument.symbol))

// ─────────────────────────────────────────────────────────────────────────────
// C-01 containment — which instruments may be OPENED
// ─────────────────────────────────────────────────────────────────────────────
// calculatePnL() computes priceDiff * lots * contractSize and books it as USD.
// That product is denominated in the instrument's quote currency, so it is only
// correct where the quote currency IS USD. For the rest it is wrong by the
// QUOTE/USD rate — about 150x on the JPY pairs and JP225.
//
// Until FX conversion lands, only USD-quoted instruments may be opened. This
// gates entry only: existing positions still price, chart and close normally.
//
// Set FX_CONVERSION_ENABLED=true once utils/fxRates.js is in place and the
// per-currency parity tests pass.
const USD_QUOTED_INSTRUMENTS = Object.freeze(
  INSTRUMENT_DEFINITIONS
    .filter((instrument) => instrument.quoteCurrency === 'USD')
    .map((instrument) => instrument.symbol)
)

function isFxConversionEnabled(): boolean {
  return String(process.env.FX_CONVERSION_ENABLED || '').trim().toLowerCase() === 'true'
}

/** Instruments a trader may open a NEW position on right now. */
function getTradableInstruments(): readonly string[] {
  return isFxConversionEnabled() ? INSTRUMENTS : USD_QUOTED_INSTRUMENTS
}

/** True when `symbol` may be opened right now. */
function isTradableInstrument(symbol: unknown): boolean {
  return getTradableInstruments().includes(String(symbol || '').trim().toUpperCase())
}

const INSTRUMENT_GROUPS = Object.freeze({
  FOREX_MAJORS: Object.freeze([...FOREX_MAJORS]),
  FOREX_MINORS: Object.freeze([...FOREX_MINORS]),
  COMMODITY_METALS: Object.freeze([...COMMODITY_METALS]),
  ENERGIES: Object.freeze([...ENERGIES]),
  INDICES_SPOT: Object.freeze([...INDICES_SPOT]),
  INDICES_MAJOR: Object.freeze([...INDICES_MAJOR])
})

const CONTRACT_SIZES: Readonly<Record<string, number>> = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.contractSize
    return acc
  }, {} as Record<string, number>)
)

const LEVERAGE: Readonly<Record<string, number>> = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.leverage
    return acc
  }, {} as Record<string, number>)
)

const TWELVE_DATA_SYMBOLS: Readonly<Record<string, string>> = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.marketDataSymbol
    return acc
  }, {} as Record<string, string>)
)

const DEFAULT_SPREADS: Readonly<Record<string, number>> = Object.freeze(
  INSTRUMENT_DEFINITIONS.reduce((acc, instrument) => {
    acc[instrument.symbol] = instrument.defaultSpread
    return acc
  }, {} as Record<string, number>)
)

function getInstrumentConfig(symbol: unknown): Readonly<InstrumentDefinition> | null {
  return INSTRUMENT_CATALOG[String(symbol || '').toUpperCase()] || null
}

function getPriceDecimals(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.decimals ?? 5
}

function getInputStep(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.step ?? 0.00001
}

function getInputStepString(symbol: unknown): string {
  const decimals = getPriceDecimals(symbol)
  return getInputStep(symbol).toFixed(decimals)
}

function getPipSize(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.pipSize ?? 0.0001
}

function getMinDistance(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.minDistance ?? getPipSize(symbol)
}

function getPointMultiplier(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.pointMultiplier ?? 100000
}

function getSpreadPoints(spreadAbs: number, symbol: unknown): number {
  return spreadAbs * getPointMultiplier(symbol)
}

function getWideSpreadThreshold(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.wideSpreadThreshold ?? 4.5
}

function getQuickMoveThreshold(symbol: unknown): number {
  return getInstrumentConfig(symbol)?.quickMoveThreshold ?? 20
}

function roundPrice(value: unknown, symbol: unknown): number {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(parsed)) return parsed
  return parseFloat(parsed.toFixed(getPriceDecimals(symbol)))
}

function formatPrice(value: unknown, symbol: unknown): string {
  const parsed = typeof value === 'number' ? value : parseFloat(String(value))
  if (!Number.isFinite(parsed)) return ''
  return parsed.toFixed(getPriceDecimals(symbol))
}

const instruments = {
  INSTRUMENT_DEFINITIONS,
  INSTRUMENT_CATALOG,
  INSTRUMENTS,
  USD_QUOTED_INSTRUMENTS,
  getTradableInstruments,
  isTradableInstrument,
  isFxConversionEnabled,
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

export = instruments
