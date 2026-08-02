const express = require('express')
const router = express.Router()
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateAdmin } = require('./middleware')
const { calcTradePnl, getExposureData } = require('./admin')._internals

// New sibling router for the Admin Analytics section — mirrors the
// adminViolations.js precedent (separate file, mounted at /api/admin)
// rather than growing the already-9000-line admin.js further. All routes
// use plain authenticateAdmin, matching the existing dashboard/reporting
// endpoints (/overview, /signup-trends) which have no extra capability gate.

function round(value, decimals = 2) {
  const factor = 10 ** decimals
  return Math.round((Number(value) || 0) * factor) / factor
}

function computeTraderStats({ userId, email, fullName, trades }) {
  const pnls = trades.map((t) => parseFloat(t.demo_pnl) || 0)
  const winners = pnls.filter((p) => p > 0)
  const losers = pnls.filter((p) => p < 0)

  const winRate = trades.length ? (winners.length / trades.length) * 100 : 0
  const grossProfit = winners.reduce((sum, p) => sum + p, 0)
  const grossLoss = Math.abs(losers.reduce((sum, p) => sum + p, 0))
  const avgWin = winners.length ? grossProfit / winners.length : 0
  const avgLoss = losers.length ? grossLoss / losers.length : 0
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0)
  const riskReward = avgLoss > 0 ? avgWin / avgLoss : 0

  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0
  for (const p of pnls) {
    if (p > 0) { curWin += 1; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin) }
    else if (p < 0) { curLoss += 1; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss) }
    else { curWin = 0; curLoss = 0 }
  }

  const durations = trades
    .filter((t) => t.open_time && t.close_time)
    .map((t) => (new Date(t.close_time) - new Date(t.open_time)) / 60000)
  const avgDurationMin = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0

  // Consistency score: a simple bounded proxy off the coefficient of
  // variation of per-trade PnL — not the same formula as the trader-facing
  // /api/trades/analytics risk-consistency score (that one factors in lot
  // size/planned risk via private helpers scoped to trades.js), just a
  // lighter platform-wide stand-in with the same "higher = steadier" intent.
  const mean = pnls.length ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0
  const variance = pnls.length ? pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / pnls.length : 0
  const stdDev = Math.sqrt(variance)
  const cv = mean !== 0 ? Math.abs(stdDev / mean) : (stdDev > 0 ? 1 : 0)
  const consistency = Math.max(0, Math.min(100, 100 - cv * 40))

  let running = 0
  const equityCurve = trades.map((t) => {
    running += parseFloat(t.demo_pnl) || 0
    return { date: t.close_time, equity: round(running) }
  })

  return {
    traderId: userId,
    email,
    fullName,
    totalTrades: trades.length,
    winRate: round(winRate, 1),
    riskReward: round(riskReward),
    profitFactor: round(profitFactor),
    consistency: round(consistency, 1),
    maxWinStreak,
    maxLossStreak,
    avgDurationMin: round(avgDurationMin, 1),
    avgWin: round(avgWin),
    avgLoss: round(-avgLoss),
    equityCurve,
  }
}

