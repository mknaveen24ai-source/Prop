// Firm Intelligence → Payout & Liability tab (metrics C41–C52).
//
// The single most important question on these two pages is "what do we owe, and
// can we pay it". Everything here is built from `payouts` (the settled record)
// and live funded-account equity (the unsettled exposure).
//
// Profit split resolution order, applied per account rather than firm-wide:
//   1. the account's own challenge model's profit_split_pct
//   2. PROFIT_SHARE_FALLBACK_PCT from constants.js
// This mirrors how domain/payoutEligibility.js decides what a trader is owed,
// so the forecast and the actual payout cannot disagree about the split.

const { readPool } = require('../../db')
const { PROFIT_SHARE_FALLBACK_PCT } = require('../../constants')
const { num, int, round, pct, ratio, median, percentile } = require('./helpers')

// ── C41: forward liability on live funded accounts ───────────────────────────
async function liabilityForecast () {
  const { rows } = await readPool.query(
    `SELECT a.id,
            a.account_uid,
            a.challenge_model_slug,
            a.account_size,
            a.current_balance,
            a.starting_balance,
            COALESCE(m.profit_split_pct, $1) AS profit_split_pct,
            u.full_name,
            u.email
       FROM accounts a
       LEFT JOIN challenge_models m ON m.slug = a.challenge_model_slug
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.account_type = 'funded'
        AND a.status = 'active'`,
    [PROFIT_SHARE_FALLBACK_PCT]
  )

  // Already-requested-but-unpaid money is a separate, harder commitment than
  // unrealised profit, so the two are never summed into one headline number.
  const pending = await readPool.query(
    `SELECT COUNT(*)::int                            AS requests,
            COALESCE(SUM(amount_payable), 0)         AS payable,
            COALESCE(SUM(amount_requested), 0)       AS requested
       FROM payouts
      WHERE status IN ('pending', 'approved')`
  )

  const accounts = rows.map((r) => {
    const profit = num(r.current_balance) - num(r.starting_balance)
    const split = num(r.profit_split_pct, PROFIT_SHARE_FALLBACK_PCT)
    return {
      account_id: r.id,
      account_uid: r.account_uid,
      model_slug: r.challenge_model_slug,
      trader: r.full_name || r.email,
      account_size: num(r.account_size),
      unrealised_profit: round(Math.max(profit, 0)),
      profit_split_pct: split,
      trader_share: round(Math.max(profit, 0) * (split / 100))
    }
  })

  const inProfit = accounts.filter((a) => a.unrealised_profit > 0)
  const p = pending.rows[0] || {}

  return {
    funded_active: accounts.length,
    accounts_in_profit: inProfit.length,
    // What the firm would owe if every funded account withdrew everything today.
    forecast_liability: round(inProfit.reduce((s, a) => s + a.trader_share, 0)),
    unrealised_profit_total: round(inProfit.reduce((s, a) => s + a.unrealised_profit, 0)),
    committed: {
      requests: int(p.requests),
      amount_payable: round(p.payable),
      amount_requested: round(p.requested)
    },
    top_exposures: inProfit
      .sort((a, b) => b.trader_share - a.trader_share)
      .slice(0, 25)
  }
}

