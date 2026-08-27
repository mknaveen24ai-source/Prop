// Firm Intelligence → Growth tab (metrics E78–E95).
//
// Acquisition, activation, retention, affiliate quality, competitions and
// geography. Several of these only became answerable with migration 040, which
// added campaign attribution to `marketing_funnel_events`, a `marketing_spend`
// ledger, and `login_logs.country`.
//
// Where attribution data has not accumulated yet the metric returns its real
// (possibly empty) shape plus an `attribution_available` flag — the UI renders
// "no attributed traffic yet", never a made-up channel split.

const { readPool } = require('../../db')
const {
  num, int, round, pct, ratio, fillDailySeries, twoProportionZTest
} = require('./helpers')

// ── E78, E79: acquisition funnel, overall and by source ──────────────────────
async function acquisitionFunnel (range) {
  const stages = await readPool.query(
    `SELECT event_type,
            COUNT(*)::int                       AS events,
            COUNT(DISTINCT session_id)::int     AS sessions
       FROM marketing_funnel_events
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY event_type`,
    [range.fromTs, range.toTs]
  )

  const [signups, orders] = await Promise.all([
    readPool.query(
      `SELECT COUNT(*)::int AS signups
         FROM users
        WHERE is_bot = false AND created_at BETWEEN $1 AND $2`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
              COUNT(*)::int                                AS created
         FROM challenge_orders
        WHERE created_at BETWEEN $1 AND $2`,
      [range.fromTs, range.toTs]
    )
  ])

  const stageMap = new Map(stages.rows.map((r) => [r.event_type, r]))
  const visits = int(stageMap.get('visit')?.sessions)
  const signupCount = int(signups.rows[0]?.signups)
  const ordersCreated = int(orders.rows[0]?.created)
  const ordersPaid = int(orders.rows[0]?.paid)

  // By source. Attribution is taken from the session's EARLIEST event — first
  // touch — because that is the visit the campaign actually paid for.
  const bySource = await readPool.query(
    `WITH first_touch AS (
       SELECT DISTINCT ON (session_id)
              session_id,
              COALESCE(utm_source, 'direct') AS source,
              utm_medium,
              utm_campaign,
              user_id
         FROM marketing_funnel_events
        WHERE created_at BETWEEN $1 AND $2
          AND session_id IS NOT NULL
        ORDER BY session_id, created_at ASC
     ),
     stitched AS (
       SELECT ft.source, ft.utm_medium, ft.utm_campaign,
              ft.session_id,
              MAX(fe.user_id::text) AS user_id
         FROM first_touch ft
         LEFT JOIN marketing_funnel_events fe
                ON fe.session_id = ft.session_id AND fe.user_id IS NOT NULL
        GROUP BY 1, 2, 3, 4
     )
     SELECT s.source,
            s.utm_medium,
            s.utm_campaign,
            COUNT(*)::int                                  AS sessions,
            COUNT(s.user_id)::int                          AS signups,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM challenge_orders o
               WHERE o.user_id = s.user_id AND o.status = 'paid'
            ))::int                                        AS buyers,
            COALESCE(SUM((
              SELECT COALESCE(SUM(o.amount), 0) FROM challenge_orders o
               WHERE o.user_id = s.user_id AND o.status = 'paid'
            )), 0)                                         AS revenue
       FROM stitched s
      GROUP BY 1, 2, 3
      ORDER BY sessions DESC
      LIMIT 50`,
    [range.fromTs, range.toTs]
  )

  // signup_source is a self-reported field on the user row and predates
  // migration 040; kept alongside UTM rather than merged, because they measure
  // different things and averaging them would be worse than showing both.
  const bySignupSource = await readPool.query(
    `SELECT COALESCE(NULLIF(TRIM(u.signup_source), ''), 'direct') AS signup_source,
            COUNT(*)::int AS signups,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM challenge_orders o
               WHERE o.user_id = u.id::text AND o.status = 'paid'
            ))::int AS buyers
       FROM users u
      WHERE u.is_bot = false
        AND u.created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY signups DESC`,
    [range.fromTs, range.toTs]
  )

  const attributed = bySource.rows.some((r) => r.source && r.source !== 'direct')

  return {
    stages: [
      { stage: 'Visit', count: visits },
      { stage: 'Pricing viewed', count: int(stageMap.get('view_pricing')?.sessions) },
      { stage: 'Checkout started', count: int(stageMap.get('start_checkout')?.sessions) },
      { stage: 'Registered', count: signupCount },
      { stage: 'Order created', count: ordersCreated },
      { stage: 'Order paid', count: ordersPaid }
    ],
    conversion: {
      visit_to_signup_pct: pct(signupCount, visits),
      signup_to_order_pct: pct(ordersCreated, signupCount),
      order_to_paid_pct: pct(ordersPaid, ordersCreated),
      visit_to_paid_pct: pct(ordersPaid, visits)
    },
    attribution_available: attributed,
    attribution_note: attributed
      ? null
      : 'No UTM-tagged traffic recorded in this window. Campaign columns were added in migration 040 and only populate for visits that arrive with utm_* parameters.',
    by_source: bySource.rows.map((r) => ({
      source: r.source,
      medium: r.utm_medium,
      campaign: r.utm_campaign,
      sessions: int(r.sessions),
      signups: int(r.signups),
      buyers: int(r.buyers),
      revenue: round(r.revenue),
      signup_pct: pct(r.signups, r.sessions),
      buyer_pct: pct(r.buyers, r.signups),
      revenue_per_session: ratio(r.revenue, r.sessions)
    })),
    by_signup_source: bySignupSource.rows.map((r) => ({
      signup_source: r.signup_source,
      signups: int(r.signups),
      buyers: int(r.buyers),
      conversion_pct: pct(r.buyers, r.signups)
    }))
  }
}

// ── E80, E95: activation and signup-to-revenue lag ───────────────────────────
async function activation (range) {
  const { rows } = await readPool.query(
    `WITH cohort AS (
       SELECT u.id, u.created_at
         FROM users u
        WHERE u.is_bot = false AND u.created_at BETWEEN $1 AND $2
     ),
     first_trade AS (
       SELECT a.user_id,
              MIN(t.open_time) AS first_trade_at
         FROM trades t
         JOIN accounts a ON a.id = t.account_id
        GROUP BY a.user_id
     ),
     first_order AS (
       SELECT o.user_id, MIN(o.paid_at) AS first_paid_at
         FROM challenge_orders o
        WHERE o.status = 'paid'
        GROUP BY o.user_id
     )
     SELECT COUNT(*)::int                           AS signups,
            COUNT(ft.first_trade_at)::int           AS activated,
            COUNT(fo.first_paid_at)::int            AS converted,
            AVG(EXTRACT(EPOCH FROM (ft.first_trade_at - c.created_at)) / 3600.0) AS avg_hours_to_first_trade,
            AVG(EXTRACT(EPOCH FROM (fo.first_paid_at - c.created_at)) / 86400.0) AS avg_days_to_first_order
       FROM cohort c
       LEFT JOIN first_trade ft ON ft.user_id = c.id
       LEFT JOIN first_order fo ON fo.user_id = c.id::text`,
    [range.fromTs, range.toTs]
  )

  const lag = await readPool.query(
    `WITH cohort AS (
       SELECT u.id, u.created_at
         FROM users u
        WHERE u.is_bot = false AND u.created_at BETWEEN $1 AND $2
     ),
     first_order AS (
       SELECT o.user_id, MIN(o.paid_at) AS first_paid_at
         FROM challenge_orders o
        WHERE o.status = 'paid'
        GROUP BY o.user_id
     )
     SELECT WIDTH_BUCKET(
              EXTRACT(EPOCH FROM (fo.first_paid_at - c.created_at)) / 86400.0,
              0, 30, 6
            ) AS bucket,
            COUNT(*)::int AS users
       FROM cohort c
       JOIN first_order fo ON fo.user_id = c.id::text
      WHERE fo.first_paid_at >= c.created_at
      GROUP BY 1
      ORDER BY 1`,
    [range.fromTs, range.toTs]
  )

  const r = rows[0] || {}
  const BUCKET_LABELS = ['0–5d', '5–10d', '10–15d', '15–20d', '20–25d', '25–30d', '30d+']

  return {
    signups: int(r.signups),
    activated: int(r.activated),
    activation_pct: pct(r.activated, r.signups),
    converted: int(r.converted),
    conversion_pct: pct(r.converted, r.signups),
    avg_hours_to_first_trade: num(r.avg_hours_to_first_trade, null) === null ? null : round(r.avg_hours_to_first_trade, 1),
    avg_days_to_first_order: num(r.avg_days_to_first_order, null) === null ? null : round(r.avg_days_to_first_order, 1),
    lag_histogram: lag.rows.map((row) => ({
      bucket: BUCKET_LABELS[Math.min(int(row.bucket), BUCKET_LABELS.length - 1)] || '30d+',
      users: int(row.users)
    }))
  }
}

// ── E81: A/B experiment readouts ─────────────────────────────────────────────
async function experiments (range) {
  const { rows } = await readPool.query(
    `SELECT e.key, e.name, e.status, e.outcome_metric, e.created_at,
            ev.variant_key,
            COUNT(*)::int                                     AS events,
            COUNT(DISTINCT ev.user_id)::int                   AS users,
            COUNT(*) FILTER (WHERE ev.outcome_value > 0)::int AS conversions,
            COALESCE(SUM(ev.outcome_value), 0)                AS outcome_total
       FROM ab_experiments e
       LEFT JOIN ab_experiment_events ev
              ON ev.experiment_key = e.key
             AND ev.occurred_at BETWEEN $1 AND $2
      GROUP BY e.key, e.name, e.status, e.outcome_metric, e.created_at, ev.variant_key
      ORDER BY e.created_at DESC, ev.variant_key`,
    [range.fromTs, range.toTs]
  )

  const byExperiment = new Map()
  for (const r of rows) {
    if (!byExperiment.has(r.key)) {
      byExperiment.set(r.key, {
        key: r.key,
        name: r.name,
        status: r.status,
        outcome_metric: r.outcome_metric,
        created_at: r.created_at,
        variants: []
      })
    }
    if (!r.variant_key) continue
    byExperiment.get(r.key).variants.push({
      variant_key: r.variant_key,
      events: int(r.events),
      users: int(r.users),
      conversions: int(r.conversions),
      conversion_pct: pct(r.conversions, r.users),
      outcome_total: round(r.outcome_total)
    })
  }

  return [...byExperiment.values()].map((exp) => {
    // Significance is only reported against the FIRST variant as control, and
    // only when the normal approximation actually holds — twoProportionZTest
    // returns null rather than a misleading p-value on tiny samples.
    const [control, ...rest] = exp.variants
    const comparisons = control
      ? rest.map((v) => ({
        variant_key: v.variant_key,
        vs_control: control.variant_key,
        lift_pct_points: (v.conversion_pct !== null && control.conversion_pct !== null)
          ? round(v.conversion_pct - control.conversion_pct)
          : null,
        test: twoProportionZTest(v.conversions, v.users, control.conversions, control.users)
      }))
      : []
    return { ...exp, comparisons }
  })
}

// ── E82, E83, E84: retention, dormancy, reactivation ─────────────────────────
async function retention (range) {
  const cohorts = await readPool.query(
    `WITH cohort AS (
       SELECT u.id, DATE_TRUNC('week', u.created_at)::date AS cohort_week, u.created_at
         FROM users u
        WHERE u.is_bot = false
          AND u.created_at >= (CURRENT_DATE - INTERVAL '12 weeks')
     ),
     activity AS (
       SELECT a.user_id, t.open_time
         FROM trades t
         JOIN accounts a ON a.id = t.account_id
        WHERE t.open_time >= (CURRENT_DATE - INTERVAL '12 weeks')
     )
     SELECT c.cohort_week::text AS cohort_week,
            COUNT(DISTINCT c.id)::int AS cohort_size,
            COUNT(DISTINCT c.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM activity ac WHERE ac.user_id = c.id
                             AND ac.open_time >= c.created_at + INTERVAL '7 days'
                             AND ac.open_time <  c.created_at + INTERVAL '14 days')
            )::int AS week_1,
            COUNT(DISTINCT c.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM activity ac WHERE ac.user_id = c.id
                             AND ac.open_time >= c.created_at + INTERVAL '14 days'
                             AND ac.open_time <  c.created_at + INTERVAL '28 days')
            )::int AS week_2_3,
            COUNT(DISTINCT c.id) FILTER (
              WHERE EXISTS (SELECT 1 FROM activity ac WHERE ac.user_id = c.id
                             AND ac.open_time >= c.created_at + INTERVAL '28 days')
            )::int AS week_4_plus
       FROM cohort c
      GROUP BY c.cohort_week
      ORDER BY c.cohort_week`
  )

  const dormancy = await readPool.query(
    `WITH last_trade AS (
       SELECT a.id AS account_id, a.user_id, MAX(t.open_time) AS last_trade_at
         FROM accounts a
         LEFT JOIN trades t ON t.account_id = a.id
        WHERE a.status = 'active'
        GROUP BY a.id, a.user_id
     )
     SELECT COUNT(*)::int AS active_accounts,
            COUNT(*) FILTER (WHERE last_trade_at IS NULL)::int AS never_traded,
            COUNT(*) FILTER (WHERE last_trade_at < NOW() - INTERVAL '7 days')::int  AS dormant_7d,
            COUNT(*) FILTER (WHERE last_trade_at < NOW() - INTERVAL '14 days')::int AS dormant_14d,
            COUNT(*) FILTER (WHERE last_trade_at < NOW() - INTERVAL '30 days')::int AS dormant_30d
       FROM last_trade`
  )

  const reactivation = await readPool.query(
    `WITH lapsed AS (
       SELECT o.user_id, MAX(o.paid_at) AS last_order_at
         FROM challenge_orders o
        WHERE o.status = 'paid'
        GROUP BY o.user_id
       HAVING MAX(o.paid_at) < NOW() - INTERVAL '45 days'
     )
     SELECT COUNT(*)::int AS lapsed_buyers,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM challenge_orders o2
               WHERE o2.user_id = l.user_id
                 AND o2.status = 'paid'
                 AND o2.paid_at BETWEEN $1 AND $2
            ))::int AS reactivated
       FROM lapsed l`,
    [range.fromTs, range.toTs]
  )

  const d = dormancy.rows[0] || {}
  const ra = reactivation.rows[0] || {}

  return {
    cohorts: cohorts.rows.map((r) => ({
      cohort_week: r.cohort_week,
      cohort_size: int(r.cohort_size),
      week_1_pct: pct(r.week_1, r.cohort_size),
      week_2_3_pct: pct(r.week_2_3, r.cohort_size),
      week_4_plus_pct: pct(r.week_4_plus, r.cohort_size)
    })),
    dormancy: {
      active_accounts: int(d.active_accounts),
      never_traded: int(d.never_traded),
      dormant_7d: int(d.dormant_7d),
      dormant_14d: int(d.dormant_14d),
      dormant_30d: int(d.dormant_30d),
      dormant_30d_pct: pct(d.dormant_30d, d.active_accounts)
    },
    reactivation: {
      lapsed_buyers: int(ra.lapsed_buyers),
      reactivated: int(ra.reactivated),
      reactivation_pct: pct(ra.reactivated, ra.lapsed_buyers),
      lapse_threshold_days: 45
    }
  }
}

// ── E85, E86, E87, E88: affiliate performance, quality and fraud ─────────────
async function affiliates (range) {
  const leaderboard = await readPool.query(
    `SELECT r.referrer_user_id,
            u.full_name, u.email, u.affiliate_code,
            COUNT(DISTINCT r.referred_user_id)::int AS referrals,
            COUNT(DISTINCT r.referred_user_id) FILTER (WHERE EXISTS (
              SELECT 1 FROM challenge_orders o
               WHERE o.user_id = r.referred_user_id::text AND o.status = 'paid'
            ))::int AS paying_referrals,
            COALESCE((SELECT SUM(c.commission_amount) FROM affiliate_commissions c
                       WHERE c.referrer_user_id = r.referrer_user_id), 0) AS commission_earned,
            COALESCE((SELECT SUM(o.amount) FROM challenge_orders o
                       WHERE o.status = 'paid'
                         AND o.user_id IN (
                           SELECT rr.referred_user_id::text FROM affiliate_referrals rr
                            WHERE rr.referrer_user_id = r.referrer_user_id
                         )), 0) AS referred_revenue
       FROM affiliate_referrals r
       LEFT JOIN users u ON u.id = r.referrer_user_id
      WHERE r.created_at BETWEEN $1 AND $2
      GROUP BY r.referrer_user_id, u.full_name, u.email, u.affiliate_code
      ORDER BY referred_revenue DESC
      LIMIT 50`,
    [range.fromTs, range.toTs]
  )

  // E86 — do referred traders behave differently once they are on the platform?
  const quality = await readPool.query(
    `WITH tagged AS (
       SELECT a.id, a.status,
              EXISTS (SELECT 1 FROM affiliate_referrals r WHERE r.referred_user_id = a.user_id) AS referred
         FROM accounts a
        WHERE a.created_at BETWEEN $1 AND $2
     ),
     payout AS (
       SELECT p.account_id, SUM(p.amount_payable) AS paid
         FROM payouts p WHERE p.status = 'paid'
        GROUP BY p.account_id
     )
     SELECT t.referred,
            COUNT(*)::int                                    AS accounts,
            COUNT(*) FILTER (WHERE t.status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE t.status IN ('failed','expired'))::int AS resolved_fail,
            COALESCE(SUM(po.paid), 0)                        AS payout_cost
       FROM tagged t
       LEFT JOIN payout po ON po.account_id = t.id
      GROUP BY t.referred`,
    [range.fromTs, range.toTs]
  )

  // E87 — a referrer and referee sharing a link cluster is the clearest
  // self-referral signal the platform holds, since the linking engine already
  // scores shared devices, IPs and identity documents.
  const fraud = await readPool.query(
    `SELECT r.referrer_user_id, r.referred_user_id,
            ru.full_name AS referrer_name, ru.email AS referrer_email,
            du.full_name AS referred_name, du.email AS referred_email,
            r.created_at,
            COALESCE(SUM(c.commission_amount), 0) AS commission
       FROM affiliate_referrals r
       LEFT JOIN users ru ON ru.id = r.referrer_user_id
       LEFT JOIN users du ON du.id = r.referred_user_id
       LEFT JOIN affiliate_commissions c ON c.referral_id = r.id
      WHERE EXISTS (
              SELECT 1
                FROM account_link_clusters cl
               WHERE cl.status <> 'false_positive'
                 AND cl.member_user_ids @> ARRAY[r.referrer_user_id, r.referred_user_id]::uuid[]
            )
      GROUP BY r.referrer_user_id, r.referred_user_id, ru.full_name, ru.email,
               du.full_name, du.email, r.created_at
      ORDER BY commission DESC
      LIMIT 50`
  )

  const commissionState = await readPool.query(
    `SELECT c.status,
            COUNT(*)::int                            AS commissions,
            COALESCE(SUM(c.commission_amount), 0)    AS amount
       FROM affiliate_commissions c
      WHERE c.earned_at BETWEEN $1 AND $2
      GROUP BY c.status
      ORDER BY amount DESC`,
    [range.fromTs, range.toTs]
  )

  const tiers = await readPool.query(
    `SELECT c.tier_rank,
            COUNT(*)::int                         AS commissions,
            COALESCE(AVG(c.commission_rate_pct), 0) AS avg_rate_pct,
            COALESCE(SUM(c.commission_amount), 0)   AS amount
       FROM affiliate_commissions c
      WHERE c.earned_at BETWEEN $1 AND $2
        AND c.tier_rank IS NOT NULL
      GROUP BY c.tier_rank
      ORDER BY c.tier_rank`,
    [range.fromTs, range.toTs]
  )

  const referredRow = quality.rows.find((r) => r.referred === true) || {}
  const organicRow = quality.rows.find((r) => r.referred === false) || {}
  const buildQuality = (row) => ({
    accounts: int(row.accounts),
    passed: int(row.passed),
    pass_rate_pct: pct(row.passed, int(row.passed) + int(row.resolved_fail)),
    payout_cost: round(row.payout_cost),
    payout_cost_per_account: ratio(row.payout_cost, row.accounts)
  })

  return {
    leaderboard: leaderboard.rows.map((r) => ({
      referrer_user_id: r.referrer_user_id,
      affiliate: r.full_name || r.email,
      affiliate_code: r.affiliate_code,
      referrals: int(r.referrals),
      paying_referrals: int(r.paying_referrals),
      conversion_pct: pct(r.paying_referrals, r.referrals),
      referred_revenue: round(r.referred_revenue),
      commission_earned: round(r.commission_earned),
      // Revenue the firm keeps for each commission dollar it pays this affiliate.
      revenue_per_commission_dollar: ratio(r.referred_revenue, r.commission_earned)
    })),
    quality: {
      referred: buildQuality(referredRow),
      organic: buildQuality(organicRow)
    },
    self_referral_suspects: fraud.rows.map((r) => ({
      referrer: r.referrer_name || r.referrer_email,
      referred: r.referred_name || r.referred_email,
      referrer_user_id: r.referrer_user_id,
      referred_user_id: r.referred_user_id,
      created_at: r.created_at,
      commission: round(r.commission),
      evidence: 'Referrer and referee appear in the same account-link cluster'
    })),
    commission_state: commissionState.rows.map((r) => ({
      status: r.status,
      commissions: int(r.commissions),
      amount: round(r.amount)
    })),
    tiers: tiers.rows.map((r) => ({
      tier_rank: int(r.tier_rank),
      commissions: int(r.commissions),
      avg_rate_pct: round(r.avg_rate_pct),
      amount: round(r.amount)
    }))
  }
}

// ── E89: referral seasons ────────────────────────────────────────────────────
async function referralSeasons () {
  const { rows } = await readPool.query(
    `SELECT s.id, s.slug, s.title, s.status, s.start_at, s.end_at,
            COUNT(e.id)::int                                     AS entrants,
            COALESCE(SUM(e.new_paying_referrals), 0)::int        AS paying_referrals,
            (SELECT COUNT(*) FROM referral_season_prize_vouchers v
              WHERE v.season_id = s.id)::int                     AS prize_vouchers
       FROM referral_seasons s
       LEFT JOIN referral_season_entries e ON e.season_id = s.id
      GROUP BY s.id
      ORDER BY s.start_at DESC
      LIMIT 12`
  )

  return rows.map((r) => ({
    id: int(r.id),
    slug: r.slug,
    title: r.title,
    status: r.status,
    start_at: r.start_at,
    end_at: r.end_at,
    entrants: int(r.entrants),
    paying_referrals: int(r.paying_referrals),
    prize_vouchers: int(r.prize_vouchers),
    referrals_per_entrant: ratio(r.paying_referrals, r.entrants)
  }))
}

// ── E90, E91: competitions and their return ──────────────────────────────────
async function competitions (range) {
  const { rows } = await readPool.query(
    `SELECT c.id, c.slug, c.title, c.type, c.status, c.start_at, c.end_at, c.entry_fee,
            COUNT(e.id)::int                                            AS entries,
            COUNT(e.id) FILTER (WHERE e.status = 'active')::int         AS active_entries,
            COUNT(e.id) FILTER (WHERE e.final_rank IS NOT NULL)::int    AS completed,
            COUNT(e.id) FILTER (WHERE e.disqualified_reason IS NOT NULL)::int AS disqualified,
            COUNT(DISTINCT e.user_id)::int                              AS participants,
            (SELECT COUNT(*) FROM competition_prize_vouchers v WHERE v.competition_id = c.id)::int AS prize_vouchers
       FROM competitions c
       LEFT JOIN competition_entries e ON e.competition_id = c.id
      WHERE c.is_template = false
        AND c.start_at <= $2
        AND c.end_at   >= $1
      GROUP BY c.id
      ORDER BY c.start_at DESC
      LIMIT 25`,
    [range.fromTs, range.toTs]
  )

  // E91 — did participants buy a challenge after the competition ended? A real
  // before/after comparison on the same people, not a modelled attribution.
  const roi = await readPool.query(
    `SELECT c.id,
            COUNT(DISTINCT e.user_id)::int AS participants,
            COUNT(DISTINCT o.user_id)::int AS bought_after,
            COALESCE(SUM(o.amount), 0)     AS revenue_after
       FROM competitions c
       JOIN competition_entries e ON e.competition_id = c.id
       LEFT JOIN challenge_orders o
              ON o.user_id = e.user_id::text
             AND o.status = 'paid'
             AND o.paid_at > c.end_at
             AND o.paid_at <= c.end_at + INTERVAL '30 days'
      WHERE c.is_template = false
        AND c.end_at BETWEEN $1 AND $2
      GROUP BY c.id`,
    [range.fromTs, range.toTs]
  )

  const roiById = new Map(roi.rows.map((r) => [String(r.id), r]))

  return rows.map((r) => {
    const roiRow = roiById.get(String(r.id)) || {}
    return {
      id: int(r.id),
      slug: r.slug,
      title: r.title,
      type: r.type,
      status: r.status,
      start_at: r.start_at,
      end_at: r.end_at,
      entry_fee: num(r.entry_fee),
      entries: int(r.entries),
      participants: int(r.participants),
      active_entries: int(r.active_entries),
      completed: int(r.completed),
      completion_pct: pct(r.completed, r.entries),
      disqualified: int(r.disqualified),
      disqualification_pct: pct(r.disqualified, r.entries),
      prize_vouchers: int(r.prize_vouchers),
      followed_by_purchase: int(roiRow.bought_after),
      revenue_30d_after: round(roiRow.revenue_after),
      purchase_rate_pct: pct(roiRow.bought_after, roiRow.participants)
    }
  })
}

// ── E92: geography ───────────────────────────────────────────────────────────
async function geography (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(NULLIF(TRIM(u.country), ''), 'Unknown') AS country,
            COUNT(*)::int AS signups,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM challenge_orders o WHERE o.user_id = u.id::text AND o.status = 'paid'
            ))::int AS buyers,
            COALESCE((SELECT SUM(o.amount) FROM challenge_orders o
                       WHERE o.status = 'paid'
                         AND o.user_id IN (SELECT id::text FROM users u2 WHERE u2.country = u.country)), 0) AS revenue,
            (SELECT COUNT(*) FROM accounts a
               JOIN users u3 ON u3.id = a.user_id
              WHERE u3.country = u.country AND a.status = 'passed')::int AS passed_accounts,
            (SELECT COUNT(*) FROM accounts a
               JOIN users u4 ON u4.id = a.user_id
              WHERE u4.country = u.country AND a.status IN ('passed','failed','expired'))::int AS resolved_accounts
       FROM users u
      WHERE u.is_bot = false
        AND u.created_at BETWEEN $1 AND $2
      GROUP BY u.country
      ORDER BY signups DESC
      LIMIT 40`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    country: r.country,
    signups: int(r.signups),
    buyers: int(r.buyers),
    conversion_pct: pct(r.buyers, r.signups),
    revenue: round(r.revenue),
    pass_rate_pct: pct(r.passed_accounts, r.resolved_accounts),
    revenue_per_signup: ratio(r.revenue, r.signups)
  }))
}

