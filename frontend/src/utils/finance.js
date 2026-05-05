import Decimal from 'decimal.js'

Decimal.set({
  precision: 28,
  rounding: Decimal.ROUND_HALF_UP
})

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

export function decimalToNumber(value, decimalPlaces = null) {
  const decimalValue = toDecimal(value)
  return Number(
    (decimalPlaces == null ? decimalValue : decimalValue.toDecimalPlaces(decimalPlaces)).toString()
  )
}

export function toMoneyNumber(value) {
  return decimalToNumber(toDecimal(value).toDecimalPlaces(2), 2)
}

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
