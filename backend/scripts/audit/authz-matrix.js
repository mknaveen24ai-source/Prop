'use strict'

/**
 * Authorization matrix.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     AUTHZ_BASE_URL=http://127.0.0.1:5099 \
 *     AUTHZ_SUPER_ADMIN_EMAIL=... AUTHZ_SUPER_ADMIN_PASSWORD=... \
 *     node scripts/audit/authz-matrix.js
 *
 *     --json          machine-readable result
 *     --reads-only    skip every mutating method (safe against a shared env)
 *     --limit N       first N endpoints, for a quick pass
 *
 * Drives every endpoint in scripts/audit/route-inventory.js against every kind of
 * caller the platform recognises, and fails when one answers somebody it should
 * have refused.
 *
 * ── The principals ──
 *
 *   anon          no credentials at all
 *   traderA       a registered trader who owns the fixtures
 *   traderB       a second trader — every traderB request against a traderA
 *                 resource is a live IDOR attempt, not a simulated one
 *   kyc_reviewer  ┐
 *   support_agent │ the four least-privileged built-in admin roles from
 *   risk_ops      │ routes/middleware.js ROLE_PERMISSIONS
 *   finance_ops   ┘
 *   super_admin   platform:* wildcard
 *
 * ── Why this exists ──
 *
 * The scoped admin roles were dead for months: middleware.js rejected any role
 * that was not literally 'admin' or 'super_admin' BEFORE the platform_admins
 * lookup, so the entire capability table was unreachable. The table looked right,
 * every unit test passed, and no single-principal test could see it — proving a
 * role cannot do something requires logging in AS that role and trying.
 *
 * ── What counts as a violation ──
 *
 * Not "returned 2xx". An endpoint that answers 400 for a malformed body has still
 * accepted the caller's identity, and 404 on an admin route reveals whether a
 * record exists. The rule is that an unauthorized caller must be turned away by
 * the AUTH layer — 401 or 403 — and anything else is reported for review.
 *
 * 429 is treated as inconclusive rather than as a pass: a rate limiter refusing
 * the request says nothing about whether authorization would have.
 */

require('../../loadEnv')

const crypto = require('crypto')
const axios = require('axios')
const { buildInventory } = require('./route-inventory')

const BASE_URL = String(process.env.AUTHZ_BASE_URL || 'http://127.0.0.1:5099').replace(/\/+$/, '')
const JSON_OUT = process.argv.includes('--json')
const READS_ONLY = process.argv.includes('--reads-only')
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit')
  return i === -1 ? Infinity : parseInt(process.argv[i + 1], 10) || Infinity
})()

/**
 * Requests per second, held below the platform's own abuse threshold.
 *
 * utils/security.js blocks an IP for a full hour after 600 requests in a minute,
 * and the block is a 429 that never reaches the route. A full sweep is ~2,400
 * requests, so running flat out gets the harness banned four seconds in and
 * every remaining assertion comes back inconclusive — which is exactly what the
 * first full run did, 75% throttled.
 *
 * Pacing rather than raising the threshold: the abuse detector is a real control
 * that works, and an audit harness that needs production defences turned off to
 * produce a result is measuring the wrong system. 8/s keeps a sweep near five
 * minutes with ~20% headroom under the limit.
 */
const RPS = (() => {
  const i = process.argv.indexOf('--rps')
  return i === -1 ? 8 : Math.max(1, parseFloat(process.argv[i + 1]) || 8)
})()

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const SCOPED_ROLES = ['kyc_reviewer', 'support_agent', 'risk_ops', 'finance_ops']

/**
 * Endpoints excluded from the sweep, each for a reason that would corrupt the
 * run rather than because they are hard.
 *
 * Nothing is excluded for being dangerous to DATA — this runs against a scratch
 * database, and "can traderB delete traderA's account" is precisely the question.
 */
const EXCLUDED = new Map([
  ['POST /api/setup/init', 'one-shot; already run to seed this database, and it locks itself afterwards'],
  ['POST /api/auth/logout', 'invalidates the session the rest of the sweep authenticates with'],
  ['POST /api/auth/logout-all', 'revokes every session for the CALLING user; both traders killed their own mid-sweep'],
  ['POST /api/admin/logout', 'invalidates the admin session the rest of the sweep authenticates with'],
  ['POST /api/admin/emergency-kill/execute', 'halts platform-wide trading; run separately in the workflow tests'],
  ['POST /api/metrics/reset', 'destroys the counters other checks read'],
  ['GET /', 'static SPA shell, not an API surface']
])

