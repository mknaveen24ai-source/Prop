'use strict'

/**
 * Concurrency / race-condition harness.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     RACE_BASE_URL=http://127.0.0.1:5099 \
 *     RACE_SUPER_ADMIN_EMAIL=... RACE_SUPER_ADMIN_PASSWORD=... \
 *     DATABASE_URL=... node scripts/audit/race-conditions.js
 *
 *     --json
 *
 * Fires genuinely simultaneous HTTP requests at the money paths and then reads
 * the database to see what actually happened. Everything here is a lost-update
 * or double-spend shape:
 *
 *     request A reads balance
 *     request B reads balance
 *     request A writes
 *     request B writes        <- A's effect is gone, or applied twice
 *
 * ── Why this cannot be a unit test ──
 *
 * A race needs two connections contending inside real Postgres. The existing
 * suite mocks the pg pool, so `FOR UPDATE` in a mocked query is a string in an
 * assertion, not a lock — the code can look perfectly serialized and not be. The
 * only way to know whether the lock holds is to make two requests fight over the
 * same row and count what the ledger says afterwards.
 *
 * ── Reading the results ──
 *
 * The pass condition is never "no request failed". Losing one of two concurrent
 * duplicate requests is the CORRECT outcome; both succeeding is the bug. Each
 * check therefore asserts on the DATABASE state after the dust settles, not on
 * the HTTP statuses.
 */

require('../../loadEnv')

const crypto = require('crypto')
const axios = require('axios')
const { Client } = require('pg')

const BASE_URL = String(process.env.RACE_BASE_URL || 'http://127.0.0.1:5099').replace(/\/+$/, '')
const JSON_OUT = process.argv.includes('--json')
const CONCURRENCY = 8

