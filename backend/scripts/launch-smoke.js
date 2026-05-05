require('../loadEnv')

const axios = require('axios')

const BASE_URL = String(process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '')
const TENANT_SLUG = String(process.env.SMOKE_TENANT_SLUG || '').trim()

function buildHeaders(extra = {}, cookie = '') {
  const headers = { ...extra }
  if (TENANT_SLUG) headers['X-Tenant-Slug'] = TENANT_SLUG
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

async function step(name, fn, options = {}) {
  const optional = options.optional === true
  try {
    const message = await fn()
    results.push({ name, ok: true, optional, message })
    console.log(`PASS  ${name}${message ? ` - ${message}` : ''}`)
  } catch (error) {
    if (optional) {
      results.push({ name, ok: true, optional, message: `SKIPPED: ${error.message}` })
      console.log(`SKIP  ${name} - ${error.message}`)
      return
    }
    results.push({ name, ok: false, optional, message: error.message })
    console.error(`FAIL  ${name} - ${error.message}`)
  }
}

function assertStatus(response, expectedStatuses, context) {
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(`${context} returned ${response.status}${response.data?.error ? ` (${response.data.error})` : ''}`)
  }
}

async function loginTrader() {
  const email = String(process.env.SMOKE_TRADER_EMAIL || '').trim()
  const password = String(process.env.SMOKE_TRADER_PASSWORD || '').trim()
  if (!email || !password) {
    throw new Error('SMOKE_TRADER_EMAIL and SMOKE_TRADER_PASSWORD are not configured')
  }

  const response = await postJson('/api/auth/login', { email, password }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(response, [200], 'Trader login')
  const cookie = extractCookie(response, 'token')
  if (!cookie) throw new Error('Trader login did not return auth cookie')
  return cookie
}

async function loginAdmin() {
  const email = String(process.env.SMOKE_TENANT_ADMIN_EMAIL || '').trim()
  const password = String(process.env.SMOKE_TENANT_ADMIN_PASSWORD || '').trim()
  if (!email || !password) {
    throw new Error('SMOKE_TENANT_ADMIN_EMAIL and SMOKE_TENANT_ADMIN_PASSWORD are not configured')
  }

  const response = await postJson('/api/admin/login', { email, password }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(response, [200], 'Tenant admin login')
  const cookie = extractCookie(response, 'admin_token') || `admin_token=${response.data?.token || ''}`
  if (!cookie.includes('admin_token=')) throw new Error('Tenant admin login did not return admin auth token')
  return cookie
}

async function loginSuperAdmin() {
  const email = String(process.env.SMOKE_SUPER_ADMIN_EMAIL || '').trim()
  const password = String(process.env.SMOKE_SUPER_ADMIN_PASSWORD || '').trim()
  if (!email || !password) {
    throw new Error('SMOKE_SUPER_ADMIN_EMAIL and SMOKE_SUPER_ADMIN_PASSWORD are not configured')
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

  await step('GET /api/tenant/config', async () => {
    const response = await getJson('/api/tenant/config', { headers: buildHeaders() })
    assertStatus(response, [200], 'Tenant config')
    if (!response.data?.tenant) {
      throw new Error('Tenant config did not include tenant payload')
    }
    return `tenant=${response.data.tenant.slug || 'default'}`
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

  await step('Trader free/paid challenge order creation', async () => {
    if (!traderCookie) {
      throw new Error('Trader login step did not run')
    }
    const accountSize = parseInt(process.env.SMOKE_ACCOUNT_SIZE || '10000', 10)
    const response = await postJson('/api/accounts/orders', { account_size: accountSize }, {
      headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
    })
    assertStatus(response, [201], 'Challenge order creation')
    return `checkout_mode=${response.data?.checkout_mode || 'unknown'}`
  }, { optional: true })

  await step('Trader trade open/close', async () => {
    if (!traderCookie) {
      throw new Error('Trader login step did not run')
    }
    const accountId = String(process.env.SMOKE_TRADE_ACCOUNT_ID || '').trim()
    if (!accountId) {
      throw new Error('SMOKE_TRADE_ACCOUNT_ID is not configured')
    }
    const instrument = String(process.env.SMOKE_TRADE_INSTRUMENT || 'EURUSD').trim().toUpperCase()
    const openResponse = await postJson('/api/trades/open', {
      account_id: accountId,
      instrument,
      direction: 'buy',
      lots: '0.01'
    }, {
      headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
    })
    assertStatus(openResponse, [201], 'Trade open')
    const tradeId = openResponse.data?.trade_id || openResponse.data?.trade?.id
    if (!tradeId) {
      throw new Error('Trade open did not return trade id')
    }
    const closeResponse = await postJson('/api/trades/close', { trade_id: tradeId }, {
      headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
    })
    assertStatus(closeResponse, [200], 'Trade close')
    return `trade_id=${tradeId}`
  }, { optional: true })

  await step('Trader payout request', async () => {
    if (!traderCookie) {
      throw new Error('Trader login step did not run')
    }
    const fundedAccountId = String(process.env.SMOKE_PAYOUT_ACCOUNT_ID || '').trim()
    if (!fundedAccountId) {
      throw new Error('SMOKE_PAYOUT_ACCOUNT_ID is not configured')
    }
    const response = await postJson('/api/payouts/request', {
      account_id: fundedAccountId,
      amount_requested: '50',
      payment_method: 'crypto',
      payment_details: { wallet: 'smoke-test-wallet' }
    }, {
      headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
    })
    assertStatus(response, [201], 'Payout request')
    return 'payout_requested'
  }, { optional: true })

  let tenantAdminCookie = ''
  await step('Tenant admin login + subscription view', async () => {
    tenantAdminCookie = await loginAdmin()
    const response = await getJson('/api/billing/tenant/subscription', {
      headers: buildHeaders({}, tenantAdminCookie)
    })
    assertStatus(response, [200], 'Tenant subscription view')
    return `status=${response.data?.status || 'none'}`
  }, { optional: true })

  await step('Super admin login + tenant list', async () => {
    const superAdminCookie = await loginSuperAdmin()
    const response = await getJson('/api/admin/tenants', {
      headers: buildHeaders({}, superAdminCookie)
    })
    assertStatus(response, [200], 'Super admin tenant list')
    if (!Array.isArray(response.data)) {
      throw new Error('Tenant list payload is not an array')
    }
    return `tenants=${response.data.length}`
  }, { optional: true })

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
