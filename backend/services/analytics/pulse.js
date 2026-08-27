// Firm Intelligence → Live Pulse tab.
//
// The only tab on either page that reads exclusively LIVE tables — never the
// rollups. Everything here has to be true to the second, because it is what an
// operator watches during trading hours: open exposure, floating P&L, accounts
// about to breach, violations firing right now, money waiting to move.
//
// Kept deliberately cheap. It is polled every 5 seconds by every admin with the
// tab open, so each query is either indexed-narrow or bounded by a small LIMIT,
// and nothing here scans closed-trade history.

const { readPool } = require('../../db')
const { num, int, round, pct } = require('./helpers')

// Accounts whose remaining drawdown headroom is thin. Uses the same fields the
// drawdown engine itself maintains (peak_balance / eod_trailing_floor) rather
// than recomputing a second, possibly disagreeing, notion of headroom.
const DRAWDOWN_WARNING_PCT = 75 // % of the allowance already used

async function exposure () {
  const { rows } = await readPool.query(
    `SELECT t.instrument,
            UPPER(t.direction) AS direction,
            COUNT(*)::int      AS positions,
            SUM(t.lot_size)    AS lots
       FROM trades t
      WHERE t.status = 'open'
      GROUP BY 1, 2`
  )

  const byInstrument = new Map()
  for (const r of rows) {
    const entry = byInstrument.get(r.instrument) || {
      instrument: r.instrument, buy_lots: 0, sell_lots: 0, positions: 0
    }
    const lots = num(r.lots)
    if (r.direction === 'BUY') entry.buy_lots += lots
    else entry.sell_lots += lots
    entry.positions += int(r.positions)
    byInstrument.set(r.instrument, entry)
  }

  const instruments = [...byInstrument.values()].map((e) => ({
    ...e,
    buy_lots: round(e.buy_lots, 2),
    sell_lots: round(e.sell_lots, 2),
    net_lots: round(e.buy_lots - e.sell_lots, 2),
    total_lots: round(e.buy_lots + e.sell_lots, 2)
  })).sort((a, b) => b.total_lots - a.total_lots)

  const totalLots = instruments.reduce((s, i) => s + i.total_lots, 0)

  return {
    instruments,
    total_lots: round(totalLots, 2),
    total_positions: instruments.reduce((s, i) => s + i.positions, 0),
    // A single instrument carrying most of the book is the concentration risk
    // that turns one bad print into a firm-wide event.
    concentration: instruments.slice(0, 5).map((i) => ({
      instrument: i.instrument,
      share_pct: pct(i.total_lots, totalLots)
    }))
  }
}

async function floatingPnl () {
  // demo_pnl on an open row is maintained by the trade engine on every tick, so
  // this is the live number rather than a re-marked estimate.
  const { rows } = await readPool.query(
    `SELECT COALESCE(SUM(t.demo_pnl), 0)   AS floating_demo,
            COALESCE(SUM(t.broker_pnl), 0) AS floating_broker,
            COUNT(*)::int                  AS open_trades,
            COUNT(DISTINCT t.account_id)::int AS accounts_with_exposure
       FROM trades t
      WHERE t.status = 'open'`
  )
  const r = rows[0] || {}
  return {
    floating_demo_pnl: round(r.floating_demo),
    floating_broker_pnl: round(r.floating_broker),
    open_trades: int(r.open_trades),
    accounts_with_exposure: int(r.accounts_with_exposure)
  }
}

async function drawdownProximity () {
  const { rows } = await readPool.query(
    `SELECT a.id, a.account_uid, a.account_type, a.challenge_model_slug,
            a.current_balance, a.starting_balance, a.peak_balance,
            a.max_drawdown_pct, a.eod_trailing_floor,
            u.full_name, u.email,
            COALESCE((SELECT SUM(t.demo_pnl) FROM trades t
                       WHERE t.account_id = a.id AND t.status = 'open'), 0) AS floating
       FROM accounts a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.status = 'active'
        AND a.max_drawdown_pct > 0
      LIMIT 5000`
  )

  const rowsOut = rows.map((r) => {
    const start = num(r.starting_balance)
    const peak = num(r.peak_balance, start)
    const balance = num(r.current_balance)
    const floating = num(r.floating)
    const equity = balance + floating
    const maxDdPct = num(r.max_drawdown_pct)

    // Floor is whichever the account is actually measured against: an explicit
    // trailing floor if the engine has set one, otherwise peak minus allowance.
    const allowance = (peak * maxDdPct) / 100
    const floor = num(r.eod_trailing_floor, null) ?? (peak - allowance)
    const headroom = equity - floor
    const usedPct = allowance > 0 ? ((allowance - headroom) / allowance) * 100 : null

    return {
      account_id: r.id,
      account_uid: r.account_uid,
      account_type: r.account_type,
      model_slug: r.challenge_model_slug,
      trader: r.full_name || r.email,
      equity: round(equity),
      floor: round(floor),
      headroom: round(headroom),
      floating_pnl: round(floating),
      allowance_used_pct: usedPct === null ? null : round(usedPct, 1)
    }
  })

  const atRisk = rowsOut
    .filter((r) => r.allowance_used_pct !== null && r.allowance_used_pct >= DRAWDOWN_WARNING_PCT)
    .sort((a, b) => b.allowance_used_pct - a.allowance_used_pct)

  return {
    warning_threshold_pct: DRAWDOWN_WARNING_PCT,
    active_accounts: rowsOut.length,
    at_risk_count: atRisk.length,
    at_risk: atRisk.slice(0, 40),
    breached_now: rowsOut.filter((r) => r.headroom < 0).length
  }
}

