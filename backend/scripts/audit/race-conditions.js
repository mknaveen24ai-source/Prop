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

/**
 * A news protection window blocks every trade open for 30 minutes (15 before an
 * event, 15 after), so a harness run inside one produces nothing but refusals.
 * Worth naming specifically: "every open was refused" reads like a bug, whereas
 * "a news window is active, re-run after it clears" is an instruction.
 */
function newsWindowActive(reasonList) {
  return reasonList.some((r) => /news event/i.test(r))
}

/**
 * The distinct rejection messages behind a stampede.
 *
 * An UNVERIFIED check is only actionable if it says WHY nothing contended.
 * "every open was refused" sends someone reading the harness source; "Max
 * combined forex exposure is 1 lots" sends them to the setting that needs
 * changing.
 */
function reasons(results) {
  const seen = new Set()
  for (const r of results) {
    if (r.status !== 'fulfilled') { seen.add('request failed'); continue }
    const body = r.value.data
    const message = body && (body.error || body.message)
    if (message && r.value.status >= 400) seen.add(String(message).slice(0, 160))
  }
  return [...seen]
}

/**
 * Did this check actually race anything?
 *
 * A stampede where every request was rejected for the same unrelated reason --
 * all 404 because the row was already gone, all 429 because a limiter ate them,
 * all 400 because the request was invalid -- contends over nothing. Reporting
 * that as a pass is the same false-pass failure the authorization matrix had:
 * the harness says "no double-spend observed" when what happened is "no spend
 * was attempted".
 *
 * A race needs at least one request to have reached the contended resource.
 */
