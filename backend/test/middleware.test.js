const test = require('node:test')
const assert = require('node:assert/strict')
const jwt = require('jsonwebtoken')
const {
  authenticateToken,
  authenticateAdmin,
  authenticatePre2FA,
  ROLE_PERMISSIONS
} = require('../routes/middleware')
const pool = require('../db')

const ROLE_PERMISSIONS_ROLES = Object.keys(ROLE_PERMISSIONS)
const USER_ID = '11111111-1111-4111-8111-111111111111'

function signUserToken(overrides = {}) {
  return jwt.sign(
    { userId: USER_ID, email: 'trader@example.com', tv: 1, ...overrides },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  )
}

function signAdminToken(overrides = {}) {
  return jwt.sign(
    {
      role: 'super_admin',
      adminId: null,
      atv: 1,
      email: 'admin@example.com',
      full_name: 'Admin Test',
      src: 'env_fallback',
      ...overrides
    },
    process.env.ADMIN_JWT_SECRET,
    { expiresIn: '5m' }
  )
}

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
    const previousQuery = pool.query
    pool.query = async () => ({ rows: [{ token_version: 1, is_banned: false }] })
    // FIX (H-07): a token with no `tv` claim is now rejected rather than
    // silently skipping the version check. Every jwt.sign site in routes/auth.js
    // includes tv, so this matches what the app actually issues.
    const token = signUserToken()

    const req = { headers: {}, cookies: { token } }
    const res = makeRes()
    let called = false

    try {
      await authenticateToken(req, res, () => { called = true })
      assert.equal(called, true)
      assert.equal(req.user.userId, USER_ID)
    } finally {
      pool.query = previousQuery
    }
  })
})

test('authenticateAdmin accepts admin_token cookie', async () => {
  await withEnvVar('ADMIN_JWT_SECRET', 'admin-secret', async () => {
    const token = signAdminToken({ role: 'admin' })
    // FIX (H-07): the env-fallback branch now fails closed when
    // admin_token_version is missing, so the row has to resolve.
    const previousQuery = pool.query
    pool.query = async () => ({ rows: [{ value: '1' }] })

    const req = { headers: {}, cookies: { admin_token: token } }
    const res = makeRes()
    let called = false

    try {
      await authenticateAdmin(req, res, () => { called = true })
      assert.equal(called, true)
      assert.equal(req.admin.role, 'super_admin')
    } finally {
      pool.query = previousQuery
    }
  })
})

test('authenticateAdmin rejects non-admin role', async () => {
  await withEnvVar('ADMIN_JWT_SECRET', 'admin-secret', async () => {
    const token = signAdminToken({ role: 'user' })

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
          id: '7', email: 'scoped@example.com', full_name: 'Scoped Admin',
          role, status: 'active', token_version: 1, totp_enabled: false, last_login_at: null
        }]
      })
      try {
        const token = signAdminToken({
          role,
          adminId: '7',
          email: 'scoped@example.com',
          full_name: 'Scoped Admin',
          src: 'platform_admin'
        })
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
    const token = signAdminToken({ role: 'not_a_real_role', adminId: '7' })

    const req = { headers: {}, cookies: { admin_token: token } }
    const res = makeRes()
    let called = false

    await authenticateAdmin(req, res, () => { called = true })
    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.error, 'Admin access required')
  })
})

test('authenticateToken rejects a cryptographically valid token with malformed claims', async () => {
  await withEnvVar('JWT_SECRET', 'test-secret', async () => {
    const token = jwt.sign({ userId: USER_ID, tv: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' })
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} }
    const res = makeRes()
    let called = false

    await authenticateToken(req, res, () => { called = true })

    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
    assert.deepEqual(res.body, { error: 'Invalid or expired token' })
  })
})

test('authenticateToken rejects a pre-2FA token as a full session', async () => {
  await withEnvVar('JWT_SECRET', 'test-secret', async () => {
    const token = signUserToken({ type: 'pre_2fa' })
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} }
    const res = makeRes()
    let called = false

    await authenticateToken(req, res, () => { called = true })

    assert.equal(called, false)
    assert.equal(res.statusCode, 403)
  })
})

test('authenticatePre2FA accepts only a validated pre-2FA claim set', async () => {
  await withEnvVar('JWT_SECRET', 'test-secret', async () => {
    const previousQuery = pool.query
    pool.query = async () => ({ rows: [{ token_version: 1, is_banned: false }] })
    const token = signUserToken({ type: 'pre_2fa' })
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} }
    const res = makeRes()
    let called = false

    try {
      await authenticatePre2FA(req, res, () => { called = true })
      assert.equal(called, true)
      assert.equal(req.pre2fa.type, 'pre_2fa')
    } finally {
      pool.query = previousQuery
    }
  })
})

test('authenticateToken safely handles a non-Error database throw', async () => {
  await withEnvVar('JWT_SECRET', 'test-secret', async () => {
    const previousQuery = pool.query
    pool.query = async () => { throw 'database unavailable' }
    const token = signUserToken()
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} }
    const res = makeRes()

    try {
      await authenticateToken(req, res, () => assert.fail('next must not run'))
      assert.equal(res.statusCode, 503)
      assert.deepEqual(res.body, { error: 'Authentication service unavailable' })
    } finally {
      pool.query = previousQuery
    }
  })
})