// TODO: paginate/limit once trade volume is meaningful — fine unfiltered for now.
router.get('/analytics/trader-performance', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.user_id, u.email, u.full_name, t.demo_pnl, t.open_time, t.close_time
        FROM trades t
        JOIN accounts a ON a.id = t.account_id
        JOIN users u ON u.id = a.user_id
       WHERE t.status = 'closed'
       ORDER BY a.user_id, t.close_time ASC
    `)

    const byUser = new Map()
    for (const row of result.rows) {
      if (!byUser.has(row.user_id)) {
        byUser.set(row.user_id, { userId: row.user_id, email: row.email, fullName: row.full_name, trades: [] })
      }
      byUser.get(row.user_id).trades.push(row)
    }

    const rows = Array.from(byUser.values()).map(computeTraderStats)
    res.json({ rows })
  } catch (err) {
    logger.error('Trader performance analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load trader performance' })
  }
})

// Account status distribution + per-account daily drawdown trend. The
// violation LOG itself reuses the existing GET /api/admin/violations
// endpoint (adminViolations.js) rather than duplicating it here.
router.get('/analytics/risk-overview', authenticateAdmin, async (req, res) => {
  try {
    const statusCounts = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('failed', 'locked'))::int AS breached,
        COUNT(*) FILTER (WHERE review_flagged = true AND status NOT IN ('failed', 'locked'))::int AS warned,
        COUNT(*) FILTER (WHERE status NOT IN ('failed', 'locked') AND review_flagged IS NOT TRUE)::int AS clean
      FROM accounts
    `)

    const accountsResult = await pool.query(`
      SELECT id, user_id, current_balance, starting_balance, peak_balance, max_drawdown_pct, status, review_flagged
        FROM accounts
       WHERE status = 'active'
       ORDER BY (peak_balance - current_balance) / NULLIF(peak_balance, 0) DESC NULLS LAST
       LIMIT 100
    `)
    const accounts = accountsResult.rows

    const tradesByAccount = new Map()
    if (accounts.length > 0) {
      const accountIds = accounts.map((a) => a.id)
      const tradesResult = await pool.query(
        `SELECT account_id, demo_pnl, close_time
           FROM trades
          WHERE account_id = ANY($1::uuid[]) AND status = 'closed' AND close_time >= NOW() - INTERVAL '14 days'
          ORDER BY account_id, close_time ASC`,
        [accountIds]
      )
      for (const row of tradesResult.rows) {
        if (!tradesByAccount.has(row.account_id)) tradesByAccount.set(row.account_id, [])
        tradesByAccount.get(row.account_id).push(row)
      }
    }

    const rows = accounts.map((a) => {
      const trades = tradesByAccount.get(a.id) || []
      let running = parseFloat(a.starting_balance) || 0
      let peak = running
      const byDay = new Map()
      for (const t of trades) {
        running += parseFloat(t.demo_pnl) || 0
        peak = Math.max(peak, running)
        const day = new Date(t.close_time).toISOString().slice(0, 10)
        byDay.set(day, peak > 0 ? ((peak - running) / peak) * 100 : 0)
      }
      const ddTrend = Array.from(byDay.entries()).map(([day, value]) => ({ day, value: round(value, 1) }))

      const peakBalance = parseFloat(a.peak_balance) || 0
      const currentDD = peakBalance > 0 ? ((peakBalance - (parseFloat(a.current_balance) || 0)) / peakBalance) * 100 : 0
      const status = a.review_flagged ? 'Warned' : (['failed', 'locked'].includes(a.status) ? 'Breached' : 'Clean')

      return {
        accountId: a.id,
        userId: a.user_id,
        currentDD: round(currentDD, 1),
        maxAllowedDD: round(a.max_drawdown_pct, 1),
        status,
        ddTrend,
      }
    })

    res.json({ statusCounts: statusCounts.rows[0] || { breached: 0, warned: 0, clean: 0 }, accounts: rows })
  } catch (err) {
    logger.error('Risk overview analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load risk overview' })
  }
})

