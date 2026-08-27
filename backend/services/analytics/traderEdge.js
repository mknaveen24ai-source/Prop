// Trader & Risk Intelligence → per-trader analytics (metrics G101–J150).
//
// Everything an admin needs to understand ONE trader: where the edge comes
// from, whether the risk behaviour is stable, how the challenge is tracking,
// and how all of that compares to the rest of the platform.
//
// Reuses the existing trader-facing analytics rather than re-deriving them:
// services/tradeShared.js owns R-multiple, and services/tradeAnalytics.js owns
// the discipline, risk-consistency, setup, breach and payout-forecast scores
// that the trader's own dashboard shows. An admin looking at a trader sees the
// same numbers the trader sees, which is the only way the two can ever agree
// in a support conversation.

const { readPool } = require('../../db')
const { computeRMultiple, getTradingRules } = require('../tradeShared')
const {
  buildPerformanceBreakdown,
  buildActivityHeatmap,
  buildHoldTimeAnalytics,
  buildDisciplineScore,
  buildRiskConsistencyScore,
  buildSetupReports,
  getAnalyticsSessionMeta,
  computeTradeDurationMinutes,
  ANALYTICS_WEEKDAY_LABELS
} = require('../tradeAnalytics')
const {
  num, int, round, pct, ratio, mean, median, stdDev, percentile, coefficientOfVariation
} = require('./helpers')

const QUICK_EXIT_MINUTES = 5
const OVERTRADING_TRADES_PER_DAY = 35

async function loadTrader (userId) {
  const { rows } = await readPool.query(
    `SELECT u.id, u.email, u.full_name, u.country, u.trader_uid, u.kyc_status,
            u.created_at, u.is_banned, u.signup_source, u.is_bot
       FROM users u
      WHERE u.id = $1`,
    [userId]
  )
  return rows[0] || null
}

async function loadAccounts (userId) {
  const { rows } = await readPool.query(
    `SELECT a.id, a.account_uid, a.account_type, a.status, a.account_size,
            a.starting_balance, a.current_balance, a.peak_balance,
            a.profit_target, a.max_drawdown_pct, a.daily_drawdown_pct,
            a.eod_trailing_floor, a.phase_start_date, a.phase_end_date,
            a.challenge_model_slug, a.qualifying_days_count, a.min_trading_days,
            a.consistency_max_day_pct, a.scaling_multiplier,
            a.scaling_milestones_claimed, a.free_retries_remaining,
            a.flagged, a.flag_reason, a.review_flagged, a.bot_score,
            a.created_at,
            m.name AS model_name, m.profit_split_pct, m.max_leverage,
            m.scaling_target_pct, m.scaling_increase_per_milestone_pct AS model_scaling_increase_pct,
            m.scaling_max_account_size AS model_scaling_max_size,
            m.consistency_max_day_pct AS model_consistency_pct,
            m.min_trading_days AS model_min_days
       FROM accounts a
       LEFT JOIN challenge_models m ON m.slug = a.challenge_model_slug
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC`,
    [userId]
  )
  return rows
}

async function loadTrades (accountIds) {
  if (!accountIds.length) return []
  const { rows } = await readPool.query(
    `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size,
            t.open_price, t.close_price, t.open_time, t.close_time,
            t.demo_pnl, t.broker_pnl, t.commission, t.status,
            t.stop_loss, t.take_profit, t.order_type, t.close_reason,
            t.slippage_pips, t.strategy_tag, t.tags, t.is_partial,
            t.parent_trade_id, t.notes,
            t.open_screenshot_path, t.close_screenshot_path
       FROM trades t
      WHERE t.account_id = ANY($1::uuid[])
      ORDER BY t.open_time ASC`,
    [accountIds]
  )
  return rows
}

// ── G101: equity curve with drawdown ─────────────────────────────────────────
function buildEquityCurve (trades, account) {
  const closed = trades
    .filter((t) => t.status === 'closed' && t.close_time)
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))

  let equity = num(account?.starting_balance, 0)
  let peak = equity
  const points = [{
    date: account?.phase_start_date || (closed[0]?.close_time ?? null),
    equity: round(equity),
    drawdown_pct: 0,
    trade_index: 0
  }]

  closed.forEach((t, index) => {
    equity += num(t.demo_pnl)
    peak = Math.max(peak, equity)
    points.push({
      date: t.close_time,
      equity: round(equity),
      drawdown_pct: peak > 0 ? round(((peak - equity) / peak) * 100, 2) : 0,
      trade_index: index + 1
    })
  })

  const drawdowns = points.map((p) => p.drawdown_pct)
  return {
    points,
    max_drawdown_pct: drawdowns.length ? round(Math.max(...drawdowns), 2) : 0,
    final_equity: round(equity),
    peak_equity: round(peak)
  }
}

