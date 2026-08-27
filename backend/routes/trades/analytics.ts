// GET /api/trades/analytics — trader-facing analytics payload.

import type {
  IsoTimestamp,
  JsonValue,
  LegacyErrorResponse,
  TraderAnalyticsAccountDto,
  TraderAnalyticsPayloadDto,
  TraderAnalyticsResponseDto
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import { z } from 'zod'
import pool = require('../../db')
import { getTenantSettings } from '../../services/tenantPolicyService'
import tradeShared = require('../../services/tradeShared')
import { ensureViolationTables } from '../../services/violationEngine'
import logger = require('../../utils/logger')
import { authenticateToken } from '../middleware'

type AnalyticsResponse = TraderAnalyticsResponseDto | LegacyErrorResponse
type AnalyticsRequest = ExpressRequest<
  Record<string, never>,
  AnalyticsResponse,
  unknown,
  Record<string, unknown>
>

interface AnalyticsAccountRow extends QueryResultRow {
  id: string
  user_id: string
  account_type: string
  account_size: string
  current_balance: string
  starting_balance: string
  peak_balance: string
  status: string
  profit_target: string | null
  max_drawdown_pct: string | null
  phase_start_date: Date | string | null
  phase_end_date: Date | string | null
  created_at: Date | string
  review_flag_reason: string | null
}

interface UserProfileRow extends QueryResultRow {
  id: string
  email: string
  kyc_status: string
}

interface OpenTradeSummaryRow extends QueryResultRow {
  open_count: number
  pending_count: number
}

interface AnalyticsPayoutRow extends QueryResultRow {
  status: string
  amount_requested: string
  amount_payable: string | null
  requested_at: Date | string
  paid_at: Date | string | null
}

interface ViolationRow extends QueryResultRow {
  violation_type: string
  severity: string
  status: string
  message: string
  hit_count: number
  last_detected_at: Date | string
}

interface ClosedTradeRow extends QueryResultRow {
  id: string
  account_id: string
  instrument: string
  direction: string
  lot_size: string
  open_price: string
  close_price: string | null
  stop_loss: string | null
  take_profit: string | null
  status: string
  demo_pnl: string
  open_time: Date | string | null
  close_time: Date | string | null
  close_reason: string | null
  order_type: string | null
}

interface BreakdownBucket {
  key: string
  label: string
  order: number
}

interface PerformanceBreakdown extends Record<string, JsonValue> {
  key: string
  label: string
  order: number
  trades: number
  wins: number
  losses: number
  total_pnl: number
  avg_pnl: number
  win_rate: number
  avg_hold_mins: number | null
}

interface ActivityHour extends Record<string, JsonValue> {
  hour: number
  total_pnl: number
}

interface ActivityHeatmap extends Record<string, JsonValue> {
  hourly_summary: ActivityHour[]
}

interface TradeAnalyticsApi {
  toSafeDate: (value: unknown) => Date | null
  getAnalyticsSessionMeta: (value: unknown) => BreakdownBucket
  buildPerformanceBreakdown: (
    trades: ClosedTradeRow[],
    bucketFactory: (trade: ClosedTradeRow) => BreakdownBucket
  ) => PerformanceBreakdown[]
  buildActivityHeatmap: (trades: ClosedTradeRow[]) => ActivityHeatmap
  buildEquityCurveRanges: (curve: JsonValue[]) => JsonValue
  buildHoldTimeAnalytics: (...values: unknown[]) => JsonValue
  buildDisciplineScore: (...values: unknown[]) => JsonValue
  buildRiskConsistencyScore: (...values: unknown[]) => JsonValue
  buildSetupReports: (...values: unknown[]) => JsonValue
  buildBreachAnalysis: (...values: unknown[]) => JsonValue
  buildPayoutForecast: (...values: unknown[]) => JsonValue
  buildImprovementSuggestions: (context: Record<string, unknown>) => JsonValue
  ANALYTICS_WEEKDAY_LABELS: readonly string[]
  ANALYTICS_WEEKDAY_ORDER: readonly number[]
}

interface CoreTradeMetrics {
  winners: ClosedTradeRow[]
  losers: ClosedTradeRow[]
  breakeven: ClosedTradeRow[]
  winRate: number
  totalPnl: number
  grossProfit: number
  grossLoss: number
  avgWin: number
  avgLoss: number
  profitFactor: number
  avgRr: number
  expectancy: number
}

interface AnalyticsTestApi {
  calculateCoreTradeMetrics: (trades: ClosedTradeRow[]) => CoreTradeMetrics
}

interface AnalyticsRouter extends Router {
  __test__: AnalyticsTestApi
}

const queryRecordSchema = z.record(z.string(), z.unknown())
const analytics = require('../../services/tradeAnalytics') as TradeAnalyticsApi
const { ensureTradeExperienceInfrastructure, computeRMultiple } = tradeShared
const router = express.Router() as AnalyticsRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function requestQuery(value: unknown): Record<string, unknown> {
  const parsed = queryRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function timestampValue(value: Date | string | null): IsoTimestamp | null {
  return value instanceof Date ? value.toISOString() : value
}

function mapAnalyticsAccount(row: AnalyticsAccountRow): TraderAnalyticsAccountDto {
  return {
    id: row.id,
    user_id: row.user_id,
    account_type: row.account_type,
    account_size: row.account_size,
    current_balance: row.current_balance,
    starting_balance: row.starting_balance,
    peak_balance: row.peak_balance,
    status: row.status,
    profit_target: row.profit_target,
    max_drawdown_pct: row.max_drawdown_pct,
    phase_start_date: timestampValue(row.phase_start_date),
    phase_end_date: timestampValue(row.phase_end_date),
    created_at: timestampValue(row.created_at) || '',
    review_flag_reason: row.review_flag_reason
  }
}

function pnl(trade: ClosedTradeRow): number {
  return Number.parseFloat(trade.demo_pnl)
}

function calculateCoreTradeMetrics(trades: ClosedTradeRow[]): CoreTradeMetrics {
  const winners = trades.filter((trade) => pnl(trade) > 0)
  const losers = trades.filter((trade) => pnl(trade) < 0)
  const breakeven = trades.filter((trade) => pnl(trade) === 0)
  const winRate = Number.parseFloat(((winners.length / trades.length) * 100).toFixed(1))
  const totalPnl = trades.reduce((sum, trade) => sum + pnl(trade), 0)
  const grossProfit = winners.reduce((sum, trade) => sum + pnl(trade), 0)
  const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + pnl(trade), 0))
  const avgWin = winners.length ? Number.parseFloat((grossProfit / winners.length).toFixed(2)) : 0
  const avgLoss = losers.length ? Number.parseFloat((grossLoss / losers.length).toFixed(2)) : 0
  const profitFactor = grossLoss > 0
    ? Number.parseFloat((grossProfit / grossLoss).toFixed(2))
    : grossProfit > 0 ? 999 : 0
  const avgRr = avgLoss > 0 ? Number.parseFloat((avgWin / avgLoss).toFixed(2)) : 0
  const expectancy = Number.parseFloat((totalPnl / trades.length).toFixed(2))
  return {
    winners,
    losers,
    breakeven,
    winRate,
    totalPnl,
    grossProfit,
    grossLoss,
    avgWin,
    avgLoss,
    profitFactor,
    avgRr,
    expectancy
  }
}

