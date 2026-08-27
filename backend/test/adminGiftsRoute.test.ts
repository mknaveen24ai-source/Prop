import assert from 'node:assert/strict'
import test from 'node:test'
import router = require('../routes/adminGifts')

const listRow = {
  id: '17',
  code: 'GIFT-CODE',
  status: 'issued',
  account_size: '10000.00',
  challenge_model_slug: 'two-step',
  amount_paid: '99.00',
  gift_message: null,
  recipient_email: 'recipient@example.com',
  recipient_user_id: null,
  issued_at: new Date('2026-08-27T00:00:00.000Z'),
  expires_at: null,
  claimed_at: null,
  purchaser_email: 'buyer@example.com',
  purchaser_name: 'Buyer'
}

void test('gift list rows map IDs, decimals, nulls, and timestamps explicitly', () => {
  assert.deepEqual(router.__test__.mapGiftVoucherListItem(listRow), {
    ...listRow,
    issued_at: '2026-08-27T00:00:00.000Z'
  })
})

void test('gift list query normalization preserves legacy paging bounds and filters', () => {
  assert.deepEqual(router.__test__.normalizeGiftListQuery({
    status: ' ISSUED ',
    search: ' buyer ',
    page: '2',
    page_size: '500'
  }), {
    status: 'issued',
    search: 'buyer',
    page: 2,
    pageSize: 100,
    offset: 100
  })
})

void test('revoked gift rows expose the prior RETURNING payload through an explicit mapper', () => {
  const mapped = router.__test__.mapGiftVoucher({
    ...listRow,
    purchaser_user_id: 'user-1',
    order_id: '9',
    claimed_order_id: null,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: new Date('2026-08-27T01:00:00.000Z')
  })
  assert.equal(mapped.id, '17')
  assert.equal(mapped.account_size, '10000.00')
  assert.equal(mapped.order_id, '9')
  assert.equal(mapped.updated_at, '2026-08-27T01:00:00.000Z')
})