// Firm-level fees/payouts (date-range filtered) + per-model economics. Note:
// "cost per funded trader" from the original spec has no real data source
// (no acquisition-cost/marketing-spend ledger exists anywhere in this
// schema) — it comes back null rather than being fabricated; avg trader LTV
// IS real (revenue collected minus payouts paid, per funded trader).
router.get('/analytics/firm-profitability', authenticateAdmin, async (req, res) => {
  try {
    const conditions = ["status = 'paid'"]
    const values = []
    if (req.query.from) {
      values.push(String(req.query.from))
      conditions.push(`paid_at >= $${values.length}::timestamptz`)
    }
    if (req.query.to) {
      values.push(String(req.query.to))
      conditions.push(`paid_at < ($${values.length}::timestamptz + INTERVAL '1 day')`)
    }
    const dateWhere = conditions.join(' AND ')

    const [feesResult, payoutsResult, modelsResult, revenueByModelResult, payoutsByModelResult, accountCountsResult] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM challenge_orders WHERE ${dateWhere}`, values),
      pool.query(`SELECT COALESCE(SUM(amount_payable), 0) AS total FROM payouts WHERE ${dateWhere}`, values),
      pool.query(`SELECT slug, name FROM challenge_models ORDER BY display_order ASC`),
      pool.query(`SELECT challenge_model_slug AS slug, COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS revenue FROM challenge_orders GROUP BY challenge_model_slug`),
      pool.query(`
        SELECT a.challenge_model_slug AS slug, COALESCE(SUM(p.amount_payable) FILTER (WHERE p.status = 'paid'), 0) AS payouts
          FROM payouts p JOIN accounts a ON a.id = p.account_id
         GROUP BY a.challenge_model_slug
      `),
      pool.query(`
        SELECT challenge_model_slug AS slug,
               COUNT(*) FILTER (WHERE status IN ('passed', 'funded'))::int AS passed,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
               COUNT(*) FILTER (WHERE account_type = 'funded')::int AS funded_count
          FROM accounts
         GROUP BY challenge_model_slug
      `),
    ])

    const revenueBySlug = new Map(revenueByModelResult.rows.map((r) => [r.slug, parseFloat(r.revenue) || 0]))
    const payoutsBySlug = new Map(payoutsByModelResult.rows.map((r) => [r.slug, parseFloat(r.payouts) || 0]))
    const countsBySlug = new Map(accountCountsResult.rows.map((r) => [r.slug, r]))

    const models = modelsResult.rows.map((m) => {
      const counts = countsBySlug.get(m.slug) || { passed: 0, failed: 0, funded_count: 0 }
      const revenue = revenueBySlug.get(m.slug) || 0
      const payouts = payoutsBySlug.get(m.slug) || 0
      const passRate = (counts.passed + counts.failed) > 0 ? (counts.passed / (counts.passed + counts.failed)) * 100 : 0
      const avgLtv = counts.funded_count > 0 ? (revenue - payouts) / counts.funded_count : 0
      return {
        model: m.name,
        slug: m.slug,
        passRate: round(passRate, 1),
        fundedCount: counts.funded_count,
        costPerFundedTrader: null, // no acquisition-cost ledger exists — not fabricated
        avgLtv: round(avgLtv),
      }
    })

    res.json({
      totalFees: round(feesResult.rows[0]?.total),
      totalPayouts: round(payoutsResult.rows[0]?.total),
      models,
    })
  } catch (err) {
    logger.error('Firm profitability analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load firm profitability' })
  }
})

// Funnel & Conversion. Acquisition funnel: Visitors is real (the new
// marketing_funnel_events table, populated by the Landing page tracking
// call added alongside this), Signups/Purchases are real (users/
// challenge_orders). Challenge funnel, phase timing, retry rate, and
// conversion-by-tier are all real, derived from accounts/challenge_orders.
router.get('/analytics/funnel', authenticateAdmin, async (req, res) => {
  try {
    const [visitorsResult, signupsResult, purchasesResult, challengeFunnelResult, phaseTimingResult, retryResult, conversionByTierResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS count FROM marketing_funnel_events WHERE event_type = 'visit'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM users`),
      pool.query(`SELECT COUNT(*)::int AS count FROM challenge_orders WHERE status = 'paid'`),
      pool.query(`
        SELECT
          COUNT(DISTINCT user_id)::int AS started,
          COUNT(DISTINCT user_id) FILTER (WHERE account_type IN ('phase2', 'phase3', 'funded'))::int AS phase1_pass,
          COUNT(DISTINCT user_id) FILTER (WHERE account_type IN ('phase3', 'funded'))::int AS phase2_pass,
          COUNT(DISTINCT user_id) FILTER (WHERE account_type = 'funded')::int AS funded
        FROM accounts
      `),
      pool.query(`
        SELECT account_type,
               AVG(EXTRACT(EPOCH FROM (phase_end_date - phase_start_date)) / 86400) FILTER (WHERE status = 'passed') AS avg_days_to_pass,
               AVG(EXTRACT(EPOCH FROM (phase_end_date - phase_start_date)) / 86400) FILTER (WHERE status = 'failed') AS avg_days_to_fail
          FROM accounts
         WHERE phase_start_date IS NOT NULL AND phase_end_date IS NOT NULL
         GROUP BY account_type
      `),
      pool.query(`
        SELECT account_type,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
               COUNT(*) FILTER (WHERE parent_account_id IS NOT NULL)::int AS retry_count
          FROM accounts
         GROUP BY account_type
      `),
      pool.query(`
        SELECT account_size,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE status = 'paid')::int AS paid
          FROM challenge_orders
         GROUP BY account_size
         ORDER BY account_size ASC
      `),
    ])

    const challengeFunnelRow = challengeFunnelResult.rows[0] || { started: 0, phase1_pass: 0, phase2_pass: 0, funded: 0 }

    const phaseTiming = phaseTimingResult.rows.map((r) => {
      const retry = retryResult.rows.find((x) => x.account_type === r.account_type) || { failed_count: 0, retry_count: 0 }
      return {
        phase: r.account_type,
        avgDaysToPass: round(r.avg_days_to_pass, 1),
        avgDaysToFail: round(r.avg_days_to_fail, 1),
        retryRate: retry.failed_count > 0 ? round((retry.retry_count / retry.failed_count) * 100, 1) : 0,
      }
    })

    const conversionByTier = conversionByTierResult.rows.map((r) => ({
      tier: `$${Number(r.account_size).toLocaleString()}`,
      conversionRate: r.total > 0 ? round((r.paid / r.total) * 100, 1) : 0,
    }))

    res.json({
      acquisitionFunnel: [
        { stage: 'Visitors', count: visitorsResult.rows[0]?.count || 0 },
        { stage: 'Signups', count: signupsResult.rows[0]?.count || 0 },
        { stage: 'Purchases', count: purchasesResult.rows[0]?.count || 0 },
      ],
      challengeFunnel: [
        { stage: 'Challenge Start', count: challengeFunnelRow.started },
        { stage: 'Phase 1 Pass', count: challengeFunnelRow.phase1_pass },
        { stage: 'Phase 2 Pass', count: challengeFunnelRow.phase2_pass },
        { stage: 'Funded', count: challengeFunnelRow.funded },
      ],
      phaseTiming,
      conversionByTier,
    })
  } catch (err) {
    logger.error('Funnel analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load funnel analytics' })
  }
})

