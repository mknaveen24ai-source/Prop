// Trader performance analytics.
//
// Pure functions over already-fetched rows — no database or request access — so
// they are directly unit-testable. Moved verbatim out of routes/trades.js, where
// they were ~660 lines serving the single GET /api/trades/analytics endpoint.
const { CONTRACT_SIZES } = require('../constants')
const { evaluatePayoutEligibility } = require('../domain/payoutEligibility')

const ANALYTICS_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ANALYTICS_WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
function toFiniteNumber(value, fallback = 0) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function toSafeDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function computeDaysRemainingForAnalytics(value) {
  const date = toSafeDate(value)
  if (!date) return null
  const diffMs = date.getTime() - Date.now()
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)))
}

function computeTradeDurationMinutes(trade) {
  const openTime = toSafeDate(trade?.open_time)
  const closeTime = toSafeDate(trade?.close_time)
  if (!openTime || !closeTime) return null
  const duration = (closeTime.getTime() - openTime.getTime()) / (1000 * 60)
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}

function getAnalyticsSessionMeta(value) {
  const date = toSafeDate(value)
  const hour = date ? date.getUTCHours() : null
  if (!Number.isFinite(hour)) {
    return { key: 'unknown', label: 'Unknown', order: 99 }
  }
  if (hour < 8) return { key: 'asia', label: 'Asia', order: 0 }
  if (hour < 13) return { key: 'london', label: 'London', order: 1 }
  if (hour < 21) return { key: 'new_york', label: 'New York', order: 2 }
  return { key: 'rollover', label: 'Rollover', order: 3 }
}

function buildPerformanceBreakdown(trades, bucketFactory) {
  const map = new Map()

  for (const trade of trades) {
    const bucket = bucketFactory(trade) || {}
    const key = String(bucket.key || bucket.label || 'unknown')
    const label = String(bucket.label || bucket.key || 'Unknown')
    const pnl = toFiniteNumber(trade.demo_pnl)
    const durationMins = computeTradeDurationMinutes(trade)

    const entry = map.get(key) || {
      key,
      label,
      order: Number.isFinite(bucket.order) ? bucket.order : Number.MAX_SAFE_INTEGER,
      trades: 0,
      wins: 0,
      losses: 0,
      total_pnl: 0,
      total_hold_mins: 0,
      hold_samples: 0
    }

    entry.trades += 1
    if (pnl > 0) entry.wins += 1
    if (pnl < 0) entry.losses += 1
    entry.total_pnl += pnl
    if (Number.isFinite(durationMins)) {
      entry.total_hold_mins += durationMins
      entry.hold_samples += 1
    }

    map.set(key, entry)
  }

  return Array.from(map.values())
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      order: entry.order,
      trades: entry.trades,
      wins: entry.wins,
      losses: entry.losses,
      total_pnl: parseFloat(entry.total_pnl.toFixed(2)),
      avg_pnl: entry.trades ? parseFloat((entry.total_pnl / entry.trades).toFixed(2)) : 0,
      win_rate: entry.trades ? parseFloat(((entry.wins / entry.trades) * 100).toFixed(1)) : 0,
      avg_hold_mins: entry.hold_samples ? parseFloat((entry.total_hold_mins / entry.hold_samples).toFixed(1)) : null
    }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      if (b.total_pnl !== a.total_pnl) return b.total_pnl - a.total_pnl
      return b.trades - a.trades
    })
}