function emptyAnalytics(
  account: AnalyticsAccountRow,
  userProfile: UserProfileRow | { id: string; kyc_status: string },
  payoutRows: AnalyticsPayoutRow[],
  openTradeSummary: OpenTradeSummaryRow,
  violations: ViolationRow[],
  tenantSettings: Record<string, unknown>
): TraderAnalyticsPayloadDto {
  const symbol: PerformanceBreakdown[] = []
  const session: PerformanceBreakdown[] = []
  const holdTime = analytics.buildHoldTimeAnalytics([], symbol, [], tenantSettings.min_hold_seconds)
  const setupReport = analytics.buildSetupReports([], [], [])
  const discipline = analytics.buildDisciplineScore([], violations, tenantSettings)
  const riskConsistency = analytics.buildRiskConsistencyScore([])
  const payoutForecast = analytics.buildPayoutForecast(
    account,
    userProfile,
    payoutRows,
    openTradeSummary,
    tenantSettings,
    []
  )
  return {
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
    activity_heatmap: analytics.buildActivityHeatmap([]),
    breakdowns: { symbol, weekday: [], session },
    hold_time: holdTime,
    setup_report: setupReport,
    discipline_score: discipline,
    risk_consistency_score: riskConsistency,
    breach_analysis: analytics.buildBreachAnalysis(account, [], violations),
    payout_forecast: payoutForecast,
    improvement_suggestions: analytics.buildImprovementSuggestions({
      breakdowns: { session },
      holdTime,
      discipline,
      riskConsistency,
      payoutForecast,
      setupReports: setupReport
    })
  }
}