function pearsonCorrelation(seriesA, seriesB) {
  const n = seriesA.length
  if (n < 3) return null // not enough overlapping days to mean anything
  const meanA = seriesA.reduce((s, v) => s + v, 0) / n
  const meanB = seriesB.reduce((s, v) => s + v, 0) / n
  let num = 0, denomA = 0, denomB = 0
  for (let i = 0; i < n; i++) {
    const da = seriesA[i] - meanA
    const db = seriesB[i] - meanB
    num += da * db
    denomA += da * da
    denomB += db * db
  }
  const denom = Math.sqrt(denomA * denomB)
  return denom > 0 ? num / denom : 0
}

const OVERTRADING_THRESHOLD = 35 // trades/day
const COPY_TRADING_THRESHOLD = 0.85

router.get('/analytics/trade-behavior', authenticateAdmin, async (req, res) => {
  try {
    // Bounded to the most recent 5000 closed trades — this is JS-side
    // aggregation (correlation/frequency need cross-trade grouping that
    // doesn't reduce cleanly to a single SQL query), fine at current volume,
    // would need a real windowing/pagination pass once trade volume grows.
    const result = await pool.query(`
      SELECT a.user_id, u.email, u.full_name, t.lot_size, t.demo_pnl, t.instrument, t.open_time, t.close_time
        FROM trades t
        JOIN accounts a ON a.id = t.account_id
        JOIN users u ON u.id = a.user_id
       WHERE t.status = 'closed'
       ORDER BY t.close_time DESC
       LIMIT 5000
    `)
    const trades = result.rows

    // Lot size histogram
    const buckets = [
      { bucket: '0–0.5', min: 0, max: 0.5, count: 0 },
      { bucket: '0.5–1', min: 0.5, max: 1, count: 0 },
      { bucket: '1–2', min: 1, max: 2, count: 0 },
      { bucket: '2–3', min: 2, max: 3, count: 0 },
      { bucket: '3–5', min: 3, max: 5, count: 0 },
      { bucket: '5+', min: 5, max: Infinity, count: 0 },
    ]
    for (const t of trades) {
      const lots = parseFloat(t.lot_size) || 0
      const b = buckets.find((x) => lots >= x.min && lots < x.max) || buckets[buckets.length - 1]
      b.count += 1
    }
    const lotHistogram = buckets.map(({ bucket, count }) => ({ bucket, count }))

    // Per-user grouping
    const byUser = new Map()
    for (const t of trades) {
      if (!byUser.has(t.user_id)) byUser.set(t.user_id, { userId: t.user_id, email: t.email, fullName: t.full_name, trades: [] })
      byUser.get(t.user_id).trades.push(t)
    }

    const tradeFrequency = []
    const dailyPnlByUser = new Map() // userId -> Map(day -> pnl)
    const profitSpikes = []

    for (const u of byUser.values()) {
      const uTrades = u.trades
      const days = new Set(uTrades.map((t) => new Date(t.close_time).toISOString().slice(0, 10)))
      const tradesPerDay = days.size > 0 ? round(uTrades.length / days.size, 1) : 0

      const durations = uTrades
        .filter((t) => t.open_time && t.close_time)
        .map((t) => (new Date(t.close_time) - new Date(t.open_time)) / 60000)
      const avgDurationMin = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0
      const strategy = avgDurationMin < 15 ? 'Scalping' : avgDurationMin <= 120 ? 'Intraday' : 'Swing'

      tradeFrequency.push({
        userId: u.userId,
        email: u.email,
        fullName: u.fullName,
        tradesPerDay,
        avgDurationMin: round(avgDurationMin, 1),
        strategy,
        overtrading: tradesPerDay > OVERTRADING_THRESHOLD,
      })

      // Daily PnL series (for correlation)
      const dayMap = new Map()
      for (const t of uTrades) {
        const day = new Date(t.close_time).toISOString().slice(0, 10)
        dayMap.set(day, (dayMap.get(day) || 0) + (parseFloat(t.demo_pnl) || 0))
      }
      dailyPnlByUser.set(u.userId, dayMap)

      // Profit spike detection — trade PnL vs. this trader's own trailing
      // average (excluding the trade itself), only meaningful with >=5 trades.
      if (uTrades.length >= 5) {
        const pnls = uTrades.map((t) => parseFloat(t.demo_pnl) || 0)
        const total = pnls.reduce((a, b) => a + b, 0)
        uTrades.forEach((t, i) => {
          const pnl = pnls[i]
          const othersAvg = (total - pnl) / (pnls.length - 1)
          if (pnl > 0 && othersAvg > 0 && pnl >= othersAvg * 5) {
            profitSpikes.push({
              userId: u.userId,
              instrument: t.instrument,
              tradePnl: round(pnl),
              avgHistoricalPnl: round(othersAvg),
              timestamp: t.close_time,
            })
          }
        })
      }
    }

    // Correlation matrix — pairwise Pearson correlation over days both
    // traders were active (intersection), &gt;=3 overlapping days required.
    const userIds = Array.from(byUser.keys())
    const matrix = userIds.map((idA) => userIds.map((idB) => {
      if (idA === idB) return 1
      const mapA = dailyPnlByUser.get(idA)
      const mapB = dailyPnlByUser.get(idB)
      const commonDays = Array.from(mapA.keys()).filter((d) => mapB.has(d))
      const seriesA = commonDays.map((d) => mapA.get(d))
      const seriesB = commonDays.map((d) => mapB.get(d))
      const corr = pearsonCorrelation(seriesA, seriesB)
      return corr === null ? 0 : round(corr, 2)
    }))

    const copyTradingFlags = []
    for (let i = 0; i < userIds.length; i++) {
      for (let j = i + 1; j < userIds.length; j++) {
        if (matrix[i][j] >= COPY_TRADING_THRESHOLD) {
          copyTradingFlags.push({ userIdA: userIds[i], userIdB: userIds[j], correlation: matrix[i][j] })
        }
      }
    }

    // Session timing — volume by hour of day (UTC)
    const hourCounts = Array.from({ length: 24 }, () => 0)
    for (const t of trades) {
      if (t.open_time) hourCounts[new Date(t.open_time).getUTCHours()] += 1
    }
    const sessionTiming = hourCounts.map((volume, hour) => ({ hour: `${String(hour).padStart(2, '0')}:00`, volume }))

    res.json({
      lotHistogram,
      tradeFrequency,
      userIds,
      correlationMatrix: matrix,
      copyTradingFlags,
      profitSpikes,
      sessionTiming,
    })
  } catch (err) {
    logger.error('Trade behavior analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load trade behavior analytics' })
  }
})

