import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import pool = require('../db')
import complianceRouter = require('../routes/admin/compliance')

type ApplyRequest = Parameters<typeof complianceRouter.__test__.applyEnforcementHandler>[0]
type ApplyResponse = Parameters<typeof complianceRouter.__test__.applyEnforcementHandler>[1]

interface QueryCall {
  sql: string
  values: unknown[] | undefined
}

interface MockClientOptions {
  accountFound?: boolean
  failEventInsert?: boolean
  failAuditInsert?: boolean
}

interface MockClientState {
  client: PoolClient
  calls: QueryCall[]
  released: () => boolean
}

interface CapturedResponse {
  response: ApplyResponse
  statusCode: () => number
  body: () => unknown
}

const originalPoolQuery = pool.query
const originalPoolConnect = pool.connect
let activeClient: PoolClient | null = null

function eventRow(action: string, status: string, message: string): Record<string, unknown> {
  return {
    id: 'event-1',
    rule_id: null,
    account_id: 'account-1',
    user_id: 'user-1',
    action,
    payload_json: { source: 'test' },
    status,
    message,
    created_at: new Date('2026-08-26T00:00:00.000Z')
  }
}

function makeClient(options: MockClientOptions = {}): MockClientState {
  const calls: QueryCall[] = []
  let wasReleased = false
  const query = async (sqlInput: unknown, values?: unknown[]): Promise<Record<string, unknown>> => {
    const sql = String(sqlInput)
    calls.push({ sql, values })

    if (/SELECT id, user_id, status FROM accounts/.test(sql)) {
      return options.accountFound === false
        ? { rows: [] }
        : { rows: [{ id: 'account-1', user_id: 'user-1', status: 'active' }] }
    }
    if (/SELECT t\.\*, a\.user_id/.test(sql)) return { rows: [] }
    if (/INSERT INTO admin_enforcement_events/.test(sql)) {
      if (options.failEventInsert) throw new Error('forced enforcement event failure')
      const action = Array.isArray(values) ? String(values[3]) : ''
      const status = Array.isArray(values) ? String(values[5]) : ''
      const message = Array.isArray(values) ? String(values[6]) : ''
      return { rows: [eventRow(action, status, message)] }
    }
    if (/SELECT entry_hash FROM admin_immutable_audit/.test(sql)) return { rows: [] }
    if (/INSERT INTO admin_immutable_audit/.test(sql)) {
      if (options.failAuditInsert) throw new Error('forced audit failure')
      return { rows: [{ id: 'audit-1' }] }
    }
    return { rows: [], rowCount: 1 }
  }

  const client = {
    query,
    release: () => { wasReleased = true }
  } as unknown as PoolClient

  return { client, calls, released: () => wasReleased }
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
    response: responseShape as unknown as ApplyResponse,
    statusCode: () => capturedStatus,
    body: () => capturedBody
  }
}

async function apply(body: unknown, state: MockClientState): Promise<CapturedResponse> {
  activeClient = state.client
  const captured = makeResponse()
  const request = { body } as unknown as ApplyRequest
  await complianceRouter.__test__.applyEnforcementHandler(request, captured.response)
  return captured
}

function findCall(state: MockClientState, pattern: RegExp): QueryCall | undefined {
  return state.calls.find((call) => pattern.test(call.sql))
}

void test('every compliance route keeps both admin authentication guards', () => {
  const stack = (complianceRouter as unknown as {
    stack: Array<{
      route?: {
        path: string
        stack: Array<{ name: string }>
      }
    }>
  }).stack

  const routes = stack.filter((layer) => layer.route)
  assert.equal(routes.length, 4)
  for (const layer of routes) {
    const handlerNames = layer.route?.stack.map((handler) => handler.name) || []
    assert.ok(handlerNames.includes('authenticateAdmin'), `${layer.route?.path} lost authenticateAdmin`)
    assert.ok(handlerNames.includes('requireSuperAdmin'), `${layer.route?.path} lost requireSuperAdmin`)
  }
})

