const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const request = require('supertest')
require('../loadEnv')
const pool = require('../db')
const supportRoutes = require('../routes/support')
const disputesRouter = require('../routes/disputes')

// Guards the Phase 0 route consolidation. Support tickets and disputes used to
// be served by handlers written inline in server.js; routes/support.js was a
// complete but unmounted duplicate, and routes/disputes.js shadowed the inline
// dispute handlers because it was mounted above them. These tests pin the
// behaviour that survived the merge so a future re-shuffle can't silently drop
// it again — in particular sla_due_at (which only the inline version set) and
// the admin PATCH fields (which only the inline version supported).
//
// Follows test/tradesHttp.test.js: mock the shared `pool` singleton, then drive
// the real Express routers through supertest.

const app = express()
app.use(express.json())
app.use('/api/support', supportRoutes.router)
app.use('/api/admin', supportRoutes.adminRouter)
app.use('/api/disputes', disputesRouter)

const USER_ID = 'user-support-1'
const userToken = `Bearer ${jwt.sign({ userId: USER_ID, tv: 0 }, process.env.JWT_SECRET)}`
const adminToken = `Bearer ${jwt.sign(
  { role: 'super_admin', atv: 999, email: 'admin@test.local' },
  process.env.ADMIN_JWT_SECRET
)}`

function installPoolMock(queryHandlers = []) {
  const calls = []
  pool.query = async (sql, values) => {
    calls.push({ sql, values })
    for (const [pattern, handler] of queryHandlers) {
      if (pattern.test(sql)) return handler(sql, values)
    }
    if (/SELECT token_version, is_banned FROM users/.test(sql)) {
      return { rows: [{ token_version: 0, is_banned: false }] }
    }
    // FIX (H-07): admin_token_version must resolve. authenticateAdmin used to
    // skip revocation entirely when this row was absent, so returning [] here
    // was asserting the hole. Migration 029 seeds it in every real database.
    if (/admin_token_version/.test(sql)) {
      return { rows: [{ value: '1' }] }
    }
    // ensureDisputesInfrastructure and other DDL
    return { rows: [] }
  }
  return calls
}

function findCall(calls, pattern) {
  return calls.find((call) => pattern.test(call.sql))
}

// ─── Support: user-facing ────────────────────────────────────────────────────

test('POST /api/support/ticket persists sla_due_at', async () => {
  const calls = installPoolMock()

  const res = await request(app)
    .post('/api/support/ticket')
    .set('Authorization', userToken)
    .send({ category: 'payout', subject: 'Payout stuck', message: 'My payout has been pending for six days now.' })

  assert.equal(res.status, 201)
  const insert = findCall(calls, /INSERT INTO support_tickets/i)
  assert.ok(insert, 'expected a support_tickets insert')
  assert.match(insert.sql, /sla_due_at/, 'sla_due_at must survive the move out of server.js')
  assert.match(insert.sql, /NOW\(\) \+ INTERVAL '24 hours'/)
})