const RISK_CONCENTRATION_THRESHOLD = 0.3 // flag when one instrument holds >30% of total open lots

// Real-Time Monitoring — polled by the frontend every ~5s (per your call,
// no new socket-push infrastructure). Reuses the exact live-PnL calculation
// (calcTradePnl) and per-instrument exposure aggregation (getExposureData)
// admin.js already uses for its own /trades grid and dashboard exposure card.
router.get('/analytics/open-positions', authenticateAdmin, async (req, res) => {
  try {
    const { exposureData, total_open_trades, total_floating_pnl } = await getExposureData(pool)

    const [positionsResult, pricesResult, activeAccountsResult, totalActiveResult] = await Promise.all([
      pool.query(`
        SELECT t.id, a.user_id, u.email, u.full_name, t.instrument, t.direction, t.lot_size, t.open_price
          FROM trades t
          JOIN accounts a ON a.id = t.account_id
          JOIN users u ON u.id = a.user_id
         WHERE t.status = 'open'
         ORDER BY t.open_time DESC
         LIMIT 200
      `),
      pool.query(`SELECT instrument, bid, ask FROM price_feed`),
      pool.query(`SELECT COUNT(DISTINCT account_id)::int AS count FROM trades WHERE status = 'open'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM accounts WHERE status = 'active'`),
    ])

    const priceMap = new Map(pricesResult.rows.map((p) => [p.instrument, p]))
    const positions = positionsResult.rows.map((t) => {
      const priceData = priceMap.get(t.instrument)
      let pnl = 0
      if (priceData) {
        const currentPrice = t.direction === 'buy' ? parseFloat(priceData.bid) : parseFloat(priceData.ask)
        pnl = calcTradePnl(t.direction, parseFloat(t.open_price), currentPrice, parseFloat(t.lot_size), t.instrument)
      }
      return {
        id: t.id,
        userId: t.user_id,
        email: t.email,
        fullName: t.full_name,
        instrument: t.instrument,
        direction: String(t.direction).toUpperCase(),
        lots: parseFloat(t.lot_size),
        entryPrice: parseFloat(t.open_price),
        pnl: round(pnl),
      }
    })

    const activeAccounts = activeAccountsResult.rows[0]?.count || 0
    const totalActiveAccounts = totalActiveResult.rows[0]?.count || 0
    const idleAccounts = Math.max(0, totalActiveAccounts - activeAccounts)

    const totalLots = exposureData.reduce((sum, e) => sum + e.buy_lots + e.sell_lots, 0)
    const riskAlerts = exposureData
      .map((e) => ({ instrument: e.instrument, share: totalLots > 0 ? (e.buy_lots + e.sell_lots) / totalLots : 0 }))
      .filter((e) => e.share > RISK_CONCENTRATION_THRESHOLD)
      .map((e) => ({ instrument: e.instrument, share: round(e.share * 100, 1) }))

    res.json({
      totalFloatingPnl: round(total_floating_pnl),
      openPositionsCount: total_open_trades,
      activeAccounts,
      idleAccounts,
      positions,
      exposure: exposureData.map((e) => ({ instrument: e.instrument, buyLots: e.buy_lots, sellLots: e.sell_lots })),
      riskAlerts,
    })
  } catch (err) {
    logger.error('Open positions analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load open positions' })
  }
})

