// Admin enforcement actions, payout fraud scores, device link graph.
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
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  forceCloseOpenTradesForAccount
} = require('./shared/tradeOps')

router.get('/enforcement/events', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const r = await pool.query(
      `SELECT id, rule_id, account_id, user_id, action, payload_json, status,
              message, created_at
       FROM admin_enforcement_events ORDER BY created_at DESC LIMIT 300`
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load enforcement events' })
  }
})

router.post('/enforcement/apply', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const { account_id, action, reason = '', rule_id = null, payload = {} } = req.body || {}
    if (!account_id) return res.status(400).json({ error: 'account_id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })

    await client.query('BEGIN')

    const accResult = await client.query(
      `SELECT id, user_id, status FROM accounts WHERE id = $1 FOR UPDATE`,
      [String(account_id)]
    )
    if (accResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const acc = accResult.rows[0]
    let message = ''
    let eventStatus = 'applied'

    if (action === 'lock_account') {
      await client.query(`UPDATE accounts SET status = 'locked', updated_at = NOW() WHERE id = $1`, [acc.id])
      message = 'Account locked'
    } else if (action === 'force_close_open_trades') {
      const closeResult = await forceCloseOpenTradesForAccount(client, acc.id)
      message = `Force-closed ${closeResult.closedCount} open trades; total P&L ${closeResult.totalPnl >= 0 ? '+' : ''}$${closeResult.totalPnl.toFixed(2)}`
    } else if (action === 'flag_for_review') {
      await client.query(
        `UPDATE accounts
            SET review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [acc.id, String(reason || 'Flagged by auto enforcement')]
      )
      message = 'Account flagged for manual review'
    } else {
      eventStatus = 'failed'
      message = `Unsupported action: ${action}`
    }

    const eventResult = await client.query(
      `INSERT INTO admin_enforcement_events (rule_id, account_id, user_id, action, payload_json, status, message)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        Number.isFinite(parseInt(rule_id, 10)) ? parseInt(rule_id, 10) : null,
        String(acc.id),
        String(acc.user_id),
        String(action),
        JSON.stringify(payload || {}),
        eventStatus,
        message
      ]
    )

    if (rule_id && eventStatus === 'applied') {
      await client.query(
        `UPDATE admin_rules
            SET trigger_count = trigger_count + 1,
                last_triggered_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [parseInt(rule_id, 10)]
      )
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'enforcement_applied',
        entityType: 'account',
        entityId: String(acc.id),
        payload: {
          action: String(action),
          status: eventStatus,
          rule_id: Number.isFinite(parseInt(rule_id, 10)) ? parseInt(rule_id, 10) : null
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({ message, event: eventResult.rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to apply enforcement action' })
  } finally {
    client.release()
  }
})

router.get('/payout-fraud-scores', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.status, p.requested_at,
              u.full_name, u.email, u.kyc_status,
              a.account_size, a.created_at AS account_created_at
         FROM payouts p
         JOIN users u ON u.id = p.user_id
         JOIN accounts a ON a.id = p.account_id
        WHERE p.status IN ('pending', 'flagged')
        ORDER BY p.requested_at DESC
        LIMIT 250`
    )

    const scored = []
    for (const row of result.rows) {
      let score = 0
      const reasons = []
      const amount = parseFloat(row.amount_requested || 0)
      const accountSize = parseFloat(row.account_size || 0)
      const accountAgeDays = Math.max(0, Math.floor((Date.now() - new Date(row.account_created_at).getTime()) / (1000 * 60 * 60 * 24)))

      if (accountSize > 0 && amount > accountSize * 0.2) {
        score += 30
        reasons.push('Large payout relative to account size')
      }
      if (String(row.kyc_status) !== 'approved') {
        score += 25
        reasons.push('KYC not approved')
      }
      if (accountAgeDays < 7) {
        score += 20
        reasons.push('Very new account')
      }

      const openTrades = await pool.query(
        `SELECT COUNT(*)::int AS c FROM trades WHERE account_id = $1 AND status = 'open'`,
        [row.account_id]
      )
      if ((openTrades.rows[0]?.c || 0) > 0) {
        score += 10
        reasons.push('Open trades exist at payout request time')
      }

      const recentTrades = await pool.query(
        `SELECT COUNT(*)::int AS c
           FROM trades
          WHERE account_id = $1
            AND close_time >= NOW() - INTERVAL '24 hours'`,
        [row.account_id]
      )
      if ((recentTrades.rows[0]?.c || 0) >= 10) {
        score += 10
        reasons.push('High recent trade velocity')
      }

      let sharedUsers = 1
      try {
        const lastLoginIp = await pool.query(
          `SELECT ip_address FROM login_logs
            WHERE user_id = $1 AND ip_address IS NOT NULL
            ORDER BY logged_in_at DESC LIMIT 1`,
          [row.user_id]
        )
        const ip = lastLoginIp.rows[0]?.ip_address
        if (ip) {
          const shared = await pool.query(
            `SELECT COUNT(DISTINCT user_id)::int AS c
               FROM login_logs
              WHERE ip_address = $1
                AND logged_in_at >= NOW() - INTERVAL '30 days'`,
            [ip]
          )
          sharedUsers = shared.rows[0]?.c || 1
          if (sharedUsers >= 3) {
            score += 20
            reasons.push('IP shared by multiple users')
          }
        }
      } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

      const risk_level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
      scored.push({
        ...row,
        score,
        risk_level,
        account_age_days: accountAgeDays,
        shared_ip_users: sharedUsers,
        reasons
      })
    }

    scored.sort((a, b) => b.score - a.score)
    res.json(scored)
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute payout fraud scores' })
  }
})

router.get('/device-link-graph', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const focusUserId = req.query.user_id ? String(req.query.user_id) : null

    const loginRows = await pool.query(
      `SELECT user_id, ip_address, logged_in_at
         FROM login_logs
        WHERE ip_address IS NOT NULL
          AND logged_in_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_in_at DESC
        LIMIT 3000`
    )
    const tradeRows = await pool.query(
      `SELECT user_id, account_id, ip_address, logged_at
         FROM trade_logs
        WHERE ip_address IS NOT NULL
          AND logged_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_at DESC
        LIMIT 3000`
    )

    const allowedUsers = new Set()
    if (focusUserId) {
      allowedUsers.add(focusUserId)
      for (const r of loginRows.rows) {
        if (String(r.user_id) === focusUserId) allowedUsers.add(String(r.user_id))
      }
      for (const r of tradeRows.rows) {
        if (String(r.user_id) === focusUserId) allowedUsers.add(String(r.user_id))
      }
    }

    const nodes = new Map()
    const edges = new Map()
    function addNode(id, type, label) {
      if (!nodes.has(id)) nodes.set(id, { id, type, label })
    }
    function addEdge(from, to, type) {
      const key = `${from}|${to}|${type}`
      const prev = edges.get(key)
      if (prev) prev.weight += 1
      else edges.set(key, { id: key, from, to, type, weight: 1 })
    }

    for (const r of loginRows.rows) {
      const uid = String(r.user_id || '')
      const ip = String(r.ip_address || '')
      if (!uid || !ip) continue
      if (focusUserId && uid !== focusUserId) continue
      const uNode = `u:${uid}`
      const ipNode = `ip:${ip}`
      addNode(uNode, 'user', uid)
      addNode(ipNode, 'ip', ip)
      addEdge(uNode, ipNode, 'login_ip')
    }

    for (const r of tradeRows.rows) {
      const uid = String(r.user_id || '')
      const acc = String(r.account_id || '')
      const ip = String(r.ip_address || '')
      if (!uid || !ip) continue
      if (focusUserId && uid !== focusUserId) continue
      const uNode = `u:${uid}`
      const aNode = `a:${acc}`
      const ipNode = `ip:${ip}`
      addNode(uNode, 'user', uid)
      addNode(aNode, 'account', acc)
      addNode(ipNode, 'ip', ip)
      addEdge(uNode, ipNode, 'trade_ip')
      if (acc) addEdge(aNode, ipNode, 'account_ip')
      if (acc) addEdge(uNode, aNode, 'owns')
    }

    res.json({
      generated_at: new Date(),
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values())
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to build device link graph' })
  }
})

module.exports = router
