import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import pool = require('../db')
import batchRouter = require('../routes/trades/batch')

type BatchRequest = Parameters<typeof batchRouter.__test__.batchActionHandler>[0]
type BatchResponse = Parameters<typeof batchRouter.__test__.batchActionHandler>[1]

interface QueryCall {
  sql: string
  values: unknown[] | undefined
}

interface CapturedResponse {
  response: BatchResponse
  statusCode: () => number
  body: () => unknown
}

interface MockClientState {
  client: PoolClient
  calls: QueryCall[]
  released: () => boolean
}

const originalPoolQuery = pool.query
const originalPoolConnect = pool.connect
const dependencySnapshot = { ...batchRouter.__test__.dependencies }

function tradeRow(): Record<string, unknown> {
  return {
    id: 'trade-1',
    account_id: 'account-1',
    instrument: 'EURUSD',
    direction: 'buy',
    lot_size: '1.00',
    open_price: '1.10000',
    stop_loss: '1.09000',
    take_profit: '1.12000',
    commission: '0',
    open_time: new Date('2026-08-26T00:00:00.000Z')
  }
}

function makeClient(failTradeUpdate = false, events: string[] = []): MockClientState {
  const calls: QueryCall[] = []
  let wasReleased = false
  const query = async (sqlInput: unknown, values?: unknown[]): Promise<Record<string, unknown>> => {
    const sql = String(sqlInput)
    calls.push({ sql, values })
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') events.push(sql)
    if (/FOR UPDATE SKIP LOCKED/.test(sql)) return { rows: [{ id: 'trade-1' }] }
    if (/UPDATE trades SET status = 'closed'/.test(sql) && failTradeUpdate) {
      throw new Error('forced trade update failure')
    }
    return { rows: [], rowCount: 1 }
  }
  return {
    client: { query, release: () => { wasReleased = true } } as unknown as PoolClient,
    calls,
    released: () => wasReleased
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
    response: responseShape as unknown as BatchResponse,
    statusCode: () => capturedStatus,
    body: () => capturedBody
  }
}

function installDependencies(events: string[]): void {
  const dependencies = batchRouter.__test__.dependencies
  dependencies.getActiveNewsEvent = () => null
  dependencies.getTradingRules = async () => ({ minHoldSeconds: 0 })
  dependencies.getLivePrice = async () => ({ bid: '1.10500', ask: '1.10520' })
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
  dependencies.updateAccountBalance = () => { events.push('balance-cache') }
}

async function run(body: unknown): Promise<CapturedResponse> {
  const captured = makeResponse()
  await batchRouter.__test__.batchActionHandler(
    { body, user: { userId: 'user-1' } } as unknown as BatchRequest,
    captured.response
  )
  return captured
}

void test.afterEach(() => {
  Object.defineProperty(pool, 'query', { configurable: true, writable: true, value: originalPoolQuery })
  Object.defineProperty(pool, 'connect', { configurable: true, writable: true, value: originalPoolConnect })
  Object.assign(batchRouter.__test__.dependencies, dependencySnapshot)
})

void test('batch action validates the unknown request body before database use', async () => {
  let queried = false
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => { queried = true; return { rows: [] } }
  })
  const response = await run({ action: 'invalid', account_id: 'account-1' })
  assert.equal(response.statusCode(), 400)
  assert.deepEqual(response.body(), { error: 'Invalid batch action or account ID' })
  assert.equal(queried, false)
})

void test('a failed per-trade write rolls back and emits no index side effects', async () => {
  const events: string[] = []
  const state = makeClient(true, events)
  installDependencies(events)
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => ({ rows: [tradeRow()] })
  })
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: async () => state.client
  })

  const response = await run({ action: 'close_winning', account_id: 'account-1' })
  assert.equal(response.statusCode(), 200)
  assert.deepEqual(events, ['BEGIN', 'ROLLBACK'])
  assert.equal(state.released(), true)
  assert.match(String(JSON.stringify(response.body())), /"error":1/)
})

void test('successful close commits decimal strings before index synchronization', async () => {
  const events: string[] = []
  const state = makeClient(false, events)
  installDependencies(events)
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => ({ rows: [tradeRow()] })
  })
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: async () => state.client
  })

  const response = await run({ action: 'close_winning', account_id: 'account-1' })
  const tradeUpdate = state.calls.find((call) => /UPDATE trades SET status = 'closed'/.test(call.sql))
  const accountUpdate = state.calls.find((call) => /UPDATE accounts SET current_balance/.test(call.sql))
  assert.deepEqual(tradeUpdate?.values, ['1.105', '12.34', 'trade-1'])
  assert.deepEqual(accountUpdate?.values, ['12.34', 'account-1'])
  assert.deepEqual(events, ['BEGIN', 'COMMIT', 'sync-closed', 'publish'])
  assert.equal(state.released(), true)
  assert.match(String(JSON.stringify(response.body())), /"affected":1/)
})

void test('batch route retains authentication and rate limiting before the handler', () => {
  const stack = (batchRouter as unknown as {
    stack: Array<{
      route?: { path: string; stack: Array<{ name: string }> }
    }>
  }).stack
  const route = stack.find((layer) => layer.route?.path === '/batch-action')
  assert.ok(route)
  assert.deepEqual(route.route?.stack.map((handler) => handler.name), [
    'authenticateToken',
    '<anonymous>',
    'batchActionHandler'
  ])
})
