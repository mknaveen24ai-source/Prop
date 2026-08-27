// Firm Intelligence → Revenue tab (metrics A1–A25).
//
// Sources: challenge_orders (the only real revenue product in this app),
// challenge_payments, challenge_checkout_sessions, coupon_redemptions,
// gift_vouchers, affiliate_commissions, payouts, users, accounts, and the
// revenue_daily / trade_daily_stats rollups from migration 039.
//
// Two things this module deliberately does NOT do:
//
//   - It does not invent a "reset fee" or subscription product. There is one
//     revenue line in this platform: a paid challenge order. Everything below
//     decomposes that single line rather than implying a product mix that does
//     not exist.
//
//   - It does not fabricate CAC. Customer acquisition cost comes exclusively
//     from the operator-entered `marketing_spend` ledger (migration 040). With
//     an empty ledger, A15/A16 come back null and the UI says why.

const { readPool } = require('../../db')
const {
  num, int, round, pct, ratio, fillDailySeries, median
} = require('./helpers')

// ── A1, A2, A22: revenue series, net revenue, buyer mix ──────────────────────
async function revenueSeries (range) {
  const { rows } = await readPool.query(
    `SELECT revenue_date::text AS date,
            orders_paid, gross_revenue, discount_total,
            affiliate_commission, payouts_paid, payouts_count,
            new_buyers, returning_buyers, signups
       FROM revenue_daily
      WHERE revenue_date BETWEEN $1::date AND $2::date
      ORDER BY revenue_date`,
    [range.from, range.to]
  )

  const daily = fillDailySeries(rows, {
    from: range.from,
    to: range.to,
    fields: [
      'orders_paid', 'gross_revenue', 'discount_total', 'affiliate_commission',
      'payouts_paid', 'payouts_count', 'new_buyers', 'returning_buyers', 'signups'
    ]
  })

  // Provider split cannot come from the rollup (it is a per-day total), so it
  // is a second, narrow query rather than widening the rollup for one chart.
  const providers = await readPool.query(
    `SELECT COALESCE(payment_provider, paid_via, 'unknown') AS provider,
            COUNT(*)::int                                    AS orders,
            COALESCE(SUM(amount), 0)                         AS revenue
       FROM challenge_orders
      WHERE status = 'paid'
        AND paid_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY revenue DESC`,
    [range.fromTs, range.toTs]
  )

  const totals = daily.reduce((acc, d) => {
    acc.gross_revenue += d.gross_revenue
    acc.orders_paid += d.orders_paid
    acc.discount_total += d.discount_total
    acc.affiliate_commission += d.affiliate_commission
    acc.payouts_paid += d.payouts_paid
    acc.new_buyers += d.new_buyers
    acc.returning_buyers += d.returning_buyers
    acc.signups += d.signups
    return acc
  }, {
    gross_revenue: 0, orders_paid: 0, discount_total: 0, affiliate_commission: 0,
    payouts_paid: 0, new_buyers: 0, returning_buyers: 0, signups: 0
  })

  return {
    daily,
    providers: providers.rows.map((r) => ({
      provider: r.provider,
      orders: int(r.orders),
      revenue: round(r.revenue)
    })),
    totals: {
      gross_revenue: round(totals.gross_revenue),
      orders_paid: totals.orders_paid,
      discount_total: round(totals.discount_total),
      affiliate_commission: round(totals.affiliate_commission),
      payouts_paid: round(totals.payouts_paid),
      // A2 — net after every deduction the database actually records.
      net_revenue: round(totals.gross_revenue - totals.affiliate_commission - totals.payouts_paid),
      avg_order_value: ratio(totals.gross_revenue, totals.orders_paid),
      new_buyers: totals.new_buyers,
      returning_buyers: totals.returning_buyers,
      returning_buyer_share_pct: pct(totals.returning_buyers, totals.new_buyers + totals.returning_buyers)
    }
  }
}

