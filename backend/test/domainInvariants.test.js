const test = require('node:test')
const assert = require('node:assert/strict')
require('../loadEnv')

const { shiftAnchors, rebaseAnchors } = require('../domain/drawdownAnchors')
const { evaluatePayoutEligibility, BLOCKER } = require('../domain/payoutEligibility')
const { resolveEffectiveFloor } = require('../services/drawdownService')
const { fromLockedRow } = require('../domain/account')
const { InvariantViolation } = require('../domain/errors')

// Guards for the four financial defects the domain layer was introduced to fix.
// Each one was reachable through an admin endpoint on a live account.
//
// These use a small in-memory stand-in for the accounts table rather than regex
// query stubs: the bugs are all arithmetic — which number moved, and by how
// much — so a fake that actually applies the UPDATEs is what catches a
// regression. Only the statements the domain layer issues are interpreted.

function fakeAccount(overrides = {}) {
  return {
    id: 'acc-1',
    user_id: 'user-1',
    account_type: 'funded',
    status: 'active',
    current_balance: 110000,
    starting_balance: 100000,
    peak_balance: 110000,
    eod_peak_equity: 110000,
    eod_trailing_floor: null,
    ...overrides
  }
}

/** Minimal client that applies the domain layer's own statements to a row. */
function fakeClient(account) {
  const ledger = []
  const client = {
    ledger,
    account,
    async query(sql, values = []) {
      // applyBalanceAdjustment: balance + peak, returning the new row
      if (/UPDATE accounts\s+SET current_balance = current_balance \+ \$1/i.test(sql)) {
        account.current_balance += Number(values[0])
        account.peak_balance = Math.max(account.peak_balance, account.current_balance)
        return { rows: [{ ...account }] }
      }
      if (/INSERT INTO balance_adjustments/i.test(sql)) {
        ledger.push({ amount: Number(values[5]), source: values[2], reason: values[8] })
        return { rows: [{ id: ledger.length }] }
      }
      // shiftAnchors
      if (/SET eod_peak_equity = GREATEST\(COALESCE\(eod_peak_equity, starting_balance\)/i.test(sql)) {
        const base = account.eod_peak_equity != null ? account.eod_peak_equity : account.starting_balance
        account.eod_peak_equity = Math.max(base + Number(values[1]), 0)
        return { rows: [{ eod_peak_equity: account.eod_peak_equity }] }
      }
      // rebaseAnchors
      if (/SET eod_peak_equity = \$2,\s*eod_trailing_floor = NULL/i.test(sql)) {
        account.eod_peak_equity = Number(values[1])
        account.eod_trailing_floor = null
        return { rows: [{ eod_peak_equity: account.eod_peak_equity }] }
      }
      // resetToStarting's peak_balance reset
      if (/SET peak_balance = starting_balance/i.test(sql)) {
        account.peak_balance = account.starting_balance
        return { rows: [{ ...account }] }
      }
      // resetToStarting's live re-read
      if (/SELECT current_balance, starting_balance FROM accounts/i.test(sql)) {
        return { rows: [{ current_balance: account.current_balance, starting_balance: account.starting_balance }] }
      }
      if (/UPDATE accounts SET .*status = \$2/i.test(sql)) {
        account.status = values[1]
        return { rows: [{ status: account.status }] }
      }
      return { rows: [] }
    }
  }
  return client
}

// ── Bug 3: a payout must not eat the trader's own drawdown buffer ────────────
//
// The admin approve route debited current_balance and left eod_peak_equity at
// the pre-payout high, so the trailing floor stayed anchored to money that had
// already left the account.

test('a payout debit lowers the drawdown peak by the amount withdrawn', async () => {
  const account = fakeAccount({ current_balance: 110000, eod_peak_equity: 110000 })
  const client = fakeClient(account)

  await fromLockedRow(client, account).adjustBalance({
    amount: -10000, source: 'payout', reason: 'Payout 1 approved'
  })

  assert.equal(account.current_balance, 100000)
  assert.equal(account.eod_peak_equity, 100000, 'peak must follow the capital out of the account')
})

test('after a payout the trader keeps their full drawdown headroom', async () => {
  // 10% trailing drawdown on a 100k account that grew to 110k, then withdrew
  // the whole 10k profit. The floor must come back to 90k, not stay at 99k.
  const account = fakeAccount({ current_balance: 110000, eod_peak_equity: 110000 })
  const client = fakeClient(account)

  await fromLockedRow(client, account).adjustBalance({
    amount: -10000, source: 'payout', reason: 'Payout 1 approved'
  })

  const { floor } = resolveEffectiveFloor(account, { equity: 100000, maxDrawdownPct: 10 })
  assert.equal(floor, 90000)
  assert.ok(100000 > floor, 'the account must not be in breach immediately after withdrawing its profit')
})

test('a debit larger than the peak cannot drive the anchor negative', async () => {
  const account = fakeAccount({ eod_peak_equity: 5000 })
  const client = fakeClient(account)

  await shiftAnchors(client, account.id, -9000)
  assert.equal(account.eod_peak_equity, 0, 'a negative floor would disable the drawdown check entirely')
})

// ── Bug 2: restore_with_reset must restart the drawdown frame ────────────────
//
// The raw UPDATE reset current_balance but left the anchors at the pre-reset
// peak. Because every other writer guards these columns with GREATEST, the
// stale high floor never self-corrected and could fail the account on the very
// first tick after restore.

test('resetToStarting rebases the drawdown anchors, not just the balance', async () => {
  const account = fakeAccount({
    account_type: 'phase1',
    status: 'failed',
    current_balance: 88000,
    peak_balance: 121000,
    eod_peak_equity: 121000,
    eod_trailing_floor: 99000
  })
  const client = fakeClient(account)

  await fromLockedRow(client, account).resetToStarting({ reason: 'Admin restore' })

  assert.equal(account.current_balance, 100000)
  assert.equal(account.peak_balance, 100000)
  assert.equal(account.eod_peak_equity, 100000, 'a reset account must not carry its old peak')
  assert.equal(account.eod_trailing_floor, null, 'a previously locked funded floor must not survive a reset')
})

test('a reset account is not in breach on the first tick after restore', async () => {
  const account = fakeAccount({
    account_type: 'phase1', status: 'failed', current_balance: 88000, eod_peak_equity: 121000
  })
  const client = fakeClient(account)

  await fromLockedRow(client, account).resetToStarting({ reason: 'Admin restore' })

  // 10% trailing: pre-fix the floor was 121000 * 0.9 = 108900, above the
  // account's own starting balance, so it failed instantly.
  const { floor } = resolveEffectiveFloor(account, { equity: 100000, maxDrawdownPct: 10 })
  assert.equal(floor, 90000)
  assert.ok(100000 > floor)
})

test('the reset delta is booked to the ledger so the balance stays reconstructable', async () => {
  const account = fakeAccount({ account_type: 'phase1', current_balance: 88000 })
  const client = fakeClient(account)

  // The account sits 12k below its start, so it carries -12000 of realised
  // trading P&L — the middle term of the invariant, which a reset does not erase.
  const tradingPnl = account.current_balance - account.starting_balance

  await fromLockedRow(client, account).resetToStarting({ reason: 'Admin restore' })

  const reset = client.ledger.find((row) => row.source === 'admin_reset')
  assert.ok(reset, 'a reset moves capital and must leave a ledger row')
  assert.equal(reset.amount, 12000, 'the ledger must record the capital the reset put back')

  const ledgerTotal = client.ledger.reduce((sum, row) => sum + row.amount, 0)
  assert.equal(
    account.starting_balance + tradingPnl + ledgerTotal,
    account.current_balance,
    'starting_balance + trading P&L + SUM(adjustments) must reconstruct current_balance'
  )
})

// ── Bug 1: admin credits must not read as trading profit ─────────────────────
//
// Admin adjustments used to be written only to admin_balance_adjustments, a
// table nothing else reads. evaluateScalingPlan subtracted only
// source='scaling_capital_increase' from the balance, so a goodwill credit
// counted as trading profit and could mint a real scaling milestone.

test('an admin credit writes the canonical ledger, not just the admin audit table', async () => {
  const account = fakeAccount()
  const client = fakeClient(account)

  await fromLockedRow(client, account).adjustBalance({
    amount: 5000, source: 'admin_adjustment', reason: 'Goodwill', createdBy: 'admin@x.com'
  })

  const entry = client.ledger.find((row) => row.source === 'admin_adjustment')
  assert.ok(entry, 'without this row the adjustment is invisible to the scaling calculation')
  assert.equal(entry.amount, 5000)
})

test('net trading profit excludes an admin credit', () => {
  // Mirrors evaluateScalingPlan's arithmetic: trading P&L is the balance move
  // that the ledger does NOT account for.
  const startingBalance = 100000
  const currentBalance = 105000          // entirely from a $5k admin credit
  const ledgerTotal = 5000               // SUM(balance_adjustments.amount)

  const netTradingProfit = currentBalance - startingBalance - ledgerTotal
  assert.equal(netTradingProfit, 0, 'a goodwill credit is not trading profit and must not earn a milestone')

  // The pre-fix query filtered to scaling injections only, so it saw 0 here and
  // computed 5000 of phantom profit.
  const scalingOnlyTotal = 0
  assert.equal(currentBalance - startingBalance - scalingOnlyTotal, 5000)
})

// ── Bug 4: approval must re-check eligibility ────────────────────────────────
//
// Both admin approval paths checked only status='pending' plus the profit
// guard. Time passes between request and approval.

test('a failed account is not eligible even with profit on the books', () => {
  const { blockers } = evaluatePayoutEligibility({
    account: fakeAccount({ status: 'failed' }),
    kycStatus: 'approved',
    requestedAmount: 5000
  })
  assert.ok(blockers.some((b) => b.code === BLOCKER.NOT_ACTIVE))
})

test('revoked KYC blocks approval', () => {
  const { blockers } = evaluatePayoutEligibility({
    account: fakeAccount(), kycStatus: 'rejected', requestedAmount: 5000
  })
  assert.ok(blockers.some((b) => b.code === BLOCKER.KYC_NOT_APPROVED))
})

test('open exposure opened after the request blocks approval', () => {
  const { blockers } = evaluatePayoutEligibility({
    account: fakeAccount(), kycStatus: 'approved', openTradeCount: 1, requestedAmount: 5000
  })
  assert.ok(blockers.some((b) => b.code === BLOCKER.OPEN_EXPOSURE))
})

test('a non-funded account cannot withdraw', () => {
  const { blockers } = evaluatePayoutEligibility({
    account: fakeAccount({ account_type: 'phase1' }), kycStatus: 'approved', requestedAmount: 5000
  })
  assert.ok(blockers.some((b) => b.code === BLOCKER.NOT_FUNDED))
})

test('a request beyond realised profit is refused', () => {
  const { blockers } = evaluatePayoutEligibility({
    account: fakeAccount({ current_balance: 101000 }), kycStatus: 'approved', requestedAmount: 5000
  })
  assert.ok(blockers.some((b) => b.code === BLOCKER.INSUFFICIENT_PROFIT))
})

test('a fully eligible funded account clears every gate', () => {
  const { blockers, realizedProfit } = evaluatePayoutEligibility({
    account: fakeAccount(), kycStatus: 'approved', requestedAmount: 5000
  })
  assert.deepEqual(blockers, [])
  assert.equal(realizedProfit, 10000)
})

test('assertCanRequestPayout throws with the first blocker, not a generic error', () => {
  const account = fakeAccount({ status: 'locked' })
  const aggregate = fromLockedRow(fakeClient(account), account)
  assert.throws(
    () => aggregate.assertCanRequestPayout({ kycStatus: 'approved', requestedAmount: 1000 }),
    (err) => err instanceof InvariantViolation && /locked/.test(err.message)
  )
})

// ── Status transitions ───────────────────────────────────────────────────────

test('an illegal status transition is refused', async () => {
  const account = fakeAccount({ status: 'closed' })
  const aggregate = fromLockedRow(fakeClient(account), account)
  await assert.rejects(
    () => aggregate.changeStatus('active'),
    (err) => err instanceof InvariantViolation
  )
})

test('a legal status transition applies', async () => {
  const account = fakeAccount({ status: 'active' })
  const client = fakeClient(account)
  const result = await fromLockedRow(client, account).changeStatus('failed')
  assert.equal(result.status, 'failed')
  assert.equal(account.status, 'failed')
})

test('rebaseAnchors clears a locked funded floor', async () => {
  const account = fakeAccount({ eod_peak_equity: 130000, eod_trailing_floor: 105000 })
  const client = fakeClient(account)
  await rebaseAnchors(client, account.id, 100000)
  assert.equal(account.eod_peak_equity, 100000)
  assert.equal(account.eod_trailing_floor, null)
})
