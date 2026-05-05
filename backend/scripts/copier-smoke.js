require('../loadEnv')

const axios = require('axios')
const pool = require('../db')

const BASE_URL = String(process.env.COPIER_SMOKE_BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '')
const TENANT_SLUG = String(process.env.COPIER_SMOKE_TENANT_SLUG || '').trim()
const TEST_INSTRUMENT = String(process.env.COPIER_SMOKE_INSTRUMENT || 'EURUSD').trim().toUpperCase()
const CLOSE_WAIT_SECONDS = parseInt(process.env.COPIER_SMOKE_CLOSE_WAIT_SECONDS || '65', 10)
const DEFAULT_ACCOUNT_SIZE = parseInt(process.env.COPIER_SMOKE_ACCOUNT_SIZE || '10000', 10)
const AUTO_REGISTER = String(process.env.COPIER_SMOKE_AUTO_REGISTER || 'true').trim().toLowerCase() !== 'false'
const ALLOW_LOCAL_FEED_BOOTSTRAP = String(process.env.COPIER_SMOKE_BOOTSTRAP_LOCAL_FEED || '').trim().toLowerCase() === 'true'
const SMOKE_RUN_ID = String(process.env.COPIER_SMOKE_RUN_ID || Date.now()).trim()

const FALLBACK_PRICES = {
  EURUSD: { bid: 1.085, ask: 1.0852 },
  GBPUSD: { bid: 1.272, ask: 1.2722 },
  USDJPY: { bid: 156.15, ask: 156.17 },
  XAUUSD: { bid: 2320.4, ask: 2320.9 }
}

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

function assertStatus(response, statuses, label) {
  if (!statuses.includes(response.status)) {
    throw new Error(`${label} returned ${response.status}${response.data?.error ? ` (${response.data.error})` : ''}`)
  }
}

async function getJson(path, config = {}) {
  return axios.get(`${BASE_URL}${path}`, {
    validateStatus: () => true,
    timeout: 20000,
    ...config
  })
}

async function postJson(path, body, config = {}) {
  return axios.post(`${BASE_URL}${path}`, body, {
    validateStatus: () => true,
    timeout: 20000,
    ...config
  })
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function bootstrapLocalFeedQuote(instrument) {
  if (!ALLOW_LOCAL_FEED_BOOTSTRAP) return false

  const normalizedInstrument = String(instrument || '').trim().toUpperCase()
  if (!normalizedInstrument) return false

  let bid = null
  let ask = null

  const currentResult = await pool.query(
    `SELECT bid, ask
       FROM price_feed
      WHERE instrument = $1
      LIMIT 1`,
    [normalizedInstrument]
  )

  if (currentResult.rows[0]) {
    bid = parseFloat(currentResult.rows[0].bid)
    ask = parseFloat(currentResult.rows[0].ask)
  }

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    const historyResult = await pool.query(
      `SELECT bid, ask
         FROM price_feed_history
        WHERE instrument = $1
        ORDER BY recorded_at DESC
        LIMIT 1`,
      [normalizedInstrument]
    )
    if (historyResult.rows[0]) {
      bid = parseFloat(historyResult.rows[0].bid)
      ask = parseFloat(historyResult.rows[0].ask)
    }
  }

  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    const fallback = FALLBACK_PRICES[normalizedInstrument]
    if (!fallback) return false
    bid = fallback.bid
    ask = fallback.ask
  }

  await pool.query(
    `INSERT INTO price_feed (instrument, bid, ask, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (instrument)
     DO UPDATE SET
       bid = EXCLUDED.bid,
       ask = EXCLUDED.ask,
       updated_at = NOW()`,
    [normalizedInstrument, bid, ask]
  )

  return true
}

async function pollUntil(label, fn, timeoutMs = 30000, intervalMs = 1000) {
  const startedAt = Date.now()
  let lastError = null
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      await wait(intervalMs)
    }
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

