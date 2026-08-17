const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const jwt = require('jsonwebtoken')
const request = require('supertest')
require('../loadEnv')
const pool = require('../db')
const { clearTenantPolicyCache } = require('../services/tenantPolicyService')
const payoutRoutes = require('../routes/payouts')

// POST /api/payouts/request is the only endpoint that moves money out of the
// platform, and it had no test coverage. The gates below are the ones that stop
// a trader withdrawing money they did not earn, or withdrawing it twice.
//
// Same approach as test/tradesHttp.test.js: mock the shared `pool` singleton
// and drive the real router through supertest.

const app = express()
app.use(express.json())
app.use('/api/payouts', payoutRoutes)

// A real UUID, not the old integer fixture: accounts.id is uuid in the schema
// and the route validates the shape before it queries.
const ACCOUNT_ID = 'a3f1c2d4-5e6b-4a7c-8d9e-0f1a2b3c4d5e'

// payoutRequestLimiter allows one request per user per 24 hours, so every test
// needs its own identity or the second one onwards would just see a 429.
let userSeq = 0
function freshUser() {
  const id = `user-payout-${++userSeq}`
  return { id, header: `Bearer ${jwt.sign({ userId: id, tv: 0 }, process.env.JWT_SECRET)}` }
}

function fundedAccount(overrides = {}) {
  return {
    id: ACCOUNT_ID, account_type: 'funded', account_size: '100000',
    current_balance: '110000', starting_balance: '100000', peak_balance: '110000',
    status: 'active', created_at: new Date(Date.now() - 90 * 24 * 3600 * 1000),
    challenge_model_slug: null, ...overrides
  }
}

/**
 * @param account   the row returned by the FOR UPDATE account lock ([] = not found)
 * @param kycStatus users.kyc_status
 * @param openTrades count of open/pending trades blocking the payout
 * @param pendingPayouts rows returned by the existing-pending-payout check
 */
function installPoolMock({
  account = fundedAccount(),
  kycStatus = 'approved',
  openTrades = 0,
  pendingPayouts = [],
  profitSharePct = '80'
} = {}) {
  const calls = []
  const client = {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (/FROM accounts\s+WHERE id = \$1\s+AND user_id = \$2\s+FOR UPDATE/i.test(sql)) {
        return { rows: account ? [account] : [] }
      }
      if (/SELECT kyc_status FROM users/i.test(sql)) {
        return { rows: kycStatus === null ? [] : [{ kyc_status: kycStatus }] }
      }
      if (/SELECT email, full_name/i.test(sql)) {
        return { rows: [{ email: 'trader@example.com', full_name: 'Test Trader' }] }
      }
      if (/SELECT COUNT\(\*\) FROM trades/i.test(sql)) {
        return { rows: [{ count: String(openTrades) }] }
      }
      if (/FROM payouts WHERE account_id = \$1 AND status = 'pending'/i.test(sql)) {
        return { rows: pendingPayouts }
      }
      // The idempotency claim is taken on the TRANSACTION client now, not the
      // pool: it must commit and roll back with the payout, and asking the pool
      // for a second connection while this one holds FOR UPDATE on the account
      // is the deadlock shape the route comments describe.
      if (/idempotency_requests/i.test(sql)) {
        return /INSERT INTO idempotency_requests/i.test(sql)
          ? { rows: [{ id: 1 }] }   // claim won
          : { rows: [] }            // no prior claim to replay
      }
      if (/profit_share_pct/i.test(sql)) {
        return { rows: [{ value: profitSharePct }] }
      }
      if (/INSERT INTO payouts/i.test(sql)) {
        return {
          rows: [{
            id: 900, status: 'pending',
            amount_requested: values[2], amount_payable: values[3],
            is_flagged: values[6]
          }]
        }
      }
      // Flag-check aggregate and anything else: harmless empty/zero row.
      if (/account_age_days/i.test(sql)) {
        return {
          rows: [{
            account_age_days: '90', total_closed_trades: '40', winning_trades: '25',
            max_single_trade_pnl: '900', total_realised_pnl: '10000',
            total_payouts_requested: '0'
          }]
        }
      }
      return { rows: [] }
    },
    release() {}
  }

  pool.query = async (sql, values) => {
    calls.push({ sql, values })
    if (/SELECT token_version, is_banned FROM users/.test(sql)) {
      return { rows: [{ token_version: 0, is_banned: false }] }
    }
    // FIX (H-03): payouts:request now always takes an idempotency claim. It did
    // not before, because a request without the header skipped the guard
    // entirely — so this mock never had to answer these.
    if (/idempotency_requests/i.test(sql)) {
      // No prior claim, then hand back an id for the INSERT ... RETURNING id.
      return /INSERT INTO idempotency_requests/i.test(sql)
        ? { rows: [{ id: 1 }] }
        : { rows: [] }
    }
    if (/CREATE TABLE|CREATE INDEX|ALTER TABLE/i.test(sql)) {
      return { rows: [] }
    }
    // getTenantSettingsMap passes the key list as a parameter rather than
    // inlining it, so match on the table and return a key/value row. Returning
    // nothing here is not neutral: the route would fall back to
    // DEFAULT_TENANT_SETTINGS.profit_share_pct ('75').
    if (/FROM platform_settings/i.test(sql)) {
      return { rows: [{ key: 'profit_share_pct', value: profitSharePct }] }
    }
    return { rows: [] }
  }
  pool.connect = async () => client
  // tenantPolicyService memoises settings for 3s — long enough to leak between
  // tests in the same run, so drop it whenever the mock is reinstalled.
  clearTenantPolicyCache()
  return { calls, client }
}

