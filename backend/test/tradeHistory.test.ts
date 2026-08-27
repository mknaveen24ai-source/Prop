import assert from 'node:assert/strict'
import test from 'node:test'
import historyRouter = require('../routes/trades/history')

type TradeRowInput = Parameters<typeof historyRouter.__test__.mapTradeRow>[0]

function baseRow(patch: Partial<TradeRowInput> = {}): TradeRowInput {
  return {
    id: 'trade-1',
    account_id: 'account-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1.00',
    open_price: '1.10000',
    stop_loss: '1.09000',
    take_profit: '1.12000',
    status: 'open',
    demo_pnl: '0.00',
    open_time: new Date('2026-08-27T00:00:00.000Z'),
    close_time: null,
    close_reason: null,
    order_type: 'market',
    open_screenshot_path: 'user-1/open.png',
    close_screenshot_path: null,
    ...patch
  }
}

void test('trade list mapper preserves money strings and emits ISO timestamps and screenshot URLs', () => {
  assert.deepEqual(historyRouter.__test__.mapTradeRow(baseRow()), {
    id: 'trade-1',
    account_id: 'account-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1.00',
    open_price: '1.10000',
    stop_loss: '1.09000',
    take_profit: '1.12000',
    status: 'open',
    demo_pnl: '0.00',
    open_time: '2026-08-27T00:00:00.000Z',
    close_time: null,
    close_reason: null,
    order_type: 'market',
    open_screenshot_path: 'user-1/open.png',
    close_screenshot_path: null,
    r_multiple: null,
    open_screenshot_url: '/api/trades/trade-1/screenshot/open',
    close_screenshot_url: null
  })
})

void test('closed trade mapping keeps the existing R-multiple calculation', () => {
  const mapped = historyRouter.__test__.mapTradeRow(baseRow({
    status: 'closed',
    demo_pnl: '1000.00',
    close_time: '2026-08-27T01:00:00.000Z'
  }))
  assert.equal(mapped.r_multiple, 1)
})

void test('CSV cells remain quoted, escaped, and protected from formula injection', () => {
  assert.equal(historyRouter.__test__.csvSafeValue('normal'), '"normal"')
  assert.equal(historyRouter.__test__.csvSafeValue('say "hi"'), '"say ""hi"""')
  assert.equal(historyRouter.__test__.csvSafeValue('=2+2'), '"\'=2+2"')
  assert.equal(historyRouter.__test__.csvSafeValue('-10'), '"\'-10"')
})

void test('all history routes retain authenticateToken before their handlers', () => {
  const stack = (historyRouter as unknown as {
    stack: Array<{
      route?: {
        path: string
        stack: Array<{ name: string }>
      }
    }>
  }).stack
  const expected = new Map([
    ['/open', 'openTradesHandler'],
    ['/pending', 'pendingTradesHandler'],
    ['/history', 'tradeHistoryHandler'],
    ['/export', 'tradeExportHandler']
  ])
  for (const layer of stack) {
    const path = layer.route?.path
    if (!path || !expected.has(path)) continue
    assert.deepEqual(layer.route?.stack.map((handler) => handler.name), [
      'authenticateToken',
      expected.get(path)
    ])
    expected.delete(path)
  }
  assert.deepEqual([...expected.keys()], [])
})
