// GET /api/trades/analytics — the trader-facing analytics payload.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.
//
// Thin orchestrator: every computation lives in services/tradeAnalytics.js.

const express = require('express')
const pool = require('../../db')
const logger = require('../../utils/logger')
const { authenticateToken } = require('../middleware')
const { ensureViolationTables } = require('../../services/violationEngine')
const { getTenantSettings } = require('../../services/tenantPolicyService')
const {
  toSafeDate,
  getAnalyticsSessionMeta,
  buildPerformanceBreakdown,
  buildActivityHeatmap,
  buildEquityCurveRanges,
  buildHoldTimeAnalytics,
  buildDisciplineScore,
  buildRiskConsistencyScore,
  buildSetupReports,
  buildBreachAnalysis,
  buildPayoutForecast,
  buildImprovementSuggestions,
  ANALYTICS_WEEKDAY_LABELS,
  ANALYTICS_WEEKDAY_ORDER
} = require('../../services/tradeAnalytics')
const {
  ensureTradeExperienceInfrastructure,
  computeRMultiple
} = require('../../services/tradeShared')

const router = express.Router()

router.get('/analytics', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()
    await ensureViolationTables()
    const { account_id } = req.query
    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountResult = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct,
              phase_start_date, phase_end_date, created_at, review_flag_reason
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountResult.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const account = accountResult.rows[0]

    const [userResult, openTradeSummaryResult, payoutRowsResult, violationsResult, tenantSettings] = await Promise.all([
      pool.query(
        `SELECT id, email, kyc_status
           FROM users
          WHERE id = $1`,
        [req.user.userId]
      ),
      pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
           FROM trades
          WHERE account_id = $1`,
        [account_id]
      ),
      pool.query(
        `SELECT status, amount_requested, amount_payable, requested_at, paid_at
           FROM payouts
          WHERE account_id = $1
          ORDER BY requested_at DESC
          LIMIT 10`,
        [account_id]
      ),
      pool.query(
        `SELECT violation_type, severity, status, message, hit_count, last_detected_at
           FROM admin_rule_violations
          WHERE account_id = $1
          ORDER BY last_detected_at DESC
          LIMIT 25`,
        [String(account_id)]
      ),
      getTenantSettings([
        'profit_share_pct',
        'min_payout_amount',
        'payout_processing_days',
        'max_daily_trades',
        'min_hold_seconds'
      ])
    ])

    const userProfile = userResult.rows[0] || { id: req.user.userId, kyc_status: 'unknown' }
    const openTradeSummary = openTradeSummaryResult.rows[0] || { open_count: 0, pending_count: 0 }
    const payoutRows = payoutRowsResult.rows || []
    const violations = violationsResult.rows || []

    const tradesResult = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades WHERE account_id = $1 AND status = 'closed' ORDER BY close_time ASC`,
      [account_id]
    )
    const trades = tradesResult.rows

    if (trades.length === 0) {
      return res.json({
        account,
        analytics: {
          total_trades: 0,
          winning_trades: 0,
          losing_trades: 0,
          breakeven_trades: 0,
          win_rate: 0,
          total_pnl: 0,
          avg_win: 0,
          avg_loss: 0,
          profit_factor: 0,
          avg_rr: 0,
          avg_r_multiple: null,
          r_distribution: [],
          expectancy: 0,
          best_win_streak: 0,
          sharpe_30d: null,
          best_trade: 0,
          worst_trade: 0,
          avg_trade_duration_mins: 0,
          drawdown_curve: [],
          equity_curve_ranges: { day: [], week: [], month: [], ytd: [], full: [] },
          heatmap: {},
          activity_heatmap: buildActivityHeatmap([]),
          breakdowns: {
            symbol: [],
            weekday: [],
            session: []
          },
          hold_time: buildHoldTimeAnalytics([], [], [], tenantSettings.min_hold_seconds),
          setup_report: buildSetupReports([], [], []),
          discipline_score: buildDisciplineScore([], violations, tenantSettings),
          risk_consistency_score: buildRiskConsistencyScore([]),
          breach_analysis: buildBreachAnalysis(account, [], violations),
          payout_forecast: buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, []),
          improvement_suggestions: buildImprovementSuggestions({
            breakdowns: { session: [] },
            holdTime: buildHoldTimeAnalytics([], [], [], tenantSettings.min_hold_seconds),
            discipline: buildDisciplineScore([], violations, tenantSettings),
            riskConsistency: buildRiskConsistencyScore([]),
            payoutForecast: buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, []),
            setupReports: buildSetupReports([], [], [])
          })
        }
      })
    }

    const winners   = trades.filter(t => parseFloat(t.demo_pnl) > 0)
    const losers    = trades.filter(t => parseFloat(t.demo_pnl) < 0)
    const breakeven = trades.filter(t => parseFloat(t.demo_pnl) === 0)

    const win_rate     = parseFloat(((winners.length / trades.length) * 100).toFixed(1))
    const total_pnl    = trades.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0)
    const gross_profit = winners.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0)
    const gross_loss   = Math.abs(losers.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0))

    const avg_win       = winners.length ? parseFloat((gross_profit / winners.length).toFixed(2)) : 0
    const avg_loss      = losers.length  ? parseFloat((gross_loss   / losers.length).toFixed(2))  : 0
    const profit_factor = gross_loss > 0 ? parseFloat((gross_profit / gross_loss).toFixed(2)) : gross_profit > 0 ? 999 : 0
    const avg_rr        = avg_loss > 0   ? parseFloat((avg_win / avg_loss).toFixed(2)) : 0

    // R-multiple — a different metric from avg_rr above (that's a win/loss
    // dollar ratio; this is realized P&L against the stop-loss-defined risk
    // per trade). Only trades with a stop-loss have a defined R; the rest
    // are excluded from the average rather than counted as 0.
    const rMultiples = trades.map((t) => computeRMultiple(t)).filter((r) => r != null)
    const avg_r_multiple = rMultiples.length ? parseFloat((rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length).toFixed(2)) : null
    const r_distribution = rMultiples.map((r) => parseFloat(r.toFixed(2)))

    // Expectancy — average realized P&L per trade, over the whole set.
    const expectancy = parseFloat((total_pnl / trades.length).toFixed(2))

    // Best win streak — longest run of consecutive winning trades in close
    // order. Breakeven trades (pnl === 0) break a streak without starting a
    // losing one.
    const chronological = [...trades].sort((a, b) => new Date(a.close_time) - new Date(b.close_time))
    let best_win_streak = 0
    let currentStreak = 0
    for (const t of chronological) {
      if (parseFloat(t.demo_pnl) > 0) {
        currentStreak += 1
        best_win_streak = Math.max(best_win_streak, currentStreak)
      } else {
        currentStreak = 0
      }
    }

    // Sharpe (30d) — mean/stddev of daily realized P&L over the last 30
    // calendar days ending on the most recent close, unannualized (days
    // with no trades count as a 0 return, standard for a return-series
    // Sharpe rather than only-active-days).
    let sharpe_30d = null
    if (chronological.length > 0) {
      const lastClose = new Date(chronological[chronological.length - 1].close_time)
      const dailyPnl = new Map()
      for (const t of chronological) {
        const closeDate = new Date(t.close_time)
        const daysAgo = Math.floor((lastClose - closeDate) / (1000 * 60 * 60 * 24))
        if (daysAgo < 0 || daysAgo >= 30) continue
        const dayKey = closeDate.toISOString().slice(0, 10)
        dailyPnl.set(dayKey, (dailyPnl.get(dayKey) || 0) + parseFloat(t.demo_pnl))
      }
      const returns = []
      for (let i = 0; i < 30; i++) {
        const d = new Date(lastClose.getTime() - i * 24 * 60 * 60 * 1000)
        returns.push(dailyPnl.get(d.toISOString().slice(0, 10)) || 0)
      }
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length
      const stddev = Math.sqrt(variance)
      sharpe_30d = stddev > 0 ? parseFloat((mean / stddev).toFixed(2)) : null
    }

    const pnlValues   = trades.map(t => parseFloat(t.demo_pnl))
    const best_trade  = parseFloat(pnlValues.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(2))
    const worst_trade = parseFloat(pnlValues.reduce((a, b) => Math.min(a, b),  Infinity).toFixed(2))

    const durations = trades
      .filter(t => t.open_time && t.close_time)
      .map(t => (new Date(t.close_time) - new Date(t.open_time)) / 1000 / 60)
    const avg_trade_duration_mins = durations.length
      ? parseFloat((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1))
      : 0

    let runningBalance = parseFloat(account.starting_balance)
    let peakBalance    = runningBalance
    const drawdown_curve = trades.map(t => {
      runningBalance += parseFloat(t.demo_pnl)
      peakBalance     = Math.max(peakBalance, runningBalance)
      const drawdown  = parseFloat(((peakBalance - runningBalance) / peakBalance * 100).toFixed(2))
      return {
        date:     t.close_time,
        balance:  parseFloat(runningBalance.toFixed(2)),
        drawdown: Math.max(0, drawdown)
      }
    })

    const activityHeatmap = buildActivityHeatmap(trades)
    const heatmap = activityHeatmap.hourly_summary.reduce((acc, slot) => {
      acc[`${slot.hour}:00`] = slot.total_pnl
      return acc
    }, {})

    const symbolBreakdown = buildPerformanceBreakdown(trades, (trade) => ({
      key: trade.instrument,
      label: trade.instrument,
      order: Number.MAX_SAFE_INTEGER
    }))
    const weekdayBreakdown = buildPerformanceBreakdown(trades, (trade) => {
      const openTime = toSafeDate(trade.open_time)
      const dayIndex = openTime ? openTime.getUTCDay() : 0
      return {
        key: ANALYTICS_WEEKDAY_LABELS[dayIndex],
        label: ANALYTICS_WEEKDAY_LABELS[dayIndex],
        order: ANALYTICS_WEEKDAY_ORDER.indexOf(dayIndex)
      }
    })
    const sessionBreakdown = buildPerformanceBreakdown(trades, (trade) => getAnalyticsSessionMeta(trade.open_time))

    const holdTime = buildHoldTimeAnalytics(trades, symbolBreakdown, [], tenantSettings.min_hold_seconds)
    const setupReport = buildSetupReports(symbolBreakdown, sessionBreakdown, [])
    const disciplineScore = buildDisciplineScore(trades, violations, tenantSettings)
    const riskConsistencyScore = buildRiskConsistencyScore(trades)
    const breachAnalysis = buildBreachAnalysis(account, trades, violations)
    const payoutForecast = buildPayoutForecast(account, userProfile, payoutRows, openTradeSummary, tenantSettings, trades)
    const improvementSuggestions = buildImprovementSuggestions({
      breakdowns: {
        symbol: symbolBreakdown,
        weekday: weekdayBreakdown,
        session: sessionBreakdown
      },
      holdTime,
      discipline: disciplineScore,
      riskConsistency: riskConsistencyScore,
      payoutForecast,
      setupReports: setupReport
    })
    const equityCurveRanges = buildEquityCurveRanges(drawdown_curve)

    res.json({
      account,
      analytics: {
        total_trades: trades.length,
        winning_trades: winners.length,
        losing_trades: losers.length,
        breakeven_trades: breakeven.length,
        win_rate,
        total_pnl: parseFloat(total_pnl.toFixed(2)),
        avg_win, avg_loss, profit_factor, avg_rr,
        avg_r_multiple, r_distribution,
        expectancy, best_win_streak, sharpe_30d,
        best_trade, worst_trade, avg_trade_duration_mins,
        drawdown_curve,
        equity_curve_ranges: equityCurveRanges,
        heatmap,
        activity_heatmap: activityHeatmap,
        breakdowns: {
          symbol: symbolBreakdown,
          weekday: weekdayBreakdown,
          session: sessionBreakdown
        },
        hold_time: holdTime,
        setup_report: setupReport,
        discipline_score: disciplineScore,
        risk_consistency_score: riskConsistencyScore,
        breach_analysis: breachAnalysis,
        payout_forecast: payoutForecast,
        improvement_suggestions: improvementSuggestions
      }
    })

  } catch (error) {
    logger.error('Analytics error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch analytics' })
  }
})

module.exports = router
