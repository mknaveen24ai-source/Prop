// Trader & Risk Intelligence → Risk & Fraud tab (metrics D53–D77).
//
// Detection logic, not just reporting. Several of these (martingale, grid,
// hedging, timing clusters, tick-scalping) are behaviours the platform's rule
// engine names in `challenge_models` — no_martingale, no_grid_trading,
// no_hedging, no_ea_bots — but never actually measured anywhere. This module
// measures them.
//
// Everything is bounded. The pairwise detections (copy trading, timing
// clusters) are O(n²) in the worst case, so each one is restricted to a recent
// window and to accounts with enough trades to be worth comparing, and the
// SQL does the pairing rather than pulling every trade into Node.

const { readPool } = require('../../db')
const { num, int, round, pct, ratio, stdDev, mean } = require('./helpers')

// Tunables. Exported so the UI can state the threshold beside every count
// instead of presenting a bare number the operator has to take on faith.
const THRESHOLDS = Object.freeze({
  copy_trading_correlation: 0.85,
  simultaneous_open_seconds: 30,
  min_paired_trades: 8,
  martingale_multiplier: 1.8,
  grid_min_positions: 6,
  scalp_max_seconds: 60,
  scalp_share_pct: 40,
  bot_interval_cv: 0.15,
  bot_min_trades: 20,
  news_window_minutes: 5,
  slippage_outlier_multiple: 3,
  pairwise_lookback_days: 30
})

// ── D53: violation heatmap ───────────────────────────────────────────────────
async function violationHeatmap (range) {
  const { rows } = await readPool.query(
    `SELECT v.violation_type,
            v.severity,
            COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            COUNT(*)::int                                  AS violations,
            COUNT(*) FILTER (WHERE v.status = 'open')::int AS open_violations,
            COUNT(DISTINCT v.account_id)::int              AS accounts
       FROM admin_rule_violations v
       LEFT JOIN accounts a ON a.id::text = v.account_id
      WHERE v.first_detected_at BETWEEN $1 AND $2
      GROUP BY 1, 2, 3
      ORDER BY violations DESC`,
    [range.fromTs, range.toTs]
  )

  const cells = rows.map((r) => ({
    violation_type: r.violation_type,
    severity: r.severity,
    model_slug: r.model_slug,
    violations: int(r.violations),
    open_violations: int(r.open_violations),
    accounts: int(r.accounts)
  }))

  const byType = new Map()
  for (const c of cells) {
    const entry = byType.get(c.violation_type) || { violation_type: c.violation_type, violations: 0, open_violations: 0, by_severity: {} }
    entry.violations += c.violations
    entry.open_violations += c.open_violations
    entry.by_severity[c.severity] = (entry.by_severity[c.severity] || 0) + c.violations
    byType.set(c.violation_type, entry)
  }

  return {
    cells,
    by_type: [...byType.values()].sort((a, b) => b.violations - a.violations),
    total: cells.reduce((s, c) => s + c.violations, 0)
  }
}

// ── D54: recurrence and repeat offenders ─────────────────────────────────────
async function repeatOffenders (range) {
  const { rows } = await readPool.query(
    `SELECT v.user_id,
            u.full_name, u.email, u.trader_uid,
            COUNT(*)::int                       AS violations,
            COALESCE(SUM(v.hit_count), 0)::int  AS total_hits,
            COUNT(DISTINCT v.violation_type)::int AS distinct_types,
            COUNT(*) FILTER (WHERE v.severity IN ('high', 'critical'))::int AS severe,
            MAX(v.last_detected_at)             AS last_detected_at
       FROM admin_rule_violations v
       LEFT JOIN users u ON u.id::text = v.user_id
      WHERE v.user_id IS NOT NULL
        AND v.first_detected_at BETWEEN $1 AND $2
      GROUP BY v.user_id, u.full_name, u.email, u.trader_uid
     HAVING COUNT(*) > 1
      ORDER BY severe DESC, total_hits DESC
      LIMIT 50`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    user_id: r.user_id,
    trader: r.full_name || r.email,
    trader_uid: r.trader_uid,
    violations: int(r.violations),
    total_hits: int(r.total_hits),
    distinct_types: int(r.distinct_types),
    severe: int(r.severe),
    last_detected_at: r.last_detected_at,
    // Hits per distinct violation record: a single rule tripped forty times is
    // a very different trader from forty different rules tripped once.
    escalation_ratio: ratio(r.total_hits, r.violations)
  }))
}

// ── D55: time to resolve ─────────────────────────────────────────────────────
async function resolutionTimes (range) {
  const { rows } = await readPool.query(
    `SELECT violation_type,
            resolution_type,
            COUNT(*)::int AS resolved,
            AVG(EXTRACT(EPOCH FROM (resolved_at - first_detected_at)) / 3600.0) AS avg_hours,
            MAX(EXTRACT(EPOCH FROM (resolved_at - first_detected_at)) / 3600.0) AS max_hours
       FROM admin_rule_violations
      WHERE resolved_at IS NOT NULL
        AND resolved_at >= first_detected_at
        AND resolved_at BETWEEN $1 AND $2
      GROUP BY 1, 2
      ORDER BY resolved DESC`,
    [range.fromTs, range.toTs]
  )

  const openAging = await readPool.query(
    `SELECT COUNT(*)::int AS open_violations,
            COUNT(*) FILTER (WHERE first_detected_at < NOW() - INTERVAL '7 days')::int  AS open_over_7d,
            COUNT(*) FILTER (WHERE first_detected_at < NOW() - INTERVAL '30 days')::int AS open_over_30d,
            MAX(EXTRACT(EPOCH FROM (NOW() - first_detected_at)) / 86400.0) AS oldest_days
       FROM admin_rule_violations
      WHERE status = 'open'`
  )
  const o = openAging.rows[0] || {}

  return {
    by_type: rows.map((r) => ({
      violation_type: r.violation_type,
      resolution_type: r.resolution_type,
      resolved: int(r.resolved),
      avg_hours: num(r.avg_hours, null) === null ? null : round(r.avg_hours, 1),
      max_hours: num(r.max_hours, null) === null ? null : round(r.max_hours, 1)
    })),
    open_backlog: {
      open_violations: int(o.open_violations),
      open_over_7d: int(o.open_over_7d),
      open_over_30d: int(o.open_over_30d),
      oldest_days: num(o.oldest_days, null) === null ? null : round(o.oldest_days, 1)
    }
  }
}

