const test = require('node:test')
const assert = require('node:assert/strict')
const {
  evaluatePayoutEligibility,
  consistentWithdrawableProfit,
  BLOCKER
} = require('../domain/payoutEligibility')

// ─────────────────────────────────────────────────────────────────────────────
// The consistency REMEDY, and the minimum-amount check that used to be skipped.
//
// The rule itself is unchanged and widely used: it stops one lucky day being
// cashed out. What changed is what happens when it bites. The platform used to
// refuse the whole payout and instruct the trader to "keep trading to bring that
// ratio down" — i.e. to take more risk with the firm's capital to reach money
// already earned, and to lose both if they breached on the way.
// ─────────────────────────────────────────────────────────────────────────────

const FUNDED = {
  account_type: 'funded', status: 'active',
  starting_balance: '100000', current_balance: '110000'   // $10,000 profit
}

function evaluate(overrides = {}) {
  return evaluatePayoutEligibility({
    account: FUNDED,
    kycStatus: 'approved',
    profitSharePct: 100,
    ...overrides
  })
}

test('consistentWithdrawableProfit: a compliant best day withholds nothing', () => {
  assert.equal(consistentWithdrawableProfit(10000, 1000, 15), 10000)
})

test('consistentWithdrawableProfit is continuous at the limit', () => {
  // Exactly 15% of $10,000 is $1,500. Clearing the rule by a cent must not
  // change the payout by more than a cent.
  assert.equal(consistentWithdrawableProfit(10000, 1500, 15), 10000)
  assert.equal(consistentWithdrawableProfit(10000, 1500.01, 15), 9999.99)
})

test('consistentWithdrawableProfit holds back exactly the overshoot', () => {
  // Best day $4,000 against a 15% cap on $10,000: the cap allows $1,500, so
  // $2,500 is held and $7,500 is payable now.
  assert.equal(consistentWithdrawableProfit(10000, 4000, 15), 7500)
})

test('consistentWithdrawableProfit still pays the capped share when one day made everything', () => {
  assert.equal(consistentWithdrawableProfit(10000, 10000, 15), 1500)
})

test('consistentWithdrawableProfit never returns more than the profit, or less than zero', () => {
  assert.equal(consistentWithdrawableProfit(10000, 0, 15), 10000)
  assert.equal(consistentWithdrawableProfit(10000, 999999, 15), 0)
  assert.equal(consistentWithdrawableProfit(0, 0, 15), 0)
})

test('a breached consistency rule reports what the trader may take, not what they must do', () => {
  const { blockers, withdrawableNow } = evaluate({
    consistency: { ok: false, bestDayProfit: 4000, bestDayPct: 40 },
    consistencyMaxDayPct: 15
  })

  assert.equal(withdrawableNow, 7500)
  const hold = blockers.find((b) => b.code === BLOCKER.CONSISTENCY_HOLD)
  assert.ok(hold, 'expected a consistency hold')
  assert.match(hold.message, /can withdraw \$7500\.00 now/)
  assert.match(hold.message, /\$2500\.00 stays in the account/)
  assert.doesNotMatch(hold.message, /keep trading/i,
    'the remedy must never instruct the trader to take more risk')
})

test('a compliant account has no consistency blocker and may take everything', () => {
  const { blockers, withdrawableNow } = evaluate({
    consistency: { ok: true, bestDayProfit: 1000, bestDayPct: 10 },
    consistencyMaxDayPct: 15
  })
  assert.equal(withdrawableNow, 10000)
  assert.equal(blockers.find((b) => b.code === BLOCKER.CONSISTENCY_HOLD), undefined)
})

test('the minimum is now enforced when an amount is supplied, not only when it is omitted', () => {
  // This branch previously skipped the minimum entirely; it survived only
  // because routes/payouts.js re-checked it inline — the exact drift this
  // module exists to prevent.
  const { blockers } = evaluate({ requestedAmount: 10, minRequestAmount: 50 })
  assert.ok(blockers.find((b) => b.code === BLOCKER.BELOW_MINIMUM),
    'a $10 request against a $50 minimum must be blocked')
})

test('a request above realized profit is still refused as insufficient profit', () => {
  const { blockers } = evaluate({ requestedAmount: 20000, minRequestAmount: 50 })
  assert.ok(blockers.find((b) => b.code === BLOCKER.INSUFFICIENT_PROFIT))
})

test('a request within profit but above the consistent portion is capped', () => {
  const { blockers } = evaluate({
    requestedAmount: 9000,
    minRequestAmount: 50,
    consistency: { ok: false, bestDayProfit: 4000, bestDayPct: 40 },
    consistencyMaxDayPct: 15
  })
  const hold = blockers.find((b) => b.code === BLOCKER.CONSISTENCY_HOLD)
  assert.ok(hold, '$9,000 exceeds the $7,500 consistent portion')
  assert.equal(blockers.filter((b) => b.code === BLOCKER.CONSISTENCY_HOLD).length, 1,
    'the hold must be reported once, not once per check')
})

test('a request within the consistent portion passes', () => {
  const { blockers } = evaluate({
    requestedAmount: 7000,
    minRequestAmount: 50,
    consistency: { ok: false, bestDayProfit: 4000, bestDayPct: 40 },
    consistencyMaxDayPct: 15
  })
  assert.equal(blockers.filter((b) => b.code !== BLOCKER.CONSISTENCY_HOLD).length, 0)
  // The hold still explains why the rest is unavailable, but $7,000 is payable.
  assert.ok(blockers.every((b) => b.code === BLOCKER.CONSISTENCY_HOLD))
})

test('omitting consistency data leaves the predicate behaving exactly as before', () => {
  const { blockers, withdrawableNow } = evaluate({ requestedAmount: 5000, minRequestAmount: 50 })
  assert.equal(withdrawableNow, 10000)
  assert.equal(blockers.length, 0)
})