function validBody(overrides = {}) {
  return {
    account_id: ACCOUNT_ID,
    amount_requested: 1000,
    payment_method: 'usdt_trc20',
    payment_details: { address: 'TXm00000000000000000000000000000000' },
    ...overrides
  }
}

function post(body, user) {
  // FIX (H-03): payouts:request is a strict idempotency scope now — a request
  // without this header is rejected rather than silently running with no replay
  // protection, which is how a retried POST became a duplicate withdrawal.
  return request(app)
    .post('/api/payouts/request')
    .set('Authorization', user.header)
    .set('Idempotency-Key', `test-${Math.random().toString(36).slice(2)}`)
    .send(body)
}

function findInsert(calls) {
  return calls.find((c) => /INSERT INTO payouts/i.test(c.sql))
}

// ─── Happy path ──────────────────────────────────────────────────────────────

test('a funded, KYC-approved account with realised profit gets a pending payout', async () => {
  const user = freshUser()
  const { calls } = installPoolMock()

  const res = await post(validBody(), user)

  assert.equal(res.status, 201)
  assert.equal(res.body.payout.status, 'pending')
  const insert = findInsert(calls)
  assert.ok(insert, 'expected the payout row to be written')
  assert.equal(insert.values[0], user.id)
  assert.equal(insert.values[2], 1000, 'amount_requested')
  // 80% profit share on $1,000
  assert.equal(insert.values[3], 800, 'amount_payable applies the profit share')
  assert.ok(calls.some((c) => /COMMIT/.test(c.sql)))
})

test('the profit share percentage comes from settings, not a hard-coded 80', async () => {
  const { calls } = installPoolMock({ profitSharePct: '90' })

  await post(validBody({ amount_requested: 500 }), freshUser())

  assert.equal(findInsert(calls).values[3], 450)
})

// ─── Amount gates ────────────────────────────────────────────────────────────

test('a request below the $50 minimum is rejected', async () => {
  const { calls } = installPoolMock()

  const res = await post(validBody({ amount_requested: 49.99 }), freshUser())

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Minimum payout request is \$50/)
  assert.equal(findInsert(calls), undefined)
})

test('a request larger than the realised profit is capped and rejected', async () => {
  // Balance 110,000 against a 100,000 start: only 10,000 is withdrawable.
  const { calls } = installPoolMock()

  const res = await post(validBody({ amount_requested: 10_000.01 }), freshUser())

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Maximum withdrawable amount is \$10000\.00/)
  assert.equal(findInsert(calls), undefined)
})

test('an account in drawdown has no profit to withdraw', async () => {
  const { calls } = installPoolMock({
    account: fundedAccount({ current_balance: '95000' })
  })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 400)
  assert.match(res.body.error, /No profit available/)
  assert.equal(findInsert(calls), undefined)
})

