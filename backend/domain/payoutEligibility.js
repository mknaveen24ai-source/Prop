/**
 * Payout eligibility — the single definition of "may this account withdraw?".
 *
 * These rules previously existed in three places that had drifted apart:
 *
 *   1. services/tradeAnalytics.js — the blockers list shown in the trader UI
 *   2. routes/payouts.js          — enforced on POST /api/payouts/request
 *   3. routes/admin/payouts.js and routes/admin/commandCenterActions.js —
 *      enforced on approval, where they checked only `status = 'pending'` and
 *      the profit guard
 *
 * The gap in (3) was the bug: approval re-validated almost nothing, and time
 * passes between request and approval. An account that failed, was locked, or
 * had its KYC revoked after requesting could still be approved and debited.
 *
 * Pure by design — no DB access, no tenant lookups. Callers fetch the rows
 * (they all already do, under FOR UPDATE) and pass them in. That keeps this
 * usable from the analytics read path and the two write paths alike.
 */

// FIX (F-02): the 80 defaults below predate PROFIT_SHARE_FALLBACK_PCT and
// contradicted a platform seeded at 75. constants.js is dependency-free apart
// from instruments.js, so importing it keeps this module pure as documented.
const { PROFIT_SHARE_FALLBACK_PCT } = require('../constants')

/** Reason codes, so callers can branch without matching on prose. */
const BLOCKER = {
  NOT_FUNDED: 'not_funded',
  NOT_ACTIVE: 'not_active',
  KYC_NOT_APPROVED: 'kyc_not_approved',
  OPEN_EXPOSURE: 'open_exposure',
  PENDING_PAYOUT: 'pending_payout',
  BELOW_MINIMUM: 'below_minimum',
  INSUFFICIENT_PROFIT: 'insufficient_profit',
  CONSISTENCY_HOLD: 'consistency_hold'
}

/**
 * How much of a funded account's profit the consistency rule lets it withdraw.
 *
 * The rule caps any single day at `capPct` of total profit. When a trader
 * breaches it the platform used to refuse the whole payout and tell them to
 * "keep trading to bring that ratio down" — an instruction to take MORE risk
 * with the firm's capital in order to reach money they have already earned, and
 * to lose both if they breach on the way. Mechanically the rule is fine; the
 * remedy was the problem.
 *
 * So the remedy changes, not the rule: pay out everything except the amount by
 * which the best day overshot its cap, and leave that excess in the account
 * where it unlocks naturally as profit spreads across more days.
 *
 *   allowed = totalProfit - (bestDay - capPct * totalProfit)
 *           = totalProfit * (1 + capPct) - bestDay
 *
 * Worked, at a 15% cap on $10,000 of profit:
 *   best day $1,000 (10%, compliant) -> 11,500 - 1,000 = 11,500, capped at the
 *                                       full $10,000. Nothing is withheld.
 *   best day $1,500 (exactly 15%)    -> 11,500 - 1,500 = $10,000. Continuous at
 *                                       the boundary, so clearing the rule by a
 *                                       cent never changes the payout by more.
 *   best day $4,000 (40%, breach)    -> 11,500 - 4,000 = $7,500 now, $2,500 held.
 *   best day $10,000 (all in a day)  -> 11,500 - 10,000 = $1,500, i.e. exactly
 *                                       the 15% a single day is allowed to be.
 *
 * Monotone in both arguments and never above the full profit, so a trader can
 * never do better by having a worse day.
 */
function consistentWithdrawableProfit(totalProfit, bestDayProfit, capPct) {
  const total = toNum(totalProfit)
  const best = toNum(bestDayProfit)
  const cap = toNum(capPct) / 100
  if (!(total > 0) || !(cap > 0)) return Math.max(0, total)
  const allowed = total * (1 + cap) - best
  return parseFloat(Math.max(0, Math.min(total, allowed)).toFixed(2))
}