function buildActivityHeatmap(trades) {
  const weekdays = ANALYTICS_WEEKDAY_ORDER.map((index) => ANALYTICS_WEEKDAY_LABELS[index])
  const hours = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'))
  const dayMap = new Map()

  for (const dayIndex of ANALYTICS_WEEKDAY_ORDER) {
    const label = ANALYTICS_WEEKDAY_LABELS[dayIndex]
    dayMap.set(dayIndex, {
      day_index: dayIndex,
      day_label: label,
      total_trades: 0,
      total_pnl: 0,
      slots: hours.map((hour) => ({ hour, trades: 0, pnl: 0 }))
    })
  }

  const hourlyTotals = hours.map((hour) => ({ hour, trades: 0, pnl: 0 }))

  for (const trade of trades) {
    const openTime = toSafeDate(trade.open_time)
    if (!openTime) continue
    const pnl = toFiniteNumber(trade.demo_pnl)
    const dayIndex = openTime.getUTCDay()
    const hourIndex = openTime.getUTCHours()
    const dayEntry = dayMap.get(dayIndex)
    if (!dayEntry || !dayEntry.slots[hourIndex]) continue

    dayEntry.total_trades += 1
    dayEntry.total_pnl += pnl
    dayEntry.slots[hourIndex].trades += 1
    dayEntry.slots[hourIndex].pnl += pnl
    hourlyTotals[hourIndex].trades += 1
    hourlyTotals[hourIndex].pnl += pnl
  }

  const matrix = ANALYTICS_WEEKDAY_ORDER.map((index) => {
    const entry = dayMap.get(index)
    return {
      day_index: index,
      day_label: entry.day_label,
      total_trades: entry.total_trades,
      total_pnl: parseFloat(entry.total_pnl.toFixed(2)),
      slots: entry.slots.map((slot) => ({
        hour: slot.hour,
        trades: slot.trades,
        pnl: parseFloat(slot.pnl.toFixed(2))
      }))
    }
  })

  const weekdaySummary = matrix
    .map((row) => ({
      label: row.day_label,
      trades: row.total_trades,
      total_pnl: row.total_pnl
    }))
    .sort((a, b) => b.total_pnl - a.total_pnl)

  const hourlySummary = hourlyTotals.map((slot) => ({
    hour: slot.hour,
    trades: slot.trades,
    total_pnl: parseFloat(slot.pnl.toFixed(2))
  }))

  return {
    weekdays,
    hours,
    matrix,
    weekday_summary: weekdaySummary,
    hourly_summary: hourlySummary
  }
}

function buildEquityCurveRanges(curve) {
  if (!Array.isArray(curve) || curve.length === 0) {
    return { day: [], week: [], month: [], ytd: [], full: [] }
  }

  const lastPointDate = toSafeDate(curve[curve.length - 1]?.date) || new Date()
  const filterByDays = (days) => curve.filter((point) => {
    const pointDate = toSafeDate(point.date)
    if (!pointDate) return false
    return (lastPointDate.getTime() - pointDate.getTime()) <= (days * 24 * 60 * 60 * 1000)
  })
  const yearStart = new Date(Date.UTC(lastPointDate.getUTCFullYear(), 0, 1)).getTime()
  const filterYtd = () => curve.filter((point) => {
    const pointDate = toSafeDate(point.date)
    return pointDate && pointDate.getTime() >= yearStart
  })

  return {
    day: filterByDays(1),
    week: filterByDays(7),
    month: filterByDays(30),
    ytd: filterYtd(),
    full: curve
  }
}

function percentile(sortedValues, percentileValue) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(percentileValue * (sortedValues.length - 1))))
  return sortedValues[index]
}

