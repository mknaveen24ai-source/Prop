import assert from 'node:assert/strict'
import test from 'node:test'
import analyticsRouter = require('../routes/trades/analytics')

type ClosedTrade = Parameters<typeof analyticsRouter.__test__.calculateCoreTradeMetrics>[0][number]

function trade(id: string, pnl: string): ClosedTrade {
  return {
    id,
    account_id: 'account-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1',
    open_price: '1.10000',
    close_price: '1.10100',
    stop_loss: '1.09900',
    take_profit: null,
    status: 'closed',
    demo_pnl: pnl,
    open_time: '2026-08-27T00:00:00.000Z',
    close_time: '2026-08-27T01:00:00.000Z',
    close_reason: 'Manual',
    order_type: 'market'
  }
}

void test('core analytics preserve win/loss, profit-factor, RR, and expectancy calculations', () => {
  const result = analyticsRouter.__test__.calculateCoreTradeMetrics([
    trade('win', '100.00'),
    trade('loss', '-50.00'),
    trade('flat', '0.00')
  ])
  assert.equal(result.winners.length, 1)
  assert.equal(result.losers.length, 1)
  assert.equal(result.breakeven.length, 1)
  assert.equal(result.winRate, 33.3)
  assert.equal(result.totalPnl, 50)
  assert.equal(result.avgWin, 100)
  assert.equal(result.avgLoss, 50)
  assert.equal(result.profitFactor, 2)
  assert.equal(result.avgRr, 2)
  assert.equal(result.expectancy, 16.67)
})

void test('analytics route retains authenticateToken before the named handler', () => {
  const stack = (analyticsRouter as unknown as {
    stack: Array<{
      route?: { path: string; stack: Array<{ name: string }> }
    }>
  }).stack
  const route = stack.find((layer) => layer.route?.path === '/analytics')
  assert.ok(route)
  assert.deepEqual(route.route?.stack.map((handler) => handler.name), [
    'authenticateToken',
    'analyticsHandler'
  ])
})