// ── D56, D57: drawdown proximity and breach prediction ───────────────────────
// Proximity is where the account stands NOW. Prediction adds the trajectory:
// an account with 20% headroom that has burned 15% a day for three days is in
// more trouble than one sitting at 10% and flat.
async function drawdownRisk () {
  const { rows } = await readPool.query(
    `WITH open_pnl AS (
       SELECT account_id, SUM(demo_pnl) AS floating, SUM(lot_size) AS open_lots
         FROM trades WHERE status = 'open'
        GROUP BY account_id
     ),
     burn AS (
       SELECT d.account_id,
              AVG(d.realized_pnl) FILTER (WHERE d.trading_date >= CURRENT_DATE - 5) AS avg_daily_pnl_5d,
              MIN(d.realized_pnl) FILTER (WHERE d.trading_date >= CURRENT_DATE - 5) AS worst_day_5d
         FROM daily_pnl_records d
        GROUP BY d.account_id
     )
     SELECT a.id, a.account_uid, a.account_type, a.challenge_model_slug,
            a.current_balance, a.starting_balance, a.peak_balance,
            a.max_drawdown_pct, a.daily_drawdown_pct, a.eod_trailing_floor,
            u.full_name, u.email,
            COALESCE(op.floating, 0)   AS floating,
            COALESCE(op.open_lots, 0)  AS open_lots,
            b.avg_daily_pnl_5d,
            b.worst_day_5d
       FROM accounts a
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN open_pnl op ON op.account_id = a.id
       LEFT JOIN burn b ON b.account_id = a.id::text
      WHERE a.status = 'active'
        AND a.max_drawdown_pct > 0
      LIMIT 5000`
  )

  const accounts = rows.map((r) => {
    const start = num(r.starting_balance)
    const peak = num(r.peak_balance, start)
    const equity = num(r.current_balance) + num(r.floating)
    const allowance = (peak * num(r.max_drawdown_pct)) / 100
    const floor = num(r.eod_trailing_floor, null) ?? (peak - allowance)
    const headroom = equity - floor
    const usedPct = allowance > 0 ? ((allowance - headroom) / allowance) * 100 : null
    const burn = num(r.avg_daily_pnl_5d, null)

    // Days until the floor at the account's own recent burn rate. Only computed
    // when the account is actually losing on average — projecting a breach for
    // a profitable account would be noise.
    const daysToFloor = (burn !== null && burn < 0 && headroom > 0)
      ? headroom / Math.abs(burn)
      : null

    return {
      account_id: r.id,
      account_uid: r.account_uid,
      account_type: r.account_type,
      model_slug: r.challenge_model_slug,
      trader: r.full_name || r.email,
      equity: round(equity),
      floor: round(floor),
      headroom: round(headroom),
      allowance_used_pct: usedPct === null ? null : round(usedPct, 1),
      floating_pnl: round(r.floating),
      open_lots: round(r.open_lots, 2),
      avg_daily_pnl_5d: burn === null ? null : round(burn),
      worst_day_5d: num(r.worst_day_5d, null) === null ? null : round(r.worst_day_5d),
      projected_days_to_floor: daysToFloor === null ? null : round(daysToFloor, 1)
    }
  })

  const atRisk = accounts
    .filter((a) => a.allowance_used_pct !== null && a.allowance_used_pct >= 70)
    .sort((a, b) => b.allowance_used_pct - a.allowance_used_pct)

  const predicted = accounts
    .filter((a) => a.projected_days_to_floor !== null && a.projected_days_to_floor <= 5)
    .sort((a, b) => a.projected_days_to_floor - b.projected_days_to_floor)

  return {
    active_accounts: accounts.length,
    at_risk: atRisk.slice(0, 50),
    at_risk_count: atRisk.length,
    predicted_breach: predicted.slice(0, 50),
    predicted_breach_count: predicted.length,
    already_below_floor: accounts.filter((a) => a.headroom < 0).length,
    method_note: 'Projection extrapolates the account\'s own last five trading days of realised P&L. It is a trajectory, not a forecast of intent.'
  }
}

