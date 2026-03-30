const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const { authenticateToken, authenticateAdmin } = require('../routes/middleware')
const pool = require('../db')

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this }
  }
}

test('authenticateToken accepts cookie token', async () => {
  process.env.JWT_SECRET = 'test-secret'
  pool.query = async () => ({ rows: [{ token_version: 1, is_banned: false }] })
  const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)

  const req = { headers: {}, cookies: { token } }
  const res = makeRes()
  let called = false

  await authenticateToken(req, res, () => { called = true })
  assert.equal(called, true)
  assert.equal(req.user.userId, 'u1')
})

test('authenticateAdmin accepts admin_token cookie', async () => {
  process.env.ADMIN_JWT_SECRET = 'admin-secret'
  const token = jwt.sign({ role: 'admin' }, process.env.ADMIN_JWT_SECRET)

  const req = { headers: {}, cookies: { admin_token: token } }
  const res = makeRes()
  let called = false

  await authenticateAdmin(req, res, () => { called = true })
  assert.equal(called, true)
  assert.equal(req.admin.role, 'admin')
})

test('authenticateAdmin rejects non-admin role', async () => {
  process.env.ADMIN_JWT_SECRET = 'admin-secret'
  const token = jwt.sign({ role: 'user' }, process.env.ADMIN_JWT_SECRET)

  const req = { headers: {}, cookies: { admin_token: token } }
  const res = makeRes()
  let called = false

  await authenticateAdmin(req, res, () => { called = true })
  assert.equal(called, false)
  assert.equal(res.statusCode, 403)
})