// ── C42, C43: pipeline, aging, decisions ─────────────────────────────────────
async function pipeline (range) {
  const [statusRows, aging, decisions] = await Promise.all([
    readPool.query(
      `SELECT status,
              COUNT(*)::int                      AS payouts,
              COALESCE(SUM(amount_payable), 0)   AS payable,
              COALESCE(SUM(firm_cut), 0)         AS firm_cut
         FROM payouts
        WHERE requested_at BETWEEN $1 AND $2
        GROUP BY status
        ORDER BY payouts DESC`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - requested_at)) / 86400.0 AS age_days,
              amount_payable, id, status
         FROM payouts
        WHERE status IN ('pending', 'approved')`
    ),
    readPool.query(
      `SELECT EXTRACT(EPOCH FROM (paid_at - requested_at)) / 3600.0 AS hours
         FROM payouts
        WHERE status = 'paid'
          AND paid_at IS NOT NULL
          AND paid_at >= requested_at
          AND paid_at BETWEEN $1 AND $2`,
      [range.fromTs, range.toTs]
    )
  ])

  const ages = aging.rows.map((r) => num(r.age_days)).filter(Number.isFinite)
  const hours = decisions.rows.map((r) => num(r.hours)).filter(Number.isFinite).sort((a, b) => a - b)

  // SLA buckets are descriptive of what actually happened, not a target the
  // platform stores anywhere — the UI labels them as observed, not as a policy.
  const AGE_BUCKETS = [
    { label: '< 1 day', test: (d) => d < 1 },
    { label: '1–3 days', test: (d) => d >= 1 && d < 3 },
    { label: '3–7 days', test: (d) => d >= 3 && d < 7 },
    { label: '7–14 days', test: (d) => d >= 7 && d < 14 },
    { label: '14+ days', test: (d) => d >= 14 }
  ]

  const statuses = statusRows.rows.map((r) => ({
    status: r.status,
    payouts: int(r.payouts),
    payable: round(r.payable),
    firm_cut: round(r.firm_cut)
  }))

  const totalDecided = statuses
    .filter((s) => ['paid', 'rejected'].includes(s.status))
    .reduce((sum, s) => sum + s.payouts, 0)
  const rejected = statuses.find((s) => s.status === 'rejected')?.payouts || 0

  return {
    statuses,
    open_queue: {
      count: ages.length,
      oldest_days: ages.length ? round(Math.max(...ages), 1) : null,
      median_age_days: ages.length ? round(median(ages), 1) : null,
      buckets: AGE_BUCKETS.map((b) => ({
        label: b.label,
        payouts: ages.filter(b.test).length
      }))
    },
    turnaround_hours: {
      samples: hours.length,
      median: hours.length ? round(median(hours), 1) : null,
      p90: hours.length ? round(percentile(hours, 0.9), 1) : null
    },
    decisions: {
      decided: totalDecided,
      rejected,
      rejection_pct: pct(rejected, totalDecided)
    }
  }
}

// ── C44, C47: payout size distribution and concentration ─────────────────────
async function payoutDistribution (range) {
  const { rows } = await readPool.query(
    `SELECT p.id, p.user_id, p.amount_payable, p.firm_cut, p.amount_requested,
            p.payment_method, a.account_size, u.full_name, u.email
       FROM payouts p
       LEFT JOIN accounts a ON a.id = p.account_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.status = 'paid'
        AND p.paid_at BETWEEN $1 AND $2`,
    [range.fromTs, range.toTs]
  )

  const amounts = rows.map((r) => num(r.amount_payable)).filter((v) => v > 0).sort((a, b) => a - b)
  const total = amounts.reduce((s, v) => s + v, 0)

  const byTrader = new Map()
  for (const r of rows) {
    const key = r.user_id
    if (!key) continue
    const entry = byTrader.get(key) || { trader: r.full_name || r.email, payouts: 0, amount: 0 }
    entry.payouts += 1
    entry.amount += num(r.amount_payable)
    byTrader.set(key, entry)
  }
  const traders = [...byTrader.values()].sort((a, b) => b.amount - a.amount)

  const bySize = new Map()
  for (const r of rows) {
    const size = num(r.account_size, 0)
    const entry = bySize.get(size) || { account_size: size, payouts: 0, amount: 0 }
    entry.payouts += 1
    entry.amount += num(r.amount_payable)
    bySize.set(size, entry)
  }

  const topShare = (n) => {
    if (!traders.length || total === 0) return null
    const take = Math.max(1, Math.ceil(traders.length * n))
    return round((traders.slice(0, take).reduce((s, t) => s + t.amount, 0) / total) * 100)
  }

  return {
    payouts: amounts.length,
    total_paid: round(total),
    mean: amounts.length ? round(total / amounts.length) : null,
    median: amounts.length ? round(median(amounts)) : null,
    p90: amounts.length ? round(percentile(amounts, 0.9)) : null,
    largest: amounts.length ? round(amounts[amounts.length - 1]) : null,
    by_account_size: [...bySize.values()]
      .map((e) => ({ ...e, amount: round(e.amount), avg: ratio(e.amount, e.payouts) }))
      .sort((a, b) => a.account_size - b.account_size),
    concentration: {
      traders: traders.length,
      top_1_pct_share: topShare(0.01),
      top_5_pct_share: topShare(0.05),
      top_10_pct_share: topShare(0.10)
    },
    top_earners: traders.slice(0, 20).map((t) => ({
      trader: t.trader,
      payouts: t.payouts,
      amount: round(t.amount)
    }))
  }
}

// ── C45, C46: time to first payout, repeat rate ──────────────────────────────
async function payoutCadence (range) {
  const first = await readPool.query(
    `SELECT EXTRACT(EPOCH FROM (MIN(p.paid_at) - a.created_at)) / 86400.0 AS days
       FROM payouts p
       JOIN accounts a ON a.id = p.account_id
      WHERE p.status = 'paid'
        AND p.paid_at IS NOT NULL
        AND a.account_type = 'funded'
        AND a.created_at BETWEEN $1 AND $2
      GROUP BY a.id, a.created_at`,
    [range.fromTs, range.toTs]
  )

  const repeat = await readPool.query(
    `WITH per_account AS (
       SELECT p.account_id, COUNT(*)::int AS payouts
         FROM payouts p
        WHERE p.status = 'paid'
          AND p.paid_at BETWEEN $1 AND $2
        GROUP BY p.account_id
     )
     SELECT COUNT(*)::int                              AS paying_accounts,
            COUNT(*) FILTER (WHERE payouts > 1)::int   AS repeat_accounts,
            COALESCE(AVG(payouts), 0)                  AS avg_payouts_per_account,
            COALESCE(MAX(payouts), 0)::int             AS max_payouts
       FROM per_account`,
    [range.fromTs, range.toTs]
  )

  const days = first.rows.map((r) => num(r.days)).filter((v) => Number.isFinite(v) && v >= 0)
  const r = repeat.rows[0] || {}

  return {
    time_to_first_payout_days: {
      samples: days.length,
      median: days.length ? round(median(days), 1) : null,
      p90: days.length ? round(percentile(days.sort((a, b) => a - b), 0.9), 1) : null
    },
    paying_accounts: int(r.paying_accounts),
    repeat_accounts: int(r.repeat_accounts),
    repeat_pct: pct(r.repeat_accounts, r.paying_accounts),
    avg_payouts_per_account: round(r.avg_payouts_per_account, 2),
    max_payouts: int(r.max_payouts)
  }
}

// ── C48: realised split vs configured split ──────────────────────────────────
async function splitLeakage (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            COALESCE(m.profit_split_pct, $3)            AS configured_split_pct,
            COUNT(*)::int                               AS payouts,
            COALESCE(SUM(p.amount_requested), 0)        AS requested,
            COALESCE(SUM(p.amount_payable), 0)          AS payable,
            COALESCE(SUM(p.firm_cut), 0)                AS firm_cut
       FROM payouts p
       LEFT JOIN accounts a ON a.id = p.account_id
       LEFT JOIN challenge_models m ON m.slug = a.challenge_model_slug
      WHERE p.status = 'paid'
        AND p.paid_at BETWEEN $1 AND $2
      GROUP BY 1, 2
      ORDER BY payable DESC`,
    [range.fromTs, range.toTs, PROFIT_SHARE_FALLBACK_PCT]
  )

  return rows.map((r) => {
    const requested = num(r.requested)
    const payable = num(r.payable)
    const configured = num(r.configured_split_pct, PROFIT_SHARE_FALLBACK_PCT)
    const realised = requested > 0 ? (payable / requested) * 100 : null

    return {
      model_slug: r.model_slug,
      payouts: int(r.payouts),
      requested: round(requested),
      payable: round(payable),
      firm_cut: round(r.firm_cut),
      configured_split_pct: configured,
      realised_split_pct: realised === null ? null : round(realised),
      // Positive means traders received a larger share than the model
      // configures — worth an operator's attention either way.
      drift_pct_points: realised === null ? null : round(realised - configured)
    }
  })
}

