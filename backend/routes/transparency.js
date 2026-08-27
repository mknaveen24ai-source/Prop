const express = require('express')
const router = express.Router()
// Public transparency stats are read-only and served to unauthenticated
// traffic, which makes them the easiest thing to accidentally overload the
// primary with. They run on the read pool.
const { readPool: pool } = require('../db')
const logger = require('../utils/logger')

// ── Transparency API ──────────────────────────────────────────────────────────
// Public by default. No PII is ever returned — trader names are masked to
// "J****" format. Data is read-only aggregations from existing tables.
//
// ── The one exception: revenue ──
//
// Pass rates, payout totals, funded counts and AUM are the platform's single
// best asset — no competitor publishes them, and publishing them is the whole
// positioning. Firm REVENUE is a different question that had been answered the
// same way by accident: /revenue served a daily and cumulative order-revenue
// series to anonymous traffic, and /overview returned totalRevenue,
// annualizedRunRate and todayRevenue alongside the trader-facing numbers.
//
// That is not transparency to traders, it is competitor intelligence — a rival
// can quote the firm's own P&L back at it in a comparison page, and an
// acquirer or a partner learns the run rate before any conversation starts.
//
// So revenue is admin-only and everything else stays exactly as public as it
// was. /overview keeps its shape for anonymous callers with the three revenue
// fields omitted, rather than 401-ing the whole endpoint, because the other
// five KPIs on that page are the ones worth publishing.
// ──────────────────────────────────────────────────────────────────────────────

const { authenticateAdmin } = require('./middleware')

/**
 * Is this request from a signed-in admin? Answers without refusing anonymous ones.
 *
 * authenticateAdmin ends the response itself on failure, which is exactly right
 * for /admin routes and wrong here — an anonymous caller must receive the public
 * projection, not a 401. So it runs against a sink response that absorbs the
 * rejection, and the answer is simply whether it reached next().
 *
 * Reusing the real middleware rather than re-verifying the JWT here is
 * deliberate: it carries the admin_token_version revocation check and the
 * platform_admins status lookup, and a second copy of that logic is precisely
 * the drift this codebase keeps having to undo.
 */
async function isAdminRequest(req) {
  const sink = {
    status() { return sink },
    json() { return sink },
    send() { return sink },
    clearCookie() { return sink },
    cookie() { return sink },
    set() { return sink }
  }
  let authorised = false
  try {
    await authenticateAdmin(req, sink, () => { authorised = true })
  } catch {
    return false
  }
  return authorised && !!req.admin
}

function round(value, decimals = 2) {
  const factor = 10 ** decimals
  return Math.round((Number(value) || 0) * factor) / factor
}

/** Mask a full name to "J****" or "Trader #XXXX" if no name available */
function maskName(fullName, userId) {
  if (!fullName || typeof fullName !== 'string') {
    return `Trader #${String(userId || '').slice(-4).padStart(4, '0')}`
  }
  const first = fullName.trim().split(/\s+/)[0]
  if (!first) return `Trader #${String(userId || '').slice(-4).padStart(4, '0')}`
  return `${first[0].toUpperCase()}${'*'.repeat(Math.min(4, Math.max(2, first.length - 1)))}`
}

/** Build a SQL date-range WHERE clause based on ?range= query param */
function buildDateFilter(rangeParam, column) {
  const range = String(rangeParam || '30d').toLowerCase()
  if (range === '7d')  return `AND ${column} >= NOW() - INTERVAL '7 days'`
  if (range === '30d') return `AND ${column} >= NOW() - INTERVAL '30 days'`
  if (range === '90d') return `AND ${column} >= NOW() - INTERVAL '90 days'`
  if (range === '180d') return `AND ${column} >= NOW() - INTERVAL '180 days'`
  return '' // 'all'
}

// ── GET /api/transparency/pass-rates ─────────────────────────────────────────
//
// The published pass rate, per challenge model. This is a headline marketing
// claim, so the definition has to be one the firm would defend in public:
//
//   numerator   evaluations that reached a FUNDED account
//   denominator evaluations that have FINISHED
//
// "Evaluation" means a purchased root account — parent_account_id IS NULL — not
// every account row, because a 3-step model creates three rows for one purchase
// and counting each separately would triple the denominator.
//
// "Finished" means the chain is resolved: it either reached funded, or no
// evaluation account in the chain is still active. A challenge bought yesterday
// and still running is excluded from BOTH sides rather than counted as a
// failure — including it would understate the rate for no honest reason.
//
// Deliberately NOT the shape used by /overview, which computes
// funded_count / distinct users over a set that excludes failed accounts from
// the denominator. That inflates the number, which is the one direction a
// published pass rate must never be wrong in.
//
// Cached in-process: this is a recursive CTE over the whole accounts table,
// served to unauthenticated traffic. Uncached, it is a free DB-load amplifier.
const PASS_RATE_CACHE_MS = 5 * 60 * 1000
let _passRateCache = { data: null, at: 0, inflight: null }