// ── D58, D59: copy trading and simultaneous opens ────────────────────────────
async function copyTrading () {
  // Pairs of accounts that opened the same instrument in the same direction
  // within seconds of each other, repeatedly. The SQL does the pairing so only
  // aggregated pairs cross into Node.
  const { rows } = await readPool.query(
    `WITH recent AS (
       SELECT t.id, t.account_id, t.instrument, UPPER(t.direction) AS direction,
              t.open_time, t.lot_size
         FROM trades t
        WHERE t.open_time >= NOW() - ($1::int * INTERVAL '1 day')
     )
     SELECT LEAST(a.account_id::text, b.account_id::text)    AS account_a,
            GREATEST(a.account_id::text, b.account_id::text) AS account_b,
            COUNT(*)::int                                    AS paired_trades,
            AVG(ABS(EXTRACT(EPOCH FROM (a.open_time - b.open_time)))) AS avg_gap_seconds,
            AVG(ABS(a.lot_size - b.lot_size))                AS avg_lot_gap,
            COUNT(DISTINCT a.instrument)::int                AS instruments
       FROM recent a
       JOIN recent b
         ON a.account_id < b.account_id
        AND a.instrument = b.instrument
        AND a.direction  = b.direction
        AND ABS(EXTRACT(EPOCH FROM (a.open_time - b.open_time))) <= $2
      GROUP BY 1, 2
     HAVING COUNT(*) >= $3
      ORDER BY paired_trades DESC
      LIMIT 60`,
    [
      THRESHOLDS.pairwise_lookback_days,
      THRESHOLDS.simultaneous_open_seconds,
      THRESHOLDS.min_paired_trades
    ]
  )

  if (rows.length === 0) {
    return { pairs: [], thresholds: THRESHOLDS }
  }

  // Attach trader identity and each account's own trade count, so a pair is
  // read as a SHARE of activity rather than a raw count — twelve paired trades
  // out of fifteen is collusion; twelve out of four hundred is coincidence.
  const ids = [...new Set(rows.flatMap((r) => [r.account_a, r.account_b]))]
  const meta = await readPool.query(
    `SELECT a.id::text AS account_id, a.account_uid, u.full_name, u.email,
            (SELECT COUNT(*) FROM trades t
              WHERE t.account_id = a.id
                AND t.open_time >= NOW() - ($2::int * INTERVAL '1 day'))::int AS recent_trades
       FROM accounts a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.id::text = ANY($1::text[])`,
    [ids, THRESHOLDS.pairwise_lookback_days]
  )
  const metaById = new Map(meta.rows.map((r) => [r.account_id, r]))

  return {
    thresholds: THRESHOLDS,
    pairs: rows.map((r) => {
      const a = metaById.get(r.account_a) || {}
      const b = metaById.get(r.account_b) || {}
      const paired = int(r.paired_trades)
      const minTrades = Math.min(int(a.recent_trades) || Infinity, int(b.recent_trades) || Infinity)
      return {
        account_a: r.account_a,
        account_a_uid: a.account_uid,
        trader_a: a.full_name || a.email,
        account_b: r.account_b,
        account_b_uid: b.account_uid,
        trader_b: b.full_name || b.email,
        paired_trades: paired,
        instruments: int(r.instruments),
        avg_gap_seconds: round(r.avg_gap_seconds, 2),
        avg_lot_gap: round(r.avg_lot_gap, 4),
        overlap_pct: Number.isFinite(minTrades) ? pct(paired, minTrades) : null
      }
    })
  }
}

// ── D60: latency / stale-price abuse ─────────────────────────────────────────
// Trades opened at a price materially away from the feed's own value at that
// moment. The feed is snapshot-based, so a single hit means nothing; a trader
// who does it repeatedly and profitably is the signal.
async function latencyAbuse () {
  const { rows } = await readPool.query(
    `WITH suspect AS (
       SELECT t.id, t.account_id, t.instrument, t.open_time, t.open_price, t.demo_pnl,
              (SELECT h.bid FROM price_feed_history h
                WHERE h.instrument = t.instrument
                  AND h.recorded_at <= t.open_time
                ORDER BY h.recorded_at DESC LIMIT 1) AS feed_bid
         FROM trades t
        WHERE t.open_time >= NOW() - INTERVAL '30 days'
          AND t.status = 'closed'
     )
     SELECT s.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            COUNT(*)::int AS trades,
            COUNT(*) FILTER (
              WHERE s.feed_bid > 0
                AND ABS((s.open_price - s.feed_bid) / s.feed_bid) > 0.001
            )::int AS off_feed_trades,
            COALESCE(SUM(s.demo_pnl) FILTER (
              WHERE s.feed_bid > 0
                AND ABS((s.open_price - s.feed_bid) / s.feed_bid) > 0.001
            ), 0) AS off_feed_pnl
       FROM suspect s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE s.feed_bid IS NOT NULL
      GROUP BY s.account_id, a.account_uid, u.full_name, u.email
     HAVING COUNT(*) FILTER (
              WHERE s.feed_bid > 0
                AND ABS((s.open_price - s.feed_bid) / s.feed_bid) > 0.001
            ) >= 5
      ORDER BY off_feed_pnl DESC
      LIMIT 30`
  )

  return {
    threshold_note: 'Entry more than 0.1% from the last recorded feed tick, five or more times in 30 days.',
    accounts: rows.map((r) => ({
      account_id: r.account_id,
      account_uid: r.account_uid,
      trader: r.full_name || r.email,
      trades: int(r.trades),
      off_feed_trades: int(r.off_feed_trades),
      off_feed_share_pct: pct(r.off_feed_trades, r.trades),
      off_feed_pnl: round(r.off_feed_pnl)
    }))
  }
}

// ── D61: slippage outliers ───────────────────────────────────────────────────
async function slippageOutliers (range) {
  const { rows } = await readPool.query(
    `SELECT t.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            COUNT(*)::int                       AS trades,
            AVG(ABS(t.slippage_pips))           AS avg_slippage,
            MAX(ABS(t.slippage_pips))           AS max_slippage,
            SUM(t.demo_pnl)                     AS net_pnl
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE t.slippage_pips IS NOT NULL
        AND t.slippage_pips <> 0
        AND t.open_time BETWEEN $1 AND $2
      GROUP BY t.account_id, a.account_uid, u.full_name, u.email
     HAVING COUNT(*) >= 10
      ORDER BY avg_slippage DESC
      LIMIT 60`,
    [range.fromTs, range.toTs]
  )

  const avgs = rows.map((r) => num(r.avg_slippage)).filter(Number.isFinite)
  const platformMean = mean(avgs)
  const platformSd = stdDev(avgs)

  return {
    platform_avg_slippage: platformMean === null ? null : round(platformMean, 3),
    platform_sd: platformSd === null ? null : round(platformSd, 3),
    outlier_multiple: THRESHOLDS.slippage_outlier_multiple,
    accounts: rows.map((r) => {
      const avg = num(r.avg_slippage)
      const z = (platformSd && platformSd > 0) ? (avg - platformMean) / platformSd : null
      return {
        account_id: r.account_id,
        account_uid: r.account_uid,
        trader: r.full_name || r.email,
        trades: int(r.trades),
        avg_slippage: round(avg, 3),
        max_slippage: round(r.max_slippage, 3),
        net_pnl: round(r.net_pnl),
        z_score: z === null ? null : round(z, 2),
        is_outlier: z !== null && z >= THRESHOLDS.slippage_outlier_multiple
      }
    })
  }
}

