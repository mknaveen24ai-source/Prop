import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import pool = require('../db')
import closeRouter = require('../routes/trades/close')

type CloseRequest = Parameters<typeof closeRouter.__test__.closeTradeHandler>[0]
type CloseResponse = Parameters<typeof closeRouter.__test__.closeTradeHandler>[1]
type CancelRequest = Parameters<typeof closeRouter.__test__.cancelTradeHandler>[0]

interface QueryCall {
  sql: string
  values: unknown[] | undefined
}

interface CapturedResponse {
  response: CloseResponse
  statusCode: () => number
  body: () => unknown
}

const originalPoolQuery = pool.query
const originalPoolConnect = pool.connect
const dependencySnapshot = { ...closeRouter.__test__.dependencies }

function preflightTrade(): Record<string, unknown> {
  return {
    id: 'trade-1',
    account_id: 'account-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1.00',
    open_price: '1.10000',
    open_time: new Date('2026-08-26T00:00:00.000Z'),
    status: 'open',
    commission: '0',
    original_commission: '0',
    stop_loss: '1.09000',
    take_profit: '1.12000',
    user_id: 'user-1',
    account_type: 'phase1'
  }
}

function lockedTrade(): Record<string, unknown> {
  const trade = preflightTrade()
  return {
    id: trade.id,
    account_id: trade.account_id,
    instrument: trade.instrument,
    direction: trade.direction,
    lot_size: trade.lot_size,
    open_price: trade.open_price,
    open_time: trade.open_time,
    commission: trade.commission,
    original_commission: trade.original_commission
  }
}

function makeResponse(): CapturedResponse {
  let capturedStatus = 200
  let capturedBody: unknown
  const responseShape = {
    status(code: number) {
      capturedStatus = code
      return responseShape
    },
    json(value: unknown) {
      capturedBody = value
      return responseShape
    }
  }
  return {
    response: responseShape as unknown as CloseResponse,
    statusCode: () => capturedStatus,
    body: () => capturedBody
  }
}

function installDependencies(events: string[]): void {
  const dependencies = closeRouter.__test__.dependencies
  dependencies.ensureInfrastructure = async () => {}
  dependencies.getTradingRules = async () => ({
    minHoldSeconds: 0,
    forexLotsPer1k: 0.1,
    commodityLotsPer1k: 0.02,
    minLotSize: 0.01,
    maxTradesPer1k: 5,
    maxOpenPositions: 10,
    maxDailyTrades: 20,
    maxNotionalMultiple: 500,
    dynamicCommissionPerLot: 0,
    slippageSimulatorEnabled: false,
    slippageMaxPipsAdverse: 0,
    weekendHoldingEnabled: true
  })
  dependencies.getLivePrice = async () => ({
    bid: 1.105,
    ask: 1.1052,
    updated_at: new Date()
  })
  dependencies.getMarketStatus = () => ({ open: true, reason: '' })
  dependencies.calculatePnl = () => 12.34
  dependencies.engine = () => ({
    syncOpenedTrade: async () => { events.push('sync-open') },
    syncClosedTrade: () => { events.push('sync-closed') }
  })
  dependencies.publishTradeIndex = async () => {
    events.push('publish')
    return true
  }
  dependencies.getAccountEntry = () => null
  dependencies.applyRealizedPnl = () => { events.push('realized-cache') }
  dependencies.updateAccountBalance = () => { events.push('balance-cache') }
  dependencies.persistScreenshot = async () => null
  dependencies.random = () => 0.5
  dependencies.waitForLockRetry = async () => {}
}

function installPreflightQuery(): void {
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => ({ rows: [preflightTrade()], rowCount: 1 })
  })
}

function installClient(options: { failBalance?: boolean; events: string[] }): QueryCall[] {
  const calls: QueryCall[] = []
  const query = async (sqlInput: unknown, values?: unknown[]): Promise<Record<string, unknown>> => {
    const sql = String(sqlInput)
    calls.push({ sql, values })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') options.events.push(sql)
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [lockedTrade()], rowCount: 1 }
    if (/UPDATE accounts SET/.test(sql) && options.failBalance) {
      throw new Error('forced balance failure')
    }
    return { rows: [], rowCount: 1 }
  }
  const client = {
    query,
    release: () => { options.events.push('release') }
  } as unknown as PoolClient
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: async () => client
  })
  return calls
}

