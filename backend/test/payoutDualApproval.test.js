const test = require('node:test')
const assert = require('node:assert/strict')
const { approvePayout } = require('../domain/payout')

// ─────────────────────────────────────────────────────────────────────────────
// Dual control on large payouts (migration 045).
//
// RBAC, the immutable audit trail, reason-required and mandatory TOTP all
// survive a compromised finance_ops session intact — because to every one of
// them, an attacker approving every pending payout to their own wallet is an
// authorised action correctly performed. This is the control that does not
// depend on the first admin being honest.
// ─────────────────────────────────────────────────────────────────────────────

const FUNDED_ACCOUNT = {
  id: 'acc-1', account_type: 'funded', status: 'active',
  current_balance: '110000', starting_balance: '100000'
}

function makeClient({ payout, threshold = '2500', captured = [] }) {
  return {
    captured,
    async query(sql, values) {
      captured.push({ sql, values })
      if (/FROM payouts p\s+JOIN users u/.test(sql)) {
        return { rows: [payout] }
      }
      if (/payout_dual_approval_threshold/.test(sql)) {
        return { rows: threshold == null ? [] : [{ value: threshold }] }
      }
      if (/FROM trades WHERE account_id/.test(sql)) {
        return { rows: [{ open_count: 0, pending_count: 0 }] }
      }
      if (/FROM accounts a WHERE a\.id/.test(sql)) {
        return { rows: [FUNDED_ACCOUNT] }
      }
      if (/UPDATE payouts\s+SET status = 'paid'/.test(sql)) {
        return { rows: [{ ...payout, status: 'paid' }] }
      }
      // The ledger-backed debit: applyBalanceAdjustment updates the account and
      // treats an empty result as a missing account.
      if (/UPDATE accounts\s+SET current_balance/.test(sql)) {
        return { rows: [{ id: 'acc-1', user_id: 'user-1', current_balance: '105000', peak_balance: '110000' }] }
      }
      if (/INSERT INTO balance_adjustments/.test(sql)) {
        return { rows: [{ id: 1 }] }
      }
      // A payout is a capital withdrawal, so the drawdown anchors shift with it
      // — otherwise the trader's own withdrawal eats their drawdown buffer.
      if (/SET eod_peak_equity/.test(sql)) {
        return { rows: [{ eod_peak_equity: '105000' }] }
      }
      return { rows: [] }
    }
  }
}

function basePayout(overrides = {}) {
  return {
    id: 7, user_id: 'user-1', account_id: 'acc-1',
    amount_requested: '5000', amount_payable: '5000',
    payment_method: 'usdt_trc20', status: 'pending',
    is_flagged: false, flag_reason: null, admin_notes: null,
    first_approver_admin_id: null, first_approved_at: null,
    email: 't@example.com', full_name: 'T', kyc_status: 'approved',
    ...overrides
  }
}

function sqlFor(client, pattern) {
  return client.captured.find((c) => pattern.test(c.sql))
}

test('a payout above the threshold records the first approval and moves no money', async () => {
  const client = makeClient({ payout: basePayout() })

  const result = await approvePayout(client, 7, { actor: 'finance_ops:alice@firm.test' })

  assert.equal(result.awaitingSecondApproval, true)
  assert.equal(result.firstApprover, 'finance_ops:alice@firm.test')
  assert.equal(result.recipient, null, 'no recipient means no "you have been paid" email')
  assert.equal(result.certificateCreated, false)

  const record = sqlFor(client, /SET first_approver_admin_id/)
  assert.ok(record, 'the first approval must be recorded')
  assert.equal(record.values[1], 'finance_ops:alice@firm.test')

  assert.equal(sqlFor(client, /UPDATE payouts\s+SET status = 'paid'/), undefined,
    'the payout must not be marked paid on a single approval')
  assert.equal(sqlFor(client, /INSERT INTO balance_adjustments/), undefined,
    'no debit may occur before the second approval')
})

test('the same admin cannot complete their own first approval', async () => {
  const client = makeClient({
    payout: basePayout({ first_approver_admin_id: 'finance_ops:alice@firm.test' })
  })

  await assert.rejects(
    () => approvePayout(client, 7, { actor: 'finance_ops:alice@firm.test' }),
    (err) => {
      assert.match(err.message, /second approver/i)
      assert.equal(err.statusCode, 409)
      return true
    }
  )

  assert.equal(sqlFor(client, /UPDATE payouts\s+SET status = 'paid'/), undefined)
})

test('a second, distinct admin completes the approval', async () => {
  const client = makeClient({
    payout: basePayout({ first_approver_admin_id: 'finance_ops:alice@firm.test' })
  })

  const result = await approvePayout(client, 7, { actor: 'super_admin:bob@firm.test' })

  assert.ok(!result.awaitingSecondApproval)
  const second = sqlFor(client, /SET second_approver_admin_id/)
  assert.ok(second, 'the second approver must be recorded')
  assert.equal(second.values[1], 'super_admin:bob@firm.test')
  assert.ok(sqlFor(client, /UPDATE payouts\s+SET status = 'paid'/), 'the payout is now paid')
})

test('a payout below the threshold is approved by one admin, as before', async () => {
  const client = makeClient({ payout: basePayout({ amount_requested: '400', amount_payable: '400' }) })

  const result = await approvePayout(client, 7, { actor: 'finance_ops:alice@firm.test' })

  assert.ok(!result.awaitingSecondApproval)
  assert.equal(sqlFor(client, /SET first_approver_admin_id/), undefined,
    'small payouts must not be dragged into dual control')
  assert.ok(sqlFor(client, /UPDATE payouts\s+SET status = 'paid'/))
})

test('a payout exactly at the threshold requires two approvers', async () => {
  const client = makeClient({ payout: basePayout({ amount_requested: '2500' }) })
  const result = await approvePayout(client, 7, { actor: 'finance_ops:alice@firm.test' })
  assert.equal(result.awaitingSecondApproval, true, 'the threshold is inclusive — at the limit counts')
})

test('an unreadable threshold fails open rather than freezing the payout queue', async () => {
  // A security control that can jam the whole queue on a bad settings value is
  // its own outage. The alerting path still covers every approval.
  const client = makeClient({ payout: basePayout(), threshold: 'not-a-number' })
  const result = await approvePayout(client, 7, { actor: 'finance_ops:alice@firm.test' })
  assert.ok(!result.awaitingSecondApproval)
  assert.ok(sqlFor(client, /UPDATE payouts\s+SET status = 'paid'/))
})

test('a missing threshold setting disables dual control rather than blocking', async () => {
  const client = makeClient({ payout: basePayout(), threshold: null })
  const result = await approvePayout(client, 7, { actor: 'finance_ops:alice@firm.test' })
  assert.ok(!result.awaitingSecondApproval)
})