// ── D62: news-window trading ─────────────────────────────────────────────────
async function newsWindowTrading (range) {
  const { rows } = await readPool.query(
    `SELECT t.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            COUNT(*)::int   AS news_trades,
            SUM(t.demo_pnl) AS news_pnl,
            COUNT(DISTINCT n.id)::int AS distinct_events
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
       JOIN news_cache n
         ON n.impact IN ('High', 'high', 'HIGH')
        AND t.open_time BETWEEN n.event_time - ($3::int * INTERVAL '1 minute')
                            AND n.event_time + ($3::int * INTERVAL '1 minute')
      WHERE t.open_time BETWEEN $1 AND $2
      GROUP BY t.account_id, a.account_uid, u.full_name, u.email
      ORDER BY news_trades DESC
      LIMIT 40`,
    [range.fromTs, range.toTs, THRESHOLDS.news_window_minutes]
  )

  return {
    window_minutes: THRESHOLDS.news_window_minutes,
    accounts: rows.map((r) => ({
      account_id: r.account_id,
      account_uid: r.account_uid,
      trader: r.full_name || r.email,
      news_trades: int(r.news_trades),
      distinct_events: int(r.distinct_events),
      news_pnl: round(r.news_pnl)
    })),
    note: 'High-impact events only. Whether this is a violation depends on the account\'s model — news_restriction_enabled is per model, not firm-wide.'
  }
}

// ── D63, D64, D65, D67: strategy-shape detections ────────────────────────────
async function strategyDetections (range) {
  // Martingale: lot size escalating sharply straight after a loss, repeatedly.
  const martingale = await readPool.query(
    `WITH seq AS (
       SELECT t.account_id,
              t.lot_size,
              t.demo_pnl,
              LAG(t.lot_size) OVER w AS prev_lot,
              LAG(t.demo_pnl) OVER w AS prev_pnl
         FROM trades t
        WHERE t.status = 'closed'
          AND t.close_time BETWEEN $1 AND $2
       WINDOW w AS (PARTITION BY t.account_id ORDER BY t.open_time)
     )
     SELECT s.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            COUNT(*)::int AS sequences,
            COUNT(*) FILTER (
              WHERE s.prev_pnl < 0 AND s.prev_lot > 0
                AND s.lot_size >= s.prev_lot * $3
            )::int AS escalations,
            MAX(CASE WHEN s.prev_lot > 0 THEN s.lot_size / s.prev_lot END) AS max_multiplier
       FROM seq s
       JOIN accounts a ON a.id = s.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE s.prev_lot IS NOT NULL
      GROUP BY s.account_id, a.account_uid, u.full_name, u.email
     HAVING COUNT(*) FILTER (
              WHERE s.prev_pnl < 0 AND s.prev_lot > 0
                AND s.lot_size >= s.prev_lot * $3
            ) >= 3
      ORDER BY escalations DESC
      LIMIT 40`,
    [range.fromTs, range.toTs, THRESHOLDS.martingale_multiplier]
  )

  // Grid: many concurrent positions on one instrument from one account.
  const grid = await readPool.query(
    `SELECT t.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            t.instrument,
            COUNT(*)::int                 AS open_positions,
            MIN(t.open_price)             AS min_price,
            MAX(t.open_price)             AS max_price,
            COUNT(DISTINCT t.open_price)::int AS distinct_prices
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE t.status = 'open'
      GROUP BY t.account_id, a.account_uid, u.full_name, u.email, t.instrument
     HAVING COUNT(*) >= $1
      ORDER BY open_positions DESC
      LIMIT 40`,
    [THRESHOLDS.grid_min_positions]
  )

  // Hedging: opposite directions held simultaneously on the same instrument.
  const hedging = await readPool.query(
    `SELECT t.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            t.instrument,
            SUM(t.lot_size) FILTER (WHERE UPPER(t.direction) = 'BUY')  AS buy_lots,
            SUM(t.lot_size) FILTER (WHERE UPPER(t.direction) = 'SELL') AS sell_lots,
            COUNT(*)::int AS positions
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE t.status = 'open'
      GROUP BY t.account_id, a.account_uid, u.full_name, u.email, t.instrument
     HAVING SUM(t.lot_size) FILTER (WHERE UPPER(t.direction) = 'BUY')  > 0
        AND SUM(t.lot_size) FILTER (WHERE UPPER(t.direction) = 'SELL') > 0
      ORDER BY positions DESC
      LIMIT 40`
  )

  // Tick scalping: a high share of trades closed inside a minute.
  const scalping = await readPool.query(
    `SELECT t.account_id::text AS account_id,
            a.account_uid, u.full_name, u.email,
            COUNT(*)::int AS trades,
            COUNT(*) FILTER (
              WHERE EXTRACT(EPOCH FROM (t.close_time - t.open_time)) <= $3
            )::int AS scalps,
            SUM(t.demo_pnl) AS net_pnl
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE t.status = 'closed'
        AND t.close_time IS NOT NULL
        AND t.close_time BETWEEN $1 AND $2
      GROUP BY t.account_id, a.account_uid, u.full_name, u.email
     HAVING COUNT(*) >= 20
      ORDER BY (COUNT(*) FILTER (
                 WHERE EXTRACT(EPOCH FROM (t.close_time - t.open_time)) <= $3
               ))::numeric / NULLIF(COUNT(*), 0) DESC
      LIMIT 40`,
    [range.fromTs, range.toTs, THRESHOLDS.scalp_max_seconds]
  )

  return {
    thresholds: THRESHOLDS,
    martingale: martingale.rows.map((r) => ({
      account_id: r.account_id,
      account_uid: r.account_uid,
      trader: r.full_name || r.email,
      sequences: int(r.sequences),
      escalations: int(r.escalations),
      escalation_pct: pct(r.escalations, r.sequences),
      max_multiplier: round(r.max_multiplier, 2)
    })),
    grid: grid.rows.map((r) => ({
      account_id: r.account_id,
      account_uid: r.account_uid,
      trader: r.full_name || r.email,
      instrument: r.instrument,
      open_positions: int(r.open_positions),
      distinct_prices: int(r.distinct_prices),
      price_band: round(num(r.max_price) - num(r.min_price), 5)
    })),
    hedging: hedging.rows.map((r) => ({
      account_id: r.account_id,
      account_uid: r.account_uid,
      trader: r.full_name || r.email,
      instrument: r.instrument,
      buy_lots: round(r.buy_lots, 2),
      sell_lots: round(r.sell_lots, 2),
      positions: int(r.positions),
      // 100% means perfectly flat — the classic drawdown-freeze hedge.
      offset_pct: pct(Math.min(num(r.buy_lots), num(r.sell_lots)), Math.max(num(r.buy_lots), num(r.sell_lots)))
    })),
    scalping: scalping.rows
      .map((r) => ({
        account_id: r.account_id,
        account_uid: r.account_uid,
        trader: r.full_name || r.email,
        trades: int(r.trades),
        scalps: int(r.scalps),
        scalp_share_pct: pct(r.scalps, r.trades),
        net_pnl: round(r.net_pnl)
      }))
      .filter((r) => (r.scalp_share_pct ?? 0) >= THRESHOLDS.scalp_share_pct)
  }
}

