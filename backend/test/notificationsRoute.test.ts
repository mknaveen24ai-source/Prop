import assert from 'node:assert/strict'
import test from 'node:test'
import pool = require('../db')
import notificationsRouter = require('../routes/notifications')

type ListRequest = Parameters<typeof notificationsRouter.__test__.listNotificationsHandler>[0]
type ListResponse = Parameters<typeof notificationsRouter.__test__.listNotificationsHandler>[1]

const originalPoolQuery = pool.query

function makeResponse(): {
  response: ListResponse
  status: () => number
  body: () => unknown
} {
  let statusCode = 200
  let responseBody: unknown
  const response = {
    status(code: number) { statusCode = code; return response },
    json(value: unknown) { responseBody = value; return response }
  }
  return {
    response: response as unknown as ListResponse,
    status: () => statusCode,
    body: () => responseBody
  }
}

void test.afterEach(() => {
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: originalPoolQuery
  })
})

void test('notification rows map bigint IDs and timestamps to public wire values', () => {
  assert.deepEqual(notificationsRouter.__test__.mapNotification({
    id: 42,
    type: 'info',
    title: null,
    message: 'Account updated',
    read: false,
    created_at: new Date('2026-08-27T00:00:00.000Z')
  }), {
    id: '42',
    type: 'info',
    title: null,
    message: 'Account updated',
    read: false,
    created_at: '2026-08-27T00:00:00.000Z'
  })
})

void test('notification list scopes the query to the authenticated user and maps rows', async () => {
  let values: unknown[] | undefined
  Object.defineProperty(pool, 'query', {
    configurable: true,
    writable: true,
    value: async (_sql: unknown, queryValues?: unknown[]) => {
      values = queryValues
      return { rows: [{
        id: '7',
        type: 'success',
        title: 'Done',
        message: 'Payout approved',
        read: true,
        created_at: '2026-08-27T01:00:00.000Z'
      }] }
    }
  })
  const captured = makeResponse()
  await notificationsRouter.__test__.listNotificationsHandler(
    { user: { userId: 'user-1' } } as unknown as ListRequest,
    captured.response
  )
  assert.equal(captured.status(), 200)
  assert.deepEqual(values, ['user-1', 50])
  assert.deepEqual(captured.body(), [{
    id: '7',
    type: 'success',
    title: 'Done',
    message: 'Payout approved',
    read: true,
    created_at: '2026-08-27T01:00:00.000Z'
  }])
})

void test('all notification routes retain authentication before named handlers', () => {
  const stack = (notificationsRouter as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ name: string }> } }>
  }).stack
  const expected = new Map([
    ['/', new Set(['listNotificationsHandler', 'clearNotificationsHandler'])],
    ['/mark-all-read', new Set(['markAllReadHandler'])]
  ])
  for (const layer of stack) {
    const path = layer.route?.path
    if (!path || !expected.has(path)) continue
    const names = layer.route?.stack.map((handler) => handler.name) ?? []
    assert.equal(names[0], 'authenticateToken')
    assert.ok(expected.get(path)?.has(names[1] || ''))
    expected.get(path)?.delete(names[1] || '')
  }
  assert.deepEqual([...expected.values()].flatMap((names) => [...names]), [])
})