async function computePassRates() {
  const result = await pool.query(`
    WITH RECURSIVE lineage AS (
      SELECT a.id AS root_id, a.id, a.account_type, a.status
        FROM accounts a
       WHERE a.parent_account_id IS NULL
         AND a.account_type <> 'funded'
      UNION ALL
      SELECT l.root_id, c.id, c.account_type, c.status
        FROM accounts c
        JOIN lineage l ON c.parent_account_id = l.id::text
    ),
    roots AS (
      SELECT a.id, COALESCE(a.challenge_model_slug, 'legacy') AS slug
        FROM accounts a
       WHERE a.parent_account_id IS NULL
         AND a.account_type <> 'funded'
    ),
    outcome AS (
      SELECT r.id,
             r.slug,
             bool_or(l.account_type = 'funded') AS reached_funded,
             bool_or(l.account_type <> 'funded' AND l.status = 'active') AS eval_still_active
        FROM roots r
        JOIN lineage l ON l.root_id = r.id
       GROUP BY r.id, r.slug
    )
    SELECT slug,
           COUNT(*) FILTER (WHERE reached_funded OR NOT eval_still_active)::int AS finished,
           COUNT(*) FILTER (WHERE reached_funded)::int                          AS funded,
           COUNT(*) FILTER (WHERE eval_still_active AND NOT reached_funded)::int AS in_progress
      FROM outcome
     GROUP BY slug
     ORDER BY slug ASC
  `)

  const models = result.rows.map((row) => {
    const finished = parseInt(row.finished, 10) || 0
    const funded = parseInt(row.funded, 10) || 0
    return {
      slug: row.slug,
      finished,
      funded,
      in_progress: parseInt(row.in_progress, 10) || 0,
      // null rather than 0 when nothing has finished yet: "0%" is a claim,
      // "no data yet" is the truth, and the UI must be able to tell them apart.
      pass_rate: finished > 0 ? round((funded / finished) * 100, 1) : null
    }
  })

  const totalFinished = models.reduce((sum, m) => sum + m.finished, 0)
  const totalFunded = models.reduce((sum, m) => sum + m.funded, 0)

  return {
    models,
    overall: {
      finished: totalFinished,
      funded: totalFunded,
      in_progress: models.reduce((sum, m) => sum + m.in_progress, 0),
      pass_rate: totalFinished > 0 ? round((totalFunded / totalFinished) * 100, 1) : null
    },
    methodology: 'Evaluations that reached a funded account, divided by evaluations that have finished. Challenges still in progress are excluded from both sides.',
    updated_at: new Date().toISOString()
  }
}

router.get('/pass-rates', async (req, res) => {
  try {
    const now = Date.now()
    if (_passRateCache.data && (now - _passRateCache.at) < PASS_RATE_CACHE_MS) {
      res.set('Cache-Control', 'public, max-age=300')
      return res.json(_passRateCache.data)
    }
    if (!_passRateCache.inflight) {
      _passRateCache.inflight = computePassRates()
        .then((data) => {
          _passRateCache = { data, at: Date.now(), inflight: null }
          return data
        })
        .catch((err) => {
          _passRateCache.inflight = null
          throw err
        })
    }
    const data = await _passRateCache.inflight
    res.set('Cache-Control', 'public, max-age=300')
    res.json(data)
  } catch (error) {
    logger.error('Transparency pass-rates error:', { error: error.message })
    res.status(500).json({ error: 'Could not load pass rates' })
  }
})