// Values substituted into :params. A traderA-owned id makes every traderB
// request a real cross-tenant attempt; a random uuid would only ever prove that
// 404 works.
const fixtures = {
  traderAUserId: null,
  traderAAccountId: null,
  traderATradeId: null,
  traderACertificateId: null,
  traderBUserId: null,
  // A throwaway trader that ADMIN routes are aimed at, in both path params and
  // bodies.
  //
  // Admin endpoints legitimately ban, suspend and fail traders. Pointing them at
  // traderA meant the sweep banned its own trader partway through, after which
  // every remaining trader endpoint answered 401 -- scored as "correctly denied",
  // producing a cleaner report than the truth. The liveness check caught it.
  //
  // The split matters: admin routes get the disposable trader, non-admin routes
  // keep traderA's real ids so that every traderB request stays a genuine
  // cross-tenant IDOR attempt rather than a 404 test.
  sacrificialUserId: null,
  sacrificialAccountId: null,

  // A throwaway admin that /admin-users/:id endpoints are aimed at.
  //
  // Without it those routes resolve :id to '1' -- the super admin the harness
  // authenticates as -- and the first sweep duly called
  // POST /api/admin/admin-users/1/disable and locked itself out mid-run. The
  // next run then died at login with "Platform admin account is inactive".
  //
  // Excluding the endpoints would have been the easy fix and the wrong one:
  // admin-user management is exactly the surface where a privilege-escalation
  // bug would live, so it needs a target that is safe to destroy.
  sacrificialAdminId: null
}

const principals = {}
const fixtureProblems = []