// ── G102–G105, G112, G115, G117, G118: core edge ─────────────────────────────
function buildCoreEdge (trades) {
  const closed = trades.filter((t) => t.status === 'closed')
  if (closed.length === 0) return null

  const pnls = closed.map((t) => num(t.demo_pnl))
  const wins = pnls.filter((v) => v > 0)
  const losses = pnls.filter((v) => v < 0)
  const grossWin = wins.reduce((s, v) => s + v, 0)
  const grossLoss = Math.abs(losses.reduce((s, v) => s + v, 0))

  const rMultiples = closed
    .map((t) => computeRMultiple(t))
    .filter((v) => Number.isFinite(v))

  // G115 — how much of the result rests on a handful of trades. A strategy that
  // collapses without its top 5% is a strategy with no repeatable edge.
  const sortedPnls = [...pnls].sort((a, b) => b - a)
  const topCount = Math.max(1, Math.ceil(sortedPnls.length * 0.05))
  const withoutTop = sortedPnls.slice(topCount)

  // G112 — rolling 30-trade window, so a decaying edge is visible before it
  // shows up in the all-time average.
  const rolling = []
  const WINDOW = 30
  for (let i = WINDOW - 1; i < closed.length; i += 1) {
    const slice = closed.slice(i - WINDOW + 1, i + 1).map((t) => num(t.demo_pnl))
    const w = slice.filter((v) => v > 0).length
    rolling.push({
      trade_index: i + 1,
      date: closed[i].close_time,
      win_rate_pct: round((w / WINDOW) * 100, 1),
      expectancy: round(slice.reduce((s, v) => s + v, 0) / WINDOW, 2)
    })
  }

  const longs = closed.filter((t) => String(t.direction).toUpperCase() === 'BUY')
  const shorts = closed.filter((t) => String(t.direction).toUpperCase() === 'SELL')
  const sideStats = (list) => ({
    trades: list.length,
    net_pnl: round(list.reduce((s, t) => s + num(t.demo_pnl), 0)),
    win_rate_pct: pct(list.filter((t) => num(t.demo_pnl) > 0).length, list.length)
  })

  const commission = closed.reduce((s, t) => s + Math.abs(num(t.commission)), 0)
  const netPnl = pnls.reduce((s, v) => s + v, 0)

  return {
    total_trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: pct(wins.length, closed.length),
    net_pnl: round(netPnl),
    gross_win: round(grossWin),
    gross_loss: round(grossLoss),
    profit_factor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    expectancy: round(netPnl / closed.length),
    avg_win: wins.length ? round(grossWin / wins.length) : null,
    avg_loss: losses.length ? round(grossLoss / losses.length) : null,
    payoff_ratio: (wins.length && losses.length)
      ? round((grossWin / wins.length) / (grossLoss / losses.length))
      : null,
    r_multiple: {
      samples: rMultiples.length,
      avg: rMultiples.length ? round(mean(rMultiples)) : null,
      median: rMultiples.length ? round(median(rMultiples)) : null,
      distribution: [
        { bucket: '< -2R', trades: rMultiples.filter((r) => r < -2).length },
        { bucket: '-2 to -1R', trades: rMultiples.filter((r) => r >= -2 && r < -1).length },
        { bucket: '-1 to 0R', trades: rMultiples.filter((r) => r >= -1 && r < 0).length },
        { bucket: '0 to 1R', trades: rMultiples.filter((r) => r >= 0 && r < 1).length },
        { bucket: '1 to 2R', trades: rMultiples.filter((r) => r >= 1 && r < 2).length },
        { bucket: '> 2R', trades: rMultiples.filter((r) => r >= 2).length }
      ],
      note: rMultiples.length < closed.length
        ? `R-multiple needs a stop loss and a known contract size; ${closed.length - rMultiples.length} of ${closed.length} trades have neither.`
        : null
    },
    outlier_dependence: {
      excluded_trades: topCount,
      net_pnl_excluding_top_5_pct: round(withoutTop.reduce((s, v) => s + v, 0)),
      // Positive → the edge survives without its best trades.
      survives_without_outliers: withoutTop.reduce((s, v) => s + v, 0) > 0
    },
    rolling_30: rolling,
    direction: { long: sideStats(longs), short: sideStats(shorts) },
    cost_drag: {
      commission: round(commission),
      gross_before_costs: round(netPnl + commission),
      commission_pct_of_gross: pct(commission, Math.abs(netPnl) + commission)
    }
  }
}

// ── G113, G114: risk-adjusted return ─────────────────────────────────────────
async function riskAdjusted (accountIds) {
  if (!accountIds.length) return null
  const { rows } = await readPool.query(
    `SELECT trading_date::text AS date, SUM(net_pnl) AS pnl
       FROM account_daily_stats
      WHERE account_id = ANY($1::uuid[])
      GROUP BY trading_date
      ORDER BY trading_date`,
    [accountIds]
  )

  const daily = rows.map((r) => num(r.pnl))
  if (daily.length < 3) {
    return { samples: daily.length, note: 'At least three trading days are needed for a meaningful ratio.' }
  }

  const avg = mean(daily)
  const sd = stdDev(daily)
  const downside = daily.filter((v) => v < 0)
  const downsideSd = downside.length > 1 ? stdDev(downside) : null

  // Drawdown series from cumulative daily P&L, for Calmar and the Ulcer index.
  let cumulative = 0
  let peak = 0
  const drawdowns = []
  for (const v of daily) {
    cumulative += v
    peak = Math.max(peak, cumulative)
    drawdowns.push(peak - cumulative)
  }
  const maxDrawdown = Math.max(...drawdowns, 0)
  const ulcer = Math.sqrt(mean(drawdowns.map((d) => d * d)))
  const totalReturn = cumulative

  return {
    samples: daily.length,
    avg_daily_pnl: round(avg),
    daily_sd: sd === null ? null : round(sd),
    // Unannualised, on daily P&L in currency. Labelled as such in the UI —
    // annualising a 20-day sample would be theatre.
    sharpe: (sd && sd > 0) ? round(avg / sd, 3) : null,
    sortino: (downsideSd && downsideSd > 0) ? round(avg / downsideSd, 3) : null,
    calmar: maxDrawdown > 0 ? round(totalReturn / maxDrawdown, 3) : null,
    ulcer_index: round(ulcer, 2),
    recovery_factor: maxDrawdown > 0 ? round(totalReturn / maxDrawdown, 3) : null,
    max_drawdown: round(maxDrawdown),
    total_return: round(totalReturn),
    daily_series: rows.map((r) => ({ date: r.date, pnl: round(r.pnl) }))
  }
}