// ── C49: flagged payouts ─────────────────────────────────────────────────────
async function flagged (range) {
  const { rows } = await readPool.query(
    `SELECT COUNT(*)::int                                             AS total,
            COUNT(*) FILTER (WHERE is_flagged = true)::int            AS flagged,
            COUNT(*) FILTER (WHERE is_flagged = true AND status = 'paid')::int     AS flagged_paid,
            COUNT(*) FILTER (WHERE is_flagged = true AND status = 'rejected')::int AS flagged_rejected,
            COALESCE(SUM(amount_payable) FILTER (WHERE is_flagged = true), 0)      AS flagged_value
       FROM payouts
      WHERE requested_at BETWEEN $1 AND $2`,
    [range.fromTs, range.toTs]
  )

  const reasons = await readPool.query(
    `SELECT COALESCE(NULLIF(TRIM(flag_reason), ''), 'unspecified') AS reason,
            COUNT(*)::int AS payouts
       FROM payouts
      WHERE is_flagged = true
        AND requested_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY payouts DESC
      LIMIT 20`,
    [range.fromTs, range.toTs]
  )

  const r = rows[0] || {}
  return {
    total: int(r.total),
    flagged: int(r.flagged),
    flag_rate_pct: pct(r.flagged, r.total),
    flagged_paid: int(r.flagged_paid),
    flagged_rejected: int(r.flagged_rejected),
    flagged_value: round(r.flagged_value),
    // Of the flags that reached a decision, how many were upheld. A low number
    // means the flagging rule is noisy; a high one means it is catching things.
    upheld_pct: pct(r.flagged_rejected, int(r.flagged_paid) + int(r.flagged_rejected)),
    reasons: reasons.rows.map((x) => ({ reason: x.reason, payouts: int(x.payouts) }))
  }
}