// Difficulty is a derived composite off each model's actual seeded rules
// (backend/utils/stepModels.js) — not fabricated: sum of profit targets +
// step count. With this firm's current rule set, drawdown/consistency are
// identical across all 3 models (see stepModels.js), so profit-target load
// and phase count are the only real differentiators.
function computeDifficultyScore(model) {
  const targets = Array.isArray(model.profit_targets_pct) ? model.profit_targets_pct : []
  const targetSum = targets.reduce((sum, v) => sum + (parseFloat(v) || 0), 0)
  return round(targetSum / 4 + (model.steps || 1) * 1.5, 1)
}

router.get('/analytics/model-optimization', authenticateAdmin, async (req, res) => {
  try {
    const [modelsResult, accountCountsResult, revenueByModelResult, retentionResult, revenueBySegmentResult, failureReasonsResult, abExperimentsResult] = await Promise.all([
      pool.query(`SELECT id, slug, name, steps, profit_targets_pct, max_drawdown_pct, consistency_max_day_pct FROM challenge_models ORDER BY display_order ASC`),
      pool.query(`
        SELECT challenge_model_slug AS slug,
               COUNT(*) FILTER (WHERE status IN ('passed', 'funded'))::int AS passed,
               COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
          FROM accounts
         GROUP BY challenge_model_slug
      `),
      pool.query(`SELECT challenge_model_slug AS slug, COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0) AS revenue FROM challenge_orders GROUP BY challenge_model_slug`),
      pool.query(`
        SELECT challenge_model_slug AS slug,
               AVG(EXTRACT(EPOCH FROM (COALESCE(phase_end_date, NOW()) - created_at)) / 86400) AS avg_retention_days,
               (COUNT(*) FILTER (WHERE status IN ('active', 'passed', 'funded'))::float / NULLIF(COUNT(*), 0)) * 100 AS retention_rate
          FROM accounts
         GROUP BY challenge_model_slug
      `),
      pool.query(`
        SELECT COALESCE(u.signup_source, 'unknown') AS segment, COALESCE(SUM(o.amount), 0) AS revenue
          FROM challenge_orders o
          JOIN users u ON u.id::text = o.user_id
         WHERE o.status = 'paid'
         GROUP BY COALESCE(u.signup_source, 'unknown')
         ORDER BY revenue DESC
      `),
      pool.query(`
        SELECT COALESCE(v.violation_type, 'Unspecified') AS reason, COUNT(*)::int AS count
          FROM accounts a
          LEFT JOIN LATERAL (
            SELECT violation_type FROM admin_rule_violations
             WHERE account_id = a.id::text
             ORDER BY last_detected_at DESC LIMIT 1
          ) v ON true
         WHERE a.status = 'failed'
         GROUP BY COALESCE(v.violation_type, 'Unspecified')
         ORDER BY count DESC
      `),
      pool.query(`
        SELECT e.key, e.name, e.outcome_metric, e.created_at,
               COUNT(DISTINCT ev.variant_key)::int AS variant_count,
               COUNT(ev.id)::int AS sample_size
          FROM ab_experiments e
          LEFT JOIN ab_experiment_events ev ON ev.experiment_key = e.key
         GROUP BY e.key, e.name, e.outcome_metric, e.created_at
         ORDER BY e.created_at DESC
      `),
    ])

    const countsBySlug = new Map(accountCountsResult.rows.map((r) => [r.slug, r]))
    const revenueBySlug = new Map(revenueByModelResult.rows.map((r) => [r.slug, parseFloat(r.revenue) || 0]))
    const retentionBySlug = new Map(retentionResult.rows.map((r) => [r.slug, r]))

    const passRateVsPricing = [] // populated below alongside pricing lookup
    const difficultyVsRevenue = []
    const strictnessVsRetention = []

    for (const m of modelsResult.rows) {
      const counts = countsBySlug.get(m.slug) || { passed: 0, failed: 0 }
      const passRate = (counts.passed + counts.failed) > 0 ? (counts.passed / (counts.passed + counts.failed)) * 100 : 0
      const difficulty = computeDifficultyScore(m)
      const retention = retentionBySlug.get(m.slug) || { avg_retention_days: 0, retention_rate: 0 }

      difficultyVsRevenue.push({ model: m.name, difficulty, revenue: round(revenueBySlug.get(m.slug) || 0) })
      strictnessVsRetention.push({
        ruleSet: m.name,
        strictness: difficulty,
        avgRetentionDays: round(retention.avg_retention_days, 1),
        retentionRate: round(retention.retention_rate, 1),
      })

      // Pricing tiers for this model
      const pricingResult = await pool.query(
        `SELECT account_size, price FROM challenge_model_pricing WHERE challenge_model_id = $1 AND is_active = true ORDER BY account_size ASC`,
        [m.id]
      )
      for (const p of pricingResult.rows) {
        passRateVsPricing.push({ tier: `${m.name} $${Number(p.account_size).toLocaleString()}`, price: parseFloat(p.price), passRate: round(passRate, 1) })
      }
    }

    res.json({
      passRateVsPricing,
      difficultyVsRevenue,
      strictnessVsRetention,
      abTests: abExperimentsResult.rows.map((r) => ({
        variant: r.name,
        sampleSize: r.sample_size,
        outcomeMetric: r.outcome_metric || '—',
        // No statistical-significance computation exists — this ships as
        // real infrastructure only, no experiment is running yet.
        resultValue: '—',
        significant: null,
      })),
      revenueBySegment: revenueBySegmentResult.rows.map((r) => ({ segment: r.segment, revenue: round(r.revenue) })),
      failurePatterns: failureReasonsResult.rows.map((r) => ({ reason: r.reason, count: r.count })),
    })
  } catch (err) {
    logger.error('Model optimization analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load model optimization analytics' })
  }
})

