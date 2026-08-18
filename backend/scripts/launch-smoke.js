/**
 * Launch smoke test
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/launch-smoke.js               # against an existing environment
 *     node scripts/launch-smoke.js --provision   # self-provisioning
 *
 * ── The two modes ──
 *
 * DEFAULT: exercises a live environment using credentials you supply
 * (SMOKE_TRADER_EMAIL, SMOKE_TRADE_ACCOUNT_ID, ...). Steps whose configuration
 * is missing report SKIP rather than failing, so it stays useful part-configured.
 *
 * --provision: registers a throwaway trader and, when admin credentials are
 * available, has the admin issue it an account — so the money path can be
 * exercised on a database that has never had a user in it. This is what a fresh
 * deploy needs: without it the trade steps skip and a broken deployment looks
 * indistinguishable from an unconfigured one.
 *
 * A challenge account cannot be obtained through the public API alone here —
 * POST /api/accounts/orders returns requires_payment unless a 100% coupon
 * applies — so provisioning goes through POST /api/admin/users/:id/manual-account,
 * the same endpoint an operator uses to comp an account. Without admin
 * credentials the trade steps skip, and say so.
 */

require('../loadEnv')

const crypto = require('crypto')
const axios = require('axios')

const BASE_URL = String(process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '')
const PROVISION = process.argv.includes('--provision')

// Credentials minted by --provision, filled in as the run proceeds.
const provisioned = {
  email: null,
  password: null,
  userId: null,
  accountId: null
}

function buildHeaders(extra = {}, cookie = '') {
  const headers = { ...extra }
  if (cookie) headers.Cookie = cookie
  return headers
}

function extractCookie(response, cookieName) {
  const raw = response.headers['set-cookie']
  if (!Array.isArray(raw)) return ''
  const cookie = raw.find((entry) => String(entry || '').startsWith(`${cookieName}=`))
  return cookie ? cookie.split(';')[0] : ''
}

async function getJson(path, config = {}) {
  return axios.get(`${BASE_URL}${path}`, {
    validateStatus: () => true,
    timeout: 15000,
    ...config
  })
}

async function postJson(path, data, config = {}) {
  return axios.post(`${BASE_URL}${path}`, data, {
    validateStatus: () => true,
    timeout: 15000,
    ...config
  })
}

const results = []

/**
 * Thrown when a step cannot run because something was not configured — as
 * opposed to running and failing.
 *
 * `optional: true` used to swallow BOTH. A trade open returning 500 reported
 * `SKIP  Trader trade open/close - Trade open returned 500`, and the run
 * finished "0 failed" — so a completely broken trade path was indistinguishable
 * from an unconfigured one, in the harness whose entire job is telling those
 * apart. Only a NotConfigured is a skip now; a real error fails the run.
 */
class NotConfigured extends Error {}

function notConfigured(message) {
  return new NotConfigured(message)
}

async function step(name, fn, options = {}) {
  const optional = options.optional === true
  try {
    const message = await fn()
    results.push({ name, ok: true, optional, message })
    console.log(`PASS  ${name}${message ? ` - ${message}` : ''}`)
  } catch (error) {
    if (optional && error instanceof NotConfigured) {
      results.push({ name, ok: true, optional, message: `SKIPPED: ${error.message}` })
      console.log(`SKIP  ${name} - ${error.message}`)
      return
    }
    results.push({ name, ok: false, optional, message: error.message })
    console.error(`FAIL  ${name} - ${error.message}`)
  }
}

/**
 * utils/idempotency.js fails these scopes closed without a key:
 * trades:open, payouts:request, accounts:create all return 400 rather than
 * risking a duplicate money movement on a retry. The frontend sends one per
 * request via createIdempotencyHeaders() in services/api.js; anything else
 * driving those endpoints has to as well.
 */
function idempotencyHeader(scope) {
  return { 'Idempotency-Key': `${scope}:${crypto.randomUUID()}` }
}