// ── A3: ARPU / ARPA by signup cohort month ───────────────────────────────────
async function cohortArpu () {
  const { rows } = await readPool.query(
    `WITH cohort AS (
       SELECT u.id, DATE_TRUNC('month', u.created_at)::date AS cohort_month
         FROM users u
        WHERE u.is_bot = false
          AND u.created_at >= (CURRENT_DATE - INTERVAL '12 months')
     ),
     spend AS (
       SELECT o.user_id, COALESCE(SUM(o.amount), 0) AS revenue, COUNT(*)::int AS orders
         FROM challenge_orders o
        WHERE o.status = 'paid'
        GROUP BY o.user_id
     ),
     acct AS (
       SELECT a.user_id, COUNT(*)::int AS accounts
         FROM accounts a
        GROUP BY a.user_id
     )
     SELECT c.cohort_month::text            AS cohort_month,
            COUNT(*)::int                   AS users,
            COALESCE(SUM(s.revenue), 0)     AS revenue,
            COALESCE(SUM(s.orders), 0)::int AS orders,
            COALESCE(SUM(ac.accounts), 0)::int AS accounts
       FROM cohort c
       LEFT JOIN spend s  ON s.user_id = c.id::text
       LEFT JOIN acct  ac ON ac.user_id = c.id
      GROUP BY c.cohort_month
      ORDER BY c.cohort_month`
  )

  return rows.map((r) => ({
    cohort_month: r.cohort_month,
    users: int(r.users),
    revenue: round(r.revenue),
    orders: int(r.orders),
    accounts: int(r.accounts),
    arpu: ratio(r.revenue, r.users),
    arpa: ratio(r.revenue, r.accounts)
  }))
}