// ── GET /api/transparency/overview ───────────────────────────────────────────
// Returns platform-wide KPI stats.
router.get('/overview', async (req, res) => {
  try {
    // Revenue fields are computed either way — they are three cheap aggregates
    // in a batch that already runs — and withheld from the response for
    // anonymous callers. Gating the whole endpoint would take the five KPIs
    // worth publishing down with them.
    const showRevenue = await isAdminRequest(req)

    const [
      revenueResult,
      payoutsResult,
      activeTraderResult,
      fundedResult,
      passRateResult,
      aumResult,
      largestPayoutResult,
      todayRevenueResult,
    ] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM challenge_orders WHERE status = 'paid'`),
      pool.query(`SELECT COALESCE(SUM(amount_payable), 0) AS total FROM payouts WHERE status = 'paid'`),
      pool.query(`
        SELECT COUNT(DISTINCT user_id)::int AS count
        FROM accounts
        WHERE status IN ('active', 'passed', 'funded')
          AND created_at >= NOW() - INTERVAL '30 days'
      `),
      pool.query(`SELECT COUNT(*)::int AS count FROM accounts WHERE account_type = 'funded' AND status NOT IN ('failed', 'locked')`),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE account_type = 'funded')::float AS funded_count,
          COUNT(DISTINCT user_id)::float AS total_users
        FROM accounts
        WHERE status NOT IN ('failed', 'locked') OR account_type = 'funded'
      `),
      pool.query(`
        SELECT COALESCE(SUM(a.account_size), 0) AS total
        FROM accounts a
        WHERE a.account_type = 'funded' AND a.status NOT IN ('failed', 'locked')
      `),
      pool.query(`SELECT COALESCE(MAX(amount_payable), 0) AS max FROM payouts WHERE status = 'paid'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM challenge_orders WHERE status = 'paid' AND created_at >= CURRENT_DATE`),
    ])

    const totalRevenue = round(revenueResult.rows[0]?.total)
    const totalPayouts = round(payoutsResult.rows[0]?.total)
    // Annualized run rate based on last 30 days of revenue
    const last30Result = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM challenge_orders WHERE status = 'paid' AND created_at >= NOW() - INTERVAL '30 days'`
    )
    const last30Revenue = parseFloat(last30Result.rows[0]?.total) || 0
    const annualizedRunRate = round(last30Revenue * (365 / 30))

    const prRow = passRateResult.rows[0] || {}
    const totalUsers = parseFloat(prRow.total_users) || 0
    const fundedCount = parseFloat(prRow.funded_count) || 0
    const passRate = totalUsers > 0 ? round((fundedCount / totalUsers) * 100, 1) : 0

    res.json({
      ...(showRevenue ? { totalRevenue, annualizedRunRate, todayRevenue: round(todayRevenueResult.rows[0]?.total) } : {}),
      revenue_visible: showRevenue,
      totalPayouts,
      activeTraders: activeTraderResult.rows[0]?.count || 0,
      fundedTraders: fundedResult.rows[0]?.count || 0,
      passRate,
      aum: round(aumResult.rows[0]?.total),
      largestPayout: round(largestPayoutResult.rows[0]?.max),
    })
  } catch (err) {
    logger.error('Transparency overview error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load overview' })
  }
})

// ── GET /api/transparency/revenue?range=30d ───────────────────────────────────
// Daily and cumulative revenue data for charts. ADMIN ONLY — see the note at
// the top of this file. This is the firm's P&L, not a trader-facing number, and
// it was the one thing on the transparency surface a competitor wanted.
router.get('/revenue', authenticateAdmin, async (req, res) => {
  try {
    const dateFilter = buildDateFilter(req.query.range, 'created_at')
    const result = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COALESCE(SUM(amount), 0) AS daily_revenue
      FROM challenge_orders
      WHERE status = 'paid' ${dateFilter}
      GROUP BY DATE(created_at AT TIME ZONE 'UTC')
      ORDER BY day ASC
    `)

    let cumulative = 0
    const data = result.rows.map(row => {
      const daily = round(row.daily_revenue)
      cumulative = round(cumulative + daily)
      return {
        date: row.day,
        daily,
        cumulative,
      }
    })

    res.json({ data })
  } catch (err) {
    logger.error('Transparency revenue error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load revenue data' })
  }
})

