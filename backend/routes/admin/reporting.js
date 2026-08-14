// Admin audit log, ToS acceptance, platform analytics, P&L ledger, B-book.
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
const { CURRENT_TOS_VERSION } = require('../../utils/tosVersion')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')

router.get('/audit-log', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table
    await ensureFeatureTables()
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000)
    const offset = parseInt(req.query.offset || '0', 10)

    const conditions = []
    const values = []
    if (req.query.entity_id) {
      values.push(`%${String(req.query.entity_id)}%`)
      conditions.push(`entity_id ILIKE $${values.length}`)
    }
    if (req.query.event_type) {
      values.push(String(req.query.event_type))
      conditions.push(`event_type = $${values.length}`)
    }
    if (req.query.created_from) {
      values.push(String(req.query.created_from))
      conditions.push(`created_at >= $${values.length}::timestamptz`)
    }
    if (req.query.created_to) {
      values.push(String(req.query.created_to))
      conditions.push(`created_at < ($${values.length}::timestamptz + INTERVAL '1 day')`)
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    values.push(limit, offset)
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json,
              prev_hash, entry_hash, created_at
       FROM admin_immutable_audit
       ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({ entries: result.rows });
  } catch (err) {
    logger.error('Audit log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

router.get('/tos-acceptance', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id AS user_id, u.email, u.full_name, uaa.tos_version, uaa.accepted_at
         FROM users u
         LEFT JOIN LATERAL (
           SELECT tos_version, accepted_at
             FROM user_agreement_acceptances
            WHERE user_id = u.id
            ORDER BY accepted_at DESC
            LIMIT 1
         ) uaa ON true
        ORDER BY u.created_at DESC
        LIMIT 500`
    )
    const rows = result.rows.map((row) => ({
      ...row,
      current_version: CURRENT_TOS_VERSION,
      outdated: row.tos_version !== CURRENT_TOS_VERSION
    }))
    res.json({ current_version: CURRENT_TOS_VERSION, rows })
  } catch (err) {
    logger.error('ToS acceptance error:', { error: err.message })
    res.status(500).json({ error: 'Failed to load ToS acceptance records' })
  }
})

router.get('/settings-log', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table filtered by settings events
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json, created_at
       FROM admin_immutable_audit
       WHERE event_type = 'settings_updated'
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Settings log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load settings log' });
  }
});

router.get('/platform-analytics', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-L1): Replaced wrong "estimation" calculations. The old code used
    // phase2 total as "phase1_passed" and funded total as "phase2_passed" — both wrong.
    // Now uses explicit status='passed' + account_type filter for accurate pass counts.
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE account_type = 'phase1')                         AS p1t,
        COUNT(*) FILTER (WHERE account_type = 'phase2')                         AS p2t,
        COUNT(*) FILTER (WHERE account_type = 'funded')                         AS ft,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded')   AS fa,
        COUNT(*) FILTER (WHERE status = 'passed' AND account_type = 'phase1')   AS p1_passed,
        COUNT(*) FILTER (WHERE status = 'passed' AND account_type = 'phase2')   AS p2_passed
      FROM accounts
    `);
    res.json({
      funnel: {
        phase1_total:  parseInt(r.rows[0].p1t || 0),
        phase1_passed: parseInt(r.rows[0].p1_passed || 0),
        phase2_total:  parseInt(r.rows[0].p2t || 0),
        phase2_passed: parseInt(r.rows[0].p2_passed || 0),
        funded_total:  parseInt(r.rows[0].ft || 0),
        funded_active: parseInt(r.rows[0].fa || 0)
      }
    });
  } catch (err) {
    logger.error('Platform analytics error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

// Platform P&L ledger — the prototype's isPnl block is a firm-accounting
// view (fees in, payouts out, net position, monthly ledger) distinct from
// the existing /bbook trade-level edge view below (which AdminPlatformPnL.jsx
// already covers well and keeps). Real 3-bucket cost breakdown: trader
// payouts and affiliate payouts both have dedicated tables with paid_at,
// so "where the money goes" is computed, not guessed.
router.get('/pnl-ledger', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const [feesByMonth, payoutsByMonth, affiliateByMonth, payouts90d, affiliate90d, fees90d] = await Promise.all([
      pool.query(
        `SELECT to_char(date_trunc('month', paid_at), 'Mon') AS month,
                date_trunc('month', paid_at) AS month_start,
                COALESCE(SUM(amount), 0) AS amount
           FROM challenge_orders
          WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '12 months'
          GROUP BY date_trunc('month', paid_at)`
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', paid_at), 'Mon') AS month,
                date_trunc('month', paid_at) AS month_start,
                COALESCE(SUM(amount_payable), 0) AS amount
           FROM payouts
          WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '12 months'
          GROUP BY date_trunc('month', paid_at)`
      ),
      pool.query(
        `SELECT to_char(date_trunc('month', paid_at), 'Mon') AS month,
                date_trunc('month', paid_at) AS month_start,
                COALESCE(SUM(amount_requested), 0) AS amount
           FROM affiliate_payout_requests
          WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '12 months'
          GROUP BY date_trunc('month', paid_at)`
      ),
      pool.query(`SELECT COALESCE(SUM(amount_payable), 0) AS total FROM payouts WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '90 days'`),
      pool.query(`SELECT COALESCE(SUM(amount_requested), 0) AS total FROM affiliate_payout_requests WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '90 days'`),
      pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM challenge_orders WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '90 days'`)
    ])

    const monthKey = (row) => new Date(row.month_start).toISOString().slice(0, 7)
    const feesMap = new Map(feesByMonth.rows.map((r) => [monthKey(r), { month: r.month, amount: parseFloat(r.amount) }]))
    const payoutsMap = new Map(payoutsByMonth.rows.map((r) => [monthKey(r), parseFloat(r.amount)]))
    const affiliateMap = new Map(affiliateByMonth.rows.map((r) => [monthKey(r), parseFloat(r.amount)]))

    const months = []
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date()
      d.setDate(1)
      d.setMonth(d.getMonth() - i)
      months.push(d.toISOString().slice(0, 7))
    }

    let cumulative = 0
    const monthly = months.map((key) => {
      const fees = feesMap.get(key)?.amount || 0
      const traderPayouts = payoutsMap.get(key) || 0
      const affiliatePayouts = affiliateMap.get(key) || 0
      const net = fees - traderPayouts - affiliatePayouts
      cumulative += net
      const label = feesMap.get(key)?.month || new Date(`${key}-01`).toLocaleDateString('en-US', { month: 'short' })
      return { month: label, fees: parseFloat(fees.toFixed(2)), payouts: parseFloat((traderPayouts + affiliatePayouts).toFixed(2)), net: parseFloat(net.toFixed(2)), cumulative_net: parseFloat(cumulative.toFixed(2)) }
    })

    const fees90 = parseFloat(fees90d.rows[0].total) || 0
    const traderPayouts90 = parseFloat(payouts90d.rows[0].total) || 0
    const affiliatePayouts90 = parseFloat(affiliate90d.rows[0].total) || 0
    const retained90 = Math.max(0, fees90 - traderPayouts90 - affiliatePayouts90)

    res.json({
      monthly,
      cost_breakdown: [
        { label: 'Trader Payouts', amount: parseFloat(traderPayouts90.toFixed(2)) },
        { label: 'Affiliate Payouts', amount: parseFloat(affiliatePayouts90.toFixed(2)) },
        { label: 'Retained', amount: parseFloat(retained90.toFixed(2)) }
      ].filter((b) => b.amount > 0),
      gross_fees_90d: parseFloat(fees90.toFixed(2))
    })
  } catch (err) {
    logger.error('PnL ledger error:', { error: err.message })
    res.status(500).json({ error: 'Could not load PnL ledger' })
  }
})