// ── E93: email effectiveness ─────────────────────────────────────────────────
async function emailEffectiveness (range) {
  const { rows } = await readPool.query(
    `SELECT template_key,
            COUNT(*)::int                                  AS jobs,
            COUNT(*) FILTER (WHERE status = 'sent')::int   AS sent,
            COUNT(*) FILTER (WHERE status IN ('failed','dead'))::int AS failed,
            COUNT(*) FILTER (WHERE status IN ('pending','retry','sending'))::int AS queued,
            COALESCE(AVG(attempt_count), 0)                AS avg_attempts
       FROM email_jobs
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY template_key
      ORDER BY jobs DESC
      LIMIT 40`,
    [range.fromTs, range.toTs]
  )

  return {
    templates: rows.map((r) => ({
      template_key: r.template_key,
      jobs: int(r.jobs),
      sent: int(r.sent),
      failed: int(r.failed),
      queued: int(r.queued),
      delivery_pct: pct(r.sent, r.jobs),
      avg_attempts: round(r.avg_attempts, 2)
    })),
    note: 'Delivery only. The platform records no open or click events, so engagement rates are deliberately absent rather than approximated from sends.'
  }
}

// ── E94: public-page engagement vs conversion ────────────────────────────────
async function publicPages (range) {
  const { rows } = await readPool.query(
    `SELECT event_type,
            COUNT(*)::int                   AS events,
            COUNT(DISTINCT session_id)::int AS sessions
       FROM marketing_funnel_events
      WHERE created_at BETWEEN $1 AND $2
        AND event_type IN ('view_leaderboard', 'view_transparency', 'view_pricing')
      GROUP BY event_type`,
    [range.fromTs, range.toTs]
  )

  return {
    pages: rows.map((r) => ({
      page: r.event_type,
      events: int(r.events),
      sessions: int(r.sessions)
    })),
    tracked_since_note: 'These stages exist only from migration 040 onward — earlier traffic was recorded as a bare visit and cannot be reclassified.'
  }
}