// ── A4, A5, A23: revenue cuts ────────────────────────────────────────────────
async function revenueCuts (range) {
  const [bySize, byModel, byCountry] = await Promise.all([
    readPool.query(
      `SELECT account_size::numeric AS account_size,
              COUNT(*)::int         AS orders,
              COALESCE(SUM(amount), 0) AS revenue
         FROM challenge_orders
        WHERE status = 'paid' AND paid_at BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT COALESCE(o.challenge_model_slug, 'unknown')          AS model_slug,
              COALESCE(m.name, o.challenge_model_slug, 'Unknown')  AS model_name,
              COALESCE(m.steps, 0)::int  AS steps,
              COUNT(*)::int              AS orders,
              COALESCE(SUM(o.amount), 0) AS revenue
         FROM challenge_orders o
         LEFT JOIN challenge_models m ON m.slug = o.challenge_model_slug
        WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
        GROUP BY 1, 2, 3 ORDER BY revenue DESC`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT COALESCE(u.country, 'Unknown') AS country,
              o.currency,
              COUNT(*)::int                  AS orders,
              COALESCE(SUM(o.amount), 0)     AS revenue
         FROM challenge_orders o
         JOIN users u ON u.id::text = o.user_id
        WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
        GROUP BY 1, 2 ORDER BY revenue DESC LIMIT 40`,
      [range.fromTs, range.toTs]
    )
  ])

  return {
    by_account_size: bySize.rows.map((r) => ({
      account_size: num(r.account_size),
      orders: int(r.orders),
      revenue: round(r.revenue),
      avg_price: ratio(r.revenue, r.orders)
    })),
    by_model: byModel.rows.map((r) => ({
      model_slug: r.model_slug,
      model_name: r.model_name,
      steps: int(r.steps),
      orders: int(r.orders),
      revenue: round(r.revenue),
      avg_price: ratio(r.revenue, r.orders)
    })),
    by_country: byCountry.rows.map((r) => ({
      country: r.country,
      currency: r.currency,
      orders: int(r.orders),
      revenue: round(r.revenue)
    }))
  }
}

// ── A6, A7, A8: checkout conversion, abandonment, provider quality ───────────
async function checkoutFunnel (range) {
  const { rows } = await readPool.query(
    `WITH windowed AS (
       SELECT o.id, o.status, o.created_at, o.paid_at, o.amount,
              (SELECT COUNT(*) FROM challenge_checkout_sessions s WHERE s.order_id = o.id)::int AS sessions
         FROM challenge_orders o
        WHERE o.created_at BETWEEN $1 AND $2
     )
     SELECT COUNT(*)::int                                   AS orders_created,
            COUNT(*) FILTER (WHERE sessions > 0)::int       AS orders_with_session,
            COUNT(*) FILTER (WHERE status = 'paid')::int    AS orders_paid,
            COUNT(*) FILTER (WHERE status = 'pending')::int AS orders_pending,
            COUNT(*) FILTER (WHERE status NOT IN ('paid','pending'))::int AS orders_dead,
            COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)  AS paid_value,
            COALESCE(SUM(amount) FILTER (WHERE status <> 'paid'), 0) AS unconverted_value
       FROM windowed`,
    [range.fromTs, range.toTs]
  )

  const r = rows[0] || {}
  const created = int(r.orders_created)
  const paid = int(r.orders_paid)

  // A7 — median rather than mean: one order paid three weeks late would drag an
  // average into meaninglessness.
  const timing = await readPool.query(
    `SELECT EXTRACT(EPOCH FROM (paid_at - created_at)) / 60.0 AS minutes
       FROM challenge_orders
      WHERE status = 'paid'
        AND paid_at IS NOT NULL
        AND paid_at BETWEEN $1 AND $2
        AND paid_at >= created_at`,
    [range.fromTs, range.toTs]
  )
  const minutes = timing.rows.map((row) => num(row.minutes)).filter((v) => Number.isFinite(v))

  const providerQuality = await readPool.query(
    `SELECT p.provider,
            COUNT(*)::int                                       AS attempts,
            COUNT(*) FILTER (WHERE p.status = 'succeeded')::int  AS succeeded,
            COUNT(*) FILTER (WHERE p.status = 'failed')::int     AS failed,
            COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'succeeded'), 0)              AS captured,
            COALESCE(SUM(p.platform_fee_amount) FILTER (WHERE p.status = 'succeeded'), 0) AS platform_fees,
            ROUND(AVG(EXTRACT(EPOCH FROM (p.updated_at - p.created_at)))::numeric, 1)     AS avg_settle_seconds
       FROM challenge_payments p
      WHERE p.created_at BETWEEN $1 AND $2
      GROUP BY p.provider
      ORDER BY attempts DESC`,
    [range.fromTs, range.toTs]
  )

  return {
    orders_created: created,
    orders_with_session: int(r.orders_with_session),
    orders_paid: paid,
    orders_pending: int(r.orders_pending),
    orders_dead: int(r.orders_dead),
    conversion_pct: pct(paid, created),
    abandonment_pct: pct(created - paid, created),
    paid_value: round(r.paid_value),
    unconverted_value: round(r.unconverted_value),
    time_to_pay_mins: {
      samples: minutes.length,
      median: minutes.length ? round(median(minutes), 1) : null,
      under_10_min_pct: minutes.length ? pct(minutes.filter((m) => m <= 10).length, minutes.length) : null,
      over_24h_pct: minutes.length ? pct(minutes.filter((m) => m > 1440).length, minutes.length) : null
    },
    providers: providerQuality.rows.map((row) => ({
      provider: row.provider,
      attempts: int(row.attempts),
      succeeded: int(row.succeeded),
      failed: int(row.failed),
      success_pct: pct(row.succeeded, row.attempts),
      captured: round(row.captured),
      platform_fees: round(row.platform_fees),
      avg_settle_seconds: num(row.avg_settle_seconds, null)
    }))
  }
}

// ── A9, A10, A24: coupon economics ───────────────────────────────────────────
async function couponEconomics (range) {
  const perCode = await readPool.query(
    `SELECT c.code,
            c.discount_type,
            c.discount_value,
            COUNT(r.id)::int                    AS redemptions,
            COALESCE(SUM(r.discount_amount), 0) AS discount_given,
            COALESCE(SUM(o.amount), 0)          AS revenue_after_discount,
            COUNT(DISTINCT r.user_id)::int      AS distinct_users
       FROM coupon_redemptions r
       JOIN coupon_codes c ON c.id = r.coupon_id
       LEFT JOIN challenge_orders o ON o.id = r.order_id AND o.status = 'paid'
      WHERE r.redeemed_at BETWEEN $1 AND $2
      GROUP BY c.code, c.discount_type, c.discount_value
      ORDER BY discount_given DESC`,
    [range.fromTs, range.toTs]
  )

  // A10 — how much of the book is sold at a markdown.
  const split = await readPool.query(
    `WITH paid AS (
       SELECT o.id, o.user_id, o.amount,
              EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.order_id = o.id) AS discounted
         FROM challenge_orders o
        WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
     )
     SELECT discounted,
            COUNT(*)::int                AS orders,
            COALESCE(SUM(amount), 0)     AS revenue,
            COUNT(DISTINCT user_id)::int AS buyers
       FROM paid GROUP BY discounted`,
    [range.fromTs, range.toTs]
  )

  const discountedRow = split.rows.find((r) => r.discounted === true) || {}
  const fullPriceRow = split.rows.find((r) => r.discounted === false) || {}
  const discountedRevenue = num(discountedRow.revenue)
  const fullPriceRevenue = num(fullPriceRow.revenue)
  const totalRevenue = discountedRevenue + fullPriceRevenue

  // A24 — realised vs list price. List price is the ACTIVE
  // challenge_model_pricing row for that model+size; an order with no matching
  // active price row is excluded rather than compared against a guess.
  const depth = await readPool.query(
    `SELECT COUNT(*)::int          AS comparable_orders,
            COALESCE(AVG(o.amount), 0) AS avg_realised,
            COALESCE(AVG(p.price), 0)  AS avg_list,
            COALESCE(AVG(CASE WHEN p.price > 0
                              THEN (1 - (o.amount / p.price)) * 100 END), 0) AS avg_discount_depth_pct
       FROM challenge_orders o
       JOIN challenge_models m ON m.slug = o.challenge_model_slug
       JOIN challenge_model_pricing p
         ON p.challenge_model_id = m.id
        AND p.account_size = o.account_size::int
        AND p.is_active = true
      WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2`,
    [range.fromTs, range.toTs]
  )
  const d = depth.rows[0] || {}

  return {
    per_code: perCode.rows.map((r) => ({
      code: r.code,
      discount_type: r.discount_type,
      discount_value: num(r.discount_value),
      redemptions: int(r.redemptions),
      distinct_users: int(r.distinct_users),
      discount_given: round(r.discount_given),
      revenue_after_discount: round(r.revenue_after_discount),
      // Dollars of revenue accompanying each discounted dollar. NOT a causal
      // uplift — the platform runs no coupon holdout — so the UI labels this a
      // ratio and never calls it incremental revenue.
      revenue_per_discount_dollar: ratio(r.revenue_after_discount, r.discount_given)
    })),
    cannibalisation: {
      discounted_orders: int(discountedRow.orders),
      discounted_revenue: round(discountedRevenue),
      discounted_buyers: int(discountedRow.buyers),
      full_price_orders: int(fullPriceRow.orders),
      full_price_revenue: round(fullPriceRevenue),
      full_price_buyers: int(fullPriceRow.buyers),
      discounted_revenue_share_pct: pct(discountedRevenue, totalRevenue)
    },
    discount_depth: {
      comparable_orders: int(d.comparable_orders),
      avg_realised_price: round(d.avg_realised),
      avg_list_price: round(d.avg_list),
      avg_discount_depth_pct: round(d.avg_discount_depth_pct)
    }
  }
}

// ── A11: gift vouchers ───────────────────────────────────────────────────────
async function giftVouchers (range) {
  const { rows } = await readPool.query(
    `SELECT COUNT(*)::int                                   AS issued,
            COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
            COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
            COUNT(*) FILTER (WHERE status = 'revoked')::int AS revoked,
            COALESCE(SUM(amount_paid), 0)                   AS amount_paid,
            ROUND(AVG(EXTRACT(EPOCH FROM (claimed_at - issued_at)) / 86400.0)::numeric, 2) AS avg_days_to_claim
       FROM gift_vouchers
      WHERE issued_at BETWEEN $1 AND $2`,
    [range.fromTs, range.toTs]
  )
  const r = rows[0] || {}
  return {
    issued: int(r.issued),
    claimed: int(r.claimed),
    expired: int(r.expired),
    revoked: int(r.revoked),
    amount_paid: round(r.amount_paid),
    redemption_pct: pct(r.claimed, r.issued),
    avg_days_to_claim: num(r.avg_days_to_claim, null)
  }
}

// ── A12, A19: repeat purchase and revenue concentration ──────────────────────
async function buyerDistribution (range) {
  const { rows } = await readPool.query(
    `SELECT o.user_id,
            COUNT(*)::int              AS orders,
            COALESCE(SUM(o.amount), 0) AS revenue
       FROM challenge_orders o
      WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
      GROUP BY o.user_id
      ORDER BY revenue DESC`,
    [range.fromTs, range.toTs]
  )

  const buyers = rows.map((r) => ({ orders: int(r.orders), revenue: num(r.revenue) }))
  const totalRevenue = buyers.reduce((sum, b) => sum + b.revenue, 0)
  const repeatBuyers = buyers.filter((b) => b.orders > 1).length

  const topShare = (fraction) => {
    if (buyers.length === 0 || totalRevenue === 0) return null
    const take = Math.max(1, Math.ceil(buyers.length * fraction))
    const slice = buyers.slice(0, take).reduce((sum, b) => sum + b.revenue, 0)
    return round((slice / totalRevenue) * 100)
  }

  const histogram = new Map()
  for (const b of buyers) {
    const bucket = b.orders >= 5 ? '5+' : String(b.orders)
    histogram.set(bucket, (histogram.get(bucket) || 0) + 1)
  }

  return {
    buyers: buyers.length,
    repeat_buyers: repeatBuyers,
    repeat_purchase_pct: pct(repeatBuyers, buyers.length),
    avg_orders_per_buyer: ratio(buyers.reduce((s, b) => s + b.orders, 0), buyers.length),
    orders_histogram: ['1', '2', '3', '4', '5+'].map((bucket) => ({
      orders: bucket,
      buyers: histogram.get(bucket) || 0
    })),
    concentration: {
      top_1_pct_share: topShare(0.01),
      top_5_pct_share: topShare(0.05),
      top_10_pct_share: topShare(0.10)
    }
  }
}

// ── A13: retry economics ─────────────────────────────────────────────────────
async function retryEconomics (range) {
  const { rows } = await readPool.query(
    `WITH failed AS (
       SELECT a.user_id, a.id, a.created_at, a.free_retries_remaining
         FROM accounts a
        WHERE a.status IN ('failed', 'expired')
          AND a.created_at BETWEEN $1 AND $2
     )
     SELECT COUNT(*)::int                                           AS failed_accounts,
            COUNT(*) FILTER (WHERE free_retries_remaining = 0)::int AS free_retry_consumed,
            COUNT(DISTINCT f.user_id)::int                          AS distinct_users,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM challenge_orders o
               WHERE o.user_id = f.user_id::text
                 AND o.status = 'paid'
                 AND o.paid_at > f.created_at
            ))::int                                                 AS followed_by_paid_order
       FROM failed f`,
    [range.fromTs, range.toTs]
  )
  const r = rows[0] || {}
  return {
    failed_accounts: int(r.failed_accounts),
    distinct_users: int(r.distinct_users),
    free_retry_consumed: int(r.free_retry_consumed),
    followed_by_paid_order: int(r.followed_by_paid_order),
    paid_recovery_pct: pct(r.followed_by_paid_order, r.failed_accounts)
  }
}

// ── A14, A15, A16: LTV, CAC, payback ─────────────────────────────────────────
async function lifetimeValue (range) {
  const cohorts = await readPool.query(
    `WITH cohort AS (
       SELECT u.id, DATE_TRUNC('month', u.created_at)::date AS cohort_month
         FROM users u
        WHERE u.is_bot = false
          AND u.created_at >= (CURRENT_DATE - INTERVAL '12 months')
     ),
     rev AS (
       SELECT c.cohort_month, COALESCE(SUM(o.amount), 0) AS revenue
         FROM cohort c
         JOIN challenge_orders o ON o.user_id = c.id::text AND o.status = 'paid'
        GROUP BY c.cohort_month
     ),
     pay AS (
       SELECT c.cohort_month, COALESCE(SUM(p.amount_payable), 0) AS payouts
         FROM cohort c
         JOIN payouts p ON p.user_id = c.id AND p.status = 'paid'
        GROUP BY c.cohort_month
     ),
     comm AS (
       SELECT c.cohort_month, COALESCE(SUM(ac.commission_amount), 0) AS commissions
         FROM cohort c
         JOIN affiliate_commissions ac ON ac.referred_user_id = c.id
        GROUP BY c.cohort_month
     )
     SELECT c.cohort_month::text        AS cohort_month,
            COUNT(*)::int               AS users,
            COALESCE(MAX(rev.revenue), 0)   AS revenue,
            COALESCE(MAX(pay.payouts), 0)   AS payouts,
            COALESCE(MAX(comm.commissions), 0) AS commissions
       FROM cohort c
       LEFT JOIN rev  ON rev.cohort_month  = c.cohort_month
       LEFT JOIN pay  ON pay.cohort_month  = c.cohort_month
       LEFT JOIN comm ON comm.cohort_month = c.cohort_month
      GROUP BY c.cohort_month
      ORDER BY c.cohort_month`
  )

  const spend = await readPool.query(
    `SELECT DATE_TRUNC('month', spend_date)::date::text AS month,
            COALESCE(SUM(amount), 0) AS amount
       FROM marketing_spend
      GROUP BY 1
      ORDER BY 1`
  )

  const spendByMonth = new Map(spend.rows.map((r) => [r.month, num(r.amount)]))

  const list = cohorts.rows.map((r) => {
    const users = int(r.users)
    const revenue = num(r.revenue)
    const payouts = num(r.payouts)
    const commissions = num(r.commissions)
    const contribution = revenue - payouts - commissions
    const monthSpend = spendByMonth.get(r.cohort_month)
    const cac = monthSpend != null && users > 0 ? monthSpend / users : null
    const ltv = users > 0 ? contribution / users : null

    return {
      cohort_month: r.cohort_month,
      users,
      revenue: round(revenue),
      payouts: round(payouts),
      affiliate_commissions: round(commissions),
      contribution: round(contribution),
      ltv: ltv === null ? null : round(ltv),
      cac: cac === null ? null : round(cac),
      ltv_cac_ratio: (ltv === null || !cac) ? null : round(ltv / cac),
      // Months to recoup the cohort's acquisition cost at its own observed
      // contribution rate. Null when there is no spend figure or contribution
      // is non-positive: "never pays back" and "we don't know" are different
      // answers and the UI renders them differently.
      payback_months: (!cac || contribution <= 0 || users === 0)
        ? null
        : round(((cac * users) / contribution) * (range.days / 30), 1)
    }
  })

  return {
    cohorts: list,
    cac_available: spendByMonth.size > 0,
    cac_note: spendByMonth.size > 0
      ? null
      : 'No rows in marketing_spend. CAC, LTV:CAC and payback stay blank until acquisition spend is recorded — they are never estimated.',
    range_note: 'Cohorts are signup months. Revenue and payouts are lifetime-to-date for those users, not clipped to the selected range.'
  }
}

// ── A17, A25: margin and break-even per model ────────────────────────────────
async function modelMargin (range) {
  const { rows } = await readPool.query(
    `WITH sold AS (
       SELECT COALESCE(o.challenge_model_slug, 'unknown') AS model_slug,
              COUNT(*)::int              AS orders,
              COALESCE(SUM(o.amount), 0) AS revenue
         FROM challenge_orders o
        WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
        GROUP BY 1
     ),
     outcomes AS (
       SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
              COUNT(*)::int                                          AS accounts,
              COUNT(*) FILTER (WHERE a.status = 'passed')::int       AS passed,
              COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded
         FROM accounts a
        WHERE a.created_at BETWEEN $1 AND $2
        GROUP BY 1
     ),
     paid_out AS (
       SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
              COALESCE(SUM(p.amount_payable), 0) AS payouts
         FROM payouts p
         JOIN accounts a ON a.id = p.account_id
        WHERE p.status = 'paid' AND p.paid_at BETWEEN $1 AND $2
        GROUP BY 1
     ),
     keys AS (
       SELECT model_slug FROM sold
       UNION SELECT model_slug FROM outcomes
       UNION SELECT model_slug FROM paid_out
     )
     SELECT k.model_slug,
            COALESCE(s.orders, 0)::int   AS orders,
            COALESCE(s.revenue, 0)       AS revenue,
            COALESCE(o.accounts, 0)::int AS accounts,
            COALESCE(o.passed, 0)::int   AS passed,
            COALESCE(o.funded, 0)::int   AS funded,
            COALESCE(po.payouts, 0)      AS payouts
       FROM keys k
       LEFT JOIN sold     s  ON s.model_slug  = k.model_slug
       LEFT JOIN outcomes o  ON o.model_slug  = k.model_slug
       LEFT JOIN paid_out po ON po.model_slug = k.model_slug
      ORDER BY revenue DESC`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => {
    const revenue = num(r.revenue)
    const payouts = num(r.payouts)
    const orders = int(r.orders)
    const funded = int(r.funded)
    const margin = revenue - payouts
    const avgPayout = funded > 0 ? payouts / funded : null

    return {
      model_slug: r.model_slug,
      orders,
      revenue: round(revenue),
      accounts: int(r.accounts),
      passed: int(r.passed),
      funded,
      pass_rate_pct: pct(r.passed, r.accounts),
      payouts: round(payouts),
      gross_margin: round(margin),
      gross_margin_pct: pct(margin, revenue),
      avg_price: ratio(revenue, orders),
      avg_payout: avgPayout === null ? null : round(avgPayout),
      // A25 — payouts of the observed average size this model's own sales can
      // absorb before margin hits zero. Null when the model has never paid out,
      // because the denominator would have to be invented.
      breakeven_payouts: (avgPayout && avgPayout > 0) ? Math.floor(revenue / avgPayout) : null
    }
  })
}

// ── A18: B-book edge ─────────────────────────────────────────────────────────
async function bbookEdge (range) {
  const [daily, byInstrument] = await Promise.all([
    readPool.query(
      `SELECT trading_date::text AS date,
              SUM(net_pnl)            AS demo_pnl,
              SUM(broker_pnl)         AS broker_pnl,
              SUM(trades_closed)::int AS trades
         FROM trade_daily_stats
        WHERE trading_date BETWEEN $1::date AND $2::date
        GROUP BY trading_date
        ORDER BY trading_date`,
      [range.from, range.to]
    ),
    readPool.query(
      `SELECT instrument,
              SUM(net_pnl)            AS demo_pnl,
              SUM(broker_pnl)         AS broker_pnl,
              SUM(trades_closed)::int AS trades,
              SUM(volume_lots)        AS volume_lots
         FROM trade_daily_stats
        WHERE trading_date BETWEEN $1::date AND $2::date
        GROUP BY instrument
        ORDER BY ABS(SUM(net_pnl)) DESC`,
      [range.from, range.to]
    )
  ])

  const series = daily.rows.map((r) => ({
    date: r.date,
    demo_pnl: round(r.demo_pnl),
    broker_pnl: round(r.broker_pnl),
    // Firm edge is the inverse of trader P&L on the demo book: what the book of
    // traders lost is what the firm did not have to fund.
    firm_edge: round(-num(r.demo_pnl)),
    trades: int(r.trades)
  }))

  return {
    daily: series,
    by_instrument: byInstrument.rows.map((r) => ({
      instrument: r.instrument,
      demo_pnl: round(r.demo_pnl),
      broker_pnl: round(r.broker_pnl),
      divergence: round(num(r.broker_pnl) - num(r.demo_pnl)),
      trades: int(r.trades),
      volume_lots: round(r.volume_lots, 2)
    })),
    totals: {
      demo_pnl: round(series.reduce((s, r) => s + r.demo_pnl, 0)),
      broker_pnl: round(series.reduce((s, r) => s + r.broker_pnl, 0)),
      firm_edge: round(series.reduce((s, r) => s + r.firm_edge, 0))
    }
  }
}

// ── A20: refunds and chargebacks ─────────────────────────────────────────────
async function refunds (range) {
  // The payment status vocabulary is provider-driven and unconstrained by the
  // schema, so rather than assuming a 'refunded' value exists this reports every
  // non-succeeded terminal status actually present and flags the refund-shaped
  // ones. An empty result means no such rows exist, not that the query is wrong.
  const { rows } = await readPool.query(
    `SELECT p.status,
            COUNT(*)::int              AS payments,
            COALESCE(SUM(p.amount), 0) AS amount
       FROM challenge_payments p
      WHERE p.created_at BETWEEN $1 AND $2
        AND p.status NOT IN ('succeeded', 'pending')
      GROUP BY p.status
      ORDER BY amount DESC`,
    [range.fromTs, range.toTs]
  )

  const REFUND_SHAPED = new Set(['refunded', 'refund', 'chargeback', 'disputed', 'reversed'])
  const statuses = rows.map((r) => ({
    status: r.status,
    payments: int(r.payments),
    amount: round(r.amount),
    refund_shaped: REFUND_SHAPED.has(String(r.status).toLowerCase())
  }))

  return {
    statuses,
    refund_amount: round(statuses.filter((s) => s.refund_shaped).reduce((sum, s) => sum + s.amount, 0)),
    note: statuses.length === 0
      ? 'No non-succeeded payment rows in this window. Refunds posted out of band by the provider would not appear here.'
      : null
  }
}

// ── A21: deferred revenue ────────────────────────────────────────────────────
async function deferredRevenue () {
  const [paidRows, progressRows] = await Promise.all([
    readPool.query(
      `SELECT COALESCE(SUM(o.amount), 0) AS paid_value,
              COUNT(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM accounts a
                 WHERE a.user_id::text = o.user_id
                   AND a.created_at >= o.paid_at
              ))::int AS unstarted_orders,
              COALESCE(SUM(o.amount) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM accounts a
                 WHERE a.user_id::text = o.user_id
                   AND a.created_at >= o.paid_at
              )), 0) AS unstarted_value
         FROM challenge_orders o
        WHERE o.status = 'paid'
          AND o.paid_at >= NOW() - INTERVAL '180 days'`
    ),
    readPool.query(
      `SELECT COUNT(*)::int AS accounts,
              COALESCE(SUM(a.account_size), 0) AS notional
         FROM accounts a
        WHERE a.status = 'active'
          AND a.account_type IN ('phase1', 'phase2')`
    )
  ])

  const r = paidRows.rows[0] || {}
  const p = progressRows.rows[0] || {}

  return {
    window_days: 180,
    paid_value: round(r.paid_value),
    unstarted_orders: int(r.unstarted_orders),
    unstarted_value: round(r.unstarted_value),
    in_progress_accounts: int(p.accounts),
    in_progress_notional: round(p.notional)
  }
}

async function build (range) {
  const [
    series, cohorts, cuts, funnel, coupons, gifts, buyers,
    retries, ltv, margins, bbook, refundRows, deferred
  ] = await Promise.all([
    revenueSeries(range),
    cohortArpu(),
    revenueCuts(range),
    checkoutFunnel(range),
    couponEconomics(range),
    giftVouchers(range),
    buyerDistribution(range),
    retryEconomics(range),
    lifetimeValue(range),
    modelMargin(range),
    bbookEdge(range),
    refunds(range),
    deferredRevenue()
  ])

  return {
    generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    series,                // A1, A2, A22
    cohort_arpu: cohorts,  // A3
    cuts,                  // A4, A5, A23
    checkout: funnel,      // A6, A7, A8
    coupons,               // A9, A10, A24
    gifts,                 // A11
    buyers,                // A12, A19
    retries,               // A13
    lifetime_value: ltv,   // A14, A15, A16
    model_margin: margins, // A17, A25
    bbook,                 // A18
    refunds: refundRows,   // A20
    deferred               // A21
  }
}

module.exports = { build }