// ── GET /api/transparency/evaluations ─────────────────────────────────────────
// Pass rates per challenge model + phase funnel breakdown.
router.get('/evaluations', async (req, res) => {
  try {
    const [modelsResult, funnelResult, totalResult] = await Promise.all([
      pool.query(`
        SELECT
          cm.name AS model_name,
          COUNT(a.id) FILTER (WHERE a.status IN ('passed', 'funded'))::int AS passed,
          COUNT(a.id) FILTER (WHERE a.status = 'failed')::int AS failed
        FROM challenge_models cm
        LEFT JOIN accounts a ON a.challenge_model_slug = cm.slug
        GROUP BY cm.name, cm.display_order
        ORDER BY cm.display_order ASC
      `),
      pool.query(`
        SELECT
          COUNT(DISTINCT user_id) FILTER (WHERE account_type IN ('phase2', 'phase3', 'funded'))::int AS phase1_pass,
          COUNT(DISTINCT user_id) FILTER (WHERE account_type IN ('phase3', 'funded'))::int AS phase2_pass,
          COUNT(DISTINCT user_id) FILTER (WHERE account_type = 'funded')::int AS funded,
          COUNT(DISTINCT user_id)::int AS total
        FROM accounts
      `),
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'failed')::int AS total_failed,
          COUNT(*) FILTER (WHERE status IN ('passed', 'funded'))::int AS total_passed
        FROM accounts
      `)
    ])

    const funnel = funnelResult.rows[0] || {}
    const totalRow = totalResult.rows[0] || {}

    const byModel = modelsResult.rows.map(row => {
      const total = (row.passed || 0) + (row.failed || 0)
      return {
        model: row.model_name,
        passed: row.passed || 0,
        failed: row.failed || 0,
        passRate: total > 0 ? round((row.passed / total) * 100, 1) : 0,
      }
    })

    const overallTotal = (totalRow.total_passed || 0) + (totalRow.total_failed || 0)
    const overallPassRate = overallTotal > 0 ? round((totalRow.total_passed / overallTotal) * 100, 1) : 0

    res.json({
      byModel,
      overallPassRate,
      funnel: {
        total: funnel.total || 0,
        phase1Pass: funnel.phase1_pass || 0,
        phase2Pass: funnel.phase2_pass || 0,
        funded: funnel.funded || 0,
      },
    })
  } catch (err) {
    logger.error('Transparency evaluations error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load evaluations data' })
  }
})

// ── GET /api/transparency/traders?range=30d ───────────────────────────────────
// Daily new trader signups + cumulative count over time.
router.get('/traders', async (req, res) => {
  try {
    const dateFilter = buildDateFilter(req.query.range, 'created_at')
    const result = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)::int AS daily_new
      FROM users
      WHERE 1=1 ${dateFilter}
      GROUP BY DATE(created_at AT TIME ZONE 'UTC')
      ORDER BY day ASC
    `)

    // Get total users before the range for cumulative offset
    let offsetResult = { rows: [{ count: 0 }] }
    if (result.rows.length > 0) {
      const firstDay = result.rows[0].day
      offsetResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM users WHERE created_at < $1::date`,
        [firstDay]
      )
    }

    let cumulative = parseInt(offsetResult.rows[0]?.count) || 0
    const data = result.rows.map(row => {
      cumulative += row.daily_new
      return {
        date: row.day,
        daily: row.daily_new,
        cumulative,
      }
    })

    res.json({ data })
  } catch (err) {
    logger.error('Transparency traders error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load traders data' })
  }
})

// ── GET /api/transparency/funded?range=30d ────────────────────────────────────
// Funded trader count and AUM over time.
router.get('/funded', async (req, res) => {
  try {
    const dateFilter = buildDateFilter(req.query.range, 'created_at')
    const result = await pool.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'UTC') AS day,
        COUNT(*)::int AS new_funded,
        COALESCE(SUM(account_size), 0) AS new_aum
      FROM accounts
      WHERE account_type = 'funded' ${dateFilter}
      GROUP BY DATE(created_at AT TIME ZONE 'UTC')
      ORDER BY day ASC
    `)

    // Get cumulative offset before range
    let offsetResult = { rows: [{ count: 0, total_aum: 0 }] }
    if (result.rows.length > 0) {
      const firstDay = result.rows[0].day
      offsetResult = await pool.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(account_size), 0) AS total_aum
         FROM accounts
         WHERE account_type = 'funded' AND created_at < $1::date`,
        [firstDay]
      )
    }

    let cumulativeFunded = parseInt(offsetResult.rows[0]?.count) || 0
    let cumulativeAum = parseFloat(offsetResult.rows[0]?.total_aum) || 0

    const data = result.rows.map(row => {
      cumulativeFunded += row.new_funded
      cumulativeAum += parseFloat(row.new_aum) || 0
      return {
        date: row.day,
        fundedCount: cumulativeFunded,
        aum: round(cumulativeAum),
      }
    })

    res.json({ data })
  } catch (err) {
    logger.error('Transparency funded error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load funded data' })
  }
})

// ── GET /api/transparency/payouts?page=1 ─────────────────────────────────────
// Paginated list of recent paid payouts with anonymized trader identity.
router.get('/payouts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const limit = 20
    const offset = (page - 1) * limit

    const [dataResult, countResult] = await Promise.all([
      pool.query(`
        SELECT
          p.amount_payable,
          p.payment_method,
          p.paid_at,
          u.full_name,
          u.id AS user_id
        FROM payouts p
        JOIN users u ON u.id::text = p.user_id::text
        WHERE p.status = 'paid' AND p.paid_at IS NOT NULL
        ORDER BY p.paid_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset]),
      pool.query(`SELECT COUNT(*)::int AS count FROM payouts WHERE status = 'paid' AND paid_at IS NOT NULL`),
    ])

    const payouts = dataResult.rows.map(row => ({
      trader: maskName(row.full_name, row.user_id),
      amount: round(row.amount_payable),
      method: row.payment_method || 'Bank Transfer',
      date: row.paid_at,
    }))

    res.json({
      payouts,
      total: countResult.rows[0]?.count || 0,
      page,
      totalPages: Math.ceil((countResult.rows[0]?.count || 0) / limit),
    })
  } catch (err) {
    logger.error('Transparency payouts error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load payouts' })
  }
})