router.get('/bbook', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        t.id,
        t.instrument AS symbol,
        UPPER(t.direction) AS type,
        t.lot_size AS lots,
        COALESCE(t.demo_pnl, 0) AS trader_pnl,
        (COALESCE(t.commission, 0) - COALESCE(t.demo_pnl, 0)) AS platform_pnl,
        COALESCE(t.commission, 0) AS fee_revenue,
        t.close_time AS closed_at
      FROM trades t
      JOIN accounts a ON a.id = t.account_id
      WHERE t.status = 'closed'
        AND a.account_type = 'funded'
      ORDER BY t.close_time DESC NULLS LAST, t.id DESC
      LIMIT 120
    `)

    res.json(result.rows)
  } catch (err) {
    logger.error('Bbook positions error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/bbook-report', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const q1 = await pool.query(`
      SELECT COALESCE(SUM(p.amount_payable), 0) as paid
      FROM payouts p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'paid'
    `);
    const q2 = await pool.query(`
      SELECT
        COUNT(*) FILTER(WHERE status='failed') as fails,
        COUNT(*) FILTER(WHERE status='active' AND account_type='funded') as active
      FROM accounts
    `);
    // FIX (BUG-L8): Replaced hardcoded 0 values with real PnL sums from trades table
    const q3 = await pool.query(`
      SELECT
        COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl > 0 AND t.status = 'closed'), 0) AS gross_profit,
        ABS(COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl < 0 AND t.status = 'closed'), 0)) AS gross_loss
      FROM trades t
      JOIN accounts a ON a.id = t.account_id
    `);

    const grossProfit = parseFloat(q3.rows[0].gross_profit || 0);
    const grossLoss   = parseFloat(q3.rows[0].gross_loss || 0);
    const totalPaidOut = parseFloat(q1.rows[0].paid || 0);

    res.json({
      totals: {
        total_trader_profits:  parseFloat(grossProfit.toFixed(2)),
        total_trader_losses:   parseFloat(grossLoss.toFixed(2)),
        total_paid_out:        parseFloat(totalPaidOut.toFixed(2)),
        net_firm_pnl:          parseFloat((grossLoss - grossProfit - totalPaidOut).toFixed(2)),
        total_failed:          parseInt(q2.rows[0].fails || 0),
        total_funded_active:   parseInt(q2.rows[0].active || 0)
      }
    });
  } catch (err) {
    logger.error('Bbook report error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

module.exports = router