// ── G106–G109: excursion analytics ───────────────────────────────────────────
// MAE/MFE from the price-feed snapshot history. This is an approximation and
// says so: price_feed_history is a periodic snapshot on a 90-day retention, not
// a tick archive, so an excursion between two snapshots is invisible.
async function excursions (trades) {
  const eligible = trades
    .filter((t) => t.status === 'closed' && t.close_time && t.open_time)
    .filter((t) => (Date.now() - new Date(t.open_time).getTime()) < 90 * 86400000)
    .slice(-200)

  if (eligible.length === 0) {
    return {
      available: false,
      reason: 'No closed trades inside the 90-day price-history retention window.'
    }
  }

  const results = []
  for (const t of eligible) {
    const { rows } = await readPool.query(
      `SELECT MIN(bid) AS min_bid, MAX(bid) AS max_bid, COUNT(*)::int AS samples
         FROM price_feed_history
        WHERE instrument = $1
          AND recorded_at BETWEEN $2 AND $3`,
      [t.instrument, t.open_time, t.close_time]
    )
    const r = rows[0] || {}
    if (int(r.samples) < 2) continue

    const open = num(t.open_price)
    const close = num(t.close_price)
    const isLong = String(t.direction).toUpperCase() === 'BUY'
    const best = isLong ? num(r.max_bid) : num(r.min_bid)
    const worst = isLong ? num(r.min_bid) : num(r.max_bid)

    const favourable = Math.abs(best - open)
    const adverse = Math.abs(open - worst)
    const captured = Math.abs(close - open)

    results.push({
      trade_id: t.id,
      instrument: t.instrument,
      direction: t.direction,
      samples: int(r.samples),
      mfe: round(favourable, 5),
      mae: round(adverse, 5),
      captured: round(captured, 5),
      // Share of the best available move the trader actually took.
      efficiency_pct: favourable > 0 ? round((captured / favourable) * 100, 1) : null,
      left_on_table: round(Math.max(favourable - captured, 0), 5),
      pnl: round(t.demo_pnl)
    })
  }

  if (results.length === 0) {
    return { available: false, reason: 'Price history has too few samples inside these trades to measure excursion.' }
  }

  const efficiencies = results.map((r) => r.efficiency_pct).filter((v) => v !== null)

  return {
    available: true,
    method_note: 'Approximate. price_feed_history is a periodic snapshot with 90-day retention, not a tick archive — moves between snapshots are not captured.',
    trades_measured: results.length,
    avg_efficiency_pct: efficiencies.length ? round(mean(efficiencies), 1) : null,
    median_efficiency_pct: efficiencies.length ? round(median(efficiencies), 1) : null,
    avg_mae: round(mean(results.map((r) => r.mae)), 5),
    avg_mfe: round(mean(results.map((r) => r.mfe)), 5),
    total_left_on_table: round(results.reduce((s, r) => s + r.left_on_table, 0), 5),
    worst_exits: [...results]
      .sort((a, b) => b.left_on_table - a.left_on_table)
      .slice(0, 10)
  }
}

// ── G116: concentration and correlation of held positions ────────────────────
function concentration (trades) {
  const closed = trades.filter((t) => t.status === 'closed')
  const byInstrument = new Map()
  for (const t of closed) {
    const entry = byInstrument.get(t.instrument) || { instrument: t.instrument, trades: 0, lots: 0, pnl: 0 }
    entry.trades += 1
    entry.lots += num(t.lot_size)
    entry.pnl += num(t.demo_pnl)
    byInstrument.set(t.instrument, entry)
  }

  const list = [...byInstrument.values()]
    .map((e) => ({ ...e, lots: round(e.lots, 2), pnl: round(e.pnl) }))
    .sort((a, b) => b.trades - a.trades)
  const totalTrades = list.reduce((s, e) => s + e.trades, 0)

  // Herfindahl index on trade share: 1.0 is a single-instrument trader.
  const hhi = totalTrades > 0
    ? list.reduce((s, e) => s + ((e.trades / totalTrades) ** 2), 0)
    : null

  // Concurrency: how often more than one position was open at once, which is
  // where correlated exposure actually bites.
  const open = trades.filter((t) => t.open_time).map((t) => ({
    start: new Date(t.open_time).getTime(),
    end: t.close_time ? new Date(t.close_time).getTime() : Date.now()
  }))
  let maxConcurrent = 0
  for (const a of open) {
    const overlapping = open.filter((b) => b.start < a.end && a.start < b.end).length
    maxConcurrent = Math.max(maxConcurrent, overlapping)
  }

  return {
    instruments: list,
    distinct_instruments: list.length,
    top_instrument_share_pct: list.length ? pct(list[0].trades, totalTrades) : null,
    herfindahl_index: hhi === null ? null : round(hhi, 3),
    max_concurrent_positions: maxConcurrent
  }
}

// ── G119, G120: partials and order types ─────────────────────────────────────
function executionMechanics (trades) {
  const closed = trades.filter((t) => t.status === 'closed')
  const partials = closed.filter((t) => t.is_partial === true)
  const partialPnl = partials.reduce((s, t) => s + num(t.demo_pnl), 0)

  const byOrderType = new Map()
  for (const t of trades) {
    const key = t.order_type || 'market'
    const entry = byOrderType.get(key) || { order_type: key, total: 0, closed: 0, cancelled: 0, pnl: 0 }
    entry.total += 1
    if (t.status === 'closed') { entry.closed += 1; entry.pnl += num(t.demo_pnl) }
    if (t.status === 'cancelled') entry.cancelled += 1
    byOrderType.set(key, entry)
  }

  return {
    partials: {
      trades: partials.length,
      share_pct: pct(partials.length, closed.length),
      net_pnl: round(partialPnl),
      avg_pnl: partials.length ? round(partialPnl / partials.length) : null,
      // The comparison that matters: are scaled-out trades better than all-in ones?
      full_close_avg_pnl: (closed.length - partials.length) > 0
        ? round(closed.filter((t) => !t.is_partial).reduce((s, t) => s + num(t.demo_pnl), 0) / (closed.length - partials.length))
        : null
    },
    order_types: [...byOrderType.values()].map((e) => ({
      ...e,
      pnl: round(e.pnl),
      fill_pct: pct(e.closed, e.total),
      cancel_pct: pct(e.cancelled, e.total)
    }))
  }
}