void test.before(async () => {
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async () => ({ rows: [], rowCount: 0 })
  })
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: async () => {
      if (!activeClient) throw new Error('No compliance test client installed')
      return activeClient
    }
  })

  // Prime the shared feature-table bootstrap against the inert test pool. This
  // keeps every route assertion below focused on the compliance transaction.
  const state = makeClient()
  activeClient = state.client
  await apply({}, state)
})

void test.after(() => {
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: originalPoolQuery
  })
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    writable: true,
    value: originalPoolConnect
  })
})

void test('enforcement apply preserves both required-field errors', async () => {
  const missingAccountState = makeClient()
  const missingAccount = await apply({ action: 'lock_account' }, missingAccountState)
  assert.equal(missingAccount.statusCode(), 400)
  assert.deepEqual(missingAccount.body(), { error: 'account_id is required' })
  assert.equal(missingAccountState.released(), true)

  const missingActionState = makeClient()
  const missingAction = await apply({ account_id: 'account-1' }, missingActionState)
  assert.equal(missingAction.statusCode(), 400)
  assert.deepEqual(missingAction.body(), { error: 'action is required' })
  assert.equal(missingActionState.released(), true)
})

void test('enforcement apply rolls back and returns 404 for a missing account', async () => {
  const state = makeClient({ accountFound: false })
  const captured = await apply({ account_id: 'missing', action: 'lock_account' }, state)

  assert.equal(captured.statusCode(), 404)
  assert.deepEqual(captured.body(), { error: 'Account not found' })
  assert.ok(findCall(state, /^ROLLBACK$/))
  assert.equal(findCall(state, /^COMMIT$/), undefined)
  assert.equal(state.released(), true)
})

void test('every supported enforcement action preserves its transaction and response behavior', async () => {
  const cases = [
    {
      action: 'lock_account',
      expectedMessage: 'Account locked',
      expectedSql: /SET status = 'locked'/
    },
    {
      action: 'force_close_open_trades',
      expectedMessage: 'Force-closed 0 open trades; total P&L +$0.00',
      expectedSql: /SELECT t\.id, t\.instrument, t\.direction, t\.open_price, t\.lot_size, t\.commission/
    },
    {
      action: 'flag_for_review',
      expectedMessage: 'Account flagged for manual review',
      expectedSql: /SET review_flagged = TRUE/
    }
  ] as const

  for (const scenario of cases) {
    const state = makeClient()
    const captured = await apply({
      account_id: 'account-1',
      action: scenario.action,
      reason: 'review reason',
      payload: { source: 'test' }
    }, state)

    assert.equal(captured.statusCode(), 200)
    const body = captured.body() as {
      message?: unknown
      event?: { action?: unknown; status?: unknown; created_at?: unknown }
    }
    assert.equal(body.message, scenario.expectedMessage)
    assert.equal(body.event?.action, scenario.action)
    assert.equal(body.event?.status, 'applied')
    assert.equal(body.event?.created_at, '2026-08-26T00:00:00.000Z')
    assert.ok(findCall(state, scenario.expectedSql), `${scenario.action} did not run its expected SQL`)
    assert.ok(findCall(state, /^BEGIN$/))
    assert.ok(findCall(state, /^COMMIT$/))
    assert.equal(findCall(state, /^ROLLBACK$/), undefined)
    assert.equal(state.released(), true)
  }
})

void test('an unsupported action is recorded as a failed event without changing the account', async () => {
  const state = makeClient()
  const captured = await apply({ account_id: 'account-1', action: 'future_action' }, state)

  assert.equal(captured.statusCode(), 200)
  assert.equal((captured.body() as { message?: unknown }).message, 'Unsupported action: future_action')
  const eventInsert = findCall(state, /INSERT INTO admin_enforcement_events/)
  assert.equal(eventInsert?.values?.[5], 'failed')
  assert.equal(findCall(state, /UPDATE accounts SET status = 'locked'/), undefined)
  assert.equal(findCall(state, /SET review_flagged = TRUE/), undefined)
  assert.ok(findCall(state, /^COMMIT$/))
})

