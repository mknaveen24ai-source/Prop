// Admin-side trade P&L, force-close/cancel helpers and exposure reporting.

import Decimal from 'decimal.js'
import type { QueryResult, QueryResultRow } from 'pg'
import { CONTRACT_SIZES } from '../../../constants'
import { getPriceForTenant } from '../../../priceFeed'
import { serializeDecimal } from '../../../utils/money'

interface Queryable {
  query: <Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[]
  ) => Promise<QueryResult<Row>>
}

interface PricePoint {
  bid: number
  ask: number
}

type PriceProvider = (instrument: string) => Promise<PricePoint>

interface OpenTradeRow extends QueryResultRow {
  id: string
  instrument: string
  direction: string
  open_price: string
  lot_size: string
  commission: string | null
}

interface TradeCloseRow extends OpenTradeRow {
  account_id: string
  user_id: string
}

interface PendingTradeRow extends QueryResultRow {
  id: string
}

interface PriceRow extends QueryResultRow {
  instrument: string
  bid: string
  ask: string
}

interface ExposureTradeRow extends QueryResultRow {
  instrument: string
  direction: string
  lot_size: string
  open_price: string
}

interface ExposureGroup {
  buy_lots: number
  sell_lots: number
  trade_count: number
  floating_pnl: number
}

interface ExposureRow extends ExposureGroup {
  instrument: string
  long_lots: number
  short_lots: number
  net_lots: number
  net_direction: 'BUY' | 'SELL' | 'FLAT'
  reverse_direction: 'buy' | 'sell' | 'flat'
  reverse_lots: number
}

interface ExposureResult {
  exposureData: ExposureRow[]
  total_open_trades: number
  total_floating_pnl: number
}

interface ForceCloseAccountResult {
  closedCount: number
  totalPnl: number
}

interface ForceCloseTradeResult {
  trade_id: string
  account_id: string
  user_id: string
  instrument: string
  pnl: number
  close_price: number
}

function decimalString(value: string | number): string {
  return serializeDecimal(new Decimal(value))
}

function calcTradePnl(
  direction: string,
  openPrice: string | number,
  currentPrice: string | number,
  lots: string | number,
  instrument: string
): number {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(currentPrice).minus(openPrice)
    : new Decimal(openPrice).minus(currentPrice)
  return priceDiff.times(lots).times(contractSize).toDecimalPlaces(2).toNumber()
}

async function safePrice(provider: PriceProvider, instrument: string): Promise<PricePoint | null> {
  try {
    return await provider(instrument)
  } catch (_error: unknown) {
    return null
  }
}