// ── H127–H132: risk behaviour ────────────────────────────────────────────────
async function riskBehaviour (accountIds, accounts, trades) {
  const closed = trades.filter((t) => t.status === 'closed')

  const dailyRows = accountIds.length
    ? (await readPool.query(
      `SELECT d.account_id, d.trading_date::text AS date, d.starting_equity,
              d.ending_equity, d.realized_pnl, d.is_qualifying_day
         FROM daily_pnl_records d
        WHERE d.account_id = ANY($1::text[])
        ORDER BY d.trading_date`,
      [accountIds.map(String)]
    )).rows
    : []

  const primary = accounts[0] || {}
  const dailyLimitPct = num(primary.daily_drawdown_pct, null)

  const dailyRisk = dailyRows.map((r) => {
    const start = num(r.starting_equity)
    const pnl = num(r.realized_pnl)
    const lossPct = start > 0 ? (pnl / start) * 100 : null
    return {
      date: r.date,
      realized_pnl: round(pnl),
      pnl_pct: lossPct === null ? null : round(lossPct, 2),
      // How much of that day's loss allowance was consumed.
      limit_used_pct: (dailyLimitPct && lossPct !== null && lossPct < 0)
        ? round((Math.abs(lossPct) / dailyLimitPct) * 100, 1)
        : null,
      is_qualifying_day: r.is_qualifying_day === true
    }
  })

  const nearLimitDays = dailyRisk.filter((d) => (d.limit_used_pct ?? 0) >= 70)

  // H128 — consistency exposure: the single best day as a share of total profit.
  const profitDays = dailyRisk.filter((d) => d.realized_pnl > 0)
  const totalProfit = profitDays.reduce((s, d) => s + d.realized_pnl, 0)
  const bestDay = profitDays.length ? Math.max(...profitDays.map((d) => d.realized_pnl)) : 0
  const consistencyCap = num(primary.consistency_max_day_pct, null) ?? num(primary.model_consistency_pct, null)

  // H129 — overnight / weekend exposure.
  const overnight = closed.filter((t) => {
    if (!t.open_time || !t.close_time) return false
    return new Date(t.open_time).getUTCDate() !== new Date(t.close_time).getUTCDate()
  })
  const weekend = trades.filter((t) => {
    if (!t.open_time) return false
    const day = new Date(t.open_time).getUTCDay()
    return day === 0 || day === 6
  })

  // H130 — leverage utilisation. Notional / account size, per trade.
  const maxLeverage = num(primary.max_leverage, null)
  const leverageUse = closed
    .map((t) => {
      const size = num(primary.account_size, 0)
      if (size <= 0) return null
      // Standard lot notional; instrument-specific contract sizes are handled by
      // the trade engine, so this is a relative measure, labelled as such.
      return (num(t.lot_size) * 100000) / size
    })
    .filter((v) => v !== null && Number.isFinite(v))

  // H132 — risk of ruin from the trader's own win rate and payoff, against the
  // drawdown actually remaining. Uses the standard gambler's-ruin form.
  const wins = closed.filter((t) => num(t.demo_pnl) > 0)
  const lossesArr = closed.filter((t) => num(t.demo_pnl) < 0)
  const winRate = closed.length ? wins.length / closed.length : null
  const avgWin = wins.length ? wins.reduce((s, t) => s + num(t.demo_pnl), 0) / wins.length : null
  const avgLoss = lossesArr.length ? Math.abs(lossesArr.reduce((s, t) => s + num(t.demo_pnl), 0)) / lossesArr.length : null

  let riskOfRuin = null
  if (winRate !== null && avgWin && avgLoss) {
    const peak = num(primary.peak_balance, num(primary.starting_balance, 0))
    const floor = num(primary.eod_trailing_floor, null)
      ?? (peak - ((peak * num(primary.max_drawdown_pct, 0)) / 100))
    const headroom = num(primary.current_balance, 0) - floor
    const unitsOfLoss = avgLoss > 0 ? headroom / avgLoss : null
    const payoff = avgWin / avgLoss
    const edge = (winRate * payoff) - (1 - winRate)

    if (unitsOfLoss !== null && unitsOfLoss > 0) {
      if (edge <= 0) {
        riskOfRuin = { probability_pct: 100, note: 'Negative expectancy — ruin is a certainty over enough trades.' }
      } else {
        const a = (1 - winRate) / (winRate * payoff)
        const p = a < 1 ? Math.pow(a, unitsOfLoss) * 100 : 100
        riskOfRuin = {
          probability_pct: round(Math.min(p, 100), 2),
          losing_trades_to_floor: round(unitsOfLoss, 1),
          note: 'Gambler\'s-ruin estimate from this trader\'s own win rate, payoff ratio and remaining drawdown. Assumes the current distribution persists.'
        }
      }
    }
  }

  // H131 — behaviour before and after the first violation warning.
  const firstViolation = accountIds.length
    ? (await readPool.query(
      `SELECT MIN(first_detected_at) AS first_at
         FROM admin_rule_violations
        WHERE account_id = ANY($1::text[])`,
      [accountIds.map(String)]
    )).rows[0]?.first_at
    : null

  let behaviourChange = null
  if (firstViolation) {
    const cutoff = new Date(firstViolation).getTime()
    const before = closed.filter((t) => new Date(t.close_time).getTime() < cutoff)
    const after = closed.filter((t) => new Date(t.close_time).getTime() >= cutoff)
    const summarise = (list) => ({
      trades: list.length,
      avg_lot: list.length ? round(mean(list.map((t) => num(t.lot_size))), 3) : null,
      win_rate_pct: pct(list.filter((t) => num(t.demo_pnl) > 0).length, list.length),
      avg_pnl: list.length ? round(mean(list.map((t) => num(t.demo_pnl)))) : null
    })
    behaviourChange = {
      first_violation_at: firstViolation,
      before: summarise(before),
      after: summarise(after)
    }
  }

  return {
    daily_risk: dailyRisk,
    daily_limit_pct: dailyLimitPct,
    near_limit_days: nearLimitDays.length,
    near_limit_detail: nearLimitDays.slice(-15),
    consistency: {
      best_day_pnl: round(bestDay),
      total_profit: round(totalProfit),
      best_day_share_pct: pct(bestDay, totalProfit),
      cap_pct: consistencyCap,
      breaches_cap: (consistencyCap !== null && totalProfit > 0)
        ? ((bestDay / totalProfit) * 100) > consistencyCap
        : null
    },
    overnight: {
      trades: overnight.length,
      share_pct: pct(overnight.length, closed.length),
      net_pnl: round(overnight.reduce((s, t) => s + num(t.demo_pnl), 0))
    },
    weekend: {
      trades: weekend.length,
      share_pct: pct(weekend.length, trades.length)
    },
    leverage: {
      max_allowed: maxLeverage,
      avg_utilisation: leverageUse.length ? round(mean(leverageUse), 2) : null,
      peak_utilisation: leverageUse.length ? round(Math.max(...leverageUse), 2) : null,
      note: 'Notional at a standard 100k contract size divided by account size — a relative measure across this trader\'s own trades, not the engine\'s per-instrument margin calculation.'
    },
    risk_of_ruin: riskOfRuin,
    behaviour_change: behaviourChange
  }
}