function raced(statuses) {
  const succeeded = Object.entries(statuses)
    .filter(([code]) => Number(code) >= 200 && Number(code) < 300)
    .reduce((n, [, count]) => n + count, 0)
  const throttled = Number(statuses['429'] || 0)

  // `meaningful` asks only whether the contended resource was reached at all.
  // If nothing succeeded, the stampede fought over nothing.
  const meaningful = succeeded >= 1

  // Separately: WHICH defence turned the others away.
  //
  // A stampede stopped almost entirely by 429s got its correct outcome from a
  // rate limiter, not from a database lock. That is a real defence and it did
  // work -- but it is a different one with a different failure mode. The limiter
  // is Redis-backed and falls back to in-process counters when Redis is
  // unavailable (utils/security.js makeSharedStore), and in-process counters do
  // not span instances. On a multi-instance deploy with Redis down, concurrent
  // requests can land on different instances, each pass their own limiter, and
  // leave the row lock as the only thing between a trader and a double payout.
  //
  // So the invariant is reported as holding while the lock behind it is recorded
  // as unproven, rather than quietly credited for someone else's work.
  const lockExercised = succeeded >= 1 && throttled < CONCURRENCY - 1

  return { succeeded, throttled, meaningful, lockExercised }
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
    const st1 = summarize(results)
    const st1Reasons = reasons(results)
    const ev1 = raced(st1)
    checks.push({
      name: 'concurrent identical trade opens (same idempotency key)',
      concurrency: CONCURRENCY,
      statuses: st1,
      evidence: ev1,
      reasons: st1Reasons,
      observed: `${rows[0].n} open position(s)`,
      expected: 'exactly 1',
      pass: ev1.meaningful ? rows[0].n === 1 : null,
      inconclusive: ev1.meaningful ? null : 'no request reached the contended row',
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

    // Sized against the platform's REAL cap, so some must be admitted and some
    // must be refused.
    //
    // A $10,000 account is capped at 1.00 combined forex lots (0.1 per $1k), not
    // by margin. Two earlier attempts -- 20 lots then 2 lots -- were each above
    // the cap on their own, so all eight were refused, nothing contended, and
    // the check reported a pass having tested nothing.
    //
    // 8 x 0.2 lots asks for 1.6 against a 1.0 cap: roughly five should be
    // admitted and three refused. A lost update shows up as MORE than 1.0 lots
    // open, which is the gate having read a stale exposure total.
    const results = await stampede(CONCURRENCY, () => http('post', '/api/trades/open', {
      cookie: trader.cookie,
      idempotencyKey: `trades:open:${crypto.randomUUID()}`,
      data: { account_id: accountId, instrument: 'EURUSD', direction: 'buy', lots: 0.2 }
    }))

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(lot_size), 0)::numeric AS lots
         FROM trades WHERE account_id = $1 AND status = 'open'`,
      [accountId]
    )
    const account = await db.query('SELECT current_balance FROM accounts WHERE id = $1', [accountId])
    const st2 = summarize(results)
    const st2Reasons = reasons(results)
    const ev2 = raced(st2)
    // At 1:100 leverage, 2 lots of EURUSD needs roughly $2,300 of margin, so
    // $10,000 of equity supports about four. Admitting all eight would mean the
    // gate read a stale balance.
    const admitted = Number(rows[0].n)
    const totalLots = Number(rows[0].lots)
    checks.push({
      name: 'concurrent opens must respect the exposure cap (8 x 0.2 lots vs a 1.0 cap)',
      concurrency: CONCURRENCY,
      statuses: st2,
      evidence: ev2,
      reasons: st2Reasons,
      observed: `${admitted} open, ${totalLots} lots total, balance ${account.rows[0]?.current_balance}`,
      expected: 'combined open lots must never exceed the 1.0 cap',
      // The cap is the invariant, not the request count. Admitting five 0.2-lot
      // trades is correct; admitting eight would put 1.6 lots on a 1.0 account.
      pass: ev2.meaningful ? totalLots <= 1.0 + 1e-9 : null,
      inconclusive: ev2.meaningful ? null : 'every open was refused, so nothing contended for the cap',
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
      // Wait out the minimum holding period by WATCHING THE CLOCK, never by
      // probing with a real close.
      //
      // The first version polled /trades/close until it stopped answering
      // "minimum trade duration" -- and the request that stopped answering it
      // was a successful close. The stampede then raced a position that no
      // longer existed, all eight came back 404, and the check reported a clean
      // pass having contended over nothing.
      const openedAt = Date.now()
      const HOLD_MS = 65000
      while (Date.now() - openedAt < HOLD_MS) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      // Confirm the position is STILL OPEN immediately before the stampede.
      //
      // It has to survive a 65-second holding period, and during that window the
      // engine can legitimately close it on a stop, a drawdown breach or a news
      // event. When that happened the stampede raced a position that no longer
      // existed, all eight came back 404, and the check swung between real
      // evidence and nothing depending on market noise. An intermittently
      // meaningless check is worse than an honest one, because whoever reads it
      // cannot tell which kind of run they are looking at.
      const stillOpen = await db.query(
        "SELECT status FROM trades WHERE id = $1 AND status = 'open'", [opened]
      )
      if (stillOpen.rows.length === 0) {
        checks.push({
          name: 'concurrent closes of one position',
          skipped: 'the position was closed by the engine during the 65s holding period ' +
                   '(stop, drawdown or news), so there was nothing left to race. Re-run.',
          pass: null
        })
        await db.end()
        const partial = { baseUrl: BASE_URL, concurrency: CONCURRENCY, checks }
        if (JSON_OUT) console.log(JSON.stringify(partial, null, 2))
        else report(partial)
        process.exitCode = 1
        return
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

      const st3 = summarize(results)
      const st3Reasons = reasons(results)
      const ev3 = raced(st3)
      checks.push({
        name: 'concurrent closes of one position',
        concurrency: CONCURRENCY,
        statuses: st3,
        evidence: ev3,
      reasons: st3Reasons,
        observed: `${closedRows.rows[0].n} closed row(s), balance ${before.rows[0]?.current_balance} -> ${after.rows[0]?.current_balance}`,
        expected: 'exactly 1 closed row; PnL booked once',
        pass: ev3.meaningful ? closedRows.rows[0].n === 1 : null,
        inconclusive: ev3.meaningful
          ? null
          : 'no close succeeded - the position was already gone, so nothing raced',
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

    // Put the account into a state where a payout is genuinely eligible, then
    // race it. Racing an ineligible request only proves the eligibility check
    // runs; the LOCK is exercised only when two VALID requests contend for the
    // same realised profit.
    //
    // domain/payoutEligibility.js requires all of: account_type = 'funded',
    // users.kyc_status = 'approved', and realised profit above the configured
    // minimum. Missing any one of them returns 403 before the lock is reached,
    // which is what the first three attempts at this check were measuring.
    await db.query(
      `UPDATE accounts
          SET account_type = 'funded',
              status = 'active',
              current_balance = current_balance + 2000,
              peak_balance = GREATEST(peak_balance, current_balance + 2000)
        WHERE id = $1`,
      [accountId]
    )
    await db.query(
      `UPDATE users SET kyc_status = 'approved'
        WHERE id = (SELECT user_id FROM accounts WHERE id = $1)`,
      [accountId]
    )

    // The contract is { account_id, amount_requested, payment_method,
    // payment_details } -- `amount` alone returns "All fields are required",
    // which is a validation refusal, not the lock being exercised.
    const results = await stampede(CONCURRENCY, () => http('post', '/api/payouts/request', {
      cookie: trader.cookie,
      idempotencyKey: `payouts:request:${crypto.randomUUID()}`,
      data: {
        account_id: accountId,
        amount_requested: 100,
        // The enum is crypto-only: usdt_trc20 | usdt_bep20 | usdt_erc20 |
        // usdt_polygon | btc | ltc. 'bank_transfer' is refused as invalid, which
        // is validation, not the lock.
        payment_method: 'usdt_trc20',
        payment_details: { wallet_address: 'TRaceProbeWalletAddressForAuditOnly1' }
      }
    }))

    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS n FROM payouts WHERE account_id = $1 AND status IN ('pending','under_review','approved')`,
      [accountId]
    )
    const st4 = summarize(results)
    const st4Reasons = reasons(results)
    const ev4 = raced(st4)
    checks.push({
      name: 'concurrent payout requests on an account with realised profit',
      concurrency: CONCURRENCY,
      statuses: st4,
      evidence: ev4,
      reasons: st4Reasons,
      observed: `${rows[0].n} live payout row(s)`,
      expected: 'at most 1 - the rules forbid a second pending payout',
      // Two distinct failures are possible and only one is a race: more than one
      // row means the lock lost, while zero successes means the request never
      // became eligible and the lock was never reached at all.
      pass: ev4.meaningful ? rows[0].n <= 1 : null,
      inconclusive: ev4.meaningful
        ? (ev4.lockExercised
            ? null
            : `outcome correct, but ${ev4.throttled} of ${CONCURRENCY} were stopped by the 24h payout rate ` +
              'limiter, so the database row lock was never contended. That limiter is Redis-backed and falls ' +
              'back to in-process counters, which do not span instances - on a multi-instance deploy with ' +
              'Redis down the row lock is the only remaining defence, and it stays unproven here.')
        : 'no payout request succeeded - eligibility refused them all, so the lock was never exercised',
      accountId
    })
  }

  await db.end()

  const result = { baseUrl: BASE_URL, concurrency: CONCURRENCY, checks }
  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  else report(result)

  // An unverified check exits non-zero too. "Nothing was proven" must not read
  // as "everything is fine" to CI or to anyone skimming the exit status.
  const failed = checks.filter((c) => c.pass === false)
  const unverified = checks.filter((c) => c.pass === null)
  process.exitCode = failed.length > 0 || unverified.length > 0 ? 1 : 0
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
    const mark = c.pass === true ? '✓' : c.pass === false ? '✗' : '⚠'
    console.log(`  ${mark} ${c.name}`)
    console.log(`      HTTP      ${JSON.stringify(c.statuses)}`)
    console.log(`      observed  ${c.observed}`)
    console.log(`      expected  ${c.expected}`)
    if (c.inconclusive) console.log(`      UNVERIFIED - ${c.inconclusive}`)
    if (c.reasons && newsWindowActive(c.reasons)) {
      console.log('      NOTE      a 30-minute news protection window is active (15 min either side of a')
      console.log('                high-impact event). No trade can open until it clears. Re-run after.')
    }
    if (c.reasons && c.reasons.length > 0) {
      for (const reason of c.reasons) console.log(`      reason    ${reason}`)
    }
    console.log('')
  }
  const failed = r.checks.filter((c) => c.pass === false)
  const unverified = r.checks.filter((c) => c.pass === null)
  const caveated = r.checks.filter((c) => c.pass === true && c.inconclusive)
  if (failed.length === 0 && unverified.length === 0 && caveated.length === 0) {
    console.log('  ✓ no lost update or double-spend observed, and every check genuinely contended')
  } else if (failed.length === 0 && unverified.length === 0) {
    console.log(`  ✓ every invariant held (${caveated.length} with a caveat above)`)
  } else if (failed.length === 0) {
    console.log(`  ⚠ no race confirmed, but ${unverified.length} check(s) proved nothing - see UNVERIFIED above`)
  } else {
    console.log(`  ✗ ${failed.length} race condition(s) confirmed`)
  }
  console.log('='.repeat(74))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(2)
})