async function runClose(body: unknown): Promise<CapturedResponse> {
  const captured = makeResponse()
  await closeRouter.__test__.closeTradeHandler(
    {
      body,
      user: { userId: 'user-1' },
      app: { get: () => undefined }
    } as unknown as CloseRequest,
    captured.response
  )
  return captured
}

void test.afterEach(() => {
  Object.defineProperty(pool, 'query', { configurable: true, writable: true, value: originalPoolQuery })
  Object.defineProperty(pool, 'connect', { configurable: true, writable: true, value: originalPoolConnect })
  Object.assign(closeRouter.__test__.dependencies, dependencySnapshot)
})

void test('close validates an unknown body before any database query', async () => {
  let queried = false
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => { queried = true; return { rows: [] } }
  })
  closeRouter.__test__.dependencies.ensureInfrastructure = async () => {}
  const response = await runClose(['not', 'an', 'object'])
  assert.equal(response.statusCode(), 400)
  assert.deepEqual(response.body(), { error: 'Trade ID required' })
  assert.equal(queried, false)
})

void test('a balance-write failure rolls back and emits no post-commit side effects', async () => {
  const events: string[] = []
  installDependencies(events)
  installPreflightQuery()
  installClient({ failBalance: true, events })

  const response = await runClose({ trade_id: 'trade-1' })
  assert.equal(response.statusCode(), 500)
  assert.deepEqual(response.body(), { error: 'Could not close trade' })
  assert.deepEqual(events, ['BEGIN', 'ROLLBACK', 'release'])
})

void test('a successful close persists decimal strings and commits before index publication', async () => {
  const events: string[] = []
  installDependencies(events)
  installPreflightQuery()
  const calls = installClient({ events })

  const response = await runClose({ trade_id: 'trade-1' })
  const tradeUpdate = calls.find((call) => /status = 'closed'/.test(call.sql))
  const accountUpdate = calls.find((call) => /UPDATE accounts SET/.test(call.sql))
  assert.deepEqual(tradeUpdate?.values, ['1.105', '12.34', 'trade-1'])
  assert.deepEqual(accountUpdate?.values, ['12.34', 'account-1'])
  assert.deepEqual(events, ['BEGIN', 'COMMIT', 'release', 'sync-closed', 'publish'])
  assert.equal(response.statusCode(), 200)
  assert.deepEqual(response.body(), {
    message: 'Trade closed successfully',
    pnl: 12.34,
    close_price: 1.105,
    is_partial: false,
    remaining_lots: 0
  })
})

void test('a raced pending cancel never removes the order from the index', async () => {
  let queryCount = 0
  let removed = false
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => {
      queryCount += 1
      if (queryCount === 1) {
        return { rows: [{ id: 'trade-1', account_id: 'account-1', user_id: 'user-1' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
  })
  closeRouter.__test__.dependencies.removePending = () => { removed = true; return true }
  const captured = makeResponse()
  await closeRouter.__test__.cancelTradeHandler(
    { body: { trade_id: 'trade-1' }, user: { userId: 'user-1' } } as unknown as CancelRequest,
    captured.response
  )
  assert.equal(captured.statusCode(), 409)
  assert.deepEqual(captured.body(), { error: 'Pending order was already processed' })
  assert.equal(removed, false)
})

void test('close and cancel retain authentication, limiter, and named handler order', () => {
  const stack = (closeRouter as unknown as {
    stack: Array<{
      route?: { path: string; stack: Array<{ name: string }> }
    }>
  }).stack
  const expected = new Map([
    ['/close', 'closeTradeHandler'],
    ['/cancel', 'cancelTradeHandler']
  ])
  for (const layer of stack) {
    const path = layer.route?.path
    if (!path || !expected.has(path)) continue
    assert.deepEqual(layer.route?.stack.map((handler) => handler.name), [
      'authenticateToken',
      '<anonymous>',
      expected.get(path)
    ])
    expected.delete(path)
  }
  assert.deepEqual([...expected.keys()], [])
})