// ── H124, H125, H126: behavioural flags ──────────────────────────────────────
function behaviouralFlags (trades) {
  const closed = trades
    .filter((t) => t.status === 'closed' && t.close_time)
    .sort((a, b) => new Date(a.close_time) - new Date(b.close_time))

  // Revenge: a materially bigger position opened soon after a loss.
  let revengeSequences = 0
  let revengePnl = 0
  for (let i = 1; i < closed.length; i += 1) {
    const prev = closed[i - 1]
    const cur = closed[i]
    if (num(prev.demo_pnl) >= 0) continue
    const gapMins = (new Date(cur.open_time) - new Date(prev.close_time)) / 60000
    if (gapMins >= 0 && gapMins <= 15 && num(cur.lot_size) > num(prev.lot_size) * 1.5) {
      revengeSequences += 1
      revengePnl += num(cur.demo_pnl)
    }
  }

  // Overtrading days.
  const byDay = new Map()
  for (const t of closed) {
    const key = String(t.close_time).slice(0, 10)
    const entry = byDay.get(key) || { date: key, trades: 0, pnl: 0 }
    entry.trades += 1
    entry.pnl += num(t.demo_pnl)
    byDay.set(key, entry)
  }
  const overtradingDays = [...byDay.values()].filter((d) => d.trades >= OVERTRADING_TRADES_PER_DAY)

  // Quick exits.
  const durations = closed
    .map((t) => computeTradeDurationMinutes(t))
    .filter((v) => Number.isFinite(v))
  const quickExits = durations.filter((d) => d <= QUICK_EXIT_MINUTES).length

  // Streaks.
  let bestWin = 0; let worstLoss = 0; let curWin = 0; let curLoss = 0
  for (const t of closed) {
    if (num(t.demo_pnl) > 0) { curWin += 1; curLoss = 0; bestWin = Math.max(bestWin, curWin) } else if (num(t.demo_pnl) < 0) { curLoss += 1; curWin = 0; worstLoss = Math.max(worstLoss, curLoss) }
  }

  const slUsage = closed.filter((t) => t.stop_loss !== null && num(t.stop_loss) > 0).length
  const tpUsage = closed.filter((t) => t.take_profit !== null && num(t.take_profit) > 0).length

  return {
    revenge_trading: {
      sequences: revengeSequences,
      net_pnl: round(revengePnl),
      definition: 'A position over 1.5x the previous one, opened within 15 minutes of closing that previous trade at a loss.'
    },
    overtrading: {
      threshold_trades_per_day: OVERTRADING_TRADES_PER_DAY,
      days: overtradingDays.length,
      detail: overtradingDays.map((d) => ({ ...d, pnl: round(d.pnl) })),
      net_pnl_on_those_days: round(overtradingDays.reduce((s, d) => s + d.pnl, 0))
    },
    quick_exits: {
      threshold_minutes: QUICK_EXIT_MINUTES,
      trades: quickExits,
      share_pct: pct(quickExits, durations.length)
    },
    streaks: { best_win_streak: bestWin, worst_loss_streak: worstLoss },
    protection: {
      stop_loss_usage_pct: pct(slUsage, closed.length),
      take_profit_usage_pct: pct(tpUsage, closed.length)
    },
    hold_time: {
      samples: durations.length,
      median_minutes: durations.length ? round(median(durations), 1) : null,
      p90_minutes: durations.length ? round(percentile([...durations].sort((a, b) => a - b), 0.9), 1) : null
    },
    lot_consistency_cv: (() => {
      const cv = coefficientOfVariation(closed.map((t) => num(t.lot_size)).filter((v) => v > 0))
      return cv === null ? null : round(cv, 3)
    })()
  }
}

