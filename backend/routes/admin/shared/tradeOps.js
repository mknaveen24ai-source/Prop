// Admin-side trade P&L, force-close/cancel helpers and the exposure report,
// moved verbatim from routes/admin.js during the admin modularization.
const Decimal = require('decimal.js')
const pool = require('../../../db')
const logger = require('../../../utils/logger')
const { CONTRACT_SIZES } = require('../../../constants')
const { getPriceForTenant } = require('../../../priceFeed')

function calcTradePnl(direction, openPrice, currentPrice, lots, instrument) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(currentPrice).minus(openPrice)
    : new Decimal(openPrice).minus(currentPrice)
  return priceDiff.times(lots).times(contractSize).toDecimalPlaces(2).toNumber()
}

// -- Force-close helpers ------------------------------------------------------
async function forceCloseOpenTradesForAccount(client, accountId, options) {
  if (!options) options = {}
  const openTrades = await client.query(
    `SELECT t.*, a.user_id
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [accountId]
  )

  if (openTrades.rows.length === 0) {
    return { closedCount: 0, totalPnl: 0 }
  }

  let totalPnl = 0
  for (const t of openTrades.rows) {
    const openPrice = parseFloat(t.open_price || 0)
    const lots = parseFloat(t.lot_size || 0)
    const fallbackPrice = openPrice
    const livePrice = await getPriceForTenant(t.instrument).catch(function() { return null })
    const currentPrice = t.direction === 'buy'
      ? parseFloat((livePrice && livePrice.bid) || fallbackPrice)
      : parseFloat((livePrice && livePrice.ask) || fallbackPrice)
    const pnl = parseFloat((
      calcTradePnl(t.direction, openPrice, currentPrice, lots, t.instrument) -
      parseFloat(t.commission || 0)
    ).toFixed(2))
    totalPnl += pnl

    const closeResult = await client.query(
      `UPDATE trades
          SET status = 'closed',
              close_price = $1,
              close_time = NOW(),
              demo_pnl = $2,
              close_reason = 'Admin Auto Enforcement'
        WHERE id = $3`,
      [currentPrice, pnl, t.id]
    )
    if (closeResult.rowCount !== 1) {
      throw new Error('Failed to force-close trade ' + t.id)
    }
  }

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [totalPnl, accountId]
  )

  return {
    closedCount: openTrades.rows.length,
    totalPnl: parseFloat(totalPnl.toFixed(2))
  }
}

async function cancelPendingTradesForAccount(client, accountId, closeReason, options) {
  if (!options) options = {}
  const pendingTrades = await client.query(
    `SELECT t.*
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1 AND t.status = 'pending'
      FOR UPDATE`,
    [accountId]
  )
  if (pendingTrades.rows.length === 0) return 0

  const cancelled = await client.query(
    `UPDATE trades
        SET status = 'cancelled',
            close_time = NOW(),
            close_reason = $2
      WHERE account_id = $1 AND status = 'pending'
      RETURNING id`,
    [accountId, String(closeReason || 'Cancelled by admin')]
  )
  if (cancelled.rows.length !== pendingTrades.rows.length) {
    throw new Error('Failed to cancel all pending trades for account ' + accountId)
  }
  return cancelled.rows.length
}

async function forceCloseTradeById(client, tradeId, closeReason, options) {
  if (!closeReason) closeReason = 'Admin Force Close'
  if (!options) options = {}
  const result = await client.query(
    `SELECT t.id, t.account_id, t.instrument, t.direction, t.open_price, t.lot_size, t.commission,
            a.user_id
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [tradeId]
  )

  if (result.rows.length === 0) return null

  const trade = result.rows[0]
  const openPrice = parseFloat(trade.open_price || 0)
  const fallbackPrice = openPrice
  const livePrice = await getPriceForTenant(trade.instrument).catch(function() { return null })
  const closePrice = trade.direction === 'buy'
    ? parseFloat((livePrice && livePrice.bid) || fallbackPrice)
    : parseFloat((livePrice && livePrice.ask) || fallbackPrice)
  const pnl = parseFloat((
    calcTradePnl(
      trade.direction,
      openPrice,
      closePrice,
      parseFloat(trade.lot_size || 0),
      trade.instrument
    ) - parseFloat(trade.commission || 0)
  ).toFixed(2))

  const closeResult = await client.query(
    `UPDATE trades
        SET status = 'closed',
            close_price = $1,
            close_time = NOW(),
            demo_pnl = $2,
            close_reason = $3
      WHERE id = $4`,
    [closePrice, pnl, String(closeReason || 'Admin Force Close'), trade.id]
  )
  if (closeResult.rowCount !== 1) {
    throw new Error('Failed to force-close trade ' + trade.id)
  }

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [pnl, trade.account_id]
  )

  return {
    trade_id: trade.id,
    account_id: trade.account_id,
    user_id: trade.user_id,
    instrument: trade.instrument,
    pnl,
    close_price: closePrice
  }
}
async function getExposureData(pool) {
  const pricesResult = await pool.query('SELECT instrument, bid, ask FROM price_feed');
  const priceMap = {};
  pricesResult.rows.forEach(p => priceMap[p.instrument] = p);

  const exposureQ = await pool.query(`
    SELECT t.instrument, t.direction, t.lot_size, t.open_price
    FROM trades t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.status = 'open'
  `);

  const exposureGroups = {};
  let total_open_trades = 0;
  let total_floating_pnl = 0;

  for (const t of exposureQ.rows) {
    if (!exposureGroups[t.instrument]) {
      exposureGroups[t.instrument] = { buy_lots: 0, sell_lots: 0, trade_count: 0, floating_pnl: 0 };
    }
    const group = exposureGroups[t.instrument];
    const lot = parseFloat(t.lot_size);
    group.trade_count++;
    total_open_trades++;
    
    if (t.direction === 'buy') group.buy_lots += lot;
    else group.sell_lots += lot;
    
    const priceData = priceMap[t.instrument];
    if (priceData) {
      const currentPrice = t.direction === 'buy' ? parseFloat(priceData.bid) : parseFloat(priceData.ask);
      const openPrice = parseFloat(t.open_price);
      const pnl = calcTradePnl(t.direction, openPrice, currentPrice, lot, t.instrument);
      group.floating_pnl += pnl;
      total_floating_pnl += pnl;
    }
  }

  const exposureData = Object.keys(exposureGroups).map(inst => {
    const g = exposureGroups[inst];
    const net = g.buy_lots - g.sell_lots;
    return {
      instrument: inst,
      buy_lots: g.buy_lots,
      long_lots: g.buy_lots,
      sell_lots: g.sell_lots,
      short_lots: g.sell_lots,
      net_lots: net,
      trade_count: g.trade_count,
      floating_pnl: g.floating_pnl,
      net_direction: net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'FLAT',
      reverse_direction: net > 0 ? 'sell' : net < 0 ? 'buy' : 'flat',
      reverse_lots: Math.abs(net)
    };
  });

  return { exposureData, total_open_trades, total_floating_pnl };
}


module.exports = {
  calcTradePnl,
  forceCloseOpenTradesForAccount,
  cancelPendingTradesForAccount,
  forceCloseTradeById,
  getExposureData
}