async function liveViolations () {
  const [summary, recent] = await Promise.all([
    readPool.query(
      `SELECT severity, COUNT(*)::int AS violations
         FROM admin_rule_violations
        WHERE status = 'open'
        GROUP BY severity`
    ),
    readPool.query(
      `SELECT v.id, v.violation_type, v.severity, v.message, v.instrument,
              v.account_id, v.last_detected_at, v.hit_count,
              u.full_name, u.email
         FROM admin_rule_violations v
         LEFT JOIN users u ON u.id::text = v.user_id
        WHERE v.status = 'open'
        ORDER BY v.last_detected_at DESC
        LIMIT 25`
    )
  ])

  return {
    open_by_severity: summary.rows.map((r) => ({
      severity: r.severity,
      violations: int(r.violations)
    })),
    open_total: summary.rows.reduce((s, r) => s + int(r.violations), 0),
    recent: recent.rows.map((r) => ({
      id: int(r.id),
      violation_type: r.violation_type,
      severity: r.severity,
      message: r.message,
      instrument: r.instrument,
      account_id: r.account_id,
      trader: r.full_name || r.email,
      hit_count: int(r.hit_count),
      last_detected_at: r.last_detected_at
    }))
  }
}

async function moneyQueue () {
  const { rows } = await readPool.query(
    `SELECT
       (SELECT COUNT(*) FROM payouts WHERE status = 'pending')::int  AS payouts_pending,
       (SELECT COALESCE(SUM(amount_payable), 0) FROM payouts WHERE status IN ('pending','approved')) AS payouts_pending_value,
       (SELECT COUNT(*) FROM payouts WHERE status = 'pending' AND is_flagged = true)::int AS payouts_flagged,
       (SELECT COUNT(*) FROM users WHERE kyc_status = 'pending')::int AS kyc_pending,
       (SELECT COUNT(*) FROM disputes WHERE status = 'open')::int     AS disputes_open,
       (SELECT COUNT(*) FROM support_tickets WHERE status = 'open')::int AS tickets_open,
       (SELECT COUNT(*) FROM account_promotion_reviews WHERE status = 'pending')::int AS promotions_pending,
       (SELECT COUNT(*) FROM email_jobs WHERE status IN ('pending','retry'))::int AS emails_queued`
  )
  const r = rows[0] || {}
  return {
    payouts_pending: int(r.payouts_pending),
    payouts_pending_value: round(r.payouts_pending_value),
    payouts_flagged: int(r.payouts_flagged),
    kyc_pending: int(r.kyc_pending),
    disputes_open: int(r.disputes_open),
    tickets_open: int(r.tickets_open),
    promotions_pending: int(r.promotions_pending),
    emails_queued: int(r.emails_queued)
  }
}

async function todaySoFar () {
  const { rows } = await readPool.query(
    `SELECT
       (SELECT COUNT(*) FROM challenge_orders
         WHERE status = 'paid' AND paid_at >= date_trunc('day', NOW()))::int AS orders_today,
       (SELECT COALESCE(SUM(amount), 0) FROM challenge_orders
         WHERE status = 'paid' AND paid_at >= date_trunc('day', NOW())) AS revenue_today,
       (SELECT COUNT(*) FROM users
         WHERE is_bot = false AND created_at >= date_trunc('day', NOW()))::int AS signups_today,
       (SELECT COUNT(*) FROM trades
         WHERE open_time >= date_trunc('day', NOW()))::int AS trades_opened_today,
       (SELECT COALESCE(SUM(demo_pnl), 0) FROM trades
         WHERE status = 'closed' AND close_time >= date_trunc('day', NOW())) AS realised_trader_pnl_today,
       (SELECT COUNT(*) FROM accounts
         WHERE status = 'passed' AND updated_at >= date_trunc('day', NOW()))::int AS passes_today,
       (SELECT COUNT(*) FROM accounts
         WHERE status IN ('failed','expired') AND updated_at >= date_trunc('day', NOW()))::int AS failures_today`
  )
  const r = rows[0] || {}
  const traderPnl = num(r.realised_trader_pnl_today)
  return {
    orders_today: int(r.orders_today),
    revenue_today: round(r.revenue_today),
    signups_today: int(r.signups_today),
    trades_opened_today: int(r.trades_opened_today),
    realised_trader_pnl_today: round(traderPnl),
    firm_edge_today: round(-traderPnl),
    passes_today: int(r.passes_today),
    failures_today: int(r.failures_today)
  }
}

async function feedStatus () {
  const { rows } = await readPool.query(
    `SELECT COUNT(*)::int AS instruments,
            COUNT(*) FILTER (WHERE LOCALTIMESTAMP - updated_at > INTERVAL '60 seconds')::int AS stale,
            MAX(EXTRACT(EPOCH FROM (LOCALTIMESTAMP - updated_at))) AS worst_stale_seconds
       FROM price_feed`
  )
  const r = rows[0] || {}
  return {
    instruments: int(r.instruments),
    stale_over_60s: int(r.stale),
    worst_stale_seconds: num(r.worst_stale_seconds, null) === null ? null : round(r.worst_stale_seconds, 1)
  }
}

async function build () {
  const [exp, pnl, drawdown, violations, queue, today, feed] = await Promise.all([
    exposure(),
    floatingPnl(),
    drawdownProximity(),
    liveViolations(),
    moneyQueue(),
    todaySoFar(),
    feedStatus()
  ])

  return {
    generated_at: new Date().toISOString(),
    exposure: exp,
    floating: pnl,
    drawdown,
    violations,
    queue,
    today,
    feed
  }
}

module.exports = { build, DRAWDOWN_WARNING_PCT }