// ── D66: bot / EA likelihood ─────────────────────────────────────────────────
// Two independent tells, combined: machine-regular spacing between trades, and
// lot sizes that never vary. Either alone is weak; together they are strong.
async function botLikelihood (range) {
  const { rows } = await readPool.query(
    `WITH gaps AS (
       SELECT t.account_id,
              t.lot_size,
              EXTRACT(EPOCH FROM (t.open_time - LAG(t.open_time) OVER (
                PARTITION BY t.account_id ORDER BY t.open_time
              ))) AS gap_seconds
         FROM trades t
        WHERE t.open_time BETWEEN $1 AND $2
     )
     SELECT g.account_id::text AS account_id,
            a.account_uid, a.bot_score, u.full_name, u.email,
            COUNT(*)::int                     AS trades,
            AVG(g.gap_seconds)                AS avg_gap,
            STDDEV_SAMP(g.gap_seconds)        AS sd_gap,
            AVG(g.lot_size)                   AS avg_lot,
            STDDEV_SAMP(g.lot_size)           AS sd_lot,
            COUNT(DISTINCT g.lot_size)::int   AS distinct_lots
       FROM gaps g
       JOIN accounts a ON a.id = g.account_id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE g.gap_seconds IS NOT NULL AND g.gap_seconds > 0
      GROUP BY g.account_id, a.account_uid, a.bot_score, u.full_name, u.email
     HAVING COUNT(*) >= $3
      ORDER BY trades DESC
      LIMIT 80`,
    [range.fromTs, range.toTs, THRESHOLDS.bot_min_trades]
  )

  return {
    thresholds: THRESHOLDS,
    accounts: rows.map((r) => {
      const avgGap = num(r.avg_gap)
      const sdGap = num(r.sd_gap)
      const gapCv = avgGap > 0 ? sdGap / avgGap : null
      const lotCv = num(r.avg_lot) > 0 ? num(r.sd_lot) / num(r.avg_lot) : null

      // Score is intentionally simple and fully explained by the two components
      // returned alongside it, so an operator can see exactly why an account
      // scored what it did rather than trusting an opaque number.
      let score = 0
      if (gapCv !== null && gapCv <= THRESHOLDS.bot_interval_cv) score += 60
      else if (gapCv !== null && gapCv <= THRESHOLDS.bot_interval_cv * 2) score += 30
      if (int(r.distinct_lots) === 1) score += 40
      else if (lotCv !== null && lotCv <= 0.05) score += 20

      return {
        account_id: r.account_id,
        account_uid: r.account_uid,
        trader: r.full_name || r.email,
        trades: int(r.trades),
        avg_gap_seconds: round(avgGap, 1),
        gap_cv: gapCv === null ? null : round(gapCv, 3),
        lot_cv: lotCv === null ? null : round(lotCv, 3),
        distinct_lots: int(r.distinct_lots),
        stored_bot_score: int(r.bot_score),
        computed_bot_score: score
      }
    }).filter((r) => r.computed_bot_score >= 40)
      .sort((a, b) => b.computed_bot_score - a.computed_bot_score)
  }
}

