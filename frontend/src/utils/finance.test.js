import { describe, expect, it } from 'vitest'
import {
  calculateEquity,
  calculatePayoutPreview,
  calculatePercent,
  calculateRealizedProfit,
  calculateTargetRemaining,
  formatCurrency,
  sumMoney,
} from './finance.js'

describe('finance helpers', () => {
  it('keeps payout math precise to the cent', () => {
    expect(calculatePayoutPreview('123.45', '80')).toBe(98.76)
  })

  it('calculates equity and realized profit without float drift', () => {
    expect(calculateEquity('1000.10', '-0.30')).toBe(999.8)
    expect(calculateRealizedProfit('1000.30', '1000.10')).toBe(0.2)
  })

  it('formats signed and unsigned currency consistently', () => {
    expect(formatCurrency('12.5')).toBe('$12.50')
    expect(formatCurrency('-12.5', { signed: true })).toBe('-$12.50')
    expect(formatCurrency('12.5', { signed: true })).toBe('+$12.50')
  })

  it('calculates progress and target remaining safely', () => {
    expect(calculatePercent('55', '100', { clampMin: 0, clampMax: 100, decimalPlaces: 1 })).toBe(55)
    expect(calculateTargetRemaining('100', '110')).toBe(0)
  })

  it('sums floating PnL across open trades without float drift', () => {
    // TradingPanel feeds each open trade's live PnL through sumMoney() to get
    // the account's total floating balance for the drawdown/equity display.
    expect(sumMoney(['10.10', '-5.30', '0.20'])).toBe(5)
    expect(sumMoney([])).toBe(0)
  })
})