function buildHoldTimeAnalytics(trades, symbolBreakdown, strategyBreakdown, minHoldSeconds) {
  const durations = trades
    .map((trade) => computeTradeDurationMinutes(trade))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)

  if (durations.length === 0) {
    return {
      average_mins: 0,
      median_mins: 0,
      winners_average_mins: 0,
      losers_average_mins: 0,
      quick_exit_rate: 0,
      overhold_rate: 0,
      quick_exit_threshold_mins: 0,
      overhold_threshold_mins: 0,
      bias_label: 'No hold-time samples yet',
      by_symbol: [],
      by_strategy: []
    }
  }

  const average = durations.reduce((sum, value) => sum + value, 0) / durations.length
  const median = durations.length % 2 === 1
    ? durations[(durations.length - 1) / 2]
    : (durations[(durations.length / 2) - 1] + durations[durations.length / 2]) / 2

  const winnerDurations = trades
    .filter((trade) => toFiniteNumber(trade.demo_pnl) > 0)
    .map((trade) => computeTradeDurationMinutes(trade))
    .filter((value) => Number.isFinite(value))
  const loserDurations = trades
    .filter((trade) => toFiniteNumber(trade.demo_pnl) < 0)
    .map((trade) => computeTradeDurationMinutes(trade))
    .filter((value) => Number.isFinite(value))

  const winnersAverage = winnerDurations.length
    ? winnerDurations.reduce((sum, value) => sum + value, 0) / winnerDurations.length
    : 0
  const losersAverage = loserDurations.length
    ? loserDurations.reduce((sum, value) => sum + value, 0) / loserDurations.length
    : 0

  const quickExitThreshold = Math.max(5, Math.ceil((toFiniteNumber(minHoldSeconds, 60) / 60) * 2))
  const overholdThreshold = Math.max(240, Math.ceil(median * 1.75))
  const quickExits = durations.filter((value) => value <= quickExitThreshold).length
  const overholds = durations.filter((value) => value >= overholdThreshold).length

  let biasLabel = 'Your hold times are balanced across winners and losers.'
  if (winnersAverage > 0 && losersAverage > winnersAverage * 1.2) {
    biasLabel = 'Losing trades are staying open longer than winners.'
  } else if (losersAverage > 0 && winnersAverage > losersAverage * 1.2) {
    biasLabel = 'Winning trades are getting more room than losing trades.'
  } else if ((quickExits / durations.length) > 0.35) {
    biasLabel = 'A large share of trades are being closed quickly.'
  }

  return {
    average_mins: parseFloat(average.toFixed(1)),
    median_mins: parseFloat(median.toFixed(1)),
    winners_average_mins: parseFloat(winnersAverage.toFixed(1)),
    losers_average_mins: parseFloat(losersAverage.toFixed(1)),
    quick_exit_rate: parseFloat(((quickExits / durations.length) * 100).toFixed(1)),
    overhold_rate: parseFloat(((overholds / durations.length) * 100).toFixed(1)),
    quick_exit_threshold_mins: quickExitThreshold,
    overhold_threshold_mins: overholdThreshold,
    bias_label: biasLabel,
    lower_quartile_mins: parseFloat((percentile(durations, 0.25) || 0).toFixed(1)),
    upper_quartile_mins: parseFloat((percentile(durations, 0.75) || 0).toFixed(1)),
    by_symbol: (symbolBreakdown || []).filter((entry) => entry.avg_hold_mins != null).slice(0, 8),
    by_strategy: (strategyBreakdown || []).filter((entry) => entry.avg_hold_mins != null).slice(0, 8)
  }
}

function calculateCoefficientOfVariation(values) {
  if (!Array.isArray(values) || values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  if (!Number.isFinite(mean) || mean === 0) return 0
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length
  return Math.sqrt(variance) / mean
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)))
}

function toScoreGrade(score) {
  if (score >= 85) return 'A'
  if (score >= 70) return 'B'
  if (score >= 55) return 'C'
  if (score >= 40) return 'D'
  return 'E'
}