function assertStatus(response, expectedStatuses, context) {
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${context} returned ${response.status}${response.data?.error ? ` (${response.data.error})` : ''}`)
  }
}

/**
 * Register a throwaway trader and return its cookie.
 *
 * The email is unique per run so repeated runs never collide, and identifiable
 * so the rows are easy to find and delete afterwards. This DOES leave a user
 * behind — that is the cost of proving registration works against the real
 * stack, and it is why the address says what it is.
 */
async function registerThrowawayTrader() {
  const suffix = crypto.randomBytes(6).toString('hex')
  const email = `smoke-test+${suffix}@${String(process.env.SMOKE_EMAIL_DOMAIN || 'example.com')}`
  // Meets the password policy without being guessable across runs.
  const password = `Smoke!${crypto.randomBytes(12).toString('base64url')}`

  const response = await postJson('/api/auth/register', {
    email,
    password,
    full_name: 'Launch Smoke',
    country: String(process.env.SMOKE_COUNTRY || 'United Kingdom'),
    phone: '+441234567890',
    terms_accepted: true
  }, { headers: buildHeaders({ 'Content-Type': 'application/json' }) })

  assertStatus(response, [201], 'Trader registration')
  const cookie = extractCookie(response, 'token')
  if (!cookie) throw new Error('Registration did not return an auth cookie')

  provisioned.email = email
  provisioned.password = password
  provisioned.userId = response.data?.user?.id || null
  return cookie
}

async function loginTrader() {
  if (PROVISION) return registerThrowawayTrader()

  const email = String(process.env.SMOKE_TRADER_EMAIL || '').trim()
  const password = String(process.env.SMOKE_TRADER_PASSWORD || '').trim()
  if (!email || !password) {
    throw notConfigured('SMOKE_TRADER_EMAIL and SMOKE_TRADER_PASSWORD are not configured')
  }

  const response = await postJson('/api/auth/login', { email, password }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(response, [200], 'Trader login')
  const cookie = extractCookie(response, 'token')
  if (!cookie) throw new Error('Trader login did not return auth cookie')
  return cookie
}

async function loginSuperAdmin() {
  const email = String(process.env.SMOKE_SUPER_ADMIN_EMAIL || '').trim()
  const password = String(process.env.SMOKE_SUPER_ADMIN_PASSWORD || '').trim()
  if (!email || !password) {
    throw notConfigured('SMOKE_SUPER_ADMIN_EMAIL and SMOKE_SUPER_ADMIN_PASSWORD are not configured')
  }

  const response = await postJson('/api/admin/login', { email, password }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(response, [200], 'Super admin login')
  const cookie = extractCookie(response, 'admin_token') || `admin_token=${response.data?.token || ''}`
  if (!cookie.includes('admin_token=')) throw new Error('Super admin login did not return admin auth token')
  return cookie
}

async function main() {
  await step('GET /api/health', async () => {
    const response = await getJson('/api/health', { headers: buildHeaders() })
    assertStatus(response, [200], 'Health check')
    const status = response.data?.status
    if (!['healthy', 'warning', 'unhealthy'].includes(status)) {
      throw new Error('Health endpoint returned invalid status payload')
    }
    return `status=${status}`
  })

  await step('GET /api/price-status', async () => {
    const response = await getJson('/api/price-status', { headers: buildHeaders() })
    assertStatus(response, [200], 'Price status')
    if (!response.data || typeof response.data !== 'object') {
      throw new Error('Price status payload missing')
    }
    return `status=${response.data.status || (response.data.healthy ? 'healthy' : 'unhealthy')}`
  })

  let traderCookie = ''
  await step('Trader login + /api/auth/me', async () => {
    traderCookie = await loginTrader()
    const response = await getJson('/api/auth/me', {
      headers: buildHeaders({}, traderCookie)
    })
    assertStatus(response, [200], 'Trader /me')
    return `user=${response.data?.email || 'ok'}`
  }, { optional: true })

  await step('Trader paid challenge order creation', async () => {
    if (!traderCookie) {
      throw notConfigured('Trader login step did not run')
    }
    const accountSize = parseInt(process.env.SMOKE_ACCOUNT_SIZE || '10000', 10)
    const stepModel = process.env.SMOKE_STEP_MODEL || '2-step'
    const response = await postJson('/api/accounts/orders', { account_size: accountSize, step_model: stepModel }, {
      headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
    })
    assertStatus(response, [201], 'Challenge order creation')
    return `requires_payment=${response.data?.requires_payment ?? 'unknown'}`
  }, { optional: true })

  await step('Admin issues a challenge account', async () => {
    if (!PROVISION) {
      throw notConfigured('not in --provision mode')
    }
    if (!provisioned.userId) {
      throw notConfigured('Trader registration did not run')
    }
    // Same endpoint an operator uses to comp an account. Needs admin
    // credentials; without them the trade steps below skip rather than fail,
    // because "no admin password to hand" is not a broken deployment.
    const adminCookie = await loginSuperAdmin()
    const response = await postJson(
      `/api/admin/users/${provisioned.userId}/manual-account`,
      {
        reason: 'Automated launch smoke test — verifying the trade path end to end',
        account_type: 'phase1',
        account_size: parseInt(process.env.SMOKE_ACCOUNT_SIZE || '10000', 10)
      },
      { headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie) }
    )
    assertStatus(response, [200, 201], 'Manual account creation')
    provisioned.accountId = response.data?.account?.id || response.data?.account_id || null
    if (!provisioned.accountId) {
      throw new Error('Manual account creation did not return an account id')
    }
    return `account_id=${provisioned.accountId}`
  }, { optional: true })

  await step('Trader trade open/close', async () => {
    if (!traderCookie) {
      throw notConfigured('Trader login step did not run')
    }
    const accountId = provisioned.accountId
      ? String(provisioned.accountId)
      : String(process.env.SMOKE_TRADE_ACCOUNT_ID || '').trim()
    if (!accountId) {
      throw notConfigured(PROVISION
        ? 'no account was provisioned (admin credentials unavailable?)'
        : 'SMOKE_TRADE_ACCOUNT_ID is not configured')
    }
    const instrument = String(process.env.SMOKE_TRADE_INSTRUMENT || 'EURUSD').trim().toUpperCase()
    const openResponse = await postJson('/api/trades/open', {
      account_id: accountId,
      instrument,
      direction: 'buy',
      lots: '0.01'
    }, {
      headers: buildHeaders({
        'Content-Type': 'application/json',
        ...idempotencyHeader('trades:open')
      }, traderCookie)
    })
    assertStatus(openResponse, [201], 'Trade open')
    const tradeId = openResponse.data?.trade_id || openResponse.data?.trade?.id
    if (!tradeId) {
      throw new Error('Trade open did not return trade id')
    }
    // `min_hold_seconds` (default 60, seeded by /api/setup/init) rejects a close
    // that comes too soon. That is the rule working, not a failure — but the
    // close is the half of the cycle that moves the balance, so skipping it
    // would leave the money path unverified. Wait the rule out.
    const holdBudgetMs = Math.max(0, parseInt(process.env.SMOKE_MAX_HOLD_WAIT_SECONDS || '75', 10) * 1000)
    const startedAt = Date.now()
    let closeResponse
    let waited = false
    for (;;) {
      closeResponse = await postJson('/api/trades/close', { trade_id: tradeId }, {
        headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
      })
      const tooSoon = closeResponse.status === 400
        && /minimum trade duration/i.test(String(closeResponse.data?.error || ''))
      if (!tooSoon || Date.now() - startedAt >= holdBudgetMs) break
      if (!waited) {
        console.log(`      (waiting out the minimum hold period, up to ${holdBudgetMs / 1000}s)`)
        waited = true
      }
      await new Promise((resolve) => { setTimeout(resolve, 5000) })
    }
    assertStatus(closeResponse, [200], 'Trade close')
    return `trade_id=${tradeId} opened and closed${waited ? ' (after the minimum hold)' : ''}`
  }, { optional: true })

  await step('Trader payout request', async () => {
    if (!traderCookie) {
      throw notConfigured('Trader login step did not run')
    }
    const fundedAccountId = String(process.env.SMOKE_PAYOUT_ACCOUNT_ID || '').trim()
    if (!fundedAccountId) {
      throw notConfigured('SMOKE_PAYOUT_ACCOUNT_ID is not configured')
    }
    const response = await postJson('/api/payouts/request', {
      account_id: fundedAccountId,
      amount_requested: '50',
      payment_method: 'crypto',
      payment_details: { wallet: 'smoke-test-wallet' }
    }, {
      headers: buildHeaders({
        'Content-Type': 'application/json',
        ...idempotencyHeader('payouts:request')
      }, traderCookie)
    })
    assertStatus(response, [201], 'Payout request')
    return 'payout_requested'
  }, { optional: true })

  await step('Super admin login + /api/admin/session', async () => {
    const superAdminCookie = await loginSuperAdmin()
    const response = await getJson('/api/admin/session', {
      headers: buildHeaders({}, superAdminCookie)
    })
    assertStatus(response, [200], 'Super admin session')
    return `authenticated=${response.data?.authenticated ?? 'unknown'}`
  }, { optional: true })

  if (PROVISION && provisioned.email) {
    console.log(`\nProvisioned test data left behind: ${provisioned.email}` +
      (provisioned.accountId ? ` (account ${provisioned.accountId})` : ''))
    console.log('Delete it before taking real users, or leave it — it holds no real money.')
  }

  const failures = results.filter((entry) => entry.ok === false)
  const passed = results.filter((entry) => entry.ok === true && entry.optional !== true).length
  const optionalPassed = results.filter((entry) => entry.ok === true && entry.optional === true && !String(entry.message || '').startsWith('SKIPPED')).length
  const skipped = results.filter((entry) => entry.optional === true && String(entry.message || '').startsWith('SKIPPED')).length

  console.log(`\nSummary: ${passed} required passed, ${optionalPassed} optional passed, ${skipped} optional skipped, ${failures.length} failed`)
  if (failures.length > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('Launch smoke failed:', error.message)
  process.exitCode = 1
})
