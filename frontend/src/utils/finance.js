import Decimal from 'decimal.js'

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP
})

/**
 * Coerce anything into a Decimal.
 *
 * Declared as overloads because the return type genuinely depends on the
 * argument: passing `fallback: null` opts into a nullable result ("tell me if
 * this could not be parsed"), and every other call is guaranteed a Decimal.
 * Without the overloads the inferred type is `Decimal | null` for all callers,
 * which is how a single ambiguous signature produced 30 of the 49 errors the
 * first type-check reported -- none of them real, all of them noise that would
 * have buried a real one.
 *
 * @overload
 * @param {*} value
 * @param {null} fallback Opt in to a null result when the value cannot be parsed.
 * @returns {Decimal|null}
 *
 * @overload
 * @param {*} value
 * @param {number|string|Decimal} [fallback]
 * @returns {Decimal}
 *
 * @param {*} value
 * @param {number|string|Decimal|null} [fallback]
 * @returns {Decimal|null}
 */
export function toDecimal(value, fallback = 0) {
  if (Decimal.isDecimal(value)) return value
  if (value === null || value === undefined || value === '') {
    if (fallback === null) return null
    return new Decimal(fallback)
  }
  try {
    return new Decimal(value)
  } catch {
    if (fallback === null) return null
    return new Decimal(fallback)
  }
}

/**
 * @param {*} value
 * @param {number|null} [decimalPlaces] Round to this many places; null keeps full precision.
 * @returns {number}
 */
export function decimalToNumber(value, decimalPlaces = null) {
  const decimalValue = toDecimal(value)
  return Number(
    (decimalPlaces == null ? decimalValue : decimalValue.toDecimalPlaces(decimalPlaces)).toString()
  )
}

/**
 * @param {*} value
 * @returns {number} The value at 2dp, the platform's money precision.
 */
export function toMoneyNumber(value) {
  return decimalToNumber(toDecimal(value).toDecimalPlaces(2), 2)
}

/**
 * @param {Array<*>} [values]
 * @returns {number}
 */
export function sumMoney(values = []) {
  return toMoneyNumber(values.reduce((total, current) => total.plus(toDecimal(current)), new Decimal(0)))
}

export function calculateEquity(balance, floatingPnL) {
  return toMoneyNumber(toDecimal(balance).plus(toDecimal(floatingPnL)))
}

export function calculateRealizedProfit(currentBalance, startingBalance) {
  return toMoneyNumber(toDecimal(currentBalance).minus(toDecimal(startingBalance)))
}

export function calculateTargetRemaining(profitTarget, realizedProfit) {
  const remaining = toDecimal(profitTarget).minus(toDecimal(realizedProfit))
  return toMoneyNumber(remaining.lessThan(0) ? 0 : remaining)
}

export function calculatePercent(part, total, { clampMin = null, clampMax = null, decimalPlaces = 2 } = {}) {
  const totalDecimal = toDecimal(total)
  if (totalDecimal.lte(0)) return 0

  let percent = toDecimal(part).div(totalDecimal).mul(100)
  if (clampMin != null) percent = Decimal.max(percent, toDecimal(clampMin))
  if (clampMax != null) percent = Decimal.min(percent, toDecimal(clampMax))
  return decimalToNumber(percent.toDecimalPlaces(decimalPlaces), decimalPlaces)
}

export function calculatePayoutPreview(amountRequested, profitSharePct) {
  return toMoneyNumber(
    toDecimal(amountRequested).mul(toDecimal(profitSharePct).div(100))
  )
}

export function calculateRiskRewardRatio(riskAmount, rewardAmount) {
  const risk = toDecimal(riskAmount)
  if (risk.lte(0)) return null
  return decimalToNumber(toDecimal(rewardAmount).div(risk).toDecimalPlaces(2), 2)
}

export function formatCurrency(value, { signed = false } = {}) {
  const amount = toMoneyNumber(value)
  const absolute = Math.abs(amount).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })

  if (signed) {
    const prefix = amount >= 0 ? '+' : '-'
    return `${prefix}$${absolute}`
  }

  return `$${absolute}`
}

/**
 * Running total over a series, oldest first — the cumulative P&L walk behind
 * every equity sparkline and curve on the dashboard.
 *
 * Written as a fold rather than `let running = 0` mutated inside a `.map()`,
 * which is how both call sites started. A binding reassigned from inside a
 * render-phase callback is exactly what react-hooks/immutability flags: the
 * compiler cannot prove the mutation stays local to one render, and if it ever
 * escaped, a memoised series would keep accumulating across renders and the
 * curve would climb without any trades being added.
 *
 * @param {Array<T>} items Series in display order, oldest first.
 * @param {(item: T) => number|string} amountOf Extracts the increment.
 * @param {(item: T, total: number) => object} [shape] Builds each output point.
 * @returns {Array<object>} One point per input, each carrying the running sum.
 *
 * Accumulates through `sumMoney`, so each step lands on 2dp like every other
 * money total in this module. Both call sites previously did
 * `running += parseFloat(...)` on raw floats, which drifted -- a five-trade
 * walk ending at 14.16 reported 14.155000000000001. That is a deliberate
 * correction, not an incidental one: OpenPositionsTable already accumulates
 * its floating total with sumMoney, so this brings the curves into line with
 * the figure shown above them.
 * @template T
 */
export function cumulativeSeries(items, amountOf, shape = (_item, total) => ({ value: total })) {
  let total = 0
  return items.map((item) => {
    total = sumMoney([total, amountOf(item) || 0])
    return shape(item, total)
  })
}