// ── I133–I142: challenge progress and forecasting ────────────────────────────
async function forecast (account, trades, allAccountIds) {
  if (!account) return null

  const closed = trades.filter((t) => t.status === 'closed' && t.account_id === account.id)
  const start = num(account.starting_balance)
  const balance = num(account.current_balance)
  const target = num(account.profit_target)
  const profit = balance - start
  const progressPct = target > 0 ? (profit / target) * 100 : null

  const daysRemaining = account.phase_end_date
    ? Math.max(0, Math.ceil((new Date(account.phase_end_date).getTime() - Date.now()) / 86400000))
    : null

  const daily = allAccountIds.length
    ? (await readPool.query(
      `SELECT trading_date::text AS date, realized_pnl
         FROM daily_pnl_records
        WHERE account_id = $1
        ORDER BY trading_date`,
      [String(account.id)]
    )).rows
    : []

  const dailyPnls = daily.map((r) => num(r.realized_pnl))
  const avgDaily = dailyPnls.length ? mean(dailyPnls) : null
  const remainingToTarget = Math.max(target - profit, 0)

  // I134 — pass probability from the platform's own history: of accounts on the
  // same model that reached this much of the target with this much time left,
  // how many went on to pass? A real empirical rate, not a model.
  const { rows: peerRows } = await readPool.query(
    `SELECT COUNT(*)::int AS peers,
            COUNT(*) FILTER (WHERE status = 'passed')::int AS passed
       FROM accounts
      WHERE challenge_model_slug = $1
        AND account_type = $2
        AND status IN ('passed', 'failed', 'expired')
        AND profit_target > 0
        AND ((current_balance - starting_balance) / profit_target) * 100
            BETWEEN GREATEST($3::numeric - 15, -1000) AND ($3::numeric + 15)`,
    [account.challenge_model_slug, account.account_type, progressPct ?? 0]
  )
  const peers = int(peerRows[0]?.peers)
  const peersPassed = int(peerRows[0]?.passed)

  const consistencyCap = num(account.consistency_max_day_pct, null) ?? num(account.model_consistency_pct, null)
  const profitDays = dailyPnls.filter((v) => v > 0)
  const totalProfitDays = profitDays.reduce((s, v) => s + v, 0)
  const maxAllowedDay = (consistencyCap && totalProfitDays > 0)
    ? (totalProfitDays * consistencyCap) / 100
    : null

  const peak = num(account.peak_balance, start)
  const allowance = (peak * num(account.max_drawdown_pct, 0)) / 100
  const floor = num(account.eod_trailing_floor, null) ?? (peak - allowance)
  const headroom = balance - floor
  const lossTrades = closed.filter((t) => num(t.demo_pnl) < 0)
  const avgLoss = lossTrades.length
    ? Math.abs(lossTrades.reduce((s, t) => s + num(t.demo_pnl), 0)) / lossTrades.length
    : null

  const minDays = int(account.min_trading_days) || int(account.model_min_days)

  return {
    account_id: account.id,
    account_uid: account.account_uid,
    account_type: account.account_type,
    model_slug: account.challenge_model_slug,
    target: {
      profit_target: round(target),
      current_profit: round(profit),
      progress_pct: progressPct === null ? null : round(progressPct, 1),
      remaining: round(remainingToTarget)
    },
    time: {
      phase_start: account.phase_start_date,
      phase_end: account.phase_end_date,
      days_remaining: daysRemaining,
      trading_days_used: dailyPnls.length,
      required_daily_pnl: (daysRemaining && daysRemaining > 0 && remainingToTarget > 0)
        ? round(remainingToTarget / daysRemaining)
        : null,
      projected_days_to_target: (avgDaily && avgDaily > 0 && remainingToTarget > 0)
        ? round(remainingToTarget / avgDaily, 1)
        : null,
      on_pace: (avgDaily && avgDaily > 0 && daysRemaining)
        ? (remainingToTarget / avgDaily) <= daysRemaining
        : null
    },
    pass_probability: {
      peers,
      peers_passed: peersPassed,
      probability_pct: peers >= 10 ? pct(peersPassed, peers) : null,
      note: peers >= 10
        ? 'Empirical: accounts on the same model and phase that reached a similar share of target.'
        : `Only ${peers} comparable historical accounts — too few to quote a rate.`
    },
    qualifying_days: {
      achieved: int(account.qualifying_days_count),
      required: minDays,
      remaining: Math.max(minDays - int(account.qualifying_days_count), 0),
      satisfied: int(account.qualifying_days_count) >= minDays
    },
    consistency_headroom: {
      cap_pct: consistencyCap,
      best_day_so_far: profitDays.length ? round(Math.max(...profitDays)) : 0,
      max_allowed_single_day: maxAllowedDay === null ? null : round(maxAllowedDay),
      note: consistencyCap
        ? 'A day above this figure would breach the consistency rule at the current total profit.'
        : 'No consistency cap configured for this account.'
    },
    drawdown_headroom: {
      floor: round(floor),
      headroom: round(headroom),
      headroom_pct_of_allowance: allowance > 0 ? round((headroom / allowance) * 100, 1) : null,
      avg_losing_trade: avgLoss === null ? null : round(avgLoss),
      losing_trades_to_floor: (avgLoss && avgLoss > 0) ? round(headroom / avgLoss, 1) : null
    },
    // challenge_models carries TWO scaling semantics — scaling_multiplier
    // (doubling) and scaling_increase_per_milestone_pct (linear) — and only the
    // linear one governs: routes/accounts.js and challengeEngine.js's
    // evaluateScalingPlan both grant `starting * increase_per_milestone_pct`.
    // This block used to surface m.scaling_multiplier as `next_multiplier`,
    // telling a trader their next milestone DOUBLES the account while the engine
    // was granting +25%. Two published ceilings, one of them fiction.
    //
    // account.scaling_multiplier is a different thing and stays: it is the
    // per-account "how many times has this grown" tracker, default 1.
    scaling: {
      multiplier: num(account.scaling_multiplier, 1),
      milestones_claimed: int(account.scaling_milestones_claimed),
      target_pct: num(account.scaling_target_pct, null),
      next_increase_pct: num(account.model_scaling_increase_pct, null),
      next_increase_amount: account.model_scaling_increase_pct == null
        ? null
        : round(num(account.starting_balance) * (num(account.model_scaling_increase_pct) / 100)),
      max_account_size: num(account.model_scaling_max_size, null)
    },
    what_if: [10, 25, 50].map((n) => {
      const expectancy = closed.length
        ? closed.reduce((s, t) => s + num(t.demo_pnl), 0) / closed.length
        : null
      return {
        next_trades: n,
        projected_pnl: expectancy === null ? null : round(expectancy * n),
        projected_equity: expectancy === null ? null : round(balance + (expectancy * n)),
        reaches_target: expectancy === null ? null : (profit + (expectancy * n)) >= target
      }
    })
  }
}

