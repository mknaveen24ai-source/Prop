// Admin challenge funnel, cohort analytics, AML velocity.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin
} = require('../middleware')
require('../../loadEnv')

router.get('/challenge-funnel', authenticateAdmin, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE account_type = 'phase1') AS phase1_total,
         COUNT(*) FILTER (WHERE account_type = 'phase1' AND status = 'passed') AS phase1_passed,
         COUNT(*) FILTER (WHERE account_type = 'phase2') AS phase2_total,
         COUNT(*) FILTER (WHERE account_type = 'phase2' AND status = 'passed') AS phase2_passed,
         COUNT(*) FILTER (WHERE account_type = 'funded') AS funded_total,
         COUNT(*) FILTER (WHERE account_type = 'funded' AND status = 'active') AS funded_active,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_total,
         COUNT(*) FILTER (WHERE status = 'expired') AS expired_total
       FROM accounts`
    )

    const r = totals.rows[0] || {}
    const phase1Total = parseInt(r.phase1_total || 0, 10)
    const phase1Passed = parseInt(r.phase1_passed || 0, 10)
    const phase2Total = parseInt(r.phase2_total || 0, 10)
    const phase2Passed = parseInt(r.phase2_passed || 0, 10)
    const fundedTotal = parseInt(r.funded_total || 0, 10)
    const fundedActive = parseInt(r.funded_active || 0, 10)
    const failedTotal = parseInt(r.failed_total || 0, 10)
    const expiredTotal = parseInt(r.expired_total || 0, 10)

    const phase1PassRate = phase1Total > 0 ? parseFloat(((phase1Passed / phase1Total) * 100).toFixed(2)) : 0
    const phase2PassRate = phase2Total > 0 ? parseFloat(((phase2Passed / phase2Total) * 100).toFixed(2)) : 0
    const fundedActivationRate = fundedTotal > 0 ? parseFloat(((fundedActive / fundedTotal) * 100).toFixed(2)) : 0

    res.json({
      generated_at: new Date(),
      funnel: {
        phase1_total: phase1Total,
        phase1_passed: phase1Passed,
        phase1_pass_rate: phase1PassRate,
        phase2_total: phase2Total,
        phase2_passed: phase2Passed,
        phase2_pass_rate: phase2PassRate,
        funded_total: fundedTotal,
        funded_active: fundedActive,
        funded_activation_rate: fundedActivationRate
      },
      outcomes: {
        failed_total: failedTotal,
        expired_total: expiredTotal
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load challenge funnel' })
  }
})

router.get('/cohort-analytics', authenticateAdmin, async (req, res) => {
  try {
    const monthsBackRaw = parseInt(req.query.months || '12', 10)
    const monthsBack = Number.isFinite(monthsBackRaw) ? Math.max(3, Math.min(24, monthsBackRaw)) : 12
    const cohorts = await pool.query(
      `WITH user_base AS (
         SELECT
           u.id,
           DATE_TRUNC('month', u.created_at) AS cohort_month,
           CASE
             WHEN COALESCE(NULLIF(TRIM(u.referred_by), ''), '') <> '' THEN 'referral'
             ELSE 'direct'
           END AS source,
           COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
           COALESCE(u.kyc_status, 'pending') AS kyc_status
         FROM users u
         WHERE u.created_at >= NOW() - make_interval(months => $1::int)
       ),
       account_agg AS (
         SELECT
           a.user_id,
           COUNT(*)::int AS accounts_opened,
           COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
         FROM accounts a
         GROUP BY a.user_id
       ),
       payout_agg AS (
         SELECT
           p.user_id,
           COALESCE(SUM(p.amount_payable) FILTER (WHERE p.status = 'paid'), 0)::numeric AS paid_out
         FROM payouts p
         GROUP BY p.user_id
       )
       SELECT
         ub.cohort_month,
         ub.source,
         ub.country,
         COUNT(*)::int AS signups,
         COUNT(*) FILTER (WHERE ub.kyc_status = 'approved')::int AS kyc_approved,
         COALESCE(SUM(COALESCE(aa.accounts_opened, 0)), 0)::int AS accounts_opened,
         COALESCE(SUM(COALESCE(aa.funded_accounts, 0)), 0)::int AS funded_accounts,
         COALESCE(SUM(COALESCE(pa.paid_out, 0)), 0)::numeric AS paid_out
       FROM user_base ub
       LEFT JOIN account_agg aa ON aa.user_id = ub.id
       LEFT JOIN payout_agg pa ON pa.user_id = ub.id
       GROUP BY ub.cohort_month, ub.source, ub.country
       ORDER BY ub.cohort_month DESC, signups DESC`,
      [monthsBack]
    )

    const rows = cohorts.rows.map(r => ({
      cohort_month: r.cohort_month,
      source: r.source,
      country: r.country,
      signups: parseInt(r.signups || 0, 10),
      kyc_approved: parseInt(r.kyc_approved || 0, 10),
      accounts_opened: parseInt(r.accounts_opened || 0, 10),
      funded_accounts: parseInt(r.funded_accounts || 0, 10),
      paid_out: parseFloat(r.paid_out || 0)
    }))

    const monthlyMap = new Map()
    const countryMap = new Map()
    for (const r of rows) {
      const monthKey = r.cohort_month ? new Date(r.cohort_month).toISOString().slice(0, 7) : 'unknown'
      const m = monthlyMap.get(monthKey) || {
        month: monthKey,
        signups: 0,
        kyc_approved: 0,
        funded_accounts: 0,
        paid_out: 0
      }
      m.signups += r.signups
      m.kyc_approved += r.kyc_approved
      m.funded_accounts += r.funded_accounts
      m.paid_out += r.paid_out
      monthlyMap.set(monthKey, m)

      const c = countryMap.get(r.country) || { country: r.country, signups: 0 }
      c.signups += r.signups
      countryMap.set(r.country, c)
    }

    const monthly = Array.from(monthlyMap.values())
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(m => ({
        ...m,
        kyc_approval_rate: m.signups > 0 ? parseFloat(((m.kyc_approved / m.signups) * 100).toFixed(2)) : 0
      }))
    const top_countries = Array.from(countryMap.values())
      .sort((a, b) => b.signups - a.signups)
      .slice(0, 12)

    res.json({
      generated_at: new Date(),
      months_back: monthsBack,
      cohorts: rows,
      monthly,
      top_countries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cohort analytics' })
  }
})

router.get('/aml-velocity', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `WITH active_users AS (
         SELECT DISTINCT user_id::text FROM login_logs WHERE logged_in_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM trade_logs WHERE logged_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM payouts WHERE requested_at >= NOW() - INTERVAL '7 days'
       ),
       login_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '1 hour')::int AS login_1h,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours')::int AS login_24h,
           COUNT(DISTINCT ip_address) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours' AND ip_address IS NOT NULL)::int AS unique_ip_24h
         FROM login_logs
         GROUP BY user_id::text
       ),
       trade_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '1 hour')::int AS trade_1h,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '24 hours')::int AS trade_24h
         FROM trade_logs
         GROUP BY user_id::text
       ),
       payout_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days')::int AS payout_req_7d,
           COALESCE(SUM(amount_requested) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days'), 0)::numeric AS payout_amt_7d
         FROM payouts
         GROUP BY user_id::text
       ),
       account_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*)::int AS accounts_total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_accounts
         FROM accounts
         GROUP BY user_id::text
       )
       SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(l.login_1h, 0)::int AS login_1h,
         COALESCE(l.login_24h, 0)::int AS login_24h,
         COALESCE(l.unique_ip_24h, 0)::int AS unique_ip_24h,
         COALESCE(t.trade_1h, 0)::int AS trade_1h,
         COALESCE(t.trade_24h, 0)::int AS trade_24h,
         COALESCE(p.payout_req_7d, 0)::int AS payout_req_7d,
         COALESCE(p.payout_amt_7d, 0)::numeric AS payout_amt_7d,
         COALESCE(a.accounts_total, 0)::int AS accounts_total,
         COALESCE(a.active_accounts, 0)::int AS active_accounts
       FROM active_users au
       JOIN users u ON u.id::text = au.user_id
       LEFT JOIN login_agg l ON l.user_id = u.id::text
       LEFT JOIN trade_agg t ON t.user_id = u.id::text
       LEFT JOIN payout_agg p ON p.user_id = u.id::text
       LEFT JOIN account_agg a ON a.user_id = u.id::text
       ORDER BY
         (COALESCE(l.login_1h, 0) + COALESCE(l.login_24h, 0) + COALESCE(t.trade_1h, 0) + COALESCE(t.trade_24h, 0) + COALESCE(p.payout_req_7d, 0)) DESC,
         COALESCE(p.payout_amt_7d, 0) DESC
       LIMIT 300`
    )

    const rows = []
    for (const r of result.rows) {
      let riskScore = 0
      const flags = []

      if (r.login_1h >= 8) { riskScore += 25; flags.push('High login burst (1h)') }
      if (r.login_24h >= 25) { riskScore += 15; flags.push('High login velocity (24h)') }
      if (r.unique_ip_24h >= 4) { riskScore += 20; flags.push('Many unique IPs (24h)') }
      if (r.trade_1h >= 30) { riskScore += 20; flags.push('Trade burst (1h)') }
      if (r.trade_24h >= 120) { riskScore += 20; flags.push('High trade count (24h)') }
      if (r.payout_req_7d >= 2) { riskScore += 15; flags.push('Multiple payout requests (7d)') }
      if (parseFloat(r.payout_amt_7d || 0) >= 10000) { riskScore += 10; flags.push('Large payout amount (7d)') }
      if (String(r.kyc_status || '') !== 'approved') { riskScore += 10; flags.push('KYC not approved') }

      if (riskScore <= 0) continue
      rows.push({
        ...r,
        payout_amt_7d: parseFloat(r.payout_amt_7d || 0),
        risk_score: riskScore,
        risk_level: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
        flags
      })
    }

    rows.sort((a, b) => b.risk_score - a.risk_score)
    const sliced = rows.slice(0, 200)
    res.json({
      generated_at: new Date(),
      flagged_count: sliced.length,
      high_risk_count: sliced.filter(r => r.risk_level === 'high').length,
      medium_risk_count: sliced.filter(r => r.risk_level === 'medium').length,
      rows: sliced
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AML velocity checks' })
  }
})

module.exports = router
