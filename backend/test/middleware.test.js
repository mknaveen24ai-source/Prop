const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const { authenticateToken, authenticateAdmin, ROLE_PERMISSIONS } = require('../routes/middleware')
const pool = require('../db')

const ROLE_PERMISSIONS_ROLES = Object.keys(ROLE_PERMISSIONS)

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(payload) { this.body = payload; return this }
  }
}

// Setting process.env.JWT_SECRET/ADMIN_JWT_SECRET without restoring it leaks
// into every test file that runs afterward in the same process (node --test
// --test-isolation=none shares one process) — any JWT signed elsewhere with
// the real secret would then fail verification. Always restore in `finally`.
function withEnvVar(key, value, fn) {
  const previous = process.env[key]
  process.env[key] = value
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
}

test('authenticateToken accepts cookie token', async () => {
  await withEnvVar('JWT_SECRET', 'test-secret', async () => {
    pool.query = async () => ({ rows: [{ token_version: 1, is_banned: false }] })
    const token = jwt.sign({ userId: 'u1' }, process.env.JWT_SECRET)

    const req = { headers: {}, cookies: { token } }
    const res = makeRes()
    let called = false

    await authenticateToken(req, res, () => { called = true })
    assert.equal(called, true)
    assert.equal(req.user.userId, 'u1')
  })
})

test('authenticateAdmin accepts admin_token cookie', async () => {
  await withEnvVar('ADMIN_JWT_SECRET', 'admin-secret', async () => {
    const token = jwt.sign({ role: 'admin' }, process.env.ADMIN_JWT_SECRET)

    const req = { headers: {}, cookies: { admin_token: token } }
    const res = makeRes()
    let called = false

    await authenticateAdmin(req, res, () => { called = true })
    assert.equal(called, true)
    assert.equal(req.admin.role, 'super_admin')
  })
})

test('authenticateAdmin rejects non-admin role', async () => {
  await withEnvVar('ADMIN_JWT_SECRET', 'admin-secret', async () => {
    const token = jwt.sign({ role: 'user' }, process.env.ADMIN_JWT_SECRET)

    const req = { headers: {}, cookies: { admin_token: token } }
    const res = makeRes()
    let called = false

    await authenticateAdmin(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })
})

// FIX (C-03) regression guard. The role gate used to accept only the literal
// strings 'admin' and 'super_admin', which rejected every scoped role with 403
// *before* the platform_admins lookup could resolve its permissions — so the
// entire least-privilege capability system was unreachable and every working
// admin had to be a super_admin holding platform:*.
//
// Each scoped role must now pass the gate and be authorised from its DB row.
// Per-action authority is still enforced by requireAdminCapability, which is
// covered separately.
for (const role of ROLE_PERMISSIONS_ROLES) {
  test(`authenticateAdmin admits scoped role "${role}" and grants only its own permissions`, async () => {
    await withEnvVar('ADMIN_JWT_SECRET', 'admin-secret', async () => {
      const previousQuery = pool.query
      pool.query = async () => ({
        rows: [{
          id: 7, email: 'scoped@example.com', full_name: 'Scoped Admin',
          role, status: 'active', token_version: 1, totp_enabled: false, last_login_at: null
        }]
      })
      try {
        const token = jwt.sign({ role, adminId: 7, atv: 1 }, process.env.ADMIN_JWT_SECRET)
        const req = { headers: {}, cookies: { admin_token: token } }
        const res = makeRes()
        let called = false

        await authenticateAdmin(req, res, () => { called = true })

        assert.equal(called, true, `${role} was denied at the role gate`)
        assert.equal(req.admin.role, role)
        assert.deepEqual(req.admin.permissions, ROLE_PERMISSIONS[role])
        assert.ok(
          !req.admin.permissions.includes('platform:*'),
          `${role} must not receive the super-admin wildcard`
        )
      } finally {
        pool.query = previousQuery
      }
    })
  })
}

test('authenticateAdmin still rejects a role that is not a built-in', async () => {
  await withEnvVar('ADMIN_JWT_SECRET', 'admin-secret', async () => {
    const token = jwt.sign({ role: 'not_a_real_role', adminId: 7, atv: 1 }, process.env.ADMIN_JWT_SECRET)

    const req = { headers: {}, cookies: { admin_token: token } }
    const res = makeRes()
    let called = false

    await authenticateAdmin(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.error, 'Admin access required')
  })
})
