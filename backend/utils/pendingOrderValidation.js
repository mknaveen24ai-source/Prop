function validatePendingOrderPrice(orderType, pendingPrice, bid, ask) {
  if (isNaN(pendingPrice) || pendingPrice <= 0) {
    return 'Invalid pending order price'
  }
  if (isNaN(bid) || isNaN(ask)) {
    return 'Live price not available - cannot validate pending order price'
  }
  if (orderType === 'buy_limit' && pendingPrice >= ask) {
    return `Buy Limit price must be below current ask (${ask}). Use a Market order to buy at market price.`
  }
  if (orderType === 'sell_limit' && pendingPrice <= bid) {
    return `Sell Limit price must be above current bid (${bid}). Use a Market order to sell at market price.`
  }
  if (orderType === 'buy_stop' && pendingPrice <= ask) {
    return `Buy Stop price must be above current ask (${ask}).`
  }
  if (orderType === 'sell_stop' && pendingPrice >= bid) {
    return `Sell Stop price must be below current bid (${bid}).`
  }
  return null
}

module.exports = { validatePendingOrderPrice }
