import { calculatePnL } from '../../utils/instruments'

// Recomputes floating P&L for a set of trades against the latest price map.
// Shared by the socket handlers and the open-trades fetch, so it lives outside
// the component.
export function enrichTradesWithPrices(trades = [], currentPrices = {}) {
  return trades.map(trade => {
    if (trade.status === 'pending') return trade
    const priceData = currentPrices[trade.instrument]
    if (!priceData || trade.open_price == null) return trade

    const currentPrice = trade.direction === 'buy'
      ? parseFloat(priceData.bid)
      : parseFloat(priceData.ask)

    const floatingPnl = calculatePnL(
      trade.direction,
      parseFloat(trade.open_price),
      currentPrice,
      parseFloat(trade.lot_size),
      trade.instrument,
      parseFloat(trade.commission || 0)
    )

    return {
      ...trade,
      floating_pnl: floatingPnl,
      current_price: currentPrice
    }
  })
}