async function analyticsHandler(
  req: AnalyticsRequest,
  res: ExpressResponse<AnalyticsResponse>
): Promise<ExpressResponse<AnalyticsResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()
    await ensureViolationTables()
    const { account_id: accountId } = requestQuery(req.query)
    if (!accountId) return res.status(400).json({ error: 'account_id required' })
    const userId = authenticatedUserId(req)

    const accountResult = await pool.query<AnalyticsAccountRow>(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct,
              phase_start_date, phase_end_date, created_at, review_flag_reason
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [accountId, userId]
    )
    const account = accountResult.rows[0]
    if (!account) return res.status(404).json({ error: 'Account not found' })

    const [userResult, openSummaryResult, payoutResult, violationResult, tenantSettings] = await Promise.all([
      pool.query<UserProfileRow>(`SELECT id, email, kyc_status FROM users WHERE id = $1`, [userId]),
      pool.query<OpenTradeSummaryRow>(
        `SELECT COUNT(*) FILTER (WHERE status = 'open')::int AS open_count,
                COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
           FROM trades WHERE account_id = $1`,
        [accountId]
      ),
      pool.query<AnalyticsPayoutRow>(
        `SELECT status, amount_requested, amount_payable, requested_at, paid_at
           FROM payouts WHERE account_id = $1 ORDER BY requested_at DESC LIMIT 10`,
        [accountId]
      ),
      pool.query<ViolationRow>(
        `SELECT violation_type, severity, status, message, hit_count, last_detected_at
           FROM admin_rule_violations WHERE account_id = $1
          ORDER BY last_detected_at DESC LIMIT 25`,
        [String(accountId)]
      ),
      getTenantSettings([
        'profit_share_pct',
        'min_payout_amount',
        'payout_processing_days',
        'max_daily_trades',
        'min_hold_seconds'
      ])
    ])
    const userProfile = userResult.rows[0] || { id: userId, kyc_status: 'unknown' }
    const openTradeSummary = openSummaryResult.rows[0] || { open_count: 0, pending_count: 0 }
    const payoutRows = payoutResult.rows
    const violations = violationResult.rows
    const tradesResult = await pool.query<ClosedTradeRow>(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades WHERE account_id = $1 AND status = 'closed' ORDER BY close_time ASC`,
      [accountId]
    )
    const trades = tradesResult.rows
    if (trades.length === 0) {
      return res.json({
        account: mapAnalyticsAccount(account),
        analytics: emptyAnalytics(account, userProfile, payoutRows, openTradeSummary, violations, tenantSettings)
      })
    }

    const core = calculateCoreTradeMetrics(trades)
    const rMultiples = trades
      .map((trade) => computeRMultiple(trade))
      .filter((value): value is number => value !== null)
    const avgRMultiple = rMultiples.length
      ? Number.parseFloat((rMultiples.reduce((sum, value) => sum + value, 0) / rMultiples.length).toFixed(2))
      : null
    const rDistribution = rMultiples.map((value) => Number.parseFloat(value.toFixed(2)))

    const chronological = [...trades].sort((left, right) =>
      new Date(left.close_time || 0).getTime() - new Date(right.close_time || 0).getTime()
    )
    let bestWinStreak = 0
    let currentStreak = 0
    for (const trade of chronological) {
      if (pnl(trade) > 0) {
        currentStreak += 1
        bestWinStreak = Math.max(bestWinStreak, currentStreak)
      } else {
        currentStreak = 0
      }
    }

    let sharpe30d: number | null = null
    const lastTrade = chronological[chronological.length - 1]
    if (lastTrade) {
      const lastClose = new Date(lastTrade.close_time || 0)
      const dailyPnl = new Map<string, number>()
      for (const trade of chronological) {
        const closeDate = new Date(trade.close_time || 0)
        const daysAgo = Math.floor((lastClose.getTime() - closeDate.getTime()) / 86_400_000)
        if (daysAgo < 0 || daysAgo >= 30) continue
        const dayKey = closeDate.toISOString().slice(0, 10)
        dailyPnl.set(dayKey, (dailyPnl.get(dayKey) || 0) + pnl(trade))
      }
      const returns: number[] = []
      for (let index = 0; index < 30; index += 1) {
        const date = new Date(lastClose.getTime() - index * 86_400_000)
        returns.push(dailyPnl.get(date.toISOString().slice(0, 10)) || 0)
      }
      const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
      const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length
      const standardDeviation = Math.sqrt(variance)
      sharpe30d = standardDeviation > 0 ? Number.parseFloat((mean / standardDeviation).toFixed(2)) : null
    }

    const pnlValues = trades.map(pnl)
    const bestTrade = Number.parseFloat(Math.max(...pnlValues).toFixed(2))
    const worstTrade = Number.parseFloat(Math.min(...pnlValues).toFixed(2))
    const durations = trades
      .filter((trade) => trade.open_time && trade.close_time)
      .map((trade) =>
        (new Date(trade.close_time || 0).getTime() - new Date(trade.open_time || 0).getTime()) / 60_000
      )
    const averageDuration = durations.length
      ? Number.parseFloat((durations.reduce((sum, value) => sum + value, 0) / durations.length).toFixed(1))
      : 0

    let runningBalance = Number.parseFloat(account.starting_balance)
    let peakBalance = runningBalance
    const drawdownCurve: JsonValue[] = trades.map((trade) => {
      runningBalance += pnl(trade)
      peakBalance = Math.max(peakBalance, runningBalance)
      const drawdown = Number.parseFloat((((peakBalance - runningBalance) / peakBalance) * 100).toFixed(2))
      return {
        date: timestampValue(trade.close_time),
        balance: Number.parseFloat(runningBalance.toFixed(2)),
        drawdown: Math.max(0, drawdown)
      }
    })

    const activityHeatmap = analytics.buildActivityHeatmap(trades)
    const heatmap: { [hour: string]: number } = {}
    for (const slot of activityHeatmap.hourly_summary) heatmap[`${slot.hour}:00`] = slot.total_pnl
    const symbolBreakdown = analytics.buildPerformanceBreakdown(trades, (trade) => ({
      key: trade.instrument,
      label: trade.instrument,
      order: Number.MAX_SAFE_INTEGER
    }))
    const weekdayBreakdown = analytics.buildPerformanceBreakdown(trades, (trade) => {
      const openTime = analytics.toSafeDate(trade.open_time)
      const dayIndex = openTime ? openTime.getUTCDay() : 0
      const label = analytics.ANALYTICS_WEEKDAY_LABELS[dayIndex] || 'Sun'
      return { key: label, label, order: analytics.ANALYTICS_WEEKDAY_ORDER.indexOf(dayIndex) }
    })
    const sessionBreakdown = analytics.buildPerformanceBreakdown(
      trades,
      (trade) => analytics.getAnalyticsSessionMeta(trade.open_time)
    )
    const holdTime = analytics.buildHoldTimeAnalytics(
      trades,
      symbolBreakdown,
      [],
      tenantSettings.min_hold_seconds
    )
    const setupReport = analytics.buildSetupReports(symbolBreakdown, sessionBreakdown, [])
    const disciplineScore = analytics.buildDisciplineScore(trades, violations, tenantSettings)
    const riskConsistencyScore = analytics.buildRiskConsistencyScore(trades)
    const breachAnalysis = analytics.buildBreachAnalysis(account, trades, violations)
    const payoutForecast = analytics.buildPayoutForecast(
      account,
      userProfile,
      payoutRows,
      openTradeSummary,
      tenantSettings,
      trades
    )
    const improvementSuggestions = analytics.buildImprovementSuggestions({
      breakdowns: { symbol: symbolBreakdown, weekday: weekdayBreakdown, session: sessionBreakdown },
      holdTime,
      discipline: disciplineScore,
      riskConsistency: riskConsistencyScore,
      payoutForecast,
      setupReports: setupReport
    })

    return res.json({
      account: mapAnalyticsAccount(account),
      analytics: {
        total_trades: trades.length,
        winning_trades: core.winners.length,
        losing_trades: core.losers.length,
        breakeven_trades: core.breakeven.length,
        win_rate: core.winRate,
        total_pnl: Number.parseFloat(core.totalPnl.toFixed(2)),
        avg_win: core.avgWin,
        avg_loss: core.avgLoss,
        profit_factor: core.profitFactor,
        avg_rr: core.avgRr,
        avg_r_multiple: avgRMultiple,
        r_distribution: rDistribution,
        expectancy: core.expectancy,
        best_win_streak: bestWinStreak,
        sharpe_30d: sharpe30d,
        best_trade: bestTrade,
        worst_trade: worstTrade,
        avg_trade_duration_mins: averageDuration,
        drawdown_curve: drawdownCurve,
        equity_curve_ranges: analytics.buildEquityCurveRanges(drawdownCurve),
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
  } catch (error: unknown) {
    logger.error('Analytics error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch analytics' })
  }
}

router.get('/analytics', authenticateToken as RequestHandler, analyticsHandler)
router.__test__ = { calculateCoreTradeMetrics }

export = router
