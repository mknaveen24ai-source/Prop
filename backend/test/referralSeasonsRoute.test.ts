import assert from 'node:assert/strict'
import test from 'node:test'
import router = require('../routes/referralSeasons')

void test('referral season rows map IDs, timestamps, nullability, and validated JSON explicitly', () => {
  assert.deepEqual(router.__test__.serializeSeason({
    id: '3',
    slug: 'summer-2026',
    title: 'Summer',
    description: null,
    status: 'active',
    start_at: new Date('2026-06-01T00:00:00.000Z'),
    end_at: '2026-09-01T00:00:00.000Z',
    ranking_metric: 'new_paying_referrals',
    prize_pool_json: [{ rank: 1, account_size: '10000.00' }],
    created_by: null,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z'
  }), {
    id: '3',
    slug: 'summer-2026',
    title: 'Summer',
    description: null,
    status: 'active',
    start_at: '2026-06-01T00:00:00.000Z',
    end_at: '2026-09-01T00:00:00.000Z',
    ranking_metric: 'new_paying_referrals',
    prize_pool: [{ rank: 1, account_size: '10000.00' }]
  })
})

void test('referral prize vouchers preserve decimal strings and ISO timestamps', () => {
  assert.deepEqual(router.__test__.mapReferralSeasonVoucher({
    id: '8',
    code: 'PRIZE',
    account_size: '25000.00',
    challenge_model_slug: 'two-step',
    status: 'issued',
    issued_at: new Date('2026-08-27T00:00:00.000Z'),
    expires_at: null,
    redeemed_at: null,
    season_title: 'Summer',
    season_slug: 'summer-2026',
    final_rank: 1
  }), {
    id: '8',
    code: 'PRIZE',
    account_size: '25000.00',
    challenge_model_slug: 'two-step',
    status: 'issued',
    issued_at: '2026-08-27T00:00:00.000Z',
    expires_at: null,
    redeemed_at: null,
    season_title: 'Summer',
    season_slug: 'summer-2026',
    final_rank: 1
  })
})
