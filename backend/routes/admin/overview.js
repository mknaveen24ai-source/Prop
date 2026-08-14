// Admin dashboard overview, announcements, leaderboard, signup trends.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireSuperAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const { sanitizeString } = require('../../utils/validation')
const { ensureViolationTables } = require('../../services/violationEngine')
const { ensureDisputesInfrastructure } = require('../disputes')
require('../../loadEnv')

const {  getSettingsMap, upsertSetting, toBool } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  normalizeEntityId
} = require('./shared/helpers')
const {
  getExposureData
} = require('./shared/tradeOps')

router.get('/overview', authenticateAdmin, async function(req, res) {

  try {
    await ensureViolationTables()
    await ensureDisputesInfrastructure()

    const accounts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase1') AS phase1_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase2') AS phase2_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded') AS funded_active,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE status = 'passed') AS total_passed,
        COUNT(*) FILTER (WHERE status = 'expired') AS total_expired
       FROM accounts`
    )

    const users = await pool.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE kyc_status = 'pending') AS kyc_pending,
        COUNT(*) FILTER (WHERE kyc_status = 'approved') AS kyc_approved
       FROM users`
    )

    const pnl = await pool.query(
      `SELECT
        COALESCE(SUM(t.demo_pnl), 0) AS total_demo_pnl,
        COALESCE(SUM(t.broker_pnl), 0) AS total_broker_pnl,
        COUNT(*) FILTER (WHERE t.status = 'closed') AS total_closed_trades,
        COUNT(*) FILTER (WHERE t.status = 'open') AS total_open_trades
       FROM trades t
       JOIN accounts a ON a.id = t.account_id`
    )

    const payouts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_payouts,
        COALESCE(SUM(amount_payable) FILTER (WHERE status = 'paid'), 0) AS total_paid_out
       FROM payouts p
       JOIN users u ON u.id = p.user_id`
    )

    const bannedUsers = await pool.query(
      `SELECT COUNT(*) as banned
       FROM users
       WHERE is_banned = true`
    );
    const flaggedPayouts = await pool.query(
      `SELECT COUNT(*) as flagged
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'flagged'`
    );

    const { exposureData } = await getExposureData(pool);

    // ── Command Center additions (Modern Gazette handoff spec) ──────────
    // Gross revenue by month — challenge_orders is the only real revenue
    // source in this app; there's no separate "reset fee" product, so this
    // is a single "Challenge Fees" series (the prototype's copy mentions
    // resets, but that's not a real feature here — omitted rather than
    // fabricated).
    const revenueByMonth = await pool.query(
      `SELECT to_char(date_trunc('month', paid_at), 'Mon') AS month,
              date_trunc('month', paid_at) AS month_start,
              COALESCE(SUM(amount), 0) AS revenue
         FROM challenge_orders
        WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '6 months'
        GROUP BY date_trunc('month', paid_at)
        ORDER BY month_start ASC`
    )

    // Daily event counts for KPI sparklines/deltas — only for metrics with
    // a real timestamped event stream (point-in-time counts like "active
    // challenges" or "pending KYC" have no historical series to draw from,
    // so those KPI cards render without a sparkline/delta rather than a
    // fabricated one).
    const [dailySignups, dailyFunded, dailyPayouts, dailyPnl] = await Promise.all([
      pool.query(`SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS n
                    FROM users WHERE created_at >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT date_trunc('day', phase_start_date) AS day, COUNT(*)::int AS n
                    FROM accounts WHERE account_type = 'funded' AND phase_start_date >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT date_trunc('day', paid_at) AS day, COALESCE(SUM(amount_payable), 0) AS n
                    FROM payouts WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
      pool.query(`SELECT date_trunc('day', close_time) AS day, COALESCE(SUM(demo_pnl), 0) AS n
                    FROM trades WHERE status = 'closed' AND close_time >= NOW() - INTERVAL '14 days'
                    GROUP BY day ORDER BY day ASC`),
    ])

    function buildDailySeries(rows, days = 14) {
      const byDay = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), parseFloat(r.n) || 0]))
      const series = []
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
        series.push({ value: byDay.get(d) || 0 })
      }
      return series
    }
    function trendDelta(series) {
      const last7 = series.slice(-7).reduce((a, b) => a + b.value, 0)
      const prev7 = series.slice(-14, -7).reduce((a, b) => a + b.value, 0)
      if (prev7 === 0) return last7 > 0 ? { pct: null, label: `+${last7} (7d)` } : { pct: 0, label: '0 (7d)' }
      const pct = Math.round(((last7 - prev7) / prev7) * 100)
      return { pct, label: `${pct >= 0 ? '+' : ''}${pct}% (7d)` }
    }

    const signupsSeries = buildDailySeries(dailySignups.rows)
    const fundedSeries = buildDailySeries(dailyFunded.rows)
    const payoutsSeries = buildDailySeries(dailyPayouts.rows)
    const pnlSeries = buildDailySeries(dailyPnl.rows)

    // Needs Attention — a real, sorted queue (not just a stat grid): pending
    // KYC, pending/flagged payouts, open critical violations, open disputes.
    const [violationCounts, disputeCounts] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS critical_open,
                         COUNT(*) FILTER (WHERE status = 'open')::int AS all_open
                    FROM admin_rule_violations`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('open', 'under_review'))::int AS open_count
                    FROM disputes`)
    ])

    const attentionQueue = [
      { key: 'kyc', label: 'Pending KYC reviews', meta: 'Identity verification', n: parseInt(users.rows[0].kyc_pending || 0) },
      { key: 'payouts', label: 'Pending payout requests', meta: 'Awaiting review', n: parseInt(payouts.rows[0].pending_payouts || 0) },
      { key: 'flagged', label: 'Flagged payouts', meta: 'Risk-flagged, needs decision', n: parseInt(flaggedPayouts.rows[0].flagged || 0) },
      { key: 'violations', label: 'Critical violations', meta: 'System-flagged breaches', n: violationCounts.rows[0].critical_open },
      { key: 'disputes', label: 'Open appeals', meta: 'Trader-filed disputes', n: disputeCounts.rows[0].open_count },
      { key: 'banned', label: 'Banned users', meta: 'Under enforcement', n: parseInt(bannedUsers.rows[0].banned || 0) },
    ].filter((item) => item.n > 0).sort((a, b) => b.n - a.n)

    const totalAttention = attentionQueue.reduce((sum, item) => sum + item.n, 0)

    // Alerts — the top 1-3 most urgent conditions only (never fabricated
    // filler if fewer than 3 exist).
    const alerts = []
    if (violationCounts.rows[0].critical_open > 0) {
      alerts.push({ tone: 'loss', kicker: 'Critical', text: `${violationCounts.rows[0].critical_open} critical violation${violationCounts.rows[0].critical_open === 1 ? '' : 's'} awaiting review`, cta: 'Review', go: 'violations' })
    }
    if (parseInt(flaggedPayouts.rows[0].flagged || 0) > 0) {
      alerts.push({ tone: 'warn', kicker: 'Flagged', text: `${flaggedPayouts.rows[0].flagged} payout${parseInt(flaggedPayouts.rows[0].flagged) === 1 ? '' : 's'} flagged for risk review`, cta: 'Review', go: 'payouts' })
    }
    if (disputeCounts.rows[0].open_count > 0) {
      alerts.push({ tone: 'accent', kicker: 'Open', text: `${disputeCounts.rows[0].open_count} trader appeal${disputeCounts.rows[0].open_count === 1 ? '' : 's'} awaiting a decision`, cta: 'Review', go: 'disputes' })
    }

    res.json({
      accounts: {
        phase1: parseInt(accounts.rows[0].phase1_active || 0),
        phase2: parseInt(accounts.rows[0].phase2_active || 0),
        funded: parseInt(accounts.rows[0].funded_active || 0),
        failed: parseInt(accounts.rows[0].total_failed || 0),
        passed: parseInt(accounts.rows[0].total_passed || 0),
        expired: parseInt(accounts.rows[0].total_expired || 0)
      },
      users: {
        total: parseInt(users.rows[0].total_users || 0),
        pending_kyc: parseInt(users.rows[0].kyc_pending || 0),
        approved_kyc: parseInt(users.rows[0].kyc_approved || 0),
        banned: parseInt(bannedUsers.rows[0].banned || 0)
      },
      trades: {
        open: parseInt(pnl.rows[0].total_open_trades || 0),
        total_pnl: parseFloat(pnl.rows[0].total_demo_pnl || 0)
      },
      payouts: {
        pending: parseInt(payouts.rows[0].pending_payouts || 0),
        total_paid: parseFloat(payouts.rows[0].total_paid_out || 0),
        flagged_count: parseInt(flaggedPayouts.rows[0].flagged || 0)
      },
      exposure: exposureData,
      settings: {},
      revenue_by_month: revenueByMonth.rows.map((r) => ({ month: r.month, revenue: parseFloat(r.revenue) })),
      kpi_trends: {
        users: { spark: signupsSeries, delta: trendDelta(signupsSeries) },
        funded: { spark: fundedSeries, delta: trendDelta(fundedSeries) },
        payouts_paid: { spark: payoutsSeries, delta: trendDelta(payoutsSeries) },
        pnl: { spark: pnlSeries, delta: trendDelta(pnlSeries) }
      },
      attention_queue: attentionQueue,
      attention_total: totalAttention,
      alerts
    })

  } catch (error) {
    logger.error('Admin overview error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch overview' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/signup-trends
// Real 30-day signup + challenge data for AdminDashboard charts.
// FIX (BUG-2): Added so dashboard charts show real data, not mock constants.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/announcement', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const settings = await getSettingsMap([
      'announcement_message',
      'announcement_type',
      'announcement_enabled',
      'announcement_updated_at'
    ])

    const message = sanitizeString(String(settings.announcement_message || ''), 500)
    const rawType = String(settings.announcement_type || 'info').toLowerCase()
    const type = ['info', 'success', 'warning', 'error'].includes(rawType) ? rawType : 'info'
    const enabled = message.length > 0 && toBool(settings.announcement_enabled, true)

    res.json({
      message,
      type,
      enabled,
      updated_at: settings.announcement_updated_at || null
    })
  } catch (error) {
    logger.error('Announcement load error:', { error: error.message })
    res.status(500).json({ error: 'Could not load announcement' })
  }
})