function buildDisciplineScore(trades, violations, tradingRules) {
  const maxDailyTrades = Math.max(1, parseInt(tradingRules?.max_daily_trades || 20, 10))
  const minHoldSeconds = Math.max(0, parseInt(tradingRules?.min_hold_seconds || 60, 10))
  const tradesByDay = new Map()
  const orderedByOpen = [...trades].sort((a, b) => new Date(a.open_time) - new Date(b.open_time))

  for (const trade of orderedByOpen) {
    const openTime = toSafeDate(trade.open_time)
    if (!openTime) continue
    const key = openTime.toISOString().slice(0, 10)
    tradesByDay.set(key, (tradesByDay.get(key) || 0) + 1)
  }

  const overtradingDays = Array.from(tradesByDay.values()).filter((count) => count > maxDailyTrades).length
  let revengeSequences = 0
  let impulsiveTrades = 0

  for (let index = 0; index < orderedByOpen.length; index += 1) {
    const trade = orderedByOpen[index]
    const durationMins = computeTradeDurationMinutes(trade)
    if (Number.isFinite(durationMins) && durationMins * 60 <= Math.max(300, minHoldSeconds * 2)) {
      impulsiveTrades += 1
    }

    if (index === 0) continue
    const previousTrade = orderedByOpen[index - 1]
    const previousPnl = toFiniteNumber(previousTrade.demo_pnl)
    if (previousPnl >= 0) continue

    const previousClose = toSafeDate(previousTrade.close_time)
    const currentOpen = toSafeDate(trade.open_time)
    if (!previousClose || !currentOpen) continue

    const gapMins = (currentOpen.getTime() - previousClose.getTime()) / (1000 * 60)
    const previousLots = toFiniteNumber(previousTrade.lot_size)
    const currentLots = toFiniteNumber(trade.lot_size)
    if (gapMins >= 0 && gapMins <= 15 && currentLots > previousLots * 1.1) {
      revengeSequences += 1
    }
  }

  const warningHits = (violations || []).reduce((sum, violation) => sum + Math.max(1, parseInt(violation.hit_count || 1, 10)), 0)
  const tradeCount = Math.max(1, trades.length)

  const overtradingComponent = clampScore(100 - ((overtradingDays / Math.max(1, tradesByDay.size)) * 220))
  const revengeComponent = clampScore(100 - ((revengeSequences / tradeCount) * 320))
  const warningComponent = clampScore(100 - (warningHits * 10))
  const patienceComponent = clampScore(100 - ((impulsiveTrades / tradeCount) * 180))

  const score = clampScore(
    (overtradingComponent * 0.3) +
    (revengeComponent * 0.3) +
    (warningComponent * 0.2) +
    (patienceComponent * 0.2)
  )

  const weakestComponent = [
    { key: 'overtrading', score: overtradingComponent },
    { key: 'revenge_trading', score: revengeComponent },
    { key: 'rule_warnings', score: warningComponent },
    { key: 'patience', score: patienceComponent }
  ].sort((a, b) => a.score - b.score)[0]

  const summaryByComponent = {
    overtrading: 'Trade frequency is pushing close to or beyond your daily limits.',
    revenge_trading: 'There are fast re-entries after losses with larger size.',
    rule_warnings: 'Rule warnings or enforcement events are dragging discipline down.',
    patience: 'A high share of trades are being closed quickly.'
  }

  return {
    score,
    grade: toScoreGrade(score),
    summary: summaryByComponent[weakestComponent.key] || 'Discipline is steady overall.',
    components: {
      overtrading: overtradingComponent,
      revenge_trading: revengeComponent,
      rule_warnings: warningComponent,
      patience: patienceComponent
    },
    metrics: {
      overtrading_days: overtradingDays,
      revenge_sequences: revengeSequences,
      warning_hits: warningHits,
      impulsive_trades: impulsiveTrades
    }
  }
}

function buildRiskConsistencyScore(trades) {
  const lotSizes = trades
    .map((trade) => toFiniteNumber(trade.lot_size))
    .filter((value) => value > 0)

  const plannedRiskValues = trades
    .map((trade) => {
      const openPrice = toFiniteNumber(trade.open_price, NaN)
      const stopLoss = toFiniteNumber(trade.stop_loss, NaN)
      const lotSize = toFiniteNumber(trade.lot_size, NaN)
      if (!Number.isFinite(openPrice) || !Number.isFinite(stopLoss) || !Number.isFinite(lotSize)) {
        return null
      }
      const contractSize = CONTRACT_SIZES[trade.instrument] || 100000
      return Math.abs(openPrice - stopLoss) * lotSize * contractSize
    })
    .filter((value) => Number.isFinite(value) && value > 0)

  const lotSizeCv = calculateCoefficientOfVariation(lotSizes)
  const plannedRiskCv = calculateCoefficientOfVariation(plannedRiskValues)
  const stopLossUsagePct = trades.length
    ? parseFloat(((plannedRiskValues.length / trades.length) * 100).toFixed(1))
    : 0

  const lotSizeComponent = clampScore(100 - Math.min(85, lotSizeCv * 100))
  const plannedRiskComponent = clampScore(100 - Math.min(90, plannedRiskCv * 100))
  const stopLossComponent = clampScore(stopLossUsagePct)
  const score = clampScore((lotSizeComponent * 0.35) + (plannedRiskComponent * 0.4) + (stopLossComponent * 0.25))

  let summary = 'Sizing is fairly controlled across the sample.'
  if (plannedRiskComponent < 60) {
    summary = 'Your monetary risk per trade varies a lot even when lot sizes look similar.'
  } else if (lotSizeComponent < 60) {
    summary = 'Lot sizes are swinging enough to make risk look random.'
  } else if (stopLossComponent < 70) {
    summary = 'A meaningful share of trades are still going out without a defined stop loss.'
  }

  return {
    score,
    grade: toScoreGrade(score),
    summary,
    components: {
      lot_size_consistency: lotSizeComponent,
      planned_risk_consistency: plannedRiskComponent,
      stop_loss_usage: stopLossComponent
    },
    metrics: {
      lot_size_cv: parseFloat(lotSizeCv.toFixed(2)),
      planned_risk_cv: parseFloat(plannedRiskCv.toFixed(2)),
      stop_loss_usage_pct: stopLossUsagePct
    }
  }
}