// ── Daily signup / order series for the tab header ───────────────────────────
async function dailySeries (range) {
  const { rows } = await readPool.query(
    `SELECT revenue_date::text AS date, signups, orders_paid, new_buyers, returning_buyers
       FROM revenue_daily
      WHERE revenue_date BETWEEN $1::date AND $2::date
      ORDER BY revenue_date`,
    [range.from, range.to]
  )
  return fillDailySeries(rows, {
    from: range.from,
    to: range.to,
    fields: ['signups', 'orders_paid', 'new_buyers', 'returning_buyers']
  })
}

async function build (range) {
  const [
    funnel, act, exps, ret, aff, seasons, comps, geo, email, pages, series
  ] = await Promise.all([
    acquisitionFunnel(range),
    activation(range),
    experiments(range),
    retention(range),
    affiliates(range),
    referralSeasons(),
    competitions(range),
    geography(range),
    emailEffectiveness(range),
    publicPages(range),
    dailySeries(range)
  ])

  return {
    generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    daily: series,
    funnel,             // E78, E79
    activation: act,    // E80, E95
    experiments: exps,  // E81
    retention: ret,     // E82, E83, E84
    affiliates: aff,    // E85, E86, E87, E88
    referral_seasons: seasons, // E89
    competitions: comps,       // E90, E91
    geography: geo,     // E92
    email,              // E93
    public_pages: pages // E94
  }
}

module.exports = { build }