async function loginAdmin() {
  const email = String(process.env.COPIER_SMOKE_ADMIN_EMAIL || '').trim()
  const password = String(process.env.COPIER_SMOKE_ADMIN_PASSWORD || '').trim()
  if (!password) {
    throw new Error('COPIER_SMOKE_ADMIN_PASSWORD is required')
  }
  const response = await postJson('/api/admin/login', { email, password }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(response, [200], 'Admin login')
  return extractCookie(response, 'admin_token') || `admin_token=${response.data?.token || ''}`
}

function buildTraderCredentials() {
  const uniqueSuffix = String(Date.now())
  return {
    email: String(process.env.COPIER_SMOKE_TRADER_EMAIL || `copier.smoke.${uniqueSuffix}@example.com`).trim().toLowerCase(),
    password: String(process.env.COPIER_SMOKE_TRADER_PASSWORD || 'SmokePass!23').trim(),
    fullName: String(process.env.COPIER_SMOKE_TRADER_NAME || 'Copier Smoke Trader').trim(),
    country: String(process.env.COPIER_SMOKE_COUNTRY || 'India').trim(),
    phone: String(process.env.COPIER_SMOKE_PHONE || `99999${uniqueSuffix.slice(-5)}`).trim()
  }
}

async function loginTrader(credentials) {
  const email = String(credentials?.email || '').trim()
  const password = String(credentials?.password || '').trim()
  if (!email || !password) {
    throw new Error('Trader credentials are required')
  }
  const response = await postJson('/api/auth/login', { email, password }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(response, [200], 'Trader login')
  return {
    cookie: extractCookie(response, 'token') || `token=${response.data?.token || ''}`,
    user: response.data?.user || null
  }
}

async function ensureTraderSession() {
  const credentials = buildTraderCredentials()
  try {
    const session = await loginTrader(credentials)
    return { ...session, credentials, registered: false }
  } catch (error) {
    if (!AUTO_REGISTER) {
      throw error
    }
  }

  const registerResponse = await postJson('/api/auth/register', {
    email: credentials.email,
    password: credentials.password,
    full_name: credentials.fullName,
    country: credentials.country,
    phone: credentials.phone
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' })
  })
  assertStatus(registerResponse, [201], 'Trader registration')
  return {
    cookie: extractCookie(registerResponse, 'token') || `token=${registerResponse.data?.token || ''}`,
    user: registerResponse.data?.user || null,
    credentials,
    registered: true
  }
}

async function ensureTraderKycApproved(adminCookie, userId) {
  if (!userId) {
    throw new Error('Cannot approve KYC without a trader user id')
  }
  const response = await postJson('/api/admin/kyc/approve', {
    user_id: userId
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie)
  })
  assertStatus(response, [200], 'Approve trader KYC')
}

async function issueManualTradeAccount(adminCookie, traderUserId) {
  if (!traderUserId) {
    throw new Error('Cannot issue a manual account without a trader user id')
  }
  const response = await postJson(`/api/admin/users/${encodeURIComponent(traderUserId)}/manual-account`, {
    reason: 'Copier smoke bootstrap',
    account_type: 'phase1',
    account_size: DEFAULT_ACCOUNT_SIZE
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie)
  })
  assertStatus(response, [200], 'Issue manual smoke account')
  return response.data?.account || null
}

async function ensureTradeAccount(adminCookie, traderCookie, traderUserId) {
  const explicitTradeAccountId = String(process.env.COPIER_SMOKE_TRADE_ACCOUNT_ID || '').trim()
  const explicitMasterAccountId = String(process.env.COPIER_SMOKE_MASTER_ACCOUNT_ID || '').trim()
  if (explicitTradeAccountId || explicitMasterAccountId) {
    return {
      tradeAccountId: explicitTradeAccountId || explicitMasterAccountId,
      masterAccountId: explicitMasterAccountId || explicitTradeAccountId
    }
  }

  const listExistingAccounts = async () => {
    const response = await getJson('/api/accounts/my-accounts', {
      headers: buildHeaders({}, traderCookie)
    })
    assertStatus(response, [200], 'List trader accounts')
    return Array.isArray(response.data) ? response.data : []
  }

  const findActiveAccount = (accounts) => accounts.find((account) => String(account.status || '').toLowerCase() === 'active')

  let accounts = await listExistingAccounts()
  let activeAccount = findActiveAccount(accounts)

  if (!activeAccount) {
    const createChallengeAccount = () => postJson('/api/accounts/create', {
      account_size: DEFAULT_ACCOUNT_SIZE
    }, {
      headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
    })

    let createResponse = await createChallengeAccount()
    if (createResponse.status === 403 && /KYC approval required/i.test(String(createResponse.data?.error || ''))) {
      await ensureTraderKycApproved(adminCookie, traderUserId)
      createResponse = await createChallengeAccount()
    }
    if (createResponse.status !== 201) {
      await issueManualTradeAccount(adminCookie, traderUserId)
    } else {
      assertStatus(createResponse, [201], 'Create challenge account')
    }
    accounts = await listExistingAccounts()
    activeAccount = findActiveAccount(accounts)
  }

  if (!activeAccount?.id) {
    throw new Error('No active trade account is available for the smoke run')
  }

  return {
    tradeAccountId: String(activeAccount.id),
    masterAccountId: String(activeAccount.id)
  }
}