// Compliance & Audit — read-only historical logs, all real:
// - Trade log: closed trades (trades + accounts + users)
// - Rule violation history: all admin_rule_violations (open + resolved)
// - Payout history: payouts
// - Account activity: admin_immutable_audit (same real table the Support &
//   Appeals Center's Compliance Log section already uses)
// - Suspicious activity (resolved): the resolved subset of
//   admin_rule_violations — narrower record-keeping view of the same table,
//   not a separate fabricated feed (copy-trading/profit-spike signals from
//   the Trade Behavior tab are computed on the fly and never persisted, so
//   there's nothing to show here with a reviewer/resolution attached).
router.get('/analytics/compliance-audit', authenticateAdmin, async (req, res) => {
  try {
    const from = req.query.from ? String(req.query.from) : null
    const to = req.query.to ? String(req.query.to) : null
    const dateFilter = (column) => {
      const conditions = []
      const values = []
      if (from) { values.push(from); conditions.push(`${column} >= $${values.length}::timestamptz`) }
      if (to) { values.push(to); conditions.push(`${column} < ($${values.length}::timestamptz + INTERVAL '1 day')`) }
      return { where: conditions.length ? `AND ${conditions.join(' AND ')}` : '', values }
    }

    const tradeDate = dateFilter('t.close_time')
    const violationDate = dateFilter('v.first_detected_at')
    const payoutDate = dateFilter('p.paid_at')
    const auditDate = dateFilter('created_at')
    const suspiciousDate = dateFilter('resolved_at')

    const [tradeLogResult, violationHistoryResult, payoutHistoryResult, accountActivityResult, suspiciousResult, kycProcessingTimeResult] = await Promise.all([
      pool.query(
        `SELECT u.email, u.full_name, t.instrument, t.direction, t.lot_size, t.demo_pnl, t.close_time
           FROM trades t
           JOIN accounts a ON a.id = t.account_id
           JOIN users u ON u.id = a.user_id
          WHERE t.status = 'closed' ${tradeDate.where}
          ORDER BY t.close_time DESC
          LIMIT 500`,
        tradeDate.values
      ),
      pool.query(
        `SELECT v.user_id, v.violation_type, v.status, v.resolution_type, v.first_detected_at
           FROM admin_rule_violations v
          WHERE 1=1 ${violationDate.where}
          ORDER BY v.first_detected_at DESC
          LIMIT 500`,
        violationDate.values
      ),
      pool.query(
        `SELECT p.user_id, p.amount_payable, p.status, p.payment_method, p.paid_at, p.requested_at
           FROM payouts p
          WHERE 1=1 ${payoutDate.where}
          ORDER BY COALESCE(p.paid_at, p.requested_at) DESC
          LIMIT 500`,
        payoutDate.values
      ),
      pool.query(
        `SELECT actor, event_type, entity_type, entity_id, created_at
           FROM admin_immutable_audit
          WHERE 1=1 ${auditDate.where}
          ORDER BY created_at DESC
          LIMIT 500`,
        auditDate.values
      ),
      pool.query(
        `SELECT user_id, violation_type, first_detected_at, resolved_at, resolution_type
           FROM admin_rule_violations
          WHERE status = 'resolved' ${suspiciousDate.where}
          ORDER BY resolved_at DESC
          LIMIT 500`,
        suspiciousDate.values
      ),
      // Average time from KYC submission to decision. Uses each user's most
      // recent kyc_approved/kyc_rejected audit entry — the only decision
      // timestamp available (users.kyc_submitted_at has no history table) —
      // and only counts pairs where the decision happened after the current
      // submission, to avoid negative durations after a resubmission.
      pool.query(
        `SELECT EXTRACT(EPOCH FROM (latest.created_at - u.kyc_submitted_at)) / 3600.0 AS hours
           FROM users u
           JOIN LATERAL (
             SELECT created_at FROM admin_immutable_audit
              WHERE entity_type = 'user' AND entity_id = u.id::text
                AND event_type IN ('kyc_approved', 'kyc_rejected')
              ORDER BY created_at DESC
              LIMIT 1
           ) latest ON true
          WHERE u.kyc_submitted_at IS NOT NULL AND latest.created_at >= u.kyc_submitted_at
          LIMIT 2000`
      ),
    ])

    res.json({
      tradeLog: tradeLogResult.rows.map((r) => ({
        trader: r.full_name || r.email,
        instrument: r.instrument,
        direction: String(r.direction).toUpperCase(),
        lots: parseFloat(r.lot_size),
        pnl: round(r.demo_pnl),
        timestamp: r.close_time,
      })),
      violationHistory: violationHistoryResult.rows.map((r) => ({
        userId: r.user_id,
        type: r.violation_type,
        timestamp: r.first_detected_at,
        resolution: r.status === 'open' ? 'Pending' : (r.resolution_type || 'resolved'),
      })),
      payoutHistory: payoutHistoryResult.rows.map((r) => ({
        userId: r.user_id,
        requestedAt: r.requested_at,
        amount: round(r.amount_payable),
        payoutDate: r.paid_at || r.requested_at,
        status: r.status,
        method: r.payment_method,
      })),
      accountActivity: accountActivityResult.rows.map((r) => ({
        actor: r.actor,
        actionType: r.event_type,
        timestamp: r.created_at,
        details: `${r.entity_type}:${r.entity_id}`,
      })),
      suspiciousActivity: suspiciousResult.rows.map((r) => ({
        userId: r.user_id,
        flagType: r.violation_type,
        detectedAt: r.first_detected_at,
        resolvedAt: r.resolved_at,
        resolution: r.resolution_type,
      })),
      kycProcessingTime: (() => {
        const hoursList = kycProcessingTimeResult.rows.map((r) => parseFloat(r.hours)).filter((h) => Number.isFinite(h) && h >= 0)
        return {
          avgHours: hoursList.length > 0 ? round(hoursList.reduce((sum, h) => sum + h, 0) / hoursList.length) : null,
          decidedCount: hoursList.length
        }
      })(),
      payoutMetrics: (() => {
        const paidRows = payoutHistoryResult.rows.filter((r) => r.status === 'paid' && r.paid_at && r.requested_at)
        const amounts = payoutHistoryResult.rows.map((r) => parseFloat(r.amount_payable)).filter((a) => Number.isFinite(a))
        const approvalHours = paidRows
          .map((r) => (new Date(r.paid_at).getTime() - new Date(r.requested_at).getTime()) / 36e5)
          .filter((h) => Number.isFinite(h) && h >= 0)
        return {
          avgAmount: amounts.length > 0 ? round(amounts.reduce((sum, a) => sum + a, 0) / amounts.length) : null,
          avgApprovalHours: approvalHours.length > 0 ? round(approvalHours.reduce((sum, h) => sum + h, 0) / approvalHours.length) : null,
          paidCount: paidRows.length
        }
      })(),
    })
  } catch (err) {
    logger.error('Compliance audit analytics error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load compliance & audit data' })
  }
})

module.exports = router
