const test = require('node:test')
const assert = require('node:assert/strict')
const pool = require('../db')
const { processStripeWebhookEvent } = require('../routes/billing')

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook fan-out.
//
// Before this suite the handler understood exactly one event type
// (checkout.session.completed) and nothing ever wrote to stripe_events, so
// replay protection was an accident of whichever downstream ON CONFLICT
// happened to run. These tests pin the four things that go wrong in a normal
// first month: a redelivery after a refund, a chargeback on a live account, a
// refund before activation, and an abandoned checkout.
// ─────────────────────────────────────────────────────────────────────────────

const REAL_POOL_QUERY = pool.query
const REAL_POOL_CONNECT = pool.connect
test.after(() => {
  pool.query = REAL_POOL_QUERY
  pool.connect = REAL_POOL_CONNECT
})

function installMock({ handlers = [], claimSucceeds = true } = {}) {
  const calls = []
  const client = {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (/INSERT INTO stripe_events/.test(sql)) {
        return { rows: claimSucceeds ? [{ event_id: values?.[0] }] : [] }
      }
      for (const [pattern, handler] of handlers) {
        if (pattern.test(sql)) return handler(sql, values)
      }
      return { rows: [] }
    },
    release() {}
  }
  // ensureBillingInfrastructure runs its CREATE TABLEs through pool.query.
  pool.query = async () => ({ rows: [] })
  pool.connect = async () => client
  return client
}

function sqlFor(client, pattern) {
  return client.calls.find((c) => pattern.test(c.sql))
}

const PAID_ORDER = {
  id: 42, status: 'paid', amount: '39.00', currency: 'USD',
  user_id: 'user-1', provider_reference: 'pi_123',
  metadata_json: { account_id: '11111111-1111-1111-1111-111111111111' }
}

test('a replayed event is claimed once and does no work the second time', async () => {
  const client = installMock({ claimSucceeds: false })

  await processStripeWebhookEvent({
    id: 'evt_replay', type: 'charge.refunded',
    data: { object: { payment_intent: 'pi_123' } }
  })

  assert.ok(sqlFor(client, /INSERT INTO stripe_events/), 'the claim must be attempted first')
  assert.equal(sqlFor(client, /UPDATE challenge_orders/), undefined,
    'a losing claim must do no work at all')
  assert.ok(sqlFor(client, /COMMIT/), 'the transaction still commits — a replay is not an error')
})

test('charge.refunded marks the order refunded, freezes the account and claws back commission', async () => {
  const client = installMock({
    handlers: [
      [/SELECT \* FROM challenge_orders WHERE provider_reference/, () => ({ rows: [PAID_ORDER] })],
      [/UPDATE challenge_orders/, () => ({ rows: [{ id: 42 }] })],
      [/FROM affiliate_commissions\s+WHERE order_id/, () => ({ rows: [{ referrer_user_id: 'ref-1', commission_amount: '7.80' }] })]
    ]
  })

  await processStripeWebhookEvent({
    id: 'evt_refund', type: 'charge.refunded',
    data: { object: { payment_intent: 'pi_123', amount_refunded: 3900 } }
  })

  const orderUpdate = sqlFor(client, /UPDATE challenge_orders/)
  assert.ok(orderUpdate)
  assert.equal(orderUpdate.values[1], 'refunded')
  assert.equal(orderUpdate.values[2], 39, 'amount_refunded is in minor units and must be converted')
  assert.ok(/refunded_at/.test(orderUpdate.sql))
  assert.ok(/status NOT IN \('refunded', 'disputed'\)/.test(orderUpdate.sql),
    'a terminal state must not be downgraded by a later event')

  const freeze = sqlFor(client, /UPDATE accounts\s+SET status = 'locked'/)
  assert.ok(freeze, 'the account issued from the order must be frozen')
  assert.equal(freeze.values[0], PAID_ORDER.metadata_json.account_id)

  const clawback = sqlFor(client, /INSERT INTO affiliate_commissions/)
  assert.ok(clawback, 'commission earned on a refunded order must be reversed')
  assert.equal(clawback.values[1], -7.8)
})

