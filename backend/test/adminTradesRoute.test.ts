import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import type { PoolClient } from 'pg'
import router = require('../routes/admin/trades')

type CloseHandler = typeof router.__test__.forceCloseTradeHandlerWithDependencies
type CloseRequest = Parameters<CloseHandler>[0]
type CloseResponse = Parameters<CloseHandler>[1]
type CloseDependencies = Parameters<CloseHandler>[2]

interface CapturedResponse {
  response: CloseResponse
  statusCode: () => number
  body: () => unknown
}

interface ClientState {
  client: PoolClient
  events: string[]
  released: () => boolean
}

function makeResponse(events: string[]): CapturedResponse {
  let statusCode = 200
  let body: unknown
  const shape = {
    status(code: number) {
      statusCode = code
      return shape
    },
    json(value: unknown) {
      events.push('response')
      body = value
      return shape
    }
  }
  return {
    response: shape as unknown as CloseResponse,
    statusCode: () => statusCode,
    body: () => body
  }
}

function makeClient(): ClientState {
  const events: string[] = []
  let wasReleased = false
  const client = {
    async query(sqlInput: unknown) {
      const sql = String(sqlInput)
      events.push(sql)
      return { rows: [], rowCount: 1 }
    },
    release() {
      events.push('release')
      wasReleased = true
    }
  } as unknown as PoolClient
  return { client, events, released: () => wasReleased }
}

function makeRequest(tradeId: string, events: string[]): CloseRequest {
  const app = express()
  app.set('io', {
    to(room: string) {
      events.push(`room:${room}`)
      return {
        emit(event: string, payload: unknown) {
          events.push(`socket:${event}:${JSON.stringify(payload)}`)
        }
      }
    }
  })
  return { params: { tradeId }, app } as unknown as CloseRequest
}

function dependencies(
  state: ClientState,
  forceClose: CloseDependencies['forceClose'],
  audit: CloseDependencies['audit'] = async () => undefined
): CloseDependencies {
  return {
    database: { connect: async () => state.client },
    forceClose,
    audit
  }
}

void test('admin trade list normalization preserves direction, status, search fallback, and casing', () => {
  assert.deepEqual(router.__test__.normalizeTradeListQuery({
    direction: ' BUY ',
    status: ' CLOSED ',
    q: ' account-1 '
  }), {
    direction: ' buy ',
    status: ' closed ',
    search: 'account-1'
  })
})

void test('admin trade rows map decimal strings and ISO timestamps while preserving legacy numeric PnL', () => {
  const mapped = router.__test__.mapTradeListRow({
    id: 'trade-1',
    account_id: 'account-1',
    user_id: 'user-1',
    symbol: 'EURUSD',
    type: 'BUY',
    lots: '1',
    open_price: '1.1',
    close_price: null,
    sl: '1.09',
    tp: '1.12',
    status: 'open',
    demo_pnl: null,
    commission: '7',
    bid: '1.101',
    ask: '1.102',
    open_time: new Date('2026-08-27T00:00:00.000Z'),
    close_time: null
  })

  assert.equal(mapped.pnl, 93)
  assert.equal(mapped.open_price, '1.1')
  assert.equal(mapped.bid, '1.101')
  assert.equal(mapped.open_time, '2026-08-27T00:00:00.000Z')
  assert.equal(mapped.close_time, null)
  assert.equal(mapped.r_multiple, null)
})

void test('force close commits before emitting, returns the legacy response, and releases', async () => {
  const state = makeClient()
  const captured = makeResponse(state.events)
  const closed = {
    trade_id: 'trade-1',
    account_id: 'account-1',
    user_id: 'user-1',
    instrument: 'EURUSD',
    pnl: 93,
    close_price: 1.101
  }

  await router.__test__.forceCloseTradeHandlerWithDependencies(
    makeRequest(' trade-1 ', state.events),
    captured.response,
    dependencies(
      state,
      async (_client, tradeId, reason) => {
        state.events.push(`force:${tradeId}:${String(reason)}`)
        return closed
      },
      async (_client, input) => { state.events.push(`audit:${input.entityId}`) }
    )
  )

  assert.deepEqual(captured.body(), {
    message: 'Trade force-closed successfully',
    pnl: 93,
    close_price: 1.101
  })
  assert.equal(captured.statusCode(), 200)
  assert.ok(state.events.indexOf('BEGIN') < state.events.indexOf('force:trade-1:Admin Force Close'))
  assert.ok(state.events.indexOf('audit:trade-1') < state.events.indexOf('COMMIT'))
  assert.ok(state.events.indexOf('COMMIT') < state.events.indexOf('room:user-1'))
  assert.ok(state.events.some((event) => event.includes('Admin force-closed EURUSD: +$93.00')))
  assert.equal(state.released(), true)
})

void test('a missing or already-closed trade rolls back, returns 404, and releases', async () => {
  const state = makeClient()
  const captured = makeResponse(state.events)
  await router.__test__.forceCloseTradeHandlerWithDependencies(
    makeRequest('trade-missing', state.events),
    captured.response,
    dependencies(state, async () => null)
  )

  assert.equal(captured.statusCode(), 404)
  assert.deepEqual(captured.body(), { error: 'Trade not found or already closed' })
  assert.ok(state.events.includes('ROLLBACK'))
  assert.equal(state.events.includes('COMMIT'), false)
  assert.equal(state.events.some((event) => event.startsWith('socket:')), false)
  assert.equal(state.released(), true)
})

void test('a force-close failure rolls back, returns 500, and releases', async () => {
  const state = makeClient()
  const captured = makeResponse(state.events)
  await router.__test__.forceCloseTradeHandlerWithDependencies(
    makeRequest('trade-1', state.events),
    captured.response,
    dependencies(state, async () => { throw new Error('forced close failure') })
  )

  assert.equal(captured.statusCode(), 500)
  assert.deepEqual(captured.body(), { error: 'Could not force close trade' })
  assert.ok(state.events.includes('ROLLBACK'))
  assert.equal(state.events.includes('COMMIT'), false)
  assert.equal(state.released(), true)
})

void test('an immutable-audit failure remains best-effort and does not undo the close', async () => {
  const state = makeClient()
  const captured = makeResponse(state.events)
  await router.__test__.forceCloseTradeHandlerWithDependencies(
    makeRequest('trade-1', state.events),
    captured.response,
    dependencies(
      state,
      async () => ({
        trade_id: 'trade-1',
        account_id: 'account-1',
        user_id: 'user-1',
        instrument: 'EURUSD',
        pnl: -7,
        close_price: 1.1
      }),
      async () => { throw new Error('forced audit failure') }
    )
  )

  assert.equal(captured.statusCode(), 200)
  assert.ok(state.events.includes('COMMIT'))
  assert.equal(state.events.includes('ROLLBACK'), false)
  assert.equal(state.released(), true)
})

void test('an empty trade id preserves the 400 response and still releases the acquired client', async () => {
  const state = makeClient()
  const captured = makeResponse(state.events)
  await router.__test__.forceCloseTradeHandlerWithDependencies(
    makeRequest('   ', state.events),
    captured.response,
    dependencies(state, async () => null)
  )

  assert.equal(captured.statusCode(), 400)
  assert.deepEqual(captured.body(), { error: 'Valid trade id is required' })
  assert.equal(state.events.includes('BEGIN'), false)
  assert.equal(state.released(), true)
})