function http(method, url, { cookie, data, idempotencyKey } = {}) {
  return axios({
    method,
    url: `${BASE_URL}${url}`,
    data,
    headers: {
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    validateStatus: () => true,
    timeout: 30000
  })
}

function cookieFrom(response, name) {
  const raw = response.headers['set-cookie']
  if (!Array.isArray(raw)) return ''
  const found = raw.find((entry) => String(entry || '').startsWith(`${name}=`))
  return found ? found.split(';')[0] : ''
}

function policyPassword() {
  return `Aa1!${crypto.randomBytes(12).toString('base64url')}0zX`
}

async function registerTrader() {
  const email = `race-${crypto.randomBytes(6).toString('hex')}@example.com`
  const password = policyPassword()
  const response = await http('post', '/api/auth/register', {
    data: {
      email, password, full_name: 'Race Probe', country: 'United Kingdom',
      phone: '+441234567890', terms_accepted: true
    }
  })
  if (response.status !== 201) {
    throw new Error(`register returned ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`)
  }
  return { cookie: cookieFrom(response, 'token'), userId: response.data?.user?.id, email }
}

async function loginSuperAdmin() {
  const email = String(process.env.RACE_SUPER_ADMIN_EMAIL || '').trim()
  const password = String(process.env.RACE_SUPER_ADMIN_PASSWORD || '').trim()
  if (!email || !password) throw new Error('RACE_SUPER_ADMIN_EMAIL and RACE_SUPER_ADMIN_PASSWORD are required')
  const response = await http('post', '/api/admin/login', { data: { email, password } })
  if (response.status !== 200) {
    throw new Error(`admin login returned ${response.status}: ${JSON.stringify(response.data).slice(0, 160)}`)
  }
  return cookieFrom(response, 'admin_token') || `admin_token=${response.data?.token || ''}`
}

/** Fire N identical requests as close to simultaneously as the runtime allows. */
async function stampede(n, makeRequest) {
  // Built first, awaited together: constructing inside Promise.all would
  // serialize the setup and hand the first request a head start, which is the
  // difference between testing a race and testing a queue.
  const inFlight = []
  for (let i = 0; i < n; i++) inFlight.push(makeRequest(i))
  return Promise.allSettled(inFlight)
}

function summarize(results) {
  const statuses = {}
  for (const r of results) {
    const status = r.status === 'fulfilled' ? r.value.status : 'rejected'
    statuses[status] = (statuses[status] || 0) + 1
  }
  return statuses
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')

  const db = new Client({ connectionString: process.env.DATABASE_URL })
  await db.connect()

  const superCookie = await loginSuperAdmin()
  const checks = []

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Concurrent identical trade opens
  //
  // Same account, same idempotency key, fired together. Exactly one position
  // must exist afterwards: an idempotency key that only works when requests
  // arrive sequentially is not idempotency, it is luck.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const trader = await registerTrader()
    const issued = await http('post', `/api/admin/users/${trader.userId}/manual-account`, {
      cookie: superCookie,
      idempotencyKey: `race:acct:${crypto.randomUUID()}`,
      data: { account_size: 10000, challenge_type: 'two_phase', reason: 'race harness' }
    })
    const accountId = issued.data?.account?.id
    const key = `trades:open:${crypto.randomUUID()}`

    const results = await stampede(CONCURRENCY, () => http('post', '/api/trades/open', {
      cookie: trader.cookie,
      idempotencyKey: key,
      data: { account_id: accountId, instrument: 'EURUSD', direction: 'buy', lots: 0.01 }
    }))

    const { rows } = await db.query(
      "SELECT COUNT(*)::int AS n FROM trades WHERE account_id = $1 AND status = 'open'",
      [accountId]
    )
    checks.push({
      name: 'concurrent identical trade opens (same idempotency key)',
      concurrency: CONCURRENCY,
      statuses: summarize(results),
      observed: `${rows[0].n} open position(s)`,
      expected: 'exactly 1',
      pass: rows[0].n === 1,
      accountId
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Concurrent DISTINCT trade opens
  //
  // Different keys, so all are legitimate. This is not about idempotency: it
  // checks the margin/equity gate holds when several requests read the same
  // balance before any of them writes. Each open must be affordable against the
  // equity remaining after the others, not against the shared starting balance.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const trader = await registerTrader()
    const issued = await http('post', `/api/admin/users/${trader.userId}/manual-account`, {
      cookie: superCookie,
      idempotencyKey: `race:acct:${crypto.randomUUID()}`,
      data: { account_size: 10000, challenge_type: 'two_phase', reason: 'race harness' }
    })
    const accountId = issued.data?.account?.id

    // 20 lots of EURUSD is ~$2M notional — far beyond what $10,000 of equity
    // can margin, so only a few may be admitted however they interleave.
    const results = await stampede(CONCURRENCY, () => http('post', '/api/trades/open', {
      cookie: trader.cookie,
      idempotencyKey: `trades:open:${crypto.randomUUID()}`,
      data: { account_id: accountId, instrument: 'EURUSD', direction: 'buy', lots: 20 }
    }))

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(lot_size), 0)::numeric AS lots
         FROM trades WHERE account_id = $1 AND status = 'open'`,
      [accountId]
    )
    const account = await db.query('SELECT current_balance FROM accounts WHERE id = $1', [accountId])
    checks.push({
      name: 'concurrent oversized opens must respect margin',
      concurrency: CONCURRENCY,
      statuses: summarize(results),
      observed: `${rows[0].n} open, ${rows[0].lots} lots, balance ${account.rows[0]?.current_balance}`,
      expected: 'admitted lots must be affordable — not all 8',
      pass: Number(rows[0].n) < CONCURRENCY,
      accountId
    })
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Concurrent closes of ONE position
  //
  // The classic double-spend: if two closes both book PnL, the account is
  // credited twice for one position.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const trader = await registerTrader()
    const issued = await http('post', `/api/admin/users/${trader.userId}/manual-account`, {
      cookie: superCookie,
      idempotencyKey: `race:acct:${crypto.randomUUID()}`,
      data: { account_size: 10000, challenge_type: 'two_phase', reason: 'race harness' }
    })
    const accountId = issued.data?.account?.id

    let opened = null
    for (let attempt = 0; attempt < 8 && !opened; attempt++) {
      const r = await http('post', '/api/trades/open', {
        cookie: trader.cookie,
        idempotencyKey: `trades:open:${crypto.randomUUID()}`,
        data: { account_id: accountId, instrument: 'EURUSD', direction: 'buy', lots: 0.05 }
      })
      if (r.status < 400) opened = r.data?.trade_id || r.data?.trade?.id
      else await new Promise((resolve) => setTimeout(resolve, 2500))
    }

    if (!opened) {
      checks.push({
        name: 'concurrent closes of one position',
        skipped: 'could not open a position to close (price feed rejected every attempt)',
        pass: null
      })
    } else {
      // The platform enforces a minimum holding time; wait it out rather than
      // racing the guard, which would test the wrong thing.
      let closable = false
      for (let i = 0; i < 20 && !closable; i++) {
        const probe = await http('post', '/api/trades/close', {
          cookie: trader.cookie,
          idempotencyKey: `trades:close:probe:${crypto.randomUUID()}`,
          data: { trade_id: opened, account_id: accountId }
        })
        if (!/Minimum trade duration/i.test(JSON.stringify(probe.data))) {
          closable = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }

      const before = await db.query('SELECT current_balance FROM accounts WHERE id = $1', [accountId])
      const results = await stampede(CONCURRENCY, () => http('post', '/api/trades/close', {
        cookie: trader.cookie,
        idempotencyKey: `trades:close:${crypto.randomUUID()}`,
        data: { trade_id: opened, account_id: accountId }
      }))
      const closedRows = await db.query(
        "SELECT COUNT(*)::int AS n FROM trades WHERE (id = $1 OR parent_trade_id = $1) AND status = 'closed'",
        [opened]
      )
      const after = await db.query('SELECT current_balance FROM accounts WHERE id = $1', [accountId])

      checks.push({
        name: 'concurrent closes of one position',
        concurrency: CONCURRENCY,
        statuses: summarize(results),
        observed: `${closedRows.rows[0].n} closed row(s), balance ${before.rows[0]?.current_balance} -> ${after.rows[0]?.current_balance}`,
        expected: 'exactly 1 closed row; PnL booked once',
        pass: closedRows.rows[0].n === 1,
        accountId
      })
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Concurrent payout requests
  //
  // Two requests reading the same realised profit before either writes would let
  // a trader request the same money twice.
  // ───────────────────────────────────────────────────────────────────────────
  {
    const trader = await registerTrader()
    const issued = await http('post', `/api/admin/users/${trader.userId}/manual-account`, {
      cookie: superCookie,
      idempotencyKey: `race:acct:${crypto.randomUUID()}`,
      data: { account_size: 10000, challenge_type: 'funded', reason: 'race harness payout' }
    })
    const accountId = issued.data?.account?.id

    const results = await stampede(CONCURRENCY, () => http('post', '/api/payouts/request', {
      cookie: trader.cookie,
      idempotencyKey: `payouts:request:${crypto.randomUUID()}`,
      data: { account_id: accountId, amount: 100 }
    }))

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM payouts WHERE account_id = $1 AND status IN ('pending','under_review','approved')`,
      [accountId]
    )
    checks.push({
      name: 'concurrent payout requests',
      concurrency: CONCURRENCY,
      statuses: summarize(results),
      observed: `${rows[0].n} live payout row(s)`,
      expected: 'at most 1 — the eligibility rules forbid a second pending payout',
      pass: rows[0].n <= 1,
      accountId
    })
  }

  await db.end()

  const result = { baseUrl: BASE_URL, concurrency: CONCURRENCY, checks }
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  else report(result)

  const failed = checks.filter((c) => c.pass === false)
  process.exitCode = failed.length > 0 ? 1 : 0
}

function report(r) {
  console.log('Race conditions')
  console.log('='.repeat(74))
  console.log(`  base URL     ${r.baseUrl}`)
  console.log(`  concurrency  ${r.concurrency} simultaneous requests per check`)
  console.log('')
  for (const c of r.checks) {
    if (c.skipped) {
      console.log(`  ⚠ UNVERIFIED  ${c.name}`)
      console.log(`                ${c.skipped}`)
      console.log('')
      continue
    }
    console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}`)
    console.log(`      HTTP      ${JSON.stringify(c.statuses)}`)
    console.log(`      observed  ${c.observed}`)
    console.log(`      expected  ${c.expected}`)
    console.log('')
  }
  const failed = r.checks.filter((c) => c.pass === false)
  const skipped = r.checks.filter((c) => c.pass === null)
  if (failed.length === 0) {
    console.log(`  ✓ no lost update or double-spend observed${skipped.length ? ` (${skipped.length} unverified)` : ''}`)
  } else {
    console.log(`  ✗ ${failed.length} race condition(s) confirmed`)
  }
  console.log('='.repeat(74))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(2)
})
