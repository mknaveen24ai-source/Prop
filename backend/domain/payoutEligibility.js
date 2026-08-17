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

/** Reason codes, so callers can branch without matching on prose. */
const BLOCKER = {
  NOT_FUNDED: 'not_funded',
  NOT_ACTIVE: 'not_active',
  KYC_NOT_APPROVED: 'kyc_not_approved',
  OPEN_EXPOSURE: 'open_exposure',
  PENDING_PAYOUT: 'pending_payout',
  BELOW_MINIMUM: 'below_minimum',
  INSUFFICIENT_PROFIT: 'insufficient_profit'
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
 * @returns {{blockers: Array<{code:string, message:string}>, realizedProfit:number, estimatedPayable:number}}
 */
function evaluatePayoutEligibility({
  account,
  kycStatus = null,
  openTradeCount = 0,
  pendingOrderCount = 0,
  pendingPayoutCount = 0,
  requestedAmount = null,
  minRequestAmount = 50,
  profitSharePct = 80
} = {}) {
  const blockers = []
  const add = (code, message) => blockers.push({ code, message })

  const accountType = String(account?.account_type || '').toLowerCase()
  const status = String(account?.status || '').toLowerCase()
  const realizedProfit = parseFloat(
    (toNum(account?.current_balance) - toNum(account?.starting_balance)).toFixed(2)
  )
  const shareRatio = toNum(profitSharePct, 80) / 100
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

  // Amount checks. `requestedAmount` is null on the analytics path, which asks
  // "could this account withdraw at all", not "may it withdraw $X".
  if (requestedAmount == null) {
    if (estimatedPayable < toNum(minRequestAmount, 50)) {
      const gap = parseFloat((toNum(minRequestAmount, 50) - estimatedPayable).toFixed(2))
      add(BLOCKER.BELOW_MINIMUM, `You need ${gap} more payable profit to clear the minimum payout.`)
    }
  } else if (toNum(requestedAmount) > realizedProfit) {
    add(BLOCKER.INSUFFICIENT_PROFIT, 'Insufficient realized profit for payout')
  }

  return { blockers, realizedProfit, estimatedPayable }
}

module.exports = { evaluatePayoutEligibility, BLOCKER }