// ── D68, D69, D70: shared identity ───────────────────────────────────────────
async function sharedIdentity () {
  const sharedIps = await readPool.query(
    `WITH ips AS (
       SELECT ip_address, user_id
         FROM login_logs
        WHERE ip_address IS NOT NULL
          AND logged_in_at >= NOW() - INTERVAL '90 days'
       UNION
       SELECT ip_address, user_id
         FROM trade_logs
        WHERE ip_address IS NOT NULL
          AND logged_at >= NOW() - INTERVAL '90 days'
     )
     SELECT ip_address,
            COUNT(DISTINCT user_id)::int AS users,
            ARRAY_AGG(DISTINCT user_id) AS user_ids
       FROM ips
      WHERE user_id IS NOT NULL
      GROUP BY ip_address
     HAVING COUNT(DISTINCT user_id) > 1
      ORDER BY users DESC
      LIMIT 40`
  )

  const sharedDevices = await readPool.query(
    `SELECT device_fingerprint,
            COUNT(*)::int AS users,
            ARRAY_AGG(id) AS user_ids
       FROM users
      WHERE device_fingerprint IS NOT NULL
        AND device_fingerprint <> ''
      GROUP BY device_fingerprint
     HAVING COUNT(*) > 1
      ORDER BY users DESC
      LIMIT 40`
  )

  const sharedDocuments = await readPool.query(
    `SELECT id_document_hash,
            COUNT(*)::int AS users,
            ARRAY_AGG(id) AS user_ids
       FROM users
      WHERE id_document_hash IS NOT NULL
        AND id_document_hash <> ''
      GROUP BY id_document_hash
     HAVING COUNT(*) > 1
      ORDER BY users DESC
      LIMIT 40`
  )

  // D70 — the same payout destination reused by different traders. Payment
  // details are free text, so this compares them verbatim rather than trying to
  // normalise account numbers it does not understand the format of.
  const sharedPaymentDetails = await readPool.query(
    `SELECT payment_details,
            payment_method,
            COUNT(DISTINCT user_id)::int AS users,
            COUNT(*)::int                AS payouts,
            COALESCE(SUM(amount_payable), 0) AS amount
       FROM payouts
      WHERE payment_details IS NOT NULL
        AND TRIM(payment_details) <> ''
      GROUP BY payment_details, payment_method
     HAVING COUNT(DISTINCT user_id) > 1
      ORDER BY users DESC, amount DESC
      LIMIT 30`
  )

  const signals = await readPool.query(
    `SELECT signal_type,
            COUNT(*)::int                   AS signals,
            COUNT(DISTINCT user_id)::int    AS users,
            COUNT(DISTINCT signal_value)::int AS distinct_values
       FROM identity_signals
      WHERE last_seen_at >= NOW() - INTERVAL '90 days'
      GROUP BY signal_type
      ORDER BY signals DESC`
  )

  return {
    shared_ips: sharedIps.rows.map((r) => ({
      ip_address: r.ip_address,
      users: int(r.users),
      user_ids: r.user_ids
    })),
    shared_devices: sharedDevices.rows.map((r) => ({
      device_fingerprint: r.device_fingerprint,
      users: int(r.users),
      user_ids: r.user_ids
    })),
    shared_documents: sharedDocuments.rows.map((r) => ({
      // The hash itself is not rendered — it is a KYC identifier, and the count
      // is the actionable part.
      users: int(r.users),
      user_ids: r.user_ids
    })),
    shared_payment_details: sharedPaymentDetails.rows.map((r) => ({
      payment_method: r.payment_method,
      users: int(r.users),
      payouts: int(r.payouts),
      amount: round(r.amount)
    })),
    signal_types: signals.rows.map((r) => ({
      signal_type: r.signal_type,
      signals: int(r.signals),
      users: int(r.users),
      distinct_values: int(r.distinct_values)
    }))
  }
}

