const test = require('node:test')
const assert = require('node:assert/strict')
const {
  SESSION_REVALIDATE_MS,
  assertUserSessionValid,
  assertAdminSessionValid,
  startSessionRevalidation,
  stopSessionRevalidation
} = require('../services/socketService')

// Socket.IO used to validate a session only during the handshake, so a socket
// opened before a ban kept streaming prices and account events until the client
// happened to reconnect. These cover the shared validators (used by both the
// handshake and the new periodic re-check) and the timer lifecycle.

function makePool(handlers = []) {
  return {
    calls: [],
    async query(sql, values) {
      this.calls.push({ sql, values })
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, values)
      }
      return { rows: [] }
    }
  }
}

const USERS = /FROM users WHERE id/
const ADMIN_TV = /admin_token_version/

function makeSocket(data = {}) {
  const socket = {
    id: 'sock-1',
    data,
    disconnected: false,
    disconnect() { this.disconnected = true }
  }
  return socket
}

// ─── User session validation ─────────────────────────────────────────────────

test('assertUserSessionValid passes for an active user on the current token version', async () => {
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 3, is_banned: false }] })]])
  await assertUserSessionValid(pool, 'user-1', 3)
})

test('assertUserSessionValid rejects a banned user', async () => {
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 1, is_banned: true }] })]])
  await assert.rejects(
    () => assertUserSessionValid(pool, 'user-1', 1),
    (err) => err.sessionInvalid === true && /suspended/i.test(err.message)
  )
})

test('assertUserSessionValid rejects a token version bumped since the handshake', async () => {
  // "log out everywhere" / password change increments token_version.
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 5, is_banned: false }] })]])
  await assert.rejects(
    () => assertUserSessionValid(pool, 'user-1', 4),
    (err) => err.sessionInvalid === true && /expired/i.test(err.message)
  )
})

test('assertUserSessionValid rejects a deleted user', async () => {
  const pool = makePool([[USERS, () => ({ rows: [] })]])
  await assert.rejects(
    () => assertUserSessionValid(pool, 'user-gone', 1),
    (err) => err.sessionInvalid === true
  )
})

test('assertUserSessionValid tolerates a token minted without a tv claim', async () => {
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 2, is_banned: false }] })]])
  await assertUserSessionValid(pool, 'user-1', undefined)
})

// ─── Admin session validation ────────────────────────────────────────────────

test('assertAdminSessionValid rejects an admin token behind the platform version', async () => {
  const pool = makePool([[ADMIN_TV, () => ({ rows: [{ value: '7' }] })]])
  await assert.rejects(
    () => assertAdminSessionValid(pool, 6),
    (err) => err.sessionInvalid === true
  )
})

test('assertAdminSessionValid accepts an admin token at or above the platform version', async () => {
  const pool = makePool([[ADMIN_TV, () => ({ rows: [{ value: '7' }] })]])
  await assertAdminSessionValid(pool, 7)
  await assertAdminSessionValid(pool, 8)
})

test('assertAdminSessionValid is a no-op when the setting row is absent', async () => {
  const pool = makePool()
  await assertAdminSessionValid(pool, 0)
})

// ─── Periodic re-validation ──────────────────────────────────────────────────

test('a revoked session disconnects the socket on re-check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 9, is_banned: true }] })]])
  const socket = makeSocket({ userId: 'user-1', tokenVersion: 9 })

  startSessionRevalidation(pool, socket)
  // Jittered first run lands somewhere inside the window; clear the whole
  // window so it has definitely fired.
  t.mock.timers.tick(SESSION_REVALIDATE_MS)
  await new Promise((resolve) => { setImmediate(resolve) })

  assert.equal(socket.disconnected, true)
  assert.equal(socket.data._revalidateTimer, null)
})

test('a still-valid session keeps the socket open', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 2, is_banned: false }] })]])
  const socket = makeSocket({ userId: 'user-1', tokenVersion: 2 })

  startSessionRevalidation(pool, socket)
  t.mock.timers.tick(SESSION_REVALIDATE_MS)
  await new Promise((resolve) => { setImmediate(resolve) })

  assert.equal(socket.disconnected, false)
})

test('a database fault does not disconnect the socket', async (t) => {
  // Mass-disconnecting every trader because the pool blipped would be worse
  // than briefly keeping a session that might be stale.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pool = {
    async query() { throw new Error('connection terminated unexpectedly') }
  }
  const socket = makeSocket({ userId: 'user-1', tokenVersion: 1 })

  startSessionRevalidation(pool, socket)
  t.mock.timers.tick(SESSION_REVALIDATE_MS)
  await new Promise((resolve) => { setImmediate(resolve) })

  assert.equal(socket.disconnected, false)
})

test('stopSessionRevalidation clears the timer so disconnect leaks nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pool = makePool([[USERS, () => ({ rows: [{ token_version: 1, is_banned: false }] })]])
  const socket = makeSocket({ userId: 'user-1', tokenVersion: 1 })

  startSessionRevalidation(pool, socket)
  assert.ok(socket.data._revalidateTimer)

  stopSessionRevalidation(socket)
  assert.equal(socket.data._revalidateTimer, null)

  // No further queries once stopped.
  const before = pool.calls.length
  t.mock.timers.tick(SESSION_REVALIDATE_MS * 3)
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(pool.calls.length, before)
})

test('an admin socket re-checks the platform admin token version', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const pool = makePool([[ADMIN_TV, () => ({ rows: [{ value: '4' }] })]])
  const socket = makeSocket({ isAdmin: true, adminTokenVersion: 3 })

  startSessionRevalidation(pool, socket)
  t.mock.timers.tick(SESSION_REVALIDATE_MS)
  await new Promise((resolve) => { setImmediate(resolve) })

  assert.equal(socket.disconnected, true)
})