test('charge.dispute.created locks the account so it cannot trade or withdraw', async () => {
  const client = installMock({
    handlers: [
      [/SELECT \* FROM challenge_orders WHERE provider_reference/, () => ({ rows: [PAID_ORDER] })],
      [/UPDATE challenge_orders/, () => ({ rows: [{ id: 42 }] })]
    ]
  })

  await processStripeWebhookEvent({
    id: 'evt_dispute', type: 'charge.dispute.created',
    data: { object: { payment_intent: 'pi_123' } }
  })

  const orderUpdate = sqlFor(client, /UPDATE challenge_orders/)
  assert.equal(orderUpdate.values[1], 'disputed')
  assert.ok(/disputed_at/.test(orderUpdate.sql))
  assert.ok(sqlFor(client, /UPDATE accounts\s+SET status = 'locked'/),
    'a disputed order must freeze the funded account it paid for')
})

test('a refund on an order that never produced an account freezes nothing', async () => {
  const client = installMock({
    handlers: [
      [/SELECT \* FROM challenge_orders WHERE provider_reference/, () => ({ rows: [{ ...PAID_ORDER, metadata_json: {} }] })],
      [/UPDATE challenge_orders/, () => ({ rows: [{ id: 42 }] })]
    ]
  })

  await processStripeWebhookEvent({
    id: 'evt_refund_early', type: 'charge.refunded',
    data: { object: { payment_intent: 'pi_123' } }
  })

  assert.ok(sqlFor(client, /UPDATE challenge_orders/), 'the order is still marked refunded')
  assert.equal(sqlFor(client, /UPDATE accounts/), undefined,
    'no account was ever created, so there is nothing to lock')
})

test('checkout.session.expired cancels only an unpaid order', async () => {
  const client = installMock()

  await processStripeWebhookEvent({
    id: 'evt_expired', type: 'checkout.session.expired',
    data: { object: { metadata: { flow: 'challenge_checkout', order_id: '42' } } }
  })

  const cancel = sqlFor(client, /UPDATE challenge_orders/)
  assert.ok(cancel)
  assert.ok(/status IN \('pending', 'processing'\)/.test(cancel.sql),
    'an order that already paid must never be cancelled by an expiry event')
  assert.ok(sqlFor(client, /UPDATE challenge_checkout_sessions/))
})

test('an unhandled event type is still claimed, so it is never reprocessed', async () => {
  const client = installMock()

  await processStripeWebhookEvent({
    id: 'evt_unknown', type: 'invoice.paid', data: { object: {} }
  })

  assert.ok(sqlFor(client, /INSERT INTO stripe_events/))
  assert.ok(sqlFor(client, /UPDATE stripe_events SET processed_at/))
  assert.ok(sqlFor(client, /COMMIT/))
})

test('a handler that throws rolls back the claim, so Stripe retry is processed normally', async () => {
  const client = installMock({
    handlers: [
      [/SELECT \* FROM challenge_orders WHERE provider_reference/, () => { throw new Error('db exploded') }]
    ]
  })

  await assert.rejects(() => processStripeWebhookEvent({
    id: 'evt_boom', type: 'charge.refunded',
    data: { object: { payment_intent: 'pi_123' } }
  }), /db exploded/)

  assert.ok(sqlFor(client, /ROLLBACK/), 'the claim must roll back with the work it guards')
  assert.equal(sqlFor(client, /COMMIT/), undefined)
})

test('report T10: a checkout.session.completed redelivery cannot flip a refunded order back to paid', async () => {
  // Two independent guards have to hold here, because they fail in different
  // situations. The event claim stops the SAME event id being processed twice.
  // The status guard inside markChallengeOrderPaid stops a genuinely new event
  // — a late capture, a manually replayed webhook — reviving an order whose
  // money has already gone back. This asserts the second one.
  let paidUpdateSql = null
  const client = installMock({
    handlers: [
      [/UPDATE challenge_orders\s+SET status = 'paid'/, (sql) => {
        paidUpdateSql = sql
        return { rows: [] }   // refunded: the guard matches nothing
      }]
    ]
  })

  await processStripeWebhookEvent({
    id: 'evt_late_capture', type: 'checkout.session.completed',
    data: { object: { payment_intent: 'pi_123', metadata: { flow: 'challenge_checkout', order_id: '42' } } }
  })

  assert.ok(paidUpdateSql, 'the paid update must be attempted')
  assert.ok(/status NOT IN \('refunded', 'disputed', 'cancelled'\)/.test(paidUpdateSql),
    'the paid update must be guarded on the current status')
  assert.equal(sqlFor(client, /INSERT INTO challenge_payments/), undefined,
    'no payment row, no voucher and no commission may follow a refused revival')
  assert.equal(sqlFor(client, /INSERT INTO affiliate_commissions/), undefined)
})