// ── D71: link-cluster risk over time ─────────────────────────────────────────
async function linkClusters (range) {
  const [clusters, trend] = await Promise.all([
    readPool.query(
      `SELECT c.id, c.cluster_key, c.score, c.confidence, c.member_count,
              c.signal_types, c.status, c.first_detected_at, c.last_detected_at
         FROM account_link_clusters c
        WHERE c.status <> 'false_positive'
        ORDER BY c.score DESC
        LIMIT 40`
    ),
    readPool.query(
      `SELECT (first_detected_at AT TIME ZONE 'UTC')::date::text AS date,
              COUNT(*)::int AS clusters,
              COALESCE(AVG(score), 0) AS avg_score
         FROM account_link_clusters
        WHERE first_detected_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [range.fromTs, range.toTs]
    )
  ])

  const byStatus = await readPool.query(
    `SELECT status, confidence, COUNT(*)::int AS clusters
       FROM account_link_clusters
      GROUP BY status, confidence`
  )

  return {
    top: clusters.rows.map((r) => ({
      id: int(r.id),
      cluster_key: r.cluster_key,
      score: int(r.score),
      confidence: r.confidence,
      member_count: int(r.member_count),
      signal_types: r.signal_types,
      status: r.status,
      first_detected_at: r.first_detected_at,
      last_detected_at: r.last_detected_at
    })),
    trend: trend.rows.map((r) => ({
      date: r.date,
      clusters: int(r.clusters),
      avg_score: round(r.avg_score, 1)
    })),
    by_status: byStatus.rows.map((r) => ({
      status: r.status,
      confidence: r.confidence,
      clusters: int(r.clusters)
    }))
  }
}

// ── D72: payout fraud scoring ────────────────────────────────────────────────
// Feature-attributed rather than a single opaque number: every point added is
// returned with the reason that added it, so an admin reviewing a withdrawal
// sees the case rather than a verdict.
async function payoutFraudScores () {
  const { rows } = await readPool.query(
    `SELECT p.id, p.user_id, p.account_id, p.amount_payable, p.requested_at,
            p.is_flagged, p.status,
            u.full_name, u.email, u.kyc_status, u.created_at AS user_created_at,
            a.account_uid, a.created_at AS account_created_at, a.bot_score,
            (SELECT COUNT(*) FROM admin_rule_violations v
              WHERE v.user_id = p.user_id::text AND v.severity IN ('high','critical'))::int AS severe_violations,
            (SELECT COUNT(*) FROM trades t
              WHERE t.account_id = p.account_id AND t.status = 'closed')::int AS closed_trades,
            (SELECT COUNT(*) FROM account_link_clusters c
              WHERE c.member_user_ids @> ARRAY[p.user_id]::uuid[]
                AND c.status <> 'false_positive')::int AS link_clusters,
            (SELECT COUNT(DISTINCT l.ip_address) FROM login_logs l
              WHERE l.user_id = p.user_id::text
                AND l.logged_in_at >= NOW() - INTERVAL '30 days')::int AS distinct_ips
       FROM payouts p
       LEFT JOIN users u ON u.id = p.user_id
       LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.status IN ('pending', 'approved')
      ORDER BY p.requested_at DESC
      LIMIT 100`
  )

  return rows.map((r) => {
    const factors = []
    let score = 0

    const accountAgeDays = r.account_created_at
      ? (Date.now() - new Date(r.account_created_at).getTime()) / 86400000
      : null

    if (r.kyc_status !== 'approved') {
      score += 25; factors.push({ factor: 'KYC not approved', points: 25, detail: r.kyc_status })
    }
    if (int(r.severe_violations) > 0) {
      const pts = Math.min(30, int(r.severe_violations) * 10)
      score += pts; factors.push({ factor: 'High/critical rule violations', points: pts, detail: `${int(r.severe_violations)} on record` })
    }
    if (int(r.link_clusters) > 0) {
      score += 25; factors.push({ factor: 'Member of an account-link cluster', points: 25, detail: `${int(r.link_clusters)} cluster(s)` })
    }
    if (accountAgeDays !== null && accountAgeDays < 14) {
      score += 15; factors.push({ factor: 'Very new account', points: 15, detail: `${Math.round(accountAgeDays)} days old` })
    }
    if (int(r.closed_trades) < 10) {
      score += 15; factors.push({ factor: 'Few closed trades', points: 15, detail: `${int(r.closed_trades)} trades` })
    }
    if (int(r.bot_score) >= 50) {
      score += 10; factors.push({ factor: 'Elevated stored bot score', points: 10, detail: String(int(r.bot_score)) })
    }
    if (int(r.distinct_ips) > 5) {
      score += 10; factors.push({ factor: 'Many distinct login IPs (30d)', points: 10, detail: `${int(r.distinct_ips)} IPs` })
    }

    return {
      payout_id: r.id,
      user_id: r.user_id,
      trader: r.full_name || r.email,
      account_uid: r.account_uid,
      amount_payable: round(r.amount_payable),
      requested_at: r.requested_at,
      status: r.status,
      already_flagged: r.is_flagged === true,
      risk_score: Math.min(score, 100),
      risk_band: score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low',
      factors
    }
  }).sort((a, b) => b.risk_score - a.risk_score)
}

// ── D73: AML velocity ────────────────────────────────────────────────────────
async function amlVelocity () {
  const { rows } = await readPool.query(
    `WITH journey AS (
       SELECT p.id AS payout_id, p.user_id, p.amount_payable, p.requested_at,
              a.id AS account_id, a.account_uid, a.created_at AS account_created_at,
              (SELECT MIN(o.paid_at) FROM challenge_orders o
                WHERE o.user_id = p.user_id::text AND o.status = 'paid') AS first_order_at,
              (SELECT COUNT(*) FROM trades t WHERE t.account_id = a.id AND t.status = 'closed')::int AS closed_trades,
              u.full_name, u.email
         FROM payouts p
         JOIN accounts a ON a.id = p.account_id
         LEFT JOIN users u ON u.id = p.user_id
        WHERE p.requested_at >= NOW() - INTERVAL '180 days'
     )
     SELECT j.*,
            EXTRACT(EPOCH FROM (j.requested_at - j.first_order_at)) / 86400.0 AS days_purchase_to_payout,
            EXTRACT(EPOCH FROM (j.requested_at - j.account_created_at)) / 86400.0 AS days_account_to_payout
       FROM journey j
      WHERE j.first_order_at IS NOT NULL
      ORDER BY days_purchase_to_payout ASC
      LIMIT 60`
  )

  return rows.map((r) => ({
    payout_id: r.payout_id,
    user_id: r.user_id,
    trader: r.full_name || r.email,
    account_uid: r.account_uid,
    amount_payable: round(r.amount_payable),
    closed_trades: int(r.closed_trades),
    days_purchase_to_payout: num(r.days_purchase_to_payout, null) === null ? null : round(r.days_purchase_to_payout, 1),
    days_account_to_payout: num(r.days_account_to_payout, null) === null ? null : round(r.days_account_to_payout, 1),
    // The AML shape that matters: money in, minimal trading, money out fast.
    fast_cycle: num(r.days_purchase_to_payout, 999) < 14 && int(r.closed_trades) < 20
  }))
}

// ── D74: KYC funnel ──────────────────────────────────────────────────────────
async function kycFunnel (range) {
  const [statuses, timing, reasons] = await Promise.all([
    readPool.query(
      `SELECT kyc_status, COUNT(*)::int AS users
         FROM users
        WHERE is_bot = false
          AND created_at BETWEEN $1 AND $2
        GROUP BY kyc_status
        ORDER BY users DESC`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (NOW() - kyc_submitted_at)) / 3600.0)
                FILTER (WHERE kyc_status = 'pending') AS avg_pending_hours,
              MAX(EXTRACT(EPOCH FROM (NOW() - kyc_submitted_at)) / 3600.0)
                FILTER (WHERE kyc_status = 'pending') AS oldest_pending_hours,
              COUNT(*) FILTER (WHERE kyc_status = 'pending')::int AS pending_now
         FROM users
        WHERE kyc_submitted_at IS NOT NULL`
    ),
    readPool.query(
      `SELECT COALESCE(NULLIF(TRIM(kyc_rejection_reason), ''), 'unspecified') AS reason,
              COUNT(*)::int AS users
         FROM users
        WHERE kyc_status = 'rejected'
          AND kyc_submitted_at BETWEEN $1 AND $2
        GROUP BY 1
        ORDER BY users DESC
        LIMIT 15`,
      [range.fromTs, range.toTs]
    )
  ])

  const total = statuses.rows.reduce((s, r) => s + int(r.users), 0)
  const t = timing.rows[0] || {}

  return {
    statuses: statuses.rows.map((r) => ({
      kyc_status: r.kyc_status,
      users: int(r.users),
      share_pct: pct(r.users, total)
    })),
    pending_now: int(t.pending_now),
    avg_pending_hours: num(t.avg_pending_hours, null) === null ? null : round(t.avg_pending_hours, 1),
    oldest_pending_hours: num(t.oldest_pending_hours, null) === null ? null : round(t.oldest_pending_hours, 1),
    rejection_reasons: reasons.rows.map((r) => ({ reason: r.reason, users: int(r.users) }))
  }
}