// ── C50: payout-to-revenue ratio ─────────────────────────────────────────────
async function payoutToRevenue () {
  const { rows } = await readPool.query(
    `SELECT
       COALESCE(SUM(gross_revenue) FILTER (WHERE revenue_date >= CURRENT_DATE - 30), 0) AS revenue_30,
       COALESCE(SUM(payouts_paid)  FILTER (WHERE revenue_date >= CURRENT_DATE - 30), 0) AS payouts_30,
       COALESCE(SUM(gross_revenue) FILTER (WHERE revenue_date >= CURRENT_DATE - 90), 0) AS revenue_90,
       COALESCE(SUM(payouts_paid)  FILTER (WHERE revenue_date >= CURRENT_DATE - 90), 0) AS payouts_90,
       COALESCE(SUM(gross_revenue), 0) AS revenue_all,
       COALESCE(SUM(payouts_paid), 0)  AS payouts_all
     FROM revenue_daily`
  )
  const r = rows[0] || {}

  const series = await readPool.query(
    `SELECT revenue_date::text AS date, gross_revenue, payouts_paid
       FROM revenue_daily
      WHERE revenue_date >= CURRENT_DATE - 90
      ORDER BY revenue_date`
  )

  return {
    rolling_30d: {
      revenue: round(r.revenue_30),
      payouts: round(r.payouts_30),
      ratio_pct: pct(r.payouts_30, r.revenue_30)
    },
    rolling_90d: {
      revenue: round(r.revenue_90),
      payouts: round(r.payouts_90),
      ratio_pct: pct(r.payouts_90, r.revenue_90)
    },
    all_time_in_rollup: {
      revenue: round(r.revenue_all),
      payouts: round(r.payouts_all),
      ratio_pct: pct(r.payouts_all, r.revenue_all)
    },
    daily: series.rows.map((row) => ({
      date: row.date,
      revenue: round(row.gross_revenue),
      payouts: round(row.payouts_paid)
    }))
  }
}