function toNum(value, fallback = 0) {
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * @param {object} input
 * @param {object} input.account         needs account_type, status, current_balance, starting_balance
 * @param {string} [input.kycStatus]     users.kyc_status
 * @param {number} [input.openTradeCount]
 * @param {number} [input.pendingOrderCount]
 * @param {number} [input.pendingPayoutCount]
 * @param {number} [input.requestedAmount] when checking a specific amount
 * @param {number} [input.minRequestAmount]
 * @param {number} [input.profitSharePct]
 * @param {object} [input.consistency]   { ok, bestDayProfit, bestDayPct } from
 *                                       tradingDaysService.checkConsistencyRule
 * @param {number} [input.consistencyMaxDayPct]
 * @returns {{blockers: Array<{code:string, message:string}>, realizedProfit:number,
 *            estimatedPayable:number, withdrawableNow:number}}
 */
function evaluatePayoutEligibility({
  account,
  kycStatus = null,
  openTradeCount = 0,
  pendingOrderCount = 0,
  pendingPayoutCount = 0,
  requestedAmount = null,
  minRequestAmount = 50,
  profitSharePct = PROFIT_SHARE_FALLBACK_PCT,
  consistency = null,
  consistencyMaxDayPct = 0
} = {}) {
  const blockers = []
  const add = (code, message) => blockers.push({ code, message })

  const accountType = String(account?.account_type || '').toLowerCase()
  const status = String(account?.status || '').toLowerCase()
  const realizedProfit = parseFloat(
    (toNum(account?.current_balance) - toNum(account?.starting_balance)).toFixed(2)
  )
  const shareRatio = toNum(profitSharePct, PROFIT_SHARE_FALLBACK_PCT) / 100
  const estimatedPayable = parseFloat((Math.max(0, realizedProfit) * shareRatio).toFixed(2))

  if (accountType !== 'funded') {
    add(BLOCKER.NOT_FUNDED, 'Only funded accounts can request payouts.')
  }
  if (status !== 'active') {
    add(BLOCKER.NOT_ACTIVE, `Account status is ${account?.status}.`)
  }
  if (String(kycStatus || '').toLowerCase() !== 'approved') {
    add(BLOCKER.KYC_NOT_APPROVED, 'KYC approval is still required.')
  }
  if (toNum(openTradeCount) > 0 || toNum(pendingOrderCount) > 0) {
    add(BLOCKER.OPEN_EXPOSURE, 'All open and pending trades must be closed before requesting a payout.')
  }
  if (toNum(pendingPayoutCount) > 0) {
    add(BLOCKER.PENDING_PAYOUT, 'There is already a pending payout request on this account.')
  }

  // Consistency. The caller supplies the already-computed result because that
  // needs a query and this module is pure; passing it in keeps the REMEDY (how
  // much may be taken, and what the trader is told) in one place, which is the
  // whole reason this module exists.
  const capPct = toNum(consistencyMaxDayPct)
  const withdrawableNow = (consistency && capPct > 0)
    ? consistentWithdrawableProfit(realizedProfit, consistency.bestDayProfit, capPct)
    : Math.max(0, realizedProfit)

  if (consistency && consistency.ok === false && capPct > 0) {
    const held = parseFloat(Math.max(0, realizedProfit - withdrawableNow).toFixed(2))
    add(
      BLOCKER.CONSISTENCY_HOLD,
      withdrawableNow > 0
        ? `You can withdraw $${withdrawableNow.toFixed(2)} now. Your best single day is ` +
          `${toNum(consistency.bestDayPct).toFixed(1)}% of total profit against a ${capPct}% limit, ` +
          `so $${held.toFixed(2)} stays in the account and unlocks as your profit spreads across more days.`
        : `Your best single day is ${toNum(consistency.bestDayPct).toFixed(1)}% of total profit, ` +
          `above this model's ${capPct}% limit. Profit spread across more days unlocks this automatically.`
    )
  }

  // Amount checks. `requestedAmount` is null on the analytics path, which asks
  // "could this account withdraw at all", not "may it withdraw $X".
  //
  // The minimum used to be checked ONLY on the null branch, so a supplied amount
  // skipped it entirely — it survived only because routes/payouts.js re-checked
  // it inline, which is precisely the drift this module was written to prevent.
  // Both branches enforce it now.
  const minimum = toNum(minRequestAmount, 50)
  if (requestedAmount == null) {
    if (estimatedPayable < minimum) {
      const gap = parseFloat((minimum - estimatedPayable).toFixed(2))
      add(BLOCKER.BELOW_MINIMUM, `You need ${gap} more payable profit to clear the minimum payout.`)
    }
  } else {
    if (toNum(requestedAmount) < minimum) {
      add(BLOCKER.BELOW_MINIMUM, `The minimum payout request is ${minimum}.`)
    }
    if (toNum(requestedAmount) > realizedProfit) {
      add(BLOCKER.INSUFFICIENT_PROFIT, 'Insufficient realized profit for payout')
    } else if (toNum(requestedAmount) > withdrawableNow) {
      // Already reported by CONSISTENCY_HOLD above when the rule is breached;
      // this is the amount-specific refusal that keeps the two consistent.
      if (!blockers.some((b) => b.code === BLOCKER.CONSISTENCY_HOLD)) {
        add(BLOCKER.CONSISTENCY_HOLD, `You can withdraw up to $${withdrawableNow.toFixed(2)} on this account right now.`)
      }
    }
  }

  return { blockers, realizedProfit, estimatedPayable, withdrawableNow }
}

module.exports = { evaluatePayoutEligibility, consistentWithdrawableProfit, BLOCKER }