// ── J143–J146: benchmarking against the platform ─────────────────────────────
async function benchmarks (account, core) {
  // Every other block in this payload states WHY it is empty rather than
  // returning a bare null, so the page can explain the gap instead of rendering
  // a silent blank. This guard fires for a trader with no account or no closed
  // trades — the most common real case, not an edge case.
  if (!account || !core) {
    return {
      available: false,
      peers: 0,
      passers: 0,
      percentile_rank: null,
      peer_group: null,
      comparison: [],
      reason: account
        ? 'This trader has no closed trades yet, so there is nothing to rank against peers.'
        : 'This trader has no challenge account, so there is no peer group to compare with.'
    }
  }

  const { rows } = await readPool.query(
    `WITH peer_stats AS (
       SELECT a.id,
              COUNT(t.id)::int AS trades,
              COUNT(t.id) FILTER (WHERE t.demo_pnl > 0)::int AS wins,
              SUM(t.demo_pnl) AS net_pnl,
              SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl > 0) AS gross_win,
              ABS(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl < 0)) AS gross_loss,
              AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)) / 60.0) AS avg_hold_mins,
              a.status
         FROM accounts a
         JOIN trades t ON t.account_id = a.id AND t.status = 'closed'
        WHERE a.challenge_model_slug = $1
          AND a.account_size = $2
          AND a.id <> $3
        GROUP BY a.id
       HAVING COUNT(t.id) >= 10
     )
     SELECT COUNT(*)::int AS peers,
            AVG(CASE WHEN trades > 0 THEN (wins::numeric / trades) * 100 END) AS avg_win_rate,
            AVG(CASE WHEN gross_loss > 0 THEN gross_win / gross_loss END)     AS avg_profit_factor,
            AVG(net_pnl)                                                      AS avg_net_pnl,
            AVG(avg_hold_mins)                                                AS avg_hold_mins,
            COUNT(*) FILTER (WHERE net_pnl < $4)::int                         AS worse_net_pnl,
            AVG(CASE WHEN trades > 0 THEN (wins::numeric / trades) * 100 END)
              FILTER (WHERE status = 'passed')                                AS passer_win_rate,
            AVG(CASE WHEN gross_loss > 0 THEN gross_win / gross_loss END)
              FILTER (WHERE status = 'passed')                                AS passer_profit_factor,
            AVG(avg_hold_mins) FILTER (WHERE status = 'passed')               AS passer_hold_mins,
            COUNT(*) FILTER (WHERE status = 'passed')::int                    AS passers
       FROM peer_stats`,
    [account.challenge_model_slug, account.account_size, account.id, core.net_pnl]
  )

  const r = rows[0] || {}
  const peers = int(r.peers)

  if (peers < 5) {
    return {
      peers,
      available: false,
      reason: `Only ${peers} comparable accounts on this model and size — too few to rank against.`
    }
  }

  return {
    available: true,
    peers,
    peer_group: `${account.challenge_model_slug || 'unknown model'} · ${round(num(account.account_size))} account size`,
    percentile_rank: pct(r.worse_net_pnl, peers),
    comparison: [
      { metric: 'Win rate %', trader: core.win_rate_pct, peer_avg: round(r.avg_win_rate, 1), passer_avg: round(r.passer_win_rate, 1) },
      { metric: 'Profit factor', trader: core.profit_factor, peer_avg: round(r.avg_profit_factor, 2), passer_avg: round(r.passer_profit_factor, 2) },
      { metric: 'Net P&L', trader: core.net_pnl, peer_avg: round(r.avg_net_pnl), passer_avg: null }
    ],
    passers: int(r.passers)
  }
}

// ── J148, J149: tags, notes and journal signal ───────────────────────────────
function journalInsights (trades) {
  const closed = trades.filter((t) => t.status === 'closed')

  const withNotes = closed.filter((t) => t.notes && String(t.notes).trim().length > 0)
  const withoutNotes = closed.filter((t) => !t.notes || String(t.notes).trim().length === 0)
  const summarise = (list) => ({
    trades: list.length,
    win_rate_pct: pct(list.filter((t) => num(t.demo_pnl) > 0).length, list.length),
    avg_pnl: list.length ? round(mean(list.map((t) => num(t.demo_pnl)))) : null
  })

  const byTag = new Map()
  for (const t of closed) {
    const tags = Array.isArray(t.tags) ? t.tags : []
    for (const raw of tags) {
      const tag = String(raw).trim()
      if (!tag) continue
      const entry = byTag.get(tag) || { tag, trades: 0, wins: 0, pnl: 0 }
      entry.trades += 1
      if (num(t.demo_pnl) > 0) entry.wins += 1
      entry.pnl += num(t.demo_pnl)
      byTag.set(tag, entry)
    }
  }

  return {
    notes: {
      journalled: summarise(withNotes),
      unjournalled: summarise(withoutNotes),
      journalling_rate_pct: pct(withNotes.length, closed.length)
    },
    tags: [...byTag.values()]
      .map((e) => ({
        tag: e.tag,
        trades: e.trades,
        win_rate_pct: pct(e.wins, e.trades),
        net_pnl: round(e.pnl),
        avg_pnl: ratio(e.pnl, e.trades)
      }))
      .sort((a, b) => b.trades - a.trades)
      .slice(0, 25)
  }
}

// ── J150: certificates and milestones ────────────────────────────────────────
async function milestones (userId, accounts) {
  const { rows } = await readPool.query(
    `SELECT c.id, c.public_id, c.kind, c.title, c.amount, c.currency,
            c.issued_at, c.status, c.account_id
       FROM certificates c
      WHERE c.user_id = $1
      ORDER BY c.issued_at DESC
      LIMIT 50`,
    [userId]
  ).catch(() => ({ rows: [] }))

  const timeline = [
    ...accounts.map((a) => ({
      at: a.created_at,
      kind: 'account_created',
      label: `${a.account_type} account ${a.account_uid || ''}`.trim()
    })),
    ...accounts.filter((a) => a.status === 'passed').map((a) => ({
      at: a.created_at,
      kind: 'passed',
      label: `Passed ${a.account_type}`
    })),
    ...rows.map((c) => ({
      at: c.issued_at,
      kind: 'certificate',
      label: c.title || c.kind,
      status: c.status
    }))
  ].filter((e) => e.at).sort((a, b) => new Date(b.at) - new Date(a.at))

  return { certificates: rows, timeline }
}