function buildSetupReports(symbolBreakdown, sessionBreakdown, strategyBreakdown) {
  const candidates = [
    ...(strategyBreakdown || []).map((entry) => ({ ...entry, setup_type: 'Strategy' })),
    ...(symbolBreakdown || []).map((entry) => ({ ...entry, setup_type: 'Symbol' })),
    ...(sessionBreakdown || []).map((entry) => ({ ...entry, setup_type: 'Session' }))
  ].filter((entry) => entry.trades >= 2)

  const bestSetups = [...candidates]
    .sort((a, b) => b.total_pnl - a.total_pnl || b.win_rate - a.win_rate)
    .slice(0, 4)
  const worstSetups = [...candidates]
    .sort((a, b) => a.total_pnl - b.total_pnl || a.win_rate - b.win_rate)
    .slice(0, 4)

  return {
    best_setups: bestSetups,
    worst_setups: worstSetups
  }
}

function buildBreachAnalysis(account, trades, violations) {
  const currentBalance = toFiniteNumber(account.current_balance)
  const startingBalance = toFiniteNumber(account.starting_balance)
  const peakBalance = toFiniteNumber(account.peak_balance || account.starting_balance)
  const profitTarget = toFiniteNumber(account.profit_target)
  const maxDrawdownPct = toFiniteNumber(account.max_drawdown_pct, 0)
  const currentDrawdownPct = peakBalance > 0
    ? parseFloat((((peakBalance - currentBalance) / peakBalance) * 100).toFixed(2))
    : 0
  const totalDrawdownPct = startingBalance > 0
    ? parseFloat((Math.max(0, ((startingBalance - currentBalance) / startingBalance) * 100)).toFixed(2))
    : 0
  const targetProgressPct = profitTarget > 0
    ? parseFloat((Math.max(0, ((currentBalance - startingBalance) / profitTarget) * 100).toFixed(1)))
    : String(account.account_type || '').toLowerCase() === 'funded' ? 100 : 0
  const latestTrade = trades[trades.length - 1] || null
  const recentViolations = (violations || []).slice(0, 3).map((violation) => ({
    violation_type: violation.violation_type,
    severity: violation.severity,
    status: violation.status,
    message: violation.message,
    detected_at: violation.last_detected_at
  }))

  let title = 'Challenge Health'
  let primaryCause = 'monitoring'
  let explanation = 'This account is still live. The key job now is balancing target progress against drawdown usage.'

  if (String(account.status).toLowerCase() === 'failed') {
    title = 'Breach Cause'
    if (recentViolations.length > 0) {
      primaryCause = recentViolations[0].violation_type || 'rule_violation'
      explanation = recentViolations[0].message || 'A recorded rule violation pushed the account into failure.'
    } else if (maxDrawdownPct > 0 && totalDrawdownPct >= maxDrawdownPct * 0.9) {
      primaryCause = 'max_drawdown'
      explanation = `Total drawdown reached ${totalDrawdownPct.toFixed(2)}% against a ${maxDrawdownPct.toFixed(2)}% limit.`
    } else {
      primaryCause = 'account_failed'
      explanation = latestTrade?.close_reason || 'The account was closed after a failure condition was hit.'
    }
  } else if (String(account.status).toLowerCase() === 'expired') {
    title = 'Expiry Cause'
    primaryCause = 'time_limit'
    explanation = `The account expired before the profit target was completed. Progress reached ${targetProgressPct.toFixed(1)}% of target.`
  } else if (String(account.status).toLowerCase() === 'passed') {
    title = 'Pass Analysis'
    primaryCause = 'target_hit'
    explanation = 'The profit target was completed before the risk limits were breached.'
  } else if (maxDrawdownPct > 0 && totalDrawdownPct >= maxDrawdownPct * 0.7) {
    primaryCause = 'drawdown_pressure'
    explanation = `Drawdown is at ${totalDrawdownPct.toFixed(2)}% of a ${maxDrawdownPct.toFixed(2)}% max loss limit, so risk control is the main pressure right now.`
  } else if (profitTarget > 0 && targetProgressPct < 40) {
    primaryCause = 'target_distance'
    explanation = `Target progress is still only ${targetProgressPct.toFixed(1)}%, so the focus is efficient target building without forcing extra trades.`
  }

  return {
    title,
    status: account.status,
    primary_cause: primaryCause,
    explanation,
    latest_close_reason: latestTrade?.close_reason || null,
    recent_violations: recentViolations,
    review_flag_reason: account.review_flag_reason || null,
    days_remaining: computeDaysRemainingForAnalytics(account.phase_end_date),
    target_progress_pct: targetProgressPct,
    current_drawdown_pct: currentDrawdownPct,
    total_drawdown_pct: totalDrawdownPct,
    drawdown_usage_pct: maxDrawdownPct > 0 ? parseFloat(((totalDrawdownPct / maxDrawdownPct) * 100).toFixed(1)) : 0
  }
}

function buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, recentTrades) {
  const sharePct = toFiniteNumber(tenantSettings.profit_share_pct, 80)
  const shareRatio = sharePct / 100
  const minRequestAmount = toFiniteNumber(tenantSettings.min_payout_amount, 50)
  const processingDays = Math.max(1, parseInt(tenantSettings.payout_processing_days || 3, 10))
  const currentBalance = toFiniteNumber(account.current_balance)
  const startingBalance = toFiniteNumber(account.starting_balance)
  const realizedProfit = parseFloat((currentBalance - startingBalance).toFixed(2))
  const estimatedPayable = parseFloat((Math.max(0, realizedProfit) * shareRatio).toFixed(2))
  const pendingPayoutCount = (payoutRows || []).filter((row) => String(row.status).toLowerCase() === 'pending').length
  const nextMilestoneProfit = shareRatio > 0 ? parseFloat((minRequestAmount / shareRatio).toFixed(2)) : minRequestAmount
  const profitGap = parseFloat(Math.max(0, nextMilestoneProfit - realizedProfit).toFixed(2))
  const recentTrendPnl = parseFloat(
    (recentTrades || [])
      .slice(-5)
      .reduce((sum, trade) => sum + toFiniteNumber(trade.demo_pnl), 0)
      .toFixed(2)
  )
  const trendLabel = recentTrendPnl > 0 ? 'improving' : recentTrendPnl < 0 ? 'cooling' : 'flat'

  // Shared with routes/payouts.js (request) and domain/payout.js (approval), so
  // what the trader is told here is exactly what the two write paths enforce.
  // These rules used to be written out three times and had drifted: approval
  // checked almost none of them.
  //
  // Flattened to strings because this list is a published API shape the
  // dashboard renders directly; the predicate returns {code, message} objects.
  const blockers = evaluatePayoutEligibility({
    account,
    kycStatus: userProfile?.kyc_status,
    openTradeCount: openTradeSummary?.open_count || 0,
    pendingOrderCount: openTradeSummary?.pending_count || 0,
    pendingPayoutCount,
    minRequestAmount,
    profitSharePct: sharePct
  }).blockers.map((blocker) => blocker.message)

  return {
    eligible_now: blockers.length === 0,
    next_status: blockers.length === 0 ? 'Ready to request payout' : blockers[0],
    estimated_payable: estimatedPayable,
    realized_profit: realizedProfit,
    profit_share_pct: sharePct,
    min_request_amount: minRequestAmount,
    payout_processing_days: processingDays,
    kyc_status: userProfile?.kyc_status || 'unknown',
    open_trade_count: parseInt(openTradeSummary?.open_count || 0, 10),
    pending_order_count: parseInt(openTradeSummary?.pending_count || 0, 10),
    pending_payout_count: pendingPayoutCount,
    profit_gap_to_min_request: profitGap,
    next_profit_milestone: nextMilestoneProfit,
    days_remaining: computeDaysRemainingForAnalytics(account.phase_end_date),
    trend_label: trendLabel,
    trend_pnl_last_5_trades: recentTrendPnl,
    blockers
  }
}