// ── C51: payment method mix ──────────────────────────────────────────────────
async function paymentMethods (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(NULLIF(TRIM(payment_method), ''), 'unspecified') AS method,
            COUNT(*)::int                                          AS requests,
            COUNT(*) FILTER (WHERE status = 'paid')::int           AS paid,
            COUNT(*) FILTER (WHERE status = 'rejected')::int       AS rejected,
            COALESCE(SUM(amount_payable) FILTER (WHERE status = 'paid'), 0) AS paid_amount,
            AVG(EXTRACT(EPOCH FROM (paid_at - requested_at)) / 3600.0)
              FILTER (WHERE status = 'paid' AND paid_at IS NOT NULL) AS avg_hours
       FROM payouts
      WHERE requested_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY requests DESC`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    method: r.method,
    requests: int(r.requests),
    paid: int(r.paid),
    rejected: int(r.rejected),
    success_pct: pct(r.paid, r.requests),
    paid_amount: round(r.paid_amount),
    avg_turnaround_hours: num(r.avg_hours, null) === null ? null : round(r.avg_hours, 1)
  }))
}

// ── C52: liability stress test ───────────────────────────────────────────────
// What the firm would owe if a given share of currently-active evaluation
// accounts passed and immediately withdrew at the observed average payout size
// for their model. Every input is measured; nothing is assumed except the
// scenario percentages themselves, which are labelled as scenarios.
async function stressTest () {
  const [active, avgPayout, cash] = await Promise.all([
    readPool.query(
      `SELECT COALESCE(challenge_model_slug, 'unknown') AS model_slug,
              COUNT(*)::int AS active_accounts
         FROM accounts
        WHERE status = 'active'
          AND account_type IN ('phase1', 'phase2')
        GROUP BY 1`
    ),
    readPool.query(
      `SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
              COALESCE(AVG(p.amount_payable), 0) AS avg_payout
         FROM payouts p
         JOIN accounts a ON a.id = p.account_id
        WHERE p.status = 'paid'
        GROUP BY 1`
    ),
    readPool.query(
      `SELECT COALESCE(SUM(gross_revenue), 0) AS revenue_90
         FROM revenue_daily
        WHERE revenue_date >= CURRENT_DATE - 90`
    )
  ])

  const payoutBySlug = new Map(avgPayout.rows.map((r) => [r.model_slug, num(r.avg_payout)]))
  const revenue90 = num(cash.rows[0]?.revenue_90)

  const models = active.rows.map((r) => ({
    model_slug: r.model_slug,
    active_accounts: int(r.active_accounts),
    avg_payout: round(payoutBySlug.get(r.model_slug) ?? 0),
    has_payout_history: payoutBySlug.has(r.model_slug)
  }))

  const scenarios = [5, 10, 20, 35].map((sharePct) => {
    const liability = models.reduce(
      (sum, m) => sum + (m.active_accounts * (sharePct / 100) * (payoutBySlug.get(m.model_slug) ?? 0)),
      0
    )
    return {
      pass_share_pct: sharePct,
      accounts: Math.round(models.reduce((s, m) => s + m.active_accounts, 0) * (sharePct / 100)),
      liability: round(liability),
      // Coverage against the last 90 days of sales, the only cash figure the
      // database actually holds. It is not a treasury balance and is labelled
      // that way in the UI.
      coverage_vs_90d_revenue_pct: pct(liability, revenue90)
    }
  })

  return {
    models,
    revenue_90d: round(revenue90),
    scenarios,
    note: models.some((m) => !m.has_payout_history)
      ? 'Models with no payout history contribute zero to these scenarios — their true exposure is unknown, not zero.'
      : null
  }
}

async function build (range) {
  const [
    forecast, pipe, distribution, cadence, leakage,
    flags, ratioRows, methods, stress
  ] = await Promise.all([
    liabilityForecast(),
    pipeline(range),
    payoutDistribution(range),
    payoutCadence(range),
    splitLeakage(range),
    flagged(range),
    payoutToRevenue(),
    paymentMethods(range),
    stressTest()
  ])

  return {
    generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    forecast,                    // C41
    pipeline: pipe,              // C42, C43
    distribution,                // C44, C47
    cadence,                     // C45, C46
    split_leakage: leakage,      // C48
    flagged: flags,              // C49
    payout_to_revenue: ratioRows, // C50
    payment_methods: methods,    // C51
    stress                       // C52
  }
}

module.exports = { build }