void test('an enforcement-event write failure rolls the whole action back', async () => {
  const state = makeClient({ failEventInsert: true })
  const captured = await apply({ account_id: 'account-1', action: 'lock_account' }, state)

  assert.equal(captured.statusCode(), 500)
  assert.deepEqual(captured.body(), { error: 'Failed to apply enforcement action' })
  assert.ok(findCall(state, /SET status = 'locked'/), 'the failure must occur after the transactional update')
  assert.ok(findCall(state, /^ROLLBACK$/))
  assert.equal(findCall(state, /^COMMIT$/), undefined)
  assert.equal(state.released(), true)
})

void test('immutable-audit failure remains best-effort and does not undo enforcement', async () => {
  const state = makeClient({ failAuditInsert: true })
  const captured = await apply({ account_id: 'account-1', action: 'flag_for_review' }, state)

  assert.equal(captured.statusCode(), 200)
  assert.ok(findCall(state, /INSERT INTO admin_immutable_audit/))
  assert.ok(findCall(state, /^COMMIT$/))
  assert.equal(findCall(state, /^ROLLBACK$/), undefined)
})

void test('fraud-score boundaries remain low below 40, medium at 40, and high at 70', () => {
  const now = Date.parse('2026-08-26T00:00:00.000Z')
  const baseRow = {
    id: 'payout-1',
    user_id: 'user-1',
    account_id: 'account-1',
    amount_requested: '1000',
    status: 'pending',
    requested_at: '2026-08-25T00:00:00.000Z',
    full_name: 'Trader',
    email: 'trader@example.com',
    kyc_status: 'approved',
    account_size: '10000',
    account_created_at: '2026-07-01T00:00:00.000Z'
  }

  const low = complianceRouter.__test__.buildPayoutFraudScore(
    baseRow,
    { openTradeCount: 0, recentTradeCount: 0, sharedUsers: 1 },
    now
  )
  assert.equal(low.score, 0)
  assert.equal(low.risk_level, 'low')

  const medium = complianceRouter.__test__.buildPayoutFraudScore(
    { ...baseRow, amount_requested: '2000.01' },
    { openTradeCount: 1, recentTradeCount: 0, sharedUsers: 1 },
    now
  )
  assert.equal(medium.score, 40)
  assert.equal(medium.risk_level, 'medium')

  const high = complianceRouter.__test__.buildPayoutFraudScore(
    {
      ...baseRow,
      amount_requested: '2000.01',
      account_created_at: '2026-08-25T00:00:00.000Z'
    },
    { openTradeCount: 1, recentTradeCount: 10, sharedUsers: 1 },
    now
  )
  assert.equal(high.score, 70)
  assert.equal(high.risk_level, 'high')
})

void test('device graph focus filtering preserves only the requested user and aggregates edge weights', () => {
  const generatedAt = '2026-08-26T00:00:00.000Z'
  const graph = complianceRouter.__test__.buildDeviceLinkGraph(
    [
      { user_id: 'user-a', ip_address: '203.0.113.10', logged_in_at: generatedAt },
      { user_id: 'user-a', ip_address: '203.0.113.10', logged_in_at: generatedAt },
      { user_id: 'user-b', ip_address: '203.0.113.10', logged_in_at: generatedAt }
    ],
    [
      { user_id: 'user-a', account_id: 'account-a', ip_address: '203.0.113.10', logged_at: generatedAt },
      { user_id: 'user-b', account_id: 'account-b', ip_address: '203.0.113.10', logged_at: generatedAt }
    ],
    'user-a',
    generatedAt
  )

  assert.equal(graph.generated_at, generatedAt)
  assert.ok(graph.nodes.some((node) => node.id === 'u:user-a'))
  assert.ok(graph.nodes.some((node) => node.id === 'a:account-a'))
  assert.equal(graph.nodes.some((node) => node.id.includes('user-b') || node.id.includes('account-b')), false)
  assert.equal(
    graph.edges.find((edge) => edge.id === 'u:user-a|ip:203.0.113.10|login_ip')?.weight,
    2
  )
})