router.post('/announcement', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  const client = await pool.connect()
  try {
    const message = sanitizeString(String(req.body?.message || ''), 500)
    const rawType = String(req.body?.type || 'info').toLowerCase()
    const type = ['info', 'success', 'warning', 'error'].includes(rawType) ? rawType : 'info'
    const enabled = message.length > 0 && toBool(req.body?.enabled, true)
    const updatedAt = new Date().toISOString()

    await client.query('BEGIN')
    await upsertSetting(client, 'announcement_message', message)
    await upsertSetting(client, 'announcement_type', type)
    await upsertSetting(client, 'announcement_enabled', enabled ? 'true' : 'false')
    await upsertSetting(client, 'announcement_updated_at', updatedAt)

    try {
      await appendImmutableAudit(client, {
        eventType: 'announcement_saved',
        entityType: 'system',
        entityId: 'announcement',
        payload: { enabled, type, message_length: message.length }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({ message, type, enabled, updated_at: updatedAt })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Announcement save error:', { error: error.message })
    res.status(500).json({ error: 'Could not save announcement' })
  } finally {
    client.release()
  }
})

router.get('/leaderboard', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `
        WITH ranked_accounts AS (
          SELECT
            u.id AS user_id,
            u.email,
            u.full_name,
            u.country,
            u.trader_uid,
            COALESCE(u.leaderboard_visible, TRUE) AS visible,
            a.account_uid,
            a.account_size,
            ROUND((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0))::numeric, 2) AS profit_usd,
            ROUND(
              CASE
                WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                ELSE ((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance) * 100
              END::numeric,
              2
            ) AS profit_pct,
            ROW_NUMBER() OVER (
              PARTITION BY u.id
              ORDER BY
                CASE
                  WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                  ELSE (COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance
                END DESC,
                a.current_balance DESC,
                a.id DESC
            ) AS rn
          FROM users u
          JOIN accounts a ON a.user_id = u.id
          WHERE a.account_type = 'funded'
            AND a.status = 'active'
            AND COALESCE(u.is_banned, FALSE) = FALSE
        ),
        closed_trade_stats AS (
          SELECT
            a.user_id,
            COUNT(t.id)::int AS total_trades,
            COALESCE(
              ROUND(
                CASE
                  WHEN COUNT(t.id) = 0 THEN 0
                  ELSE (100.0 * COUNT(t.id) FILTER (WHERE t.demo_pnl > 0) / COUNT(t.id))
                END::numeric,
                1
              ),
              0
            ) AS win_rate
          FROM accounts a
          LEFT JOIN trades t ON t.account_id = a.id AND t.status = 'closed'
          GROUP BY a.user_id
        )
        SELECT
          r.user_id,
          r.email,
          r.full_name,
          r.country,
          r.trader_uid,
          r.visible,
          r.account_uid,
          r.account_size,
          r.profit_usd,
          r.profit_pct,
          COALESCE(s.total_trades, 0) AS total_trades,
          COALESCE(s.win_rate, 0) AS win_rate
        FROM ranked_accounts r
        LEFT JOIN closed_trade_stats s ON s.user_id = r.user_id
        WHERE r.rn = 1
        ORDER BY r.profit_pct DESC, r.profit_usd DESC, r.user_id ASC
        LIMIT 100
      `
    )

    res.json(result.rows.map((row, index) => ({
      ...row,
      rank: index + 1,
      username: row.full_name,
      display_name: row.full_name,
      profit_pct: parseFloat(row.profit_pct || 0),
      profit_usd: parseFloat(row.profit_usd || 0),
      account_size: parseFloat(row.account_size || 0),
      total_trades: parseInt(row.total_trades || 0, 10),
      win_rate: parseFloat(row.win_rate || 0),
      visible: row.visible !== false
    })))
  } catch (error) {
    logger.error('Admin leaderboard error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch leaderboard' })
  }
})