// ── GET /api/transparency/activity ───────────────────────────────────────────
// Last 30 anonymized platform events: phase passed, payout sent, new trader.
router.get('/activity', async (req, res) => {
  try {
    const [passedResult, payoutsResult, signupsResult] = await Promise.all([
      pool.query(`
        SELECT
          a.phase_end_date AS ts,
          a.account_type,
          a.challenge_model_slug,
          u.full_name,
          u.id AS user_id
        FROM accounts a
        JOIN users u ON u.id = a.user_id
        WHERE a.status = 'passed' AND a.phase_end_date IS NOT NULL
        ORDER BY a.phase_end_date DESC
        LIMIT 15
      `),
      pool.query(`
        SELECT
          p.paid_at AS ts,
          p.amount_payable,
          p.payment_method,
          u.full_name,
          u.id AS user_id
        FROM payouts p
        JOIN users u ON u.id::text = p.user_id::text
        WHERE p.status = 'paid' AND p.paid_at IS NOT NULL
        ORDER BY p.paid_at DESC
        LIMIT 15
      `),
      pool.query(`
        SELECT
          u.created_at AS ts,
          u.full_name,
          u.id AS user_id
        FROM users u
        ORDER BY u.created_at DESC
        LIMIT 15
      `),
    ])

    const events = []

    for (const row of passedResult.rows) {
      const phase = row.account_type === 'funded' ? 'Evaluation' :
                    row.account_type === 'phase2' ? 'Phase 1' :
                    row.account_type === 'phase3' ? 'Phase 2' : 'Phase'
      events.push({
        type: 'pass',
        label: `${maskName(row.full_name, row.user_id)} passed ${phase}`,
        sublabel: row.challenge_model_slug || '',
        ts: row.ts,
      })
    }

    for (const row of payoutsResult.rows) {
      events.push({
        type: 'payout',
        label: `${maskName(row.full_name, row.user_id)} received a payout`,
        sublabel: `$${round(row.amount_payable).toLocaleString('en-US')} via ${row.payment_method || 'Bank Transfer'}`,
        ts: row.ts,
      })
    }

    for (const row of signupsResult.rows) {
      events.push({
        type: 'signup',
        label: `${maskName(row.full_name, row.user_id)} joined the platform`,
        sublabel: 'New trader',
        ts: row.ts,
      })
    }

    // Sort all events by timestamp desc, take top 30
    events.sort((a, b) => new Date(b.ts) - new Date(a.ts))

    res.json({ events: events.slice(0, 30) })
  } catch (err) {
    logger.error('Transparency activity error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load activity feed' })
  }
})

// ── GET /api/transparency/top-performers ─────────────────────────────────────
// Top 5 funded traders by profit % — fully anonymized.
router.get('/top-performers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.id AS account_id,
        a.user_id,
        a.account_size,
        a.current_balance,
        a.challenge_model_slug,
        u.full_name,
        u.id AS uid
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      WHERE a.account_type = 'funded'
        AND a.status NOT IN ('failed', 'locked')
        AND a.account_size > 0
        AND a.current_balance > a.starting_balance
      ORDER BY ((a.current_balance - a.starting_balance) / NULLIF(a.starting_balance, 0)) DESC
      LIMIT 5
    `)

    const performers = result.rows.map((row, idx) => {
      const startBal = parseFloat(row.account_size) || 0
      const currentBal = parseFloat(row.current_balance) || 0
      const profitUsd = round(currentBal - startBal)
      const profitPct = startBal > 0 ? round(((currentBal - startBal) / startBal) * 100, 2) : 0
      return {
        rank: idx + 1,
        trader: maskName(row.full_name, row.uid),
        accountSize: startBal,
        profitUsd,
        profitPct,
        model: row.challenge_model_slug || '—',
      }
    })

    res.json({ performers })
  } catch (err) {
    logger.error('Transparency top-performers error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load top performers' })
  }
})

module.exports = router