// ── D75: geographic mismatch ─────────────────────────────────────────────────
async function geoMismatch () {
  const { rows } = await readPool.query(
    `WITH login_countries AS (
       SELECT l.user_id,
              ARRAY_AGG(DISTINCT l.country) AS countries,
              COUNT(DISTINCT l.country)::int AS distinct_countries
         FROM login_logs l
        WHERE l.country IS NOT NULL
          AND l.logged_in_at >= NOW() - INTERVAL '90 days'
        GROUP BY l.user_id
     )
     SELECT lc.user_id, lc.countries, lc.distinct_countries,
            u.country AS signup_country, u.full_name, u.email, u.kyc_status
       FROM login_countries lc
       JOIN users u ON u.id::text = lc.user_id
      WHERE lc.distinct_countries > 1
      ORDER BY lc.distinct_countries DESC
      LIMIT 50`
  )

  const coverage = await readPool.query(
    `SELECT COUNT(*)::int AS logins,
            COUNT(country)::int AS with_country
       FROM login_logs
      WHERE logged_in_at >= NOW() - INTERVAL '90 days'`
  )
  const c = coverage.rows[0] || {}

  return {
    coverage: {
      logins_90d: int(c.logins),
      with_country: int(c.with_country),
      coverage_pct: pct(c.with_country, c.logins)
    },
    available: int(c.with_country) > 0,
    note: int(c.with_country) > 0
      ? null
      : 'No login has a resolved country yet. login_logs.country is populated from the CDN/edge country header (migration 040) and stays null when the deployment has no such header — that is "unknown", not "no mismatch".',
    users: rows.map((r) => ({
      user_id: r.user_id,
      trader: r.full_name || r.email,
      kyc_status: r.kyc_status,
      signup_country: r.signup_country,
      login_countries: r.countries,
      distinct_countries: int(r.distinct_countries)
    }))
  }
}

// ── D76: admin action analytics ──────────────────────────────────────────────
async function adminActions (range) {
  const [byActor, byAction, fourEyes, enforcement] = await Promise.all([
    readPool.query(
      `SELECT actor,
              COUNT(*)::int                        AS events,
              COUNT(DISTINCT event_type)::int      AS distinct_actions,
              MAX(created_at)                      AS last_action_at
         FROM admin_immutable_audit
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY actor
        ORDER BY events DESC
        LIMIT 30`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT event_type, COUNT(*)::int AS events
         FROM admin_immutable_audit
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY event_type
        ORDER BY events DESC
        LIMIT 30`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT status,
              COUNT(*)::int AS requests,
              AVG(EXTRACT(EPOCH FROM (decided_at - created_at)) / 3600.0) AS avg_decision_hours
         FROM admin_four_eyes_requests
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY status`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT action, status, COUNT(*)::int AS events
         FROM admin_enforcement_events
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY action, status
        ORDER BY events DESC
        LIMIT 30`,
      [range.fromTs, range.toTs]
    )
  ])

  return {
    by_actor: byActor.rows.map((r) => ({
      actor: r.actor,
      events: int(r.events),
      distinct_actions: int(r.distinct_actions),
      last_action_at: r.last_action_at
    })),
    by_action: byAction.rows.map((r) => ({
      event_type: r.event_type,
      events: int(r.events)
    })),
    four_eyes: fourEyes.rows.map((r) => ({
      status: r.status,
      requests: int(r.requests),
      avg_decision_hours: num(r.avg_decision_hours, null) === null ? null : round(r.avg_decision_hours, 1)
    })),
    enforcement: enforcement.rows.map((r) => ({
      action: r.action,
      status: r.status,
      events: int(r.events)
    }))
  }
}

// ── D77: rule-change impact on violations ────────────────────────────────────
async function ruleChangeImpact (range) {
  const { rows } = await readPool.query(
    `SELECT s.id, s.key, s.old_value, s.new_value, s.changed_at,
            (SELECT COUNT(*) FROM admin_rule_violations v
              WHERE v.first_detected_at >= s.changed_at - INTERVAL '14 days'
                AND v.first_detected_at <  s.changed_at)::int AS violations_before,
            (SELECT COUNT(*) FROM admin_rule_violations v
              WHERE v.first_detected_at >= s.changed_at
                AND v.first_detected_at <  s.changed_at + INTERVAL '14 days')::int AS violations_after
       FROM settings_change_log s
      WHERE s.changed_at BETWEEN $1 AND $2
      ORDER BY s.changed_at DESC
      LIMIT 40`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => {
    const before = int(r.violations_before)
    const after = int(r.violations_after)
    return {
      id: int(r.id),
      key: r.key,
      old_value: r.old_value,
      new_value: r.new_value,
      changed_at: r.changed_at,
      window_days: 14,
      violations_before: before,
      violations_after: after,
      change_pct: before > 0 ? round(((after - before) / before) * 100, 1) : null
    }
  })
}

async function build (range) {
  const [
    heatmap, offenders, resolution, drawdown, copy, latency, slippage,
    news, strategies, bots, identity, clusters, fraudScores, aml,
    kyc, geo, admins, ruleImpact
  ] = await Promise.all([
    violationHeatmap(range),
    repeatOffenders(range),
    resolutionTimes(range),
    drawdownRisk(),
    copyTrading(),
    latencyAbuse(),
    slippageOutliers(range),
    newsWindowTrading(range),
    strategyDetections(range),
    botLikelihood(range),
    sharedIdentity(),
    linkClusters(range),
    payoutFraudScores(),
    amlVelocity(),
    kycFunnel(range),
    geoMismatch(),
    adminActions(range),
    ruleChangeImpact(range)
  ])

  return {
    generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    thresholds: THRESHOLDS,
    heatmap,                   // D53
    repeat_offenders: offenders, // D54
    resolution,                // D55
    drawdown,                  // D56, D57
    copy_trading: copy,        // D58, D59
    latency_abuse: latency,    // D60
    slippage,                  // D61
    news_window: news,         // D62
    strategies,                // D63, D64, D65, D67
    bots,                      // D66
    identity,                  // D68, D69, D70
    link_clusters: clusters,   // D71
    payout_fraud: fraudScores, // D72
    aml,                       // D73
    kyc,                       // D74
    geo,                       // D75
    admin_actions: admins,     // D76
    rule_change_impact: ruleImpact // D77
  }
}

module.exports = { build, THRESHOLDS }