async function forceCloseOpenTradesForAccountWithPrice(
  client: Queryable,
  accountId: string,
  priceProvider: PriceProvider
): Promise<ForceCloseAccountResult> {
  const openTrades = await client.query<OpenTradeRow>(
    `SELECT t.id, t.instrument, t.direction, t.open_price, t.lot_size, t.commission
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [accountId]
  )
  if (openTrades.rows.length === 0) return { closedCount: 0, totalPnl: 0 }

  let totalPnl = 0
  for (const trade of openTrades.rows) {
    const openPrice = Number.parseFloat(trade.open_price || '0')
    const lots = Number.parseFloat(trade.lot_size || '0')
    const livePrice = await safePrice(priceProvider, trade.instrument)
    const currentPrice = trade.direction === 'buy'
      ? Number.parseFloat(String(livePrice?.bid || openPrice))
      : Number.parseFloat(String(livePrice?.ask || openPrice))
    const pnl = Number.parseFloat((
      calcTradePnl(trade.direction, openPrice, currentPrice, lots, trade.instrument)
      - Number.parseFloat(trade.commission || '0')
    ).toFixed(2))
    totalPnl += pnl

    const closeResult = await client.query(
      `UPDATE trades
          SET status = 'closed', close_price = $1, close_time = NOW(),
              demo_pnl = $2, close_reason = 'Admin Auto Enforcement'
        WHERE id = $3`,
      [decimalString(currentPrice), decimalString(pnl), trade.id]
    )
    if (closeResult.rowCount !== 1) throw new Error(`Failed to force-close trade ${trade.id}`)
  }

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [decimalString(totalPnl), accountId]
  )
  return {
    closedCount: openTrades.rows.length,
    totalPnl: Number.parseFloat(totalPnl.toFixed(2))
  }
}

async function forceCloseOpenTradesForAccount(
  client: Queryable,
  accountId: string,
  _options?: unknown
): Promise<ForceCloseAccountResult> {
  return forceCloseOpenTradesForAccountWithPrice(client, accountId, getPriceForTenant)
}

async function cancelPendingTradesForAccount(
  client: Queryable,
  accountId: string,
  closeReason: unknown,
  _options?: unknown
): Promise<number> {
  const pendingTrades = await client.query<PendingTradeRow>(
    `SELECT t.id
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.account_id = $1 AND t.status = 'pending'
      FOR UPDATE`,
    [accountId]
  )
  if (pendingTrades.rows.length === 0) return 0

  const cancelled = await client.query<PendingTradeRow>(
    `UPDATE trades
        SET status = 'cancelled', close_time = NOW(), close_reason = $2
      WHERE account_id = $1 AND status = 'pending'
      RETURNING id`,
    [accountId, String(closeReason || 'Cancelled by admin')]
  )
  if (cancelled.rows.length !== pendingTrades.rows.length) {
    throw new Error(`Failed to cancel all pending trades for account ${accountId}`)
  }
  return cancelled.rows.length
}

async function forceCloseTradeByIdWithPrice(
  client: Queryable,
  tradeId: string,
  closeReason: unknown,
  priceProvider: PriceProvider
): Promise<ForceCloseTradeResult | null> {
  const result = await client.query<TradeCloseRow>(
    `SELECT t.id, t.account_id, t.instrument, t.direction, t.open_price,
            t.lot_size, t.commission, a.user_id
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [tradeId]
  )
  const trade = result.rows[0]
  if (!trade) return null

  const openPrice = Number.parseFloat(trade.open_price || '0')
  const livePrice = await safePrice(priceProvider, trade.instrument)
  const closePrice = trade.direction === 'buy'
    ? Number.parseFloat(String(livePrice?.bid || openPrice))
    : Number.parseFloat(String(livePrice?.ask || openPrice))
  const pnl = Number.parseFloat((
    calcTradePnl(
      trade.direction,
      openPrice,
      closePrice,
      Number.parseFloat(trade.lot_size || '0'),
      trade.instrument
    ) - Number.parseFloat(trade.commission || '0')
  ).toFixed(2))

  const closeResult = await client.query(
    `UPDATE trades
        SET status = 'closed', close_price = $1, close_time = NOW(),
            demo_pnl = $2, close_reason = $3
      WHERE id = $4`,
    [
      decimalString(closePrice),
      decimalString(pnl),
      String(closeReason || 'Admin Force Close'),
      trade.id
    ]
  )
  if (closeResult.rowCount !== 1) throw new Error(`Failed to force-close trade ${trade.id}`)

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [decimalString(pnl), trade.account_id]
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

async function forceCloseTradeById(
  client: Queryable,
  tradeId: string,
  closeReason: unknown = 'Admin Force Close',
  _options?: unknown
): Promise<ForceCloseTradeResult | null> {
  return forceCloseTradeByIdWithPrice(client, tradeId, closeReason, getPriceForTenant)
}

async function getExposureData(database: Queryable): Promise<ExposureResult> {
  const pricesResult = await database.query<PriceRow>('SELECT instrument, bid, ask FROM price_feed')
  const priceMap: Record<string, PriceRow> = {}
  for (const price of pricesResult.rows) priceMap[price.instrument] = price

  const exposureQuery = await database.query<ExposureTradeRow>(
    `SELECT t.instrument, t.direction, t.lot_size, t.open_price
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'open'`
  )
  const exposureGroups: Record<string, ExposureGroup> = {}
  let totalOpenTrades = 0
  let totalFloatingPnl = 0

  for (const trade of exposureQuery.rows) {
    const group = exposureGroups[trade.instrument] || {
      buy_lots: 0,
      sell_lots: 0,
      trade_count: 0,
      floating_pnl: 0
    }
    exposureGroups[trade.instrument] = group
    const lot = Number.parseFloat(trade.lot_size)
    group.trade_count += 1
    totalOpenTrades += 1
    if (trade.direction === 'buy') group.buy_lots += lot
    else group.sell_lots += lot

    const priceData = priceMap[trade.instrument]
    if (priceData) {
      const currentPrice = trade.direction === 'buy'
        ? Number.parseFloat(priceData.bid)
        : Number.parseFloat(priceData.ask)
      const pnl = calcTradePnl(
        trade.direction,
        Number.parseFloat(trade.open_price),
        currentPrice,
        lot,
        trade.instrument
      )
      group.floating_pnl += pnl
      totalFloatingPnl += pnl
    }
  }

  const exposureData = Object.entries(exposureGroups).map(([instrument, group]): ExposureRow => {
    const net = group.buy_lots - group.sell_lots
    return {
      instrument,
      ...group,
      long_lots: group.buy_lots,
      short_lots: group.sell_lots,
      net_lots: net,
      net_direction: net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'FLAT',
      reverse_direction: net > 0 ? 'sell' : net < 0 ? 'buy' : 'flat',
      reverse_lots: Math.abs(net)
    }
  })
  return {
    exposureData,
    total_open_trades: totalOpenTrades,
    total_floating_pnl: totalFloatingPnl
  }
}

export {
  calcTradePnl,
  cancelPendingTradesForAccount,
  forceCloseOpenTradesForAccount,
  forceCloseOpenTradesForAccountWithPrice,
  forceCloseTradeById,
  forceCloseTradeByIdWithPrice,
  getExposureData
}