async function ensureMaster(adminCookie, tenantId, accountId) {
  const listResponse = await getJson('/api/admin/copier/masters', {
    params: { tenant_id: tenantId },
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(listResponse, [200], 'List copier masters')
  const existing = (Array.isArray(listResponse.data) ? listResponse.data : []).find((row) => String(row.account_id) === String(accountId))
  if (existing) return existing

  const createResponse = await postJson('/api/admin/copier/masters', {
    tenant_id: tenantId,
    account_id: accountId,
    label: `Smoke Master ${accountId}`
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie)
  })
  assertStatus(createResponse, [201], 'Create copier master')
  return createResponse.data
}

async function ensureFollower(adminCookie, tenantId) {
  const bridgeTargetKey = String(process.env.COPIER_SMOKE_FOLLOWER_KEY || `smoke-follower-${SMOKE_RUN_ID}`).trim()
  const displayName = String(process.env.COPIER_SMOKE_FOLLOWER_NAME || `Smoke Follower ${SMOKE_RUN_ID}`).trim()

  const listResponse = await getJson('/api/admin/copier/followers', {
    params: { tenant_id: tenantId },
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(listResponse, [200], 'List copier followers')
  const existing = (Array.isArray(listResponse.data) ? listResponse.data : []).find((row) => row.bridge_target_key === bridgeTargetKey)
  if (existing) return existing

  const createResponse = await postJson('/api/admin/copier/followers', {
    tenant_id: tenantId,
    display_name: displayName,
    bridge_target_key: bridgeTargetKey,
    status: 'active',
    copy_mode: 'mirror',
    risk_mode: 'fixed_lots',
    fixed_lots: '0.10',
    symbol_allowlist: [TEST_INSTRUMENT]
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie)
  })
  assertStatus(createResponse, [201], 'Create copier follower')
  return createResponse.data
}

async function ensureMapping(adminCookie, tenantId, masterId, followerId) {
  const listResponse = await getJson('/api/admin/copier/mappings', {
    params: { tenant_id: tenantId },
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(listResponse, [200], 'List copier mappings')
  const existing = (Array.isArray(listResponse.data) ? listResponse.data : []).find((row) => String(row.master_id) === String(masterId) && String(row.follower_id) === String(followerId))
  if (existing) return existing

  const createResponse = await postJson('/api/admin/copier/mappings', {
    tenant_id: tenantId,
    master_id: masterId,
    follower_id: followerId,
    is_enabled: true,
    allowed_master_account_types: ['phase1', 'phase2', 'funded'],
    symbol_allowlist: [TEST_INSTRUMENT]
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie)
  })
  assertStatus(createResponse, [201], 'Create copier mapping')
  return createResponse.data
}

async function ensureSymbolMapping(adminCookie, tenantId, followerId, symbol) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase()
  if (!normalizedSymbol) {
    throw new Error('A copier smoke symbol mapping requires a symbol')
  }

  const listResponse = await getJson('/api/admin/copier/symbol-mappings', {
    params: { tenant_id: tenantId },
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(listResponse, [200], 'List copier symbol mappings')
  const existing = (Array.isArray(listResponse.data) ? listResponse.data : []).find((row) =>
    String(row.follower_id) === String(followerId)
    && String(row.master_symbol || '').toUpperCase() === normalizedSymbol
    && String(row.follower_symbol || '').toUpperCase() === normalizedSymbol
    && row.is_enabled !== false
  )
  if (existing) return existing

  const createResponse = await postJson('/api/admin/copier/symbol-mappings', {
    tenant_id: tenantId,
    follower_id: followerId,
    master_symbol: normalizedSymbol,
    follower_symbol: normalizedSymbol,
    is_enabled: true
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, adminCookie)
  })
  assertStatus(createResponse, [201], 'Create copier symbol mapping')
  return createResponse.data
}

async function fetchTenantIdForAccount(accountId, adminCookie) {
  const response = await getJson('/api/admin/copier/masters', {
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(response, [200], 'Probe copier masters')
  const found = (Array.isArray(response.data) ? response.data : []).find((row) => String(row.account_id) === String(accountId))
  if (found?.tenant_id) return found.tenant_id

  const accountResponse = await getJson('/api/admin/accounts', {
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(accountResponse, [200], 'Load admin accounts')
  const account = (Array.isArray(accountResponse.data) ? accountResponse.data : []).find((row) => String(row.id) === String(accountId))
  return account?.tenant_id || 1
}

async function findJob(adminCookie, tenantId, masterTradeId, followerId, expectedEventType) {
  const response = await getJson('/api/admin/copier/jobs', {
    params: { tenant_id: tenantId, limit: 200 },
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(response, [200], 'List copier jobs')
  const jobs = Array.isArray(response.data) ? response.data : []
  const job = jobs.find((row) =>
    String(row.master_trade_id) === String(masterTradeId)
    && String(row.follower_id) === String(followerId)
    && String(row.event_type || '').toUpperCase() === String(expectedEventType || '').toUpperCase()
  )
  if (!job) {
    throw new Error(`No copier job found yet for trade ${masterTradeId} / event ${expectedEventType}`)
  }
  if (job.state === 'dead' || job.state === 'expired') {
    throw new Error(`Copier job ${job.id} failed with state ${job.state}${job.last_error ? ` (${job.last_error})` : ''}`)
  }
  if (job.state !== 'acknowledged') {
    throw new Error(`Copier job ${job.id} is still ${job.state}`)
  }
  return job
}

async function waitForReconciliationToSettle(adminCookie, tenantId, followerId) {
  return pollUntil(
    'copier reconciliation settle',
    async () => {
      const response = await getJson('/api/admin/copier/reconciliation', {
        params: { tenant_id: tenantId, follower_id: followerId },
        headers: buildHeaders({}, adminCookie)
      })
      assertStatus(response, [200], 'Copier reconciliation')
      const diffs = Array.isArray(response.data?.rows) ? response.data.rows : []
      if (diffs.length > 0) {
        const summary = diffs.map((row) => `${row.type}: ${row.detail}`).join(' | ')
        throw new Error(summary)
      }
      return diffs
    },
    10000,
    1000
  )
}

async function main() {
  const explicitTenantId = String(process.env.COPIER_SMOKE_TENANT_ID || '').trim()
  console.log(`[copier-smoke] base=${BASE_URL} instrument=${TEST_INSTRUMENT}`)
  const adminCookie = await loginAdmin()
  const traderSession = await ensureTraderSession()
  const traderCookie = traderSession.cookie
  const accountSelection = await ensureTradeAccount(adminCookie, traderCookie, traderSession.user?.id || traderSession.user?.trader_id || null)
  const masterAccountId = accountSelection.masterAccountId
  const tradeAccountId = accountSelection.tradeAccountId
  const tenantId = explicitTenantId || await fetchTenantIdForAccount(masterAccountId, adminCookie)

  console.log(`[copier-smoke] trader=${traderSession.credentials.email} registered=${traderSession.registered}`)

  const healthResponse = await getJson('/api/admin/copier/health', {
    params: { tenant_id: tenantId },
    headers: buildHeaders({}, adminCookie)
  })
  assertStatus(healthResponse, [200], 'Copier health')
  if (!healthResponse.data?.runtime?.running) {
    throw new Error('Copier worker is not reporting running=true')
  }

  const master = await ensureMaster(adminCookie, tenantId, masterAccountId)
  const follower = await ensureFollower(adminCookie, tenantId)
  await ensureMapping(adminCookie, tenantId, master.id, follower.id)
  await ensureSymbolMapping(adminCookie, tenantId, follower.id, TEST_INSTRUMENT)

  console.log(`[copier-smoke] master=${master.id} follower=${follower.id} tenant=${tenantId}`)

  await bootstrapLocalFeedQuote(TEST_INSTRUMENT)

  const openResponse = await postJson('/api/trades/open', {
    account_id: tradeAccountId,
    instrument: TEST_INSTRUMENT,
    direction: 'buy',
    lots: '0.01'
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
  })
  assertStatus(openResponse, [201], 'Open trade')
  const tradeId = openResponse.data?.trade_id || openResponse.data?.trade?.id
  if (!tradeId) {
    throw new Error('Trade open did not return trade_id')
  }
  console.log(`[copier-smoke] opened trade ${tradeId}`)

  const openJob = await pollUntil(
    'open copier ack',
    () => findJob(adminCookie, tenantId, tradeId, follower.id, 'OPEN_MARKET'),
    30000,
    1000
  )
  console.log(`[copier-smoke] open job acknowledged: ${openJob.id}`)

  console.log(`[copier-smoke] waiting ${CLOSE_WAIT_SECONDS}s before manual close to satisfy min hold`)
  await wait(Math.max(1, CLOSE_WAIT_SECONDS) * 1000)
  await bootstrapLocalFeedQuote(TEST_INSTRUMENT)

  const closeResponse = await postJson('/api/trades/close', {
    trade_id: tradeId
  }, {
    headers: buildHeaders({ 'Content-Type': 'application/json' }, traderCookie)
  })
  assertStatus(closeResponse, [200], 'Close trade')
  console.log(`[copier-smoke] closed trade ${tradeId}`)

  const closeJob = await pollUntil(
    'close copier ack',
    () => findJob(adminCookie, tenantId, tradeId, follower.id, 'CLOSE_POSITION'),
    30000,
    1000
  )
  console.log(`[copier-smoke] close job acknowledged: ${closeJob.id}`)

  const diffs = await waitForReconciliationToSettle(adminCookie, tenantId, follower.id)
  console.log(`[copier-smoke] reconciliation diffs after smoke run: ${diffs.length}`)
  console.log('[copier-smoke] PASS')
}

main()
  .catch((error) => {
    console.error(`[copier-smoke] FAIL: ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await pool.end()
    } catch {}
  })
