import Decimal from 'decimal.js'
import { getUsdRateForInstrument } from './fxRates'

const { CONTRACT_SIZES } = require('../constants') as {
  CONTRACT_SIZES: Readonly<Record<string, number>>
}

/**
 * Realised/unrealised PnL for a position, in USD.
 *
 * ── FIX (C-01): the conversion that was missing ──
 *
 * `priceDiff × lots × contractSize` is denominated in the instrument's QUOTE
 * currency, not USD. This function used to return that product unchanged, so a
 * USDJPY result in yen was written straight into a dollar balance — a ~150×
 * overstatement, and the same again on JP225. 31 of the 45 instruments were
 * affected. See utils/fxRates.js for where the rate comes from.
 *
 * Commission is charged in USD per lot, so it is subtracted AFTER conversion,
 * never scaled by the rate.
 *
 * @param {'buy'|'sell'} direction
 * @param {number|string} open_price
 * @param {number|string} close_price
 * @param {number|string} lots
 * @param {string} instrument
 * @param {number} [commission=0]  already in USD
 * @param {number} [usdRate]       USD per unit of quote currency. Resolved from
 *                                 the live feed when omitted; pass explicitly
 *                                 only in tests, or to value a position at a
 *                                 rate other than the current one.
 * @returns {number} PnL in USD, rounded to cents
 */
function calculatePnL(
  direction: string,
  open_price: Decimal.Value,
  close_price: Decimal.Value,
  lots: Decimal.Value,
  instrument: string,
  commission: Decimal.Value = 0,
  usdRate?: number
): number {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(close_price).minus(open_price)
    : new Decimal(open_price).minus(close_price)

  const rate = usdRate === undefined ? getUsdRateForInstrument(instrument) : usdRate

  const gross = priceDiff.times(lots).times(contractSize)

  // Skip the multiply entirely at rate 1. This is not micro-optimisation for its
  // own sake: a rate like 1/150 is a full-precision repeating decimal, and
  // Decimal.times() on one costs several times a multiply by an integer
  // contract size. Rate 1 covers every USD-quoted instrument and every
  // instrument while FX_CONVERSION_ENABLED is false, and this function is
  // called per open trade per second by checkFloatingDrawdown.
  const converted = rate === 1 ? gross : gross.times(rate)

  return converted
    .minus(commission)
    .toDecimalPlaces(2)
    .toNumber()
}

export { calculatePnL }