test('a zero or negative amount is rejected before any account lookup', async () => {
  installPoolMock()
  assert.equal((await post(validBody({ amount_requested: 0 }), freshUser())).status, 400)
  assert.equal((await post(validBody({ amount_requested: -100 }), freshUser())).status, 400)
})

// ─── Eligibility gates ───────────────────────────────────────────────────────

test('KYC must be approved before a payout is allowed', async () => {
  const { calls } = installPoolMock({ kycStatus: 'pending' })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 403)
  assert.match(res.body.error, /identity verification \(KYC\)/i)
  assert.equal(findInsert(calls), undefined)
  assert.ok(calls.some((c) => /ROLLBACK/.test(c.sql)))
})

test('a rejected KYC is treated the same as no KYC', async () => {
  installPoolMock({ kycStatus: 'rejected' })
  const res = await post(validBody(), freshUser())
  assert.equal(res.status, 403)
  assert.match(res.body.error, /identity verification \(KYC\)/i)
})

test('a user row with no KYC record at all is refused', async () => {
  installPoolMock({ kycStatus: null })
  const res = await post(validBody(), freshUser())
  assert.equal(res.status, 403)
})

test('payouts are refused on a non-funded account', async () => {
  const { calls } = installPoolMock({
    account: fundedAccount({ account_type: 'phase1' })
  })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 403)
  assert.match(res.body.error, /only available for funded accounts/i)
  assert.equal(findInsert(calls), undefined)
})

test('payouts are refused on an inactive account', async () => {
  const { calls } = installPoolMock({
    account: fundedAccount({ status: 'failed' })
  })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 403)
  assert.match(res.body.error, /not active/i)
  assert.equal(findInsert(calls), undefined)
})

test('another user\'s account cannot be withdrawn from', async () => {
  // The account lock query filters on user_id, so a mismatched owner returns
  // no rows and must surface as 404 rather than leaking existence.
  const { calls } = installPoolMock({ account: null })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 404)
  assert.equal(findInsert(calls), undefined)
})

// ─── Double-spend protection ─────────────────────────────────────────────────

test('a second payout is refused while one is still pending', async () => {
  const { calls } = installPoolMock({ pendingPayouts: [{ id: 1 }] })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 400)
  assert.match(res.body.error, /already have a pending payout/i)
  assert.equal(findInsert(calls), undefined)
})

test('the account row is locked FOR UPDATE before any of the checks run', async () => {
  // This lock is what serialises two concurrent requests: the second blocks
  // here and then sees the first request's row in the pending-payout check.
  const { calls } = installPoolMock()

  await post(validBody(), freshUser())

  const sqls = calls.map((c) => c.sql)
  const begin = sqls.findIndex((s) => /BEGIN/.test(s))
  const lock = sqls.findIndex((s) => /FROM accounts[\s\S]*FOR UPDATE/i.test(s))
  const insert = sqls.findIndex((s) => /INSERT INTO payouts/i.test(s))

  assert.ok(begin >= 0)
  assert.ok(lock > begin, 'the lock must be taken inside the transaction')
  assert.ok(insert > lock, 'nothing may be written before the lock')
})

test('open trades block a payout so equity cannot move mid-request', async () => {
  const { calls } = installPoolMock({ openTrades: 2 })

  const res = await post(validBody(), freshUser())

  assert.equal(res.status, 400)
  assert.match(res.body.error, /close all open trades/i)
  assert.equal(findInsert(calls), undefined)
})

// ─── Input validation ────────────────────────────────────────────────────────

test('an unrecognised payment method is rejected', async () => {
  const { calls } = installPoolMock()

  const res = await post(validBody({ payment_method: 'western_union' }), freshUser())

  assert.equal(res.status, 400)
  assert.match(res.body.error, /Invalid payment method/)
  assert.equal(findInsert(calls), undefined)
})

test('missing fields are rejected', async () => {
  installPoolMock()
  const res = await post({ account_id: ACCOUNT_ID, amount_requested: 100 }, freshUser())
  assert.equal(res.status, 400)
  assert.match(res.body.error, /All fields are required/)
})

test('the endpoint requires authentication', async () => {
  installPoolMock()
  const res = await request(app).post('/api/payouts/request').send(validBody())
  assert.equal(res.status, 401)
})
