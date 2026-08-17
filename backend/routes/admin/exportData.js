// Admin CSV/JSON export of the trader, account, payout and email-job lists.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const { ensureDisputesInfrastructure } = require('../disputes')
const { ensureChatTables } = require('../chat')
require('../../loadEnv')

const { ensureFeatureTables, toBool } = require('./shared/schema')
const {
  serializeCsv
} = require('./shared/helpers')
const {
  buildTraderListResult, buildAccountListResult, buildPayoutListResult
} = require('./shared/listBuilders')

const { buildEmailJobListResult } = require('./shared/emailJobList')
const { buildAccountLinkListResult } = require('./shared/accountLinkList')

router.post('/export', authenticateAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const resource = String(req.body?.resource || '').trim().toLowerCase()
    const query = {
      search: req.body?.search || '',
      page: 1,
      pageSize: 5000,
      sort: req.body?.sort || undefined,
      order: req.body?.order || undefined,
      filters: req.body?.filters && typeof req.body.filters === 'object' ? req.body.filters : {}
    }

    let result
    let columns
    if (resource === 'traders') {
      result = await buildTraderListResult({ query })
      columns = [
        { header: 'Trader ID', key: 'id' },
        { header: 'Email', key: 'email' },
        { header: 'Full Name', key: 'full_name' },
        { header: 'Country', key: 'country' },
        { header: 'KYC Status', key: 'kyc_status' },
        { header: 'Is Banned', value: (row) => row.is_banned ? 'Yes' : 'No' },
        { header: 'Risk Tier', key: 'risk_tier' },
        { header: 'Classification', key: 'classification' },
        { header: 'Tags', value: (row) => (row.tags || []).join('|') },
        { header: 'Created At', key: 'created_at' }
      ]
    } else if (resource === 'accounts') {
      result = await buildAccountListResult({ query })
      columns = [
        { header: 'Account ID', key: 'id' },
        { header: 'Trader Email', key: 'user_email' },
        { header: 'Account Type', key: 'account_type' },
        { header: 'Status', key: 'status' },
        { header: 'Account Size', key: 'account_size' },
        { header: 'Current Balance', key: 'current_balance' },
        { header: 'Risk Tier', key: 'risk_tier' },
        { header: 'Classification', key: 'classification' },
        { header: 'Tags', value: (row) => (row.tags || []).join('|') },
        { header: 'Created At', key: 'created_at' }
      ]
    } else if (resource === 'payouts') {
      result = await buildPayoutListResult({ query })
      columns = [
        { header: 'Payout ID', key: 'id' },
        { header: 'Trader Email', key: 'email' },
        { header: 'Account ID', key: 'account_id' },
        { header: 'Status', key: 'status' },
        { header: 'Flagged', value: (row) => row.is_flagged ? 'Yes' : 'No' },
        { header: 'Amount Requested', key: 'amount_requested' },
        { header: 'Amount Payable', key: 'amount_payable' },
        { header: 'Risk Tier', key: 'risk_tier' },
        { header: 'Tags', value: (row) => (row.tags || []).join('|') },
        { header: 'Requested At', key: 'requested_at' }
      ]
    } else if (resource === 'email_jobs') {
      result = await buildEmailJobListResult({ query })
      columns = [
        { header: 'Job ID', key: 'id' },
        { header: 'Recipient', key: 'to_email' },
        { header: 'Template', key: 'template_key' },
        { header: 'Delivery Type', key: 'delivery_type' },
        { header: 'Status', key: 'status' },
        { header: 'Attempts', key: 'attempt_count' },
        { header: 'Scheduled For', key: 'scheduled_for' },
        { header: 'Last Attempt', key: 'last_attempt_at' },
        { header: 'Sent At', key: 'sent_at' },
        { header: 'Provider Message ID', key: 'provider_message_id' },
        { header: 'Preview Path', key: 'preview_url' },
        { header: 'Unique Key', key: 'unique_key' },
        { header: 'Last Error', key: 'last_error' }
      ]
    } else if (resource === 'account_links') {
      result = await buildAccountLinkListResult({ query })
      columns = [
        { header: 'Cluster ID', key: 'id' },
        { header: 'Score', key: 'score' },
        { header: 'Confidence', key: 'confidence' },
        { header: 'Status', key: 'status' },
        { header: 'Members', key: 'member_count' },
        { header: 'Member Emails', key: 'member_emails' },
        { header: 'Signals', key: 'signal_types' },
        { header: 'Evidence Items', key: 'evidence_count' },
        { header: 'First Detected', key: 'first_detected_at' },
        { header: 'Last Detected', key: 'last_detected_at' },
        { header: 'Resolved By', key: 'resolved_by' },
        { header: 'Resolution Note', key: 'resolution_note' }
      ]
    } else if (resource === 'trades') {
      const filters = query.filters || {}
      const where = []
      const params = []

      if (query.search) {
        params.push(`%${String(query.search).trim().toLowerCase()}%`)
        where.push(`(
          LOWER(COALESCE(t.instrument, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.email, '')) LIKE $${params.length}
          OR LOWER(COALESCE(t.id::text, '')) LIKE $${params.length}
          OR LOWER(COALESCE(t.account_id::text, '')) LIKE $${params.length}
          OR LOWER(COALESCE(a.user_id::text, '')) LIKE $${params.length}
        )`)
      }
      if (filters.status) {
        params.push(String(filters.status).trim().toLowerCase())
        where.push(`LOWER(COALESCE(t.status, '')) = $${params.length}`)
      }
      if (filters.direction) {
        params.push(String(filters.direction).trim().toLowerCase())
        where.push(`LOWER(COALESCE(t.direction, '')) = $${params.length}`)
      }
      if (filters.instrument) {
        params.push(String(filters.instrument).trim().toUpperCase())
        where.push(`UPPER(COALESCE(t.instrument, '')) = $${params.length}`)
      }

      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      const tradesResult = await pool.query(
        `SELECT t.id,
                t.account_id,
                a.user_id,
                u.email,
                t.instrument AS symbol,
                UPPER(t.direction) AS type,
                t.lot_size AS lots,
                t.open_price,
                t.close_price,
                t.stop_loss AS sl,
                t.take_profit AS tp,
                t.status,
                t.demo_pnl AS pnl,
                t.open_time,
                t.close_time
           FROM trades t
           JOIN accounts a ON a.id = t.account_id
           LEFT JOIN users u ON u.id = a.user_id
           ${whereClause}
          ORDER BY COALESCE(t.close_time, t.open_time) DESC
          LIMIT 5000`,
        params
      )
      result = { allRows: tradesResult.rows }
      columns = [
        { header: 'Trade ID', key: 'id' },
        { header: 'Account ID', key: 'account_id' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Trader Email', key: 'email' },
        { header: 'Symbol', key: 'symbol' },
        { header: 'Direction', key: 'type' },
        { header: 'Lots', key: 'lots' },
        { header: 'Open Price', key: 'open_price' },
        { header: 'Close Price', key: 'close_price' },
        { header: 'Status', key: 'status' },
        { header: 'PnL', key: 'pnl' },
        { header: 'Open Time', key: 'open_time' },
        { header: 'Close Time', key: 'close_time' }
      ]
    } else if (resource === 'leaderboard') {
      const filters = query.filters || {}
      const params = []
      const conditions = [
        `a.account_type = 'funded'`,
        `a.status = 'active'`,
        `COALESCE(u.is_banned, FALSE) = FALSE`
      ]

      if (query.search) {
        params.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(u.email, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.full_name, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.country, '')) LIKE $${params.length}
          OR LOWER(COALESCE(u.trader_uid, '')) LIKE $${params.length}
        )`)
      }
      if (filters.visible === 'visible') {
        conditions.push(`COALESCE(u.leaderboard_visible, TRUE) = TRUE`)
      } else if (filters.visible === 'hidden') {
        conditions.push(`COALESCE(u.leaderboard_visible, TRUE) = FALSE`)
      }

      const leaderboardResult = await pool.query(
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
            WHERE ${conditions.join(' AND ')}
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
          LIMIT 5000
        `,
        params
      )
      result = {
        allRows: leaderboardResult.rows.map((row, index) => ({
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
        }))
      }
      columns = [
        { header: 'Rank', key: 'rank' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Email', key: 'email' },
        { header: 'Full Name', key: 'full_name' },
        { header: 'Country', key: 'country' },
        { header: 'Trader UID', key: 'trader_uid' },
        { header: 'Visible', value: (row) => row.visible ? 'Yes' : 'No' },
        { header: 'Account UID', key: 'account_uid' },
        { header: 'Account Size', key: 'account_size' },
        { header: 'Profit USD', key: 'profit_usd' },
        { header: 'Profit %', key: 'profit_pct' },
        { header: 'Total Trades', key: 'total_trades' },
        { header: 'Win Rate', key: 'win_rate' }
      ]
    } else if (resource === 'bbook') {
      const filters = query.filters || {}
      const where = [
        `t.status = 'closed'`,
        `a.account_type = 'funded'`
      ]
      const params = []

      if (query.search) {
        params.push(`%${String(query.search).trim().toLowerCase()}%`)
        where.push(`(
          LOWER(COALESCE(t.instrument, '')) LIKE $${params.length}
          OR LOWER(COALESCE(t.id::text, '')) LIKE $${params.length}
        )`)
      }
      if (filters.direction) {
        params.push(String(filters.direction).trim().toLowerCase())
        where.push(`LOWER(COALESCE(t.direction, '')) = $${params.length}`)
      }
      if (filters.symbol) {
        params.push(String(filters.symbol).trim().toUpperCase())
        where.push(`UPPER(COALESCE(t.instrument, '')) = $${params.length}`)
      }
      if (filters.edge_side === 'positive') {
        where.push(`(COALESCE(t.commission, 0) - COALESCE(t.demo_pnl, 0)) >= 0`)
      } else if (filters.edge_side === 'negative') {
        where.push(`(COALESCE(t.commission, 0) - COALESCE(t.demo_pnl, 0)) < 0`)
      }

      const bbookResult = await pool.query(
        `
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
          WHERE ${where.join(' AND ')}
          ORDER BY t.close_time DESC NULLS LAST, t.id DESC
          LIMIT 5000
        `,
        params
      )
      result = { allRows: bbookResult.rows }
      columns = [
        { header: 'Trade ID', key: 'id' },
        { header: 'Symbol', key: 'symbol' },
        { header: 'Direction', key: 'type' },
        { header: 'Lots', key: 'lots' },
        { header: 'Trader PnL', key: 'trader_pnl' },
        { header: 'Platform Edge', key: 'platform_pnl' },
        { header: 'Fee Revenue', key: 'fee_revenue' },
        { header: 'Closed At', key: 'closed_at' }
      ]
    } else if (resource === 'chat_conversations') {
      await ensureChatTables()
      const filters = query.filters || {}
      const conditions = []
      const values = []

      if (query.search) {
        values.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(c.subject, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.email, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(c.id::text, '')) LIKE $${values.length}
          OR LOWER(COALESCE(last_message.message, '')) LIKE $${values.length}
        )`)
      }
      if (filters.status) {
        values.push(String(filters.status).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(c.status, '')) = $${values.length}`)
      }
      if (toBool(filters.unread_only, false)) {
        conditions.push(`COALESCE(c.unread_admin_count, 0) > 0`)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const chatResult = await pool.query(
        `
          SELECT
            c.id,
            c.user_id,
            c.subject,
            c.status,
            c.assigned_to,
            c.created_at,
            c.updated_at,
            c.last_message_at,
            c.unread_user_count,
            c.unread_admin_count,
            u.email AS user_email,
            u.full_name AS user_name,
            message_count.count AS message_count,
            last_message.message AS last_message
          FROM chat_conversations c
          LEFT JOIN users u ON u.id::text = c.user_id
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS count
            FROM chat_messages
            WHERE conversation_id = c.id
          ) AS message_count ON TRUE
          LEFT JOIN LATERAL (
            SELECT message
            FROM chat_messages
            WHERE conversation_id = c.id
            ORDER BY created_at DESC
            LIMIT 1
          ) AS last_message ON TRUE
          ${whereClause}
          ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
          LIMIT 5000
        `,
        values
      )
      result = { allRows: chatResult.rows }
      columns = [
        { header: 'Conversation ID', key: 'id' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Status', key: 'status' },
        { header: 'Subject', key: 'subject' },
        { header: 'User Email', key: 'user_email' },
        { header: 'User Name', key: 'user_name' },
        { header: 'Assigned To', key: 'assigned_to' },
        { header: 'Message Count', key: 'message_count' },
        { header: 'Unread Admin', key: 'unread_admin_count' },
        { header: 'Last Message', key: 'last_message' },
        { header: 'Last Message At', key: 'last_message_at' },
        { header: 'Created At', key: 'created_at' }
      ]
    } else if (resource === 'violations') {
      const filters = query.filters || {}
      const conditions = []
      const values = []

      if (query.search) {
        values.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(violation_type, '')) LIKE $${values.length}
          OR LOWER(COALESCE(message, '')) LIKE $${values.length}
          OR LOWER(COALESCE(instrument, '')) LIKE $${values.length}
          OR LOWER(COALESCE(account_id::text, '')) LIKE $${values.length}
          OR LOWER(COALESCE(user_id::text, '')) LIKE $${values.length}
          OR LOWER(COALESCE(id::text, '')) LIKE $${values.length}
        )`)
      }
      if (filters.status) {
        values.push(String(filters.status).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(status, '')) = $${values.length}`)
      }
      if (filters.severity) {
        values.push(String(filters.severity).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(severity, '')) = $${values.length}`)
      }
      if (filters.type) {
        values.push(String(filters.type).trim())
        conditions.push(`violation_type = $${values.length}`)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const violationsResult = await pool.query(
        `SELECT id, violation_type, severity, status, account_id, user_id, trade_id,
                instrument, source, message, hit_count, first_detected_at, last_detected_at,
                resolved_at, resolution_note, resolution_type
           FROM admin_rule_violations
           ${whereClause}
          ORDER BY last_detected_at DESC
          LIMIT 5000`,
        values
      )
      result = { allRows: violationsResult.rows }
      columns = [
        { header: 'Violation ID', key: 'id' },
        { header: 'Type', key: 'violation_type' },
        { header: 'Severity', key: 'severity' },
        { header: 'Status', key: 'status' },
        { header: 'Account ID', key: 'account_id' },
        { header: 'User ID', key: 'user_id' },
        { header: 'Trade ID', key: 'trade_id' },
        { header: 'Instrument', key: 'instrument' },
        { header: 'Source', key: 'source' },
        { header: 'Message', key: 'message' },
        { header: 'Hit Count', key: 'hit_count' },
        { header: 'First Detected', key: 'first_detected_at' },
        { header: 'Last Detected', key: 'last_detected_at' },
        { header: 'Resolved At', key: 'resolved_at' },
        { header: 'Resolution Type', key: 'resolution_type' }
      ]
    } else if (resource === 'disputes') {
      await ensureDisputesInfrastructure()
      const filters = query.filters || {}
      const conditions = []
      const values = []

      if (query.search) {
        values.push(`%${String(query.search).trim().toLowerCase()}%`)
        conditions.push(`(
          LOWER(COALESCE(d.reason, '')) LIKE $${values.length}
          OR LOWER(COALESCE(d.description, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.email, '')) LIKE $${values.length}
          OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
          OR LOWER(COALESCE(d.id::text, '')) LIKE $${values.length}
        )`)
      }
      if (filters.status) {
        values.push(String(filters.status).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(d.status, '')) = $${values.length}`)
      }
      if (filters.priority) {
        values.push(String(filters.priority).trim().toLowerCase())
        conditions.push(`LOWER(COALESCE(m.priority, 'normal')) = $${values.length}`)
      }
      if (filters.owner) {
        values.push(String(filters.owner).trim())
        conditions.push(`COALESCE(m.owner, 'unassigned') = $${values.length}`)
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
      const disputesResult = await pool.query(
        `SELECT d.id::text AS dispute_id,
                d.status,
                d.reason,
                d.description,
                d.admin_response,
                d.created_at,
                d.updated_at,
                u.full_name,
                u.email,
                a.account_uid,
                a.account_type,
                a.status AS account_status,
                COALESCE(m.owner, 'unassigned') AS owner,
                COALESCE(m.priority, 'normal') AS priority,
                COALESCE(m.sla_hours, 48)::int AS sla_hours,
                COALESCE(m.notes, '') AS notes
           FROM disputes d
           LEFT JOIN users u ON u.id::text = d.user_id::text
           LEFT JOIN accounts a ON a.id::text = d.account_id::text
           LEFT JOIN admin_dispute_meta m ON m.dispute_id = d.id::text
           ${whereClause}
          ORDER BY d.created_at DESC
          LIMIT 5000`,
        values
      )
      result = { allRows: disputesResult.rows }
      columns = [
        { header: 'Dispute ID', key: 'dispute_id' },
        { header: 'Status', key: 'status' },
        { header: 'Reason', key: 'reason' },
        { header: 'Description', key: 'description' },
        { header: 'Admin Response', key: 'admin_response' },
        { header: 'Trader Name', key: 'full_name' },
        { header: 'Trader Email', key: 'email' },
        { header: 'Account UID', key: 'account_uid' },
        { header: 'Account Type', key: 'account_type' },
        { header: 'Account Status', key: 'account_status' },
        { header: 'Owner', key: 'owner' },
        { header: 'Priority', key: 'priority' },
        { header: 'SLA Hours', key: 'sla_hours' },
        { header: 'Notes', key: 'notes' },
        { header: 'Created At', key: 'created_at' },
        { header: 'Updated At', key: 'updated_at' }
      ]
    } else {
      return res.status(400).json({ error: 'resource must be traders, accounts, payouts, email_jobs, account_links, trades, leaderboard, bbook, chat_conversations, violations, or disputes' })
    }

    const csv = serializeCsv(result.allRows || [], columns)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${resource}-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(csv)
  } catch (error) {
    logger.error('Admin export error:', { error: error.message })
    res.status(500).json({ error: 'Could not export data' })
  }
})

module.exports = router
