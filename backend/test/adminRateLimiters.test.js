const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const request = require('supertest')
const {
  adminKey,
  buildAdminLimiter,
  adminModerationLimiter,
  adminBulkLimiter
} = require('../routes/admin/shared/rateLimiters')

// These limiters exist to cap the blast radius of destructive admin actions.
// The key generator is the part worth pinning: keying on IP instead of the
// acting admin would make one admin's bulk run lock out the whole desk, since
// admins commonly share an office egress IP.

test('adminKey keys on adminId when the platform-admin path set one', () => {
  assert.equal(adminKey({ admin: { adminId: 42, email: 'a@x.com' }, ip: '1.2.3.4' }), 'admin:42')
})

test('adminKey falls back to email for the legacy env-backed token', () => {
  // authenticateAdmin's env-fallback branch never sets adminId.
  assert.equal(adminKey({ admin: { email: 'Owner@X.com' }, ip: '1.2.3.4' }), 'admin:owner@x.com')
})

test('adminKey distinguishes two admins behind one IP', () => {
  const shared = '203.0.113.7'
  const a = adminKey({ admin: { adminId: 1 }, ip: shared })
  const b = adminKey({ admin: { adminId: 2 }, ip: shared })
  assert.notEqual(a, b)
})

test('adminKey falls back to the IP key when there is no admin at all', () => {
  const key = adminKey({ ip: '198.51.100.4', ips: [], socket: { remoteAddress: '198.51.100.4' } })
  assert.ok(key)
  assert.ok(!key.startsWith('admin:'))
})

test('adminKey ignores a blank adminId rather than keying every admin the same', () => {
  // '' would otherwise collapse to the single key "admin:" for all admins.
  const key = adminKey({ admin: { adminId: '', email: 'b@x.com' }, ip: '1.2.3.4' })
  assert.equal(key, 'admin:b@x.com')
})

// ─── Enforcement ─────────────────────────────────────────────────────────────

function appWithLimiter(limiter) {
  const app = express()
  app.use(express.json())
  app.post('/act', (req, _res, next) => {
    // Stand-in for authenticateAdmin, which must run before the limiter.
    req.admin = { adminId: req.headers['x-admin-id'] }
    next()
  }, limiter, (_req, res) => res.json({ ok: true }))
  return app
}

test('the bulk limiter stops the fourth call in a window', async () => {
  const app = appWithLimiter(adminBulkLimiter)
  for (let i = 0; i < 3; i++) {
    const res = await request(app).post('/act').set('x-admin-id', 'bulk-1')
    assert.equal(res.status, 200, `call ${i + 1} should pass`)
  }
  const blocked = await request(app).post('/act').set('x-admin-id', 'bulk-1')
  assert.equal(blocked.status, 429)
  assert.match(blocked.body.error, /bulk operations/i)
})

test('one admin exhausting the limit does not block another', async () => {
  const app = appWithLimiter(buildAdminLimiter({ max: 1, message: 'slow down' }))

  assert.equal((await request(app).post('/act').set('x-admin-id', 'first')).status, 200)
  assert.equal((await request(app).post('/act').set('x-admin-id', 'first')).status, 429)

  // Different admin, same connection — must still be allowed through.
  assert.equal((await request(app).post('/act').set('x-admin-id', 'second')).status, 200)
})

test('the moderation limiter allows a normal review run of ten', async () => {
  const app = appWithLimiter(adminModerationLimiter)
  for (let i = 0; i < 10; i++) {
    const res = await request(app).post('/act').set('x-admin-id', 'mod-1')
    assert.equal(res.status, 200, `call ${i + 1} should pass`)
  }
  assert.equal((await request(app).post('/act').set('x-admin-id', 'mod-1')).status, 429)
})
