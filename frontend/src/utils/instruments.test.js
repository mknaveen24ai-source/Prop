import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SUPPORTED_INSTRUMENTS,
  USD_QUOTED_INSTRUMENTS,
  getAvailableInstrumentList,
  getQuoteCurrency,
  getTradableInstruments,
  isTradableInstrument,
  getUsdRateFromPrices,
  getUsdRateForInstrument,
} from './instruments.js'

// C-01 containment, mirroring backend/test/instruments.test.js.
//
// PnL is computed as priceDiff * lots * contractSize and treated as USD, which
// is only correct where the quote currency IS USD. Until FX conversion lands,
// the picker must offer only USD-quoted instruments — otherwise the UI invites
// a trade the server rejects, and the risk preview shows a figure that is out
// by the QUOTE/USD rate (~150x on the JPY pairs).

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('quote currency', () => {
  it('reads forex quote currency off the symbol', () => {
    expect(getQuoteCurrency('USDJPY')).toBe('JPY')
    expect(getQuoteCurrency('EURUSD')).toBe('USD')
    expect(getQuoteCurrency('EURGBP')).toBe('GBP')
  })

  it('knows where each non-forex contract settles', () => {
    expect(getQuoteCurrency('JP225')).toBe('JPY')
    expect(getQuoteCurrency('HK50')).toBe('HKD')
    expect(getQuoteCurrency('UK100')).toBe('GBP')
    expect(getQuoteCurrency('DE40')).toBe('EUR')
    expect(getQuoteCurrency('AUS200')).toBe('AUD')
    expect(getQuoteCurrency('XAUUSD')).toBe('USD')
    expect(getQuoteCurrency('US500')).toBe('USD')
  })

  it('is case-insensitive', () => {
    expect(getQuoteCurrency('usdjpy')).toBe('JPY')
  })
})

describe('C-01 containment', () => {
  it('agrees with the backend on which 14 instruments are USD-quoted', () => {
    expect([...USD_QUOTED_INSTRUMENTS].sort()).toEqual([
      'AUDUSD', 'EURUSD', 'GBPUSD', 'NZDUSD',
      'US30', 'US500', 'USTEC',
      'XAGUSD', 'XAUUSD', 'XBRUSD', 'XNGUSD', 'XPDUSD', 'XPTUSD', 'XTIUSD',
    ])
    expect(SUPPORTED_INSTRUMENTS.length - USD_QUOTED_INSTRUMENTS.length).toBe(31)
  })

  it('blocks non-USD-quoted instruments while FX conversion is off', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', '')
    expect(getTradableInstruments()).toHaveLength(14)
    expect(isTradableInstrument('USDJPY')).toBe(false)
    expect(isTradableInstrument('JP225')).toBe(false)
    expect(isTradableInstrument('HK50')).toBe(false)
    expect(isTradableInstrument('EURUSD')).toBe(true)
    expect(isTradableInstrument('XAUUSD')).toBe(true)
  })

  it('restores the full catalogue once FX conversion is enabled', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', 'true')
    expect(getTradableInstruments()).toHaveLength(45)
    expect(isTradableInstrument('USDJPY')).toBe(true)
  })

  it('keeps priority ordering when the list is narrowed', () => {
    const narrowed = [...USD_QUOTED_INSTRUMENTS]
    const fullOrder = SUPPORTED_INSTRUMENTS.filter((s) => narrowed.includes(s))
    expect(narrowed).toEqual(fullOrder)
  })
})

describe('getAvailableInstrumentList', () => {
  it('drops non-tradable instruments even when the feed prices them', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', '')
    const prices = {
      EURUSD: { bid: 1.1, ask: 1.1001 },
      USDJPY: { bid: 150.0, ask: 150.01 },
      JP225: { bid: 39000, ask: 39002 },
    }
    expect(getAvailableInstrumentList(prices)).toEqual(['EURUSD'])
  })

  it('filters the fallback list too, so a dead feed cannot reopen the catalogue', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', '')
    expect(getAvailableInstrumentList({}, ['EURUSD', 'USDJPY'])).toEqual(['EURUSD'])
  })

  it('ignores instruments quoted with a zero or malformed price', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', '')
    const prices = {
      EURUSD: { bid: 1.1, ask: 1.1001 },
      XAUUSD: { bid: 0, ask: 0 },
      US500: { bid: 'nope', ask: 'nope' },
    }
    expect(getAvailableInstrumentList(prices)).toEqual(['EURUSD'])
  })
})

describe('FX rates (mirrors backend/utils/fxRates.js)', () => {
  const PRICES = {
    USDJPY: { bid: 150.0, ask: 150.02 },
    GBPUSD: { bid: 1.27, ask: 1.2701 },
    EURUSD: { bid: 1.1, ask: 1.1001 },
  }

  it('inverts USD/QUOTE pairs and passes QUOTE/USD through', () => {
    expect(getUsdRateFromPrices(PRICES, 'JPY')).toBeCloseTo(1 / 150, 10)
    expect(getUsdRateFromPrices(PRICES, 'GBP')).toBe(1.27)
    expect(getUsdRateFromPrices(PRICES, 'USD')).toBe(1)
  })

  it('uses the HKD peg rather than the feed', () => {
    expect(getUsdRateFromPrices(PRICES, 'HKD')).toBeCloseTo(1 / 7.8, 10)
  })

  it('reads the bid, so a tenant ask markup cannot skew the rate', () => {
    expect(getUsdRateFromPrices({ GBPUSD: { bid: 1.27, ask: 9.99 } }, 'GBP')).toBe(1.27)
  })

  it('returns null rather than falling back to 1 when the rate is unknown', () => {
    expect(getUsdRateFromPrices({}, 'JPY')).toBeNull()
    expect(getUsdRateFromPrices({ USDJPY: { bid: 0, ask: 0 } }, 'JPY')).toBeNull()
    expect(getUsdRateFromPrices(PRICES, 'ZWL')).toBeNull()
  })

  it('reports rate 1 for everything while conversion is off (grandfathering)', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', '')
    expect(getUsdRateForInstrument(PRICES, 'USDJPY')).toBe(1)
    expect(getUsdRateForInstrument(PRICES, 'EURUSD')).toBe(1)
  })

  it('converts once enabled, and agrees with the backend on USDJPY', () => {
    vi.stubEnv('VITE_FX_CONVERSION_ENABLED', 'true')
    expect(getUsdRateForInstrument(PRICES, 'USDJPY')).toBeCloseTo(1 / 150, 10)
    expect(getUsdRateForInstrument(PRICES, 'EURUSD')).toBe(1)
    expect(getUsdRateForInstrument(PRICES, 'JP225')).toBeCloseTo(1 / 150, 10)

    // The audit's headline case: 1 lot USDJPY over 10 pips.
    const rate = getUsdRateForInstrument(PRICES, 'USDJPY')
    expect(0.1 * 1 * 100000 * rate).toBeCloseTo(66.67, 1)
  })
})
