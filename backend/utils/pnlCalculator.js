const Decimal = require('decimal.js')
const { CONTRACT_SIZES } = require('../constants')

function calculatePnL(direction, open_price, close_price, lots, instrument, commission = 0) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(close_price).minus(open_price)
    : new Decimal(open_price).minus(close_price)
  return priceDiff.times(lots).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

module.exports = { calculatePnL }
