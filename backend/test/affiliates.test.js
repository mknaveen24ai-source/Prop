const test = require('node:test')
const assert = require('node:assert/strict')
const pool = require('../db')
const {
  resolveAffiliateCode,
  computeEffectiveTier,
  settleAffiliatePayoutAmount,
  insertBalanceAdjustment
} = require('../utils/affiliates')

test('resolveAffiliateCode looks up an uppercased, trimmed code', async () => {
  const calls = []
  pool.query = async (sql, values) => {
    calls.push({ sql, values })
    return { rows: [{ id: 'user-1', affiliate_code: 'ABC12345' }] }
  }

  const result = await resolveAffiliateCode('  abc12345 ')
  assert.equal(result.id, 'user-1')
  assert.match(calls[0].sql, /SELECT id, affiliate_code FROM users WHERE affiliate_code = \$1/)
  assert.deepEqual(calls[0].values, ['ABC12345'])
})

test('resolveAffiliateCode returns null for an empty/whitespace code without querying', async () => {
  let queried = false
  pool.query = async () => { queried = true; return { rows: [] } }

  const result = await resolveAffiliateCode('   ')
  assert.equal(result, null)
  assert.equal(queried, false)
})

test('computeEffectiveTier picks the highest qualifying tier for a NEW paying referral (count+1)', async () => {
  const mockClient = {
    async query(sql) {
      if (/COUNT\(DISTINCT referred_user_id\)/.test(sql)) {
        // Referrer has 4 existing paying referrals, and referredUserId is not among them yet.
        return { rows: [{ cnt: 4, already_counted: false }] }
      }
      if (/FROM affiliate_commission_tiers/.test(sql)) {
        // effective_count = 5 -> should match the Silver tier (min_referrals: 5)
        return { rows: [{ tier_rank: 2, commission_pct: '15' }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }

  const result = await computeEffectiveTier(mockClient, 'referrer-1', 'referred-1')
  assert.equal(result.tier_rank, 2)
  assert.equal(result.commission_pct, 15)
  assert.equal(result.effective_count, 5)
})

test('computeEffectiveTier does NOT increment count for a referred user who already has a prior commission row', async () => {
  const mockClient = {
    async query(sql) {
      if (/COUNT\(DISTINCT referred_user_id\)/.test(sql)) {
        // This referred user already counted among the 5 -> no +1.
        return { rows: [{ cnt: 5, already_counted: true }] }
      }
      if (/FROM affiliate_commission_tiers/.test(sql)) {
        return { rows: [{ tier_rank: 2, commission_pct: '15' }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }

  const result = await computeEffectiveTier(mockClient, 'referrer-1', 'referred-2')
  assert.equal(result.effective_count, 5)
})

test('computeEffectiveTier falls back to the default commission pct when no tier qualifies', async () => {
  const mockClient = {
    async query(sql) {
      if (/COUNT\(DISTINCT referred_user_id\)/.test(sql)) {
        return { rows: [{ cnt: 0, already_counted: false }] }
      }
      if (/FROM affiliate_commission_tiers/.test(sql)) {
        return { rows: [] } // no tier matches min_referrals <= 1
      }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }
  pool.query = async () => ({ rows: [{ key: 'affiliate_default_commission_pct', value: '12' }] })

  const result = await computeEffectiveTier(mockClient, 'referrer-2', 'referred-3')
  assert.equal(result.tier_rank, null)
  assert.equal(result.commission_pct, 12)
})

test('settleAffiliatePayoutAmount posts a single negative adjusted ledger entry for the requested amount (partial withdrawals allowed)', async () => {
  const calls = []
  const mockClient = {
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [{ commission_amount: '-20.00' }] }
    }
  }

  const total = await settleAffiliatePayoutAmount(mockClient, 'referrer-3', 'payout-9', 20)
  assert.equal(total, 20)
  assert.match(calls[0].sql, /INSERT INTO affiliate_commissions/)
  assert.match(calls[0].sql, /VALUES \(\$1, \$2, 'adjusted', \$3, NOW\(\), NOW\(\), \$4\)/)
  assert.deepEqual(calls[0].values, ['referrer-3', -20, 'Payout settlement for request #payout-9', 'payout-9'])
})

test('insertBalanceAdjustment inserts an adjusted-status row that can carry a negative amount', async () => {
  const calls = []
  const mockClient = {
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [{ id: 1, commission_amount: '-20', status: 'adjusted' }] }
    }
  }

  const row = await insertBalanceAdjustment(mockClient, {
    referrerUserId: 'referrer-4',
    amount: -20,
    note: 'Clawback for refunded order',
    adjustedBy: 'admin@test.local'
  })

  assert.equal(row.status, 'adjusted')
  assert.match(calls[0].sql, /status, adjustment_note, adjusted_by, adjusted_at, earned_at/)
  assert.match(calls[0].sql, /VALUES \(\$1, \$2, 'adjusted', \$3, \$4, NOW\(\), NOW\(\)\)/)
  assert.deepEqual(calls[0].values, ['referrer-4', -20, 'Clawback for refunded order', 'admin@test.local'])
})