router.post('/leaderboard/visibility', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const userId = normalizeEntityId(req.body?.userId)
    if (!userId) {
      return res.status(400).json({ error: 'Valid userId is required' })
    }

    const visible = toBool(req.body?.visible, true)
    const result = await pool.query(
      `UPDATE users
          SET leaderboard_visible = $1
        WHERE id = $2
        RETURNING id, leaderboard_visible`,
      [visible, userId]
    )
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trader not found' })
    }

    try {
      await appendImmutableAudit(pool, {
        eventType: 'leaderboard_visibility_updated',
        entityType: 'user',
        entityId: String(userId),
        payload: { visible }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({
      userId,
      visible: result.rows[0].leaderboard_visible !== false
    })
  } catch (error) {
    logger.error('Leaderboard visibility error:', { error: error.message })
    res.status(500).json({ error: 'Could not update leaderboard visibility' })
  }
})

router.get('/signup-trends', authenticateAdmin, async function(req, res) {
  try {
    const days = Math.min(parseInt(req.query.days) || 30, 90)

    const signupResult = await pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int AS signups
       FROM users
       WHERE created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY day
       ORDER BY day ASC`,
      [days]
    )

    const challengeResult = await pool.query(
      `SELECT
         date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
         COUNT(*)::int AS challenges
       FROM accounts
       WHERE account_type = 'phase1'
         AND created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY day
       ORDER BY day ASC`,
      [days]
    )

    const signupMap = {}
    signupResult.rows.forEach(r => { signupMap[String(r.day)] = r.signups })

    const challengeMap = {}
    challengeResult.rows.forEach(r => { challengeMap[String(r.day)] = r.challenges })

    // Build full date range so every day appears (zero-filling missing days)
    const result = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date()
      d.setUTCDate(d.getUTCDate() - i)
      d.setUTCHours(0, 0, 0, 0)
      const dayStr = d.toISOString().slice(0, 10)
      const label  = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      result.push({
        date:       dayStr,
        label,
        signups:    signupMap[dayStr]    || 0,
        challenges: challengeMap[dayStr] || 0
      })
    }

    res.json(result)
  } catch (error) {
    logger.error('Signup trends error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch signup trends' })
  }
})

module.exports = router