test('POST /api/support/ticket runs the shared normalizer, not ad-hoc sanitising', async () => {
  installPoolMock()

  // Empty subject is rejected by normalizeSupportTicketPayload with this exact
  // wording. If this assertion fails the live path has drifted back off the
  // tested validator in utils/supportValidation.js.
  const res = await request(app)
    .post('/api/support/ticket')
    .set('Authorization', userToken)
    .send({ category: 'account', subject: '   ', message: 'A message long enough to pass.' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Subject is required/)
})

test('POST /api/support/ticket coerces an unknown category to "other"', async () => {
  const calls = installPoolMock()

  const res = await request(app)
    .post('/api/support/ticket')
    .set('Authorization', userToken)
    .send({ category: 'not-a-real-category', subject: 'Hi', message: 'Some message body.' })

  assert.equal(res.status, 201)
  const insert = findCall(calls, /INSERT INTO support_tickets/i)
  assert.equal(insert.values[3], 'other')
})

test('POST /api/support/ticket is accepted without auth (public contact form)', async () => {
  installPoolMock()

  const res = await request(app)
    .post('/api/support/ticket')
    .send({ category: 'other', subject: 'Question', message: 'Do you accept traders from my country?', email: 'guest@example.com' })

  assert.equal(res.status, 201)
})

test('GET /api/support/tickets requires auth', async () => {
  installPoolMock()
  const res = await request(app).get('/api/support/tickets')
  assert.equal(res.status, 401)
})

// ─── Support: admin-facing ───────────────────────────────────────────────────

test('PATCH /api/admin/support-tickets/:id updates internal_notes', async () => {
  // SupportAppealsCenter.jsx patches { internal_notes } on its own; the partial
  // handler this file's router used to carry only understood `status` and would
  // have 400'd here.
  const calls = installPoolMock([
    [/UPDATE support_tickets/i, () => ({ rows: [{ id: 7, internal_notes: 'Escalated to risk.' }] })]
  ])

  const res = await request(app)
    .patch('/api/admin/support-tickets/7')
    .set('Authorization', adminToken)
    .send({ internal_notes: 'Escalated to risk.' })

  assert.equal(res.status, 200)
  const update = findCall(calls, /UPDATE support_tickets/i)
  assert.match(update.sql, /internal_notes = \$1/)
})

test('PATCH /api/admin/support-tickets/:id updates assigned_agent', async () => {
  const calls = installPoolMock([
    [/UPDATE support_tickets/i, () => ({ rows: [{ id: 7 }] })]
  ])

  const res = await request(app)
    .patch('/api/admin/support-tickets/7')
    .set('Authorization', adminToken)
    .send({ assigned_agent: 'dana' })

  assert.equal(res.status, 200)
  assert.match(findCall(calls, /UPDATE support_tickets/i).sql, /assigned_agent = \$1/)
})

test('PATCH /api/admin/support-tickets/:id rejects an invalid status', async () => {
  installPoolMock()

  const res = await request(app)
    .patch('/api/admin/support-tickets/7')
    .set('Authorization', adminToken)
    .send({ status: 'banana' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Invalid status/)
})

test('PATCH /api/admin/support-tickets/:id rejects an empty patch', async () => {
  installPoolMock()

  const res = await request(app)
    .patch('/api/admin/support-tickets/7')
    .set('Authorization', adminToken)
    .send({})

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Nothing to update/)
})

test('GET /api/admin/support-tickets/:id returns the ticket with its thread', async () => {
  installPoolMock([
    [/SELECT \* FROM support_tickets WHERE id/i, () => ({ rows: [{ id: 7, subject: 'Payout stuck' }] })],
    [/FROM support_ticket_messages/i, () => ({ rows: [{ id: 1, sender_type: 'user', message: 'hello' }] })]
  ])

  const res = await request(app)
    .get('/api/admin/support-tickets/7')
    .set('Authorization', adminToken)

  assert.equal(res.status, 200)
  assert.equal(res.body.ticket.id, 7)
  assert.equal(res.body.messages.length, 1)
})

test('POST /api/admin/support-tickets/:id/reply attributes the reply to the admin', async () => {
  const calls = installPoolMock([
    [/SELECT id FROM support_tickets/i, () => ({ rows: [{ id: 7 }] })],
    [/INSERT INTO support_ticket_messages/i, () => ({ rows: [{ id: 2, sender_type: 'admin' }] })]
  ])

  const res = await request(app)
    .post('/api/admin/support-tickets/7/reply')
    .set('Authorization', adminToken)
    .send({ message: 'We have released your payout.' })

  assert.equal(res.status, 201)
  const insert = findCall(calls, /INSERT INTO support_ticket_messages/i)
  // sender_type is hard-coded 'admin' in the SQL; sender_name falls back
  // through full_name → email → 'Support'. authenticateAdmin's env-fallback
  // branch supplies 'Platform Owner' as full_name when the JWT carries none.
  assert.match(insert.sql, /'admin'/)
  assert.equal(insert.values[1], 'Platform Owner')
})

test('admin support routes reject a non-admin token', async () => {
  installPoolMock()
  const res = await request(app)
    .get('/api/admin/support-tickets')
    .set('Authorization', userToken)
  assert.equal(res.status, 403)
})

// ─── Disputes ────────────────────────────────────────────────────────────────

test('POST /api/disputes/submit enforces the reason allowlist', async () => {
  // The deleted server.js copy had no allowlist. Its absence here would mean
  // the dead handler had been resurrected ahead of the router.
  installPoolMock()

  const res = await request(app)
    .post('/api/disputes/submit')
    .set('Authorization', userToken)
    .send({ account_id: 'acc-1', reason: 'I just disagree', description: 'A description that is comfortably long enough.' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Invalid dispute reason/)
})

test('POST /api/disputes/submit accepts a 20-char description the deleted handler would have rejected', async () => {
  // The dead inline handler required 30 characters and at least one closed
  // trade. This 25-char body proves the router's rules are the live ones.
  installPoolMock([
    [/SELECT status\s+FROM accounts/i, () => ({ rows: [{ status: 'failed' }] })],
    [/INSERT INTO disputes/i, () => ({ rows: [{ id: 11, status: 'open' }] })]
  ])

  const res = await request(app)
    .post('/api/disputes/submit')
    .set('Authorization', userToken)
    .send({ account_id: 'acc-1', reason: 'Price feed error', description: 'Bad tick closed my trade' })

  assert.equal(res.status, 200)
  assert.equal(res.body.dispute.id, 11)
})

test('POST /api/disputes/submit rejects an account that is still active', async () => {
  installPoolMock([
    [/SELECT status\s+FROM accounts/i, () => ({ rows: [{ status: 'active' }] })]
  ])

  const res = await request(app)
    .post('/api/disputes/submit')
    .set('Authorization', userToken)
    .send({ account_id: 'acc-1', reason: 'Price feed error', description: 'A description that is long enough.' })

  assert.equal(res.status, 400)
  assert.match(res.body.error, /failed or expired/)
})

test('GET /api/disputes/all is reachable and not captured by /:id', async () => {
  // /all moved out of server.js into the router. If it were registered after
  // a `/:id` route it would be swallowed; this pins the ordering.
  installPoolMock([
    [/FROM disputes d\s+JOIN users u/i, () => ({ rows: [{ id: 1, email: 'trader@example.com' }] })]
  ])

  const res = await request(app)
    .get('/api/disputes/all')
    .set('Authorization', adminToken)

  assert.equal(res.status, 200)
  assert.equal(res.body[0].email, 'trader@example.com')
})

test('GET /api/disputes/all rejects a non-admin token', async () => {
  installPoolMock()
  const res = await request(app)
    .get('/api/disputes/all')
    .set('Authorization', userToken)
  assert.equal(res.status, 403)
})

test('PATCH /api/disputes/:id validates status and updates', async () => {
  const calls = installPoolMock([
    [/UPDATE disputes SET status/i, () => ({ rows: [{ id: 4, status: 'resolved' }] })]
  ])

  const bad = await request(app)
    .patch('/api/disputes/4')
    .set('Authorization', adminToken)
    .send({ status: 'nope' })
  assert.equal(bad.status, 400)

  const ok = await request(app)
    .patch('/api/disputes/4')
    .set('Authorization', adminToken)
    .send({ status: 'resolved', admin_response: 'Overturned.' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.dispute.status, 'resolved')
  assert.ok(findCall(calls, /UPDATE disputes SET status/i))
})

test('PATCH /api/disputes/:id returns 404 for an unknown dispute', async () => {
  installPoolMock([
    [/UPDATE disputes SET status/i, () => ({ rows: [] })]
  ])

  const res = await request(app)
    .patch('/api/disputes/999')
    .set('Authorization', adminToken)
    .send({ status: 'resolved' })

  assert.equal(res.status, 404)
})