async function build (userId) {
  const trader = await loadTrader(userId)
  if (!trader) return null

  const accounts = await loadAccounts(userId)
  const accountIds = accounts.map((a) => a.id)
  const trades = await loadTrades(accountIds)
  const closedTrades = trades.filter((t) => t.status === 'closed')
  const primaryAccount = accounts.find((a) => a.status === 'active') || accounts[0] || null

  const core = buildCoreEdge(trades)

  // The existing trader-facing analytics, run for the admin. Same functions the
  // trader's own dashboard calls, so the two views cannot disagree.
  const sessionBreakdown = buildPerformanceBreakdown(closedTrades, (t) => {
    const meta = getAnalyticsSessionMeta(t.open_time)
    return { key: meta.key, label: meta.label }
  })
  const weekdayBreakdown = buildPerformanceBreakdown(closedTrades, (t) => {
    const d = t.open_time ? new Date(t.open_time) : null
    if (!d || Number.isNaN(d.getTime())) return null
    return { key: String(d.getUTCDay()), label: ANALYTICS_WEEKDAY_LABELS[d.getUTCDay()] }
  })
  const symbolBreakdown = buildPerformanceBreakdown(closedTrades, (t) => ({
    key: t.instrument, label: t.instrument
  }))
  const strategyBreakdown = buildPerformanceBreakdown(closedTrades, (t) => ({
    key: t.strategy_tag || 'untagged', label: t.strategy_tag || 'Untagged'
  }))

  const holdTime = buildHoldTimeAnalytics(closedTrades, symbolBreakdown, strategyBreakdown, QUICK_EXIT_MINUTES * 60)

  // buildDisciplineScore reads its thresholds from the live trading rules and
  // counts the trader's own rule warnings. Calling it with trades alone would
  // silently fall back to hard-coded defaults and report zero warnings, so the
  // admin view would disagree with the trader's own dashboard.
  const [tradingRules, violationRows] = await Promise.all([
    getTradingRules().catch(() => ({})),
    accountIds.length
      ? readPool.query(
        `SELECT violation_type, severity, status, message, last_detected_at
           FROM admin_rule_violations
          WHERE account_id = ANY($1::text[])
          ORDER BY last_detected_at DESC
          LIMIT 200`,
        [accountIds.map(String)]
      ).then((res) => res.rows)
      : Promise.resolve([])
  ])

  const discipline = buildDisciplineScore(closedTrades, violationRows, tradingRules)
  const riskConsistency = buildRiskConsistencyScore(closedTrades)
  const setups = buildSetupReports(symbolBreakdown, sessionBreakdown, strategyBreakdown)

  const [risk, exc, adjusted, fc, bench, ms] = await Promise.all([
    riskBehaviour(accountIds, accounts, trades),
    excursions(trades),
    riskAdjusted(accountIds),
    forecast(primaryAccount, trades, accountIds),
    benchmarks(primaryAccount, core),
    milestones(userId, accounts)
  ])

  return {
    generated_at: new Date().toISOString(),
    trader: {
      id: trader.id,
      email: trader.email,
      full_name: trader.full_name,
      trader_uid: trader.trader_uid,
      country: trader.country,
      kyc_status: trader.kyc_status,
      signup_source: trader.signup_source,
      is_banned: trader.is_banned === true,
      is_bot: trader.is_bot === true,
      created_at: trader.created_at
    },
    accounts,
    primary_account_id: primaryAccount?.id || null,
    edge: core,                                    // G102–G105, G112, G115, G117, G118
    equity_curve: buildEquityCurve(trades, primaryAccount), // G101
    breakdowns: {                                  // G103
      session: sessionBreakdown,
      weekday: weekdayBreakdown,
      instrument: symbolBreakdown,
      strategy: strategyBreakdown
    },
    heatmap: buildActivityHeatmap(closedTrades),
    hold_time: holdTime,                           // G110
    risk_adjusted: adjusted,                       // G113, G114
    excursions: exc,                               // G106–G109
    concentration: concentration(trades),          // G116
    execution: executionMechanics(trades),         // G119, G120
    discipline,                                    // H121
    risk_consistency: riskConsistency,             // H122
    behaviour: behaviouralFlags(trades),           // H123–H126
    risk_behaviour: risk,                          // H127–H132
    forecast: fc,                                  // I133–I142
    benchmarks: bench,                             // J143–J146
    setups,                                        // J148
    journal: journalInsights(trades),              // J149
    milestones: ms,                                // J150
    violations: violationRows
  }
}

// Searchable trader picker for the page's selector.
async function listTraders ({ search = '', limit = 50 } = {}) {
  const term = String(search || '').trim()
  const { rows } = await readPool.query(
    `SELECT u.id, u.full_name, u.email, u.trader_uid, u.country, u.kyc_status,
            u.is_banned, u.created_at,
            COUNT(a.id)::int                                       AS accounts,
            COUNT(a.id) FILTER (WHERE a.status = 'active')::int     AS active_accounts,
            COUNT(a.id) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts,
            COALESCE(SUM(a.current_balance - a.starting_balance), 0) AS net_pnl,
            (SELECT COUNT(*) FROM admin_rule_violations v
              WHERE v.user_id = u.id::text AND v.status = 'open')::int AS open_violations
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
      WHERE u.is_bot = false
        AND ($1 = '' OR u.email ILIKE '%' || $1 || '%'
                     OR u.full_name ILIKE '%' || $1 || '%'
                     OR u.trader_uid ILIKE '%' || $1 || '%')
      GROUP BY u.id
      ORDER BY COUNT(a.id) FILTER (WHERE a.status = 'active') DESC, u.created_at DESC
      LIMIT $2`,
    [term, Math.min(Math.max(int(limit, 50), 1), 200)]
  )

  return rows.map((r) => ({
    user_id: r.id,
    full_name: r.full_name,
    email: r.email,
    trader_uid: r.trader_uid,
    country: r.country,
    kyc_status: r.kyc_status,
    is_banned: r.is_banned === true,
    created_at: r.created_at,
    accounts: int(r.accounts),
    active_accounts: int(r.active_accounts),
    funded_accounts: int(r.funded_accounts),
    net_pnl: round(r.net_pnl),
    open_violations: int(r.open_violations)
  }))
}

module.exports = { build, listTraders }