function buildImprovementSuggestions(context) {
  const suggestions = []
  const {
    breakdowns,
    holdTime,
    discipline,
    riskConsistency,
    payoutForecast,
    setupReports
  } = context

  const weakestSession = (breakdowns?.session || [])
    .filter((entry) => entry.trades >= 2)
    .sort((a, b) => a.total_pnl - b.total_pnl)[0]
  if (weakestSession && weakestSession.total_pnl < 0) {
    suggestions.push({
      priority: 'high',
      title: `Trim exposure during ${weakestSession.label}`,
      detail: `${weakestSession.label} trades are down ${Math.abs(weakestSession.total_pnl).toFixed(2)} with a ${weakestSession.win_rate.toFixed(1)}% win rate. Reduce size or tighten entry quality in that session.`,
      metric: 'session_breakdown'
    })
  }

  if ((holdTime?.quick_exit_rate || 0) >= 35) {
    suggestions.push({
      priority: 'medium',
      title: 'Let valid trades breathe a little longer',
      detail: `${holdTime.quick_exit_rate.toFixed(1)}% of closed trades ended inside ${holdTime.quick_exit_threshold_mins} minutes. That often points to cutting trades before the idea has time to develop.`,
      metric: 'hold_time'
    })
  }

  if ((discipline?.score || 100) < 70) {
    suggestions.push({
      priority: 'high',
      title: 'Tighten discipline before adding more size',
      detail: `${discipline.summary} Current discipline score is ${discipline.score}/100, so the best edge right now is cleaner execution rather than more trades.`,
      metric: 'discipline_score'
    })
  }

  if ((riskConsistency?.score || 100) < 70) {
    suggestions.push({
      priority: 'high',
      title: 'Standardize risk per trade',
      detail: `${riskConsistency.summary} Use consistent stop placement and lot sizing so similar ideas risk similar dollars.`,
      metric: 'risk_consistency'
    })
  }

  const worstSetup = setupReports?.worst_setups?.[0]
  if (worstSetup && worstSetup.total_pnl < 0) {
    suggestions.push({
      priority: 'medium',
      title: `Review the weakest ${String(worstSetup.setup_type || 'setup').toLowerCase()}`,
      detail: `${worstSetup.label} has produced ${worstSetup.total_pnl.toFixed(2)} across ${worstSetup.trades} trades. Pause it or lower size until the edge is clearer.`,
      metric: 'setup_report'
    })
  }

  if (!(payoutForecast?.eligible_now)) {
    suggestions.push({
      priority: 'medium',
      title: 'Clear payout blockers early',
      detail: payoutForecast?.blockers?.[0] || 'There are still conditions to clear before the account is payout-ready.',
      metric: 'payout_forecast'
    })
  }

  if (suggestions.length === 0) {
    suggestions.push({
      priority: 'low',
      title: 'Keep compounding what is already working',
      detail: 'The data is relatively balanced right now. Stay selective, keep risk stable, and avoid forcing trades when the quality is not obvious.',
      metric: 'overall'
    })
  }

  return suggestions.slice(0, 5)
}

// GET /api/trades/analytics
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

module.exports = {
  ANALYTICS_WEEKDAY_LABELS,
  ANALYTICS_WEEKDAY_ORDER,
  toFiniteNumber,
  toSafeDate,
  computeDaysRemainingForAnalytics,
  computeTradeDurationMinutes,
  getAnalyticsSessionMeta,
  buildPerformanceBreakdown,
  buildActivityHeatmap,
  buildEquityCurveRanges,
  percentile,
  buildHoldTimeAnalytics,
  calculateCoefficientOfVariation,
  clampScore,
  toScoreGrade,
  buildDisciplineScore,
  buildRiskConsistencyScore,
  buildSetupReports,
  buildBreachAnalysis,
  buildPayoutForecast,
  buildImprovementSuggestions
}