function http(method, url, { cookie, headers = {}, data } = {}) {
  return axios({
    method,
    url: `${BASE_URL}${url}`,
    data,
    headers: {
      'Content-Type': 'application/json',
      // Every mutating money endpoint fails closed without one (utils/idempotency.js).
      // Omitting it would make trades:open answer 400 for a reason unrelated to
      // authorization, and a 400 is not evidence of a guard.
      'Idempotency-Key': `authz:${crypto.randomUUID()}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers
    },
    validateStatus: () => true,
    timeout: 20000,
    maxRedirects: 0
  })
}

function cookieFrom(response, name) {
  const raw = response.headers['set-cookie']
  if (!Array.isArray(raw)) return ''
  const found = raw.find((entry) => String(entry || '').startsWith(`${name}=`))
  return found ? found.split(';')[0] : ''
}

/**
 * Clear the per-endpoint rate limiters, so they cannot answer before the guard.
 *
 * Registration is 5/hour/IP, admin login 10/min, and the shared `auth` limiter
 * covers 2FA. This sweep calls every endpoint once per principal, so those trip
 * on the harness itself — and a 429 tells us nothing about whether the endpoint
 * would have authorized the caller. Left alone, 92 assertions came back
 * unverifiable, all on four endpoints.
 *
 * This is not weakening a control to make a test pass: rate limiting is a
 * separate property, verified on its own in the rate-limit checks. Confounding
 * the two only makes the authorization result less trustworthy.
 *
 * Deliberately excludes the abuse detector, which is in-process memory rather
 * than Redis, and which the harness respects by pacing instead — see RPS.
 */
async function resetRateLimiters() {
  const { createClient } = require('redis')
  const url = process.env.REDIS_URL || 'redis://localhost:6379'
  const client = createClient({ url })
  client.on('error', () => {})
  try {
    await client.connect()
    const keys = await client.keys('rl:*')
    for (const key of keys) await client.del(key)
    await client.quit()
    return keys.length
  } catch (error) {
    try { await client.quit() } catch { /* already down */ }
    return `unavailable (${error.message}) — limiters are on in-process counters, so restart the server instead`
  }
}

/**
 * A password that always satisfies the policy in routes/auth.js:
 * 8+ chars with upper, lower, digit and symbol.
 *
 * `'Authz!' + randomBytes().toString('base64url')` looked fine and failed
 * intermittently -- base64url output contains no digit maybe one run in twenty,
 * so the harness died at registration with "Password must contain at least one
 * number." A test harness that fails randomly gets distrusted and then ignored.
 */
function policyPassword() {
  return `Aa1!${crypto.randomBytes(12).toString('base64url')}0zX`
}

/** Read one claim out of a JWT payload without verifying it — this is a probe. */
function decodeJwtClaim(token, claim) {
  try {
    const payload = String(token || '').split('.')[1]
    if (!payload) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))[claim] ?? null
  } catch {
    return null
  }
}

async function registerTrader(label) {
  const suffix = crypto.randomBytes(6).toString('hex')
  const email = `authz-${label}+${suffix}@example.com`
  const password = policyPassword()
  const response = await http('post', '/api/auth/register', {
    data: {
      email,
      password,
      full_name: `Authz ${label}`,
      country: 'United Kingdom',
      phone: '+441234567890',
      terms_accepted: true
    }
  })
  if (response.status !== 201) {
    throw new Error(`register ${label} returned ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`)
  }
  const cookie = cookieFrom(response, 'token')
  if (!cookie) throw new Error(`register ${label} returned no auth cookie`)
  return { cookie, email, password, userId: response.data?.user?.id || null }
}

async function loginSuperAdmin() {
  const email = String(process.env.AUTHZ_SUPER_ADMIN_EMAIL || '').trim()
  const password = String(process.env.AUTHZ_SUPER_ADMIN_PASSWORD || '').trim()
  if (!email || !password) {
    throw new Error('AUTHZ_SUPER_ADMIN_EMAIL and AUTHZ_SUPER_ADMIN_PASSWORD are required')
  }
  const response = await http('post', '/api/admin/login', { data: { email, password } })
  if (response.status !== 200) {
    throw new Error(`admin login returned ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`)
  }
  const cookie = cookieFrom(response, 'admin_token') ||
    (response.data?.token ? `admin_token=${response.data.token}` : '')
  if (!cookie) throw new Error('admin login returned no admin_token')
  return cookie
}

/**
 * Create one scoped admin through the same endpoint an operator uses, then log
 * in as it. Creating the row directly in Postgres would skip whatever the create
 * path does to it, and the create path is itself part of what is under audit —
 * before it was fixed, every admin was forced to super_admin regardless of the
 * role asked for.
 */
async function createScopedAdmin(superCookie, role) {
  const suffix = crypto.randomBytes(4).toString('hex')
  const email = `authz-${role}+${suffix}@example.com`
  const password = policyPassword()

  const created = await http('post', '/api/admin/admin-users', {
    cookie: superCookie,
    data: { email, password, full_name: `Authz ${role}`, role }
  })
  if (![200, 201].includes(created.status)) {
    return { error: `create ${role} returned ${created.status}: ${JSON.stringify(created.data).slice(0, 160)}` }
  }

  const login = await http('post', '/api/admin/login', { data: { email, password } })
  if (login.status !== 200) {
    return { error: `login as ${role} returned ${login.status}: ${JSON.stringify(login.data).slice(0, 160)}` }
  }
  const cookie = cookieFrom(login, 'admin_token') ||
    (login.data?.token ? `admin_token=${login.data.token}` : '')
  if (!cookie) return { error: `login as ${role} returned no admin_token` }

  // Confirm the role actually stuck, by reading the claim out of the token the
  // server just minted. This is the assertion that matters most in the whole
  // harness: before middleware.js was fixed, every admin was forced to
  // super_admin regardless of the role requested, which would make every
  // scoped-role expectation below vacuously pass while proving nothing.
  //
  // Read from the JWT rather than an endpoint because there is no /api/admin/me
  // to ask, and because the claim is what authorization actually consults.
  const actualRole = decodeJwtClaim(login.data?.token || cookie.split('=')[1], 'role')
  const adminId = decodeJwtClaim(login.data?.token || cookie.split('=')[1], 'adminId')
  return { cookie, email, role, actualRole, adminId, roleMatches: actualRole === role }
}

/** Fill :params with traderA-owned ids where we have them. */
function concretePath(routePath) {
  const adminUserRoute = routePath.includes('/admin-users/')
  const adminRoute = routePath.startsWith('/api/admin/')
  return routePath.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
    const n = name.toLowerCase()
    if (adminUserRoute && (n === 'id' || n.includes('admin'))) {
      return fixtures.sacrificialAdminId || '999999'
    }
    if (adminRoute && n.includes('account')) {
      return fixtures.sacrificialAccountId || fixtures.traderAAccountId || '00000000-0000-4000-8000-000000000001'
    }
    if (adminRoute && n.includes('user')) return fixtures.sacrificialUserId || '1'
    if (n.includes('account')) return fixtures.traderAAccountId || '00000000-0000-4000-8000-000000000001'
    if (n.includes('trade')) return fixtures.traderATradeId || '00000000-0000-4000-8000-000000000002'
    if (n.includes('user')) return fixtures.traderAUserId || '1'
    if (n === 'publicid') return fixtures.traderACertificateId || 'PF-0000-0000-0000'
    if (n === 'instrument' || n === 'symbol') return 'EURUSD'
    if (n === 'slug') return 'audit-slug'
    if (n === 'type' || n === 'kind') return 'entry'
    if (n === 'format') return 'png'
    if (n === 'key') return 'audit_key'
    return '1'
  })
}

/**
 * A body good enough to get past shape validation on most endpoints, so a
 * rejection is attributable to authorization rather than to a missing field.
 * Deliberately generic: the matrix asks who may call an endpoint, not whether
 * its business logic is right.
 */
function sampleBody(endpoint) {
  // Bodies always name the disposable trader. An admin endpoint reading
  // `user_id` out of the body is exactly how the first sweep banned traderA.
  const targetUser = fixtures.sacrificialUserId || fixtures.traderAUserId
  const targetAccount = fixtures.sacrificialAccountId || fixtures.traderAAccountId
  return {
    id: targetAccount || 1,
    account_id: targetAccount,
    user_id: targetUser,
    userId: targetUser,
    trade_id: fixtures.traderATradeId,
    amount: 1,
    status: 'pending',
    reason: 'authz-matrix probe',
    note: 'authz-matrix probe',
    message: 'authz-matrix probe',
    email: 'authz-probe@example.com',
    instrument: 'EURUSD',
    direction: 'buy',
    lots: 0.01,
    lot_size: 0.01,
    value: 'authz-matrix',
    key: 'authz_probe',
    enabled: false,
    _endpoint: `${endpoint.method} ${endpoint.path}`
  }
}

/**
 * Who SHOULD be refused, per the guards the router actually carries.
 * Returns a Set of principal names that must receive 401 or 403.
 */
function expectedDenials(endpoint) {
  const denied = new Set()
  if (endpoint.auth === 'admin') {
    denied.add('anon').add('traderA').add('traderB')
    if (endpoint.superAdminOnly) for (const r of SCOPED_ROLES) denied.add(r)
  } else if (endpoint.auth === 'trader') {
    denied.add('anon')
  }
  return denied
}

function classify(status) {
  if (status === 401 || status === 403) return 'denied'
  if (status === 429) return 'ratelimited'
  if (status >= 500) return 'error'
  return 'allowed'
}

async function main() {
  const { endpoints } = buildInventory()
  const targets = endpoints
    .filter((e) => !EXCLUDED.has(`${e.method} ${e.path}`))
    .filter((e) => (READS_ONLY ? e.method === 'GET' : true))
    .slice(0, LIMIT)

  // ── principals ──
  const rateLimitReset = await resetRateLimiters()

  const traderA = await registerTrader('a')
  const traderB = await registerTrader('b')
  fixtures.traderAUserId = traderA.userId
  fixtures.traderBUserId = traderB.userId
  principals.anon = { cookie: '' }
  principals.traderA = { cookie: traderA.cookie }
  principals.traderB = { cookie: traderB.cookie }

  const superCookie = await loginSuperAdmin()
  principals.super_admin = { cookie: superCookie }

  const sacrificial = await createScopedAdmin(superCookie, 'support_agent')
  if (sacrificial.adminId) fixtures.sacrificialAdminId = sacrificial.adminId

  const roleSetup = {}
  for (const role of SCOPED_ROLES) {
    const result = await createScopedAdmin(superCookie, role)
    roleSetup[role] = result
    if (result.cookie) principals[role] = { cookie: result.cookie }
  }

  // ── fixtures owned by traderA ──
  if (fixtures.traderAUserId) {
    const issued = await http('post', `/api/admin/users/${fixtures.traderAUserId}/manual-account`, {
      cookie: superCookie,
      data: { account_size: 10000, challenge_type: 'two_phase', reason: 'authz matrix fixture' }
    })
    fixtures.traderAAccountId =
      issued.data?.account?.id || issued.data?.account_id || issued.data?.id || null
    if (!fixtures.traderAAccountId) {
      fixtureProblems.push(
        `account fixture: manual-account returned ${issued.status} ` +
        `${JSON.stringify(issued.data).slice(0, 160)}`
      )
    }
  }
  if (fixtures.traderAAccountId) {
    // Retried: the platform rejects orders while the price feed is stale
    // ("volatility protection/latency"), and the demo feed ticks on its own
    // schedule. One attempt made the trade fixture depend on timing, which is
    // how :tradeId probes silently became 404 tests on some runs and not others.
    let opened = { status: 0, data: {} }
    for (let attempt = 0; attempt < 6; attempt++) {
      opened = await http('post', '/api/trades/open', {
        cookie: traderA.cookie,
        // The field is `lots`. `lot_size` returns 400 'account_id, instrument,
        // direction, and lots are required'.
        data: { account_id: fixtures.traderAAccountId, instrument: 'EURUSD', direction: 'buy', lots: 0.01 }
      })
      if (opened.status < 400) break
      if (!/price feed|volatility|latency/i.test(JSON.stringify(opened.data))) break
      await sleep(2500)
    }
    fixtures.traderATradeId = opened.data?.trade?.id || opened.data?.trade_id || null
    if (!fixtures.traderATradeId) {
      // Silence here downgrades every :tradeId probe to a 404 test without
      // saying so, which reads as coverage the sweep does not have.
      fixtureProblems.push(
        `trade fixture: POST /api/trades/open returned ${opened.status} ` +
        `${JSON.stringify(opened.data).slice(0, 160)}`
      )
    }
  }
  const sacrificialTrader = await registerTrader('sacrificial')
  fixtures.sacrificialUserId = sacrificialTrader.userId
  if (fixtures.sacrificialUserId) {
    const issued = await http('post', `/api/admin/users/${fixtures.sacrificialUserId}/manual-account`, {
      cookie: superCookie,
      data: { account_size: 10000, challenge_type: 'two_phase', reason: 'authz matrix sacrificial fixture' }
    })
    fixtures.sacrificialAccountId = issued.data?.account?.id || issued.data?.account_id || null
  }

  const certs = await http('get', '/api/certificates', { cookie: traderA.cookie })
  if (Array.isArray(certs.data) && certs.data[0]) {
    fixtures.traderACertificateId = certs.data[0].public_id || null
  }

  // ── sweep ──
  const principalNames = ['anon', 'traderA', 'traderB', ...SCOPED_ROLES, 'super_admin']
    .filter((name) => principals[name])

  const rows = []
  const violations = []
  let rateLimited = 0
  let totalRequests = 0
  const inconclusiveCells = []

  /**
   * Confirm each principal is still authenticated.
   *
   * The sweep calls ban, suspend and disable endpoints with real credentials, so
   * a principal can lose its session partway through. Every later endpoint then
   * answers it 401 -- which this harness would score as "correctly denied", and
   * the run would finish cleaner than the truth. Checked before and after, and
   * any principal that dies invalidates its own results rather than passing them.
   */
  async function livenessSnapshot() {
    const alive = {}
    for (const name of principalNames) {
      if (name === 'anon') { alive[name] = true; continue }
      const probe = name.startsWith('trader')
        ? await http('get', '/api/auth/me', { cookie: principals[name].cookie })
        : await http('get', '/api/admin/admin-users', { cookie: principals[name].cookie })
      // 403 still means authenticated -- the identity was read and then refused
      // on capability, which is a live session.
      alive[name] = probe.status !== 401
    }
    return alive
  }

  const livenessBefore = await livenessSnapshot()

  let sweptSinceReset = 0
  for (const endpoint of targets) {
    // Limiter windows are per minute or per hour; a five-minute sweep outlives
    // them, so clearing periodically keeps late endpoints as testable as early
    // ones. Without this the results skew: whatever the inventory happens to
    // sort last is the least verified.
    if (sweptSinceReset >= 25) {
      await resetRateLimiters()
      sweptSinceReset = 0
    }
    sweptSinceReset++

    const url = concretePath(endpoint.path)
    const denials = expectedDenials(endpoint)
    const observed = {}

    for (const name of principalNames) {
      const method = endpoint.method.toLowerCase()
      const body = ['post', 'put', 'patch', 'delete'].includes(method) ? sampleBody(endpoint) : undefined
      let response
      try {
        response = await http(method, url, { cookie: principals[name].cookie, data: body })
      } catch (error) {
        observed[name] = { status: 0, outcome: 'error', note: error.message }
        continue
      }
      let outcome = classify(response.status)
      totalRequests++
      await sleep(1000 / RPS)

      // A 429 here is usually a per-endpoint limiter doing its job -- login is
      // 10/min, register 5/hour, and this sweep calls each endpoint once per
      // principal. Back off and try once more rather than writing the whole run
      // off: an endpoint whose authorization is untested is a hole in the
      // matrix, and a blanket "5% throttled = inconclusive" rule discards 294
      // good results because one endpoint was busy.
      if (outcome === 'ratelimited') {
        // Clear the window rather than wait it out. These limiters run on
        // minutes-to-hours (register is 5/hour), so sleeping cannot recover the
        // assertion -- an earlier version slept 2s and left 82 cells unverified,
        // all on the four endpoints with the tightest windows.
        await resetRateLimiters()
        try {
          response = await http(method, url, { cookie: principals[name].cookie, data: body })
          outcome = classify(response.status)
          totalRequests++
        } catch { /* keep the 429 */ }
      }

      observed[name] = { status: response.status, outcome }
      if (outcome === 'ratelimited') {
        rateLimited++
        inconclusiveCells.push(`${endpoint.method} ${endpoint.path} (${name})`)
      }

      if (denials.has(name) && outcome === 'allowed') {
        violations.push({
          severity: endpoint.auth === 'admin' && name.startsWith('trader') ? 'CRITICAL' : 'HIGH',
          endpoint: `${endpoint.method} ${endpoint.path}`,
          url,
          principal: name,
          status: response.status,
          expected: '401 or 403',
          auth: endpoint.auth,
          capability: endpoint.capability,
          source: endpoint.source,
          body: JSON.stringify(response.data).slice(0, 240)
        })
      }
    }

    rows.push({
      endpoint: `${endpoint.method} ${endpoint.path}`,
      auth: endpoint.auth,
      capability: endpoint.capability,
      observed
    })
  }

  const livenessAfter = await livenessSnapshot()
  const diedMidSweep = principalNames.filter((n) => livenessBefore[n] && !livenessAfter[n])

  const rateLimitedShare = totalRequests > 0 ? rateLimited / totalRequests : 0
  const result = {
    baseUrl: BASE_URL,
    fixtures,
    roleSetup,
    rateLimitReset,
    fixtureProblems,
    tested: targets.length,
    rps: RPS,
    principals: principalNames,
    totalRequests,
    rateLimited,
    rateLimitedShare,
    inconclusiveCells,
    livenessBefore,
    livenessAfter,
    diedMidSweep,
    rows,
    violations
  }

  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    report(result)
  }
  // A sweep that was mostly throttled proves nothing, and "0 violations" from
  // such a run is a false pass -- the most dangerous output this tool could
  // produce. Fail on it explicitly instead.
  // Judged on the endpoints that could not be assessed at all, not on the raw
  // 429 count: a retried-and-recovered throttle costs nothing.
  const inconclusive = inconclusiveCells.length > 40 || diedMidSweep.length > 0
  process.exitCode = violations.length > 0 || inconclusive ? 1 : 0
}

function report(result) {
  console.log('Authorization matrix')
  console.log('='.repeat(72))
  console.log(`  base URL       ${result.baseUrl}`)
  console.log(`  endpoints      ${result.tested}`)
  console.log(`  principals     ${result.principals.join(', ')}`)
  console.log(`  assertions     ${result.tested * result.principals.length}`)
  console.log(`  paced at       ${result.rps}/s (abuse detector blocks an IP for an hour past 600/min)`)
  console.log('')

  console.log('  Fixtures owned by traderA:')
  for (const [k, v] of Object.entries(result.fixtures)) {
    console.log(`    ${k.padEnd(22)} ${v || '(none — endpoints needing it fall back to a synthetic id)'}`)
  }
  console.log('')

  if (result.fixtureProblems.length > 0) {
    console.log('  ⚠ Fixture setup problems (probes needing these fall back to synthetic ids):')
    for (const p of result.fixtureProblems) console.log(`      ${p}`)
    console.log('')
  }
  console.log(`  Auth limiter reset: ${typeof result.rateLimitReset === 'number' ? `${result.rateLimitReset} key(s) cleared` : result.rateLimitReset}`)
  console.log('')
  console.log('  Scoped admin roles:')
  for (const [role, setup] of Object.entries(result.roleSetup)) {
    if (setup.error) console.log(`    ${role.padEnd(15)} SETUP FAILED — ${setup.error}`)
    else if (!setup.roleMatches) {
      console.log(`    ${role.padEnd(15)} ⚠ ROLE MISMATCH — token says '${setup.actualRole}'.`)
      console.log(`    ${' '.repeat(15)}   Every assertion for this role is vacuous until that is fixed.`)
    } else console.log(`    ${role.padEnd(15)} ok (token role=${setup.actualRole})`)
  }
  console.log('')

  if (result.diedMidSweep.length > 0) {
    console.log(`  ✗ INCONCLUSIVE — session(s) lost mid-sweep: ${result.diedMidSweep.join(', ')}.`)
    console.log('    Every endpoint after that point answered them 401 for the wrong reason,')
    console.log('    which would score as "correctly denied". Results for those principals')
    console.log('    cannot be trusted. Re-run after isolating what revoked them.')
    console.log('='.repeat(72))
    return
  }

  console.log(`  Requests: ${result.totalRequests}. Still throttled after one retry: ${result.rateLimited}.`)
  if (result.inconclusiveCells.length > 0) {
    console.log('')
    console.log(`  ⚠ ${result.inconclusiveCells.length} assertion(s) UNVERIFIED — the endpoint's own rate`)
    console.log('    limiter answered before the guard could. A 429 is not evidence of authorization.')
    for (const cell of result.inconclusiveCells.slice(0, 15)) console.log(`      ${cell}`)
    if (result.inconclusiveCells.length > 15) {
      console.log(`      ... and ${result.inconclusiveCells.length - 15} more`)
    }
  }
  if (result.inconclusiveCells.length > 40) {
    console.log('')
    console.log('  ✗ INCONCLUSIVE — too much of this sweep was throttled to judge authorization.')
    console.log('    Re-run with a lower --rps, or raise API_RATE_LIMIT_MAX on the server under test.')
    console.log('='.repeat(72))
    return
  }
  console.log('')

  if (result.violations.length === 0) {
    console.log('  ✓ no unauthorized caller was answered by an endpoint that should refuse it')
    console.log('='.repeat(72))
    return
  }

  console.log(`  ✗ ${result.violations.length} authorization violation(s):`)
  console.log('')
  const bySeverity = { CRITICAL: [], HIGH: [] }
  for (const v of result.violations) (bySeverity[v.severity] || (bySeverity[v.severity] = [])).push(v)
  for (const [severity, list] of Object.entries(bySeverity)) {
    if (!list.length) continue
    console.log(`  ── ${severity} (${list.length}) ──`)
    for (const v of list) {
      console.log(`    ${v.principal} -> ${v.endpoint}  returned ${v.status}, expected ${v.expected}`)
      console.log(`        auth=${v.auth}${v.capability ? ` capability=${v.capability}` : ''}  ${v.source}`)
      console.log(`        ${v.body}`)
    }
    console.log('')
  }
  console.log('='.repeat(72))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(2)
})
