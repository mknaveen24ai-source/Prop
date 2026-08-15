// Admin stress simulator, scheduled reports, emergency kill switch.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const { adminAccountActionLimiter } = require('./shared/rateLimiters')
const {
  authenticateAdmin,
  requireSuperAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const {
  getPipSize,
  roundPrice
} = require('../../constants')
require('../../loadEnv')

const { ensureFeatureTables, getSettingsMap, upsertSetting, toBool } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  calcTradePnl, forceCloseOpenTradesForAccount
} = require('./shared/tradeOps')

router.post('/stress-simulator', authenticateAdmin, async (req, res) => {
  try {
    const shockPctRaw = parseFloat(req.body?.shock_pct ?? req.query.shock_pct ?? 2)
    const shockPct = Number.isFinite(shockPctRaw) ? Math.max(0.1, Math.min(25, shockPctRaw)) : 2
    const slippageRaw = parseFloat(req.body?.slippage_points ?? req.query.slippage_points ?? 0)
    const slippagePoints = Number.isFinite(slippageRaw) ? Math.max(0, Math.min(500, slippageRaw)) : 0
    const instrument = String(req.body?.instrument || req.query.instrument || '').trim().toUpperCase()

    const query = await pool.query(
      `SELECT
         t.id::text AS trade_id,
         t.account_id::text AS account_id,
         COALESCE(a.account_uid::text, a.id::text) AS account_uid,
         a.account_type,
         a.status AS account_status,
         COALESCE(u.full_name, '') AS full_name,
         COALESCE(u.email, '') AS email,
         t.instrument,
         t.direction,
         COALESCE(t.open_price, 0)::numeric AS open_price,
         COALESCE(t.lot_size, 0)::numeric AS lot_size,
         COALESCE(p.bid, t.open_price)::numeric AS bid,
         COALESCE(p.ask, t.open_price)::numeric AS ask
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       WHERE t.status = 'open'
         AND ($1 = '' OR t.instrument = $1)
       ORDER BY t.open_time DESC
       LIMIT 5000`,
      [instrument]
    )

    const byAccount = new Map()
    const tradeRows = []

    for (const row of query.rows) {
      const openPrice = parseFloat(row.open_price || 0)
      const lots = parseFloat(row.lot_size || 0)
      const currentPrice = String(row.direction) === 'buy'
        ? parseFloat(row.bid || openPrice)
        : parseFloat(row.ask || openPrice)

      const pointSize = getPipSize(String(row.instrument))
      const shockMove = currentPrice * (shockPct / 100)
      const slippageMove = slippagePoints * pointSize
      const stressedPrice = String(row.direction) === 'buy'
        ? Math.max(0, currentPrice - shockMove - slippageMove)
        : Math.max(0, currentPrice + shockMove + slippageMove)

      const currentPnl = calcTradePnl(String(row.direction), openPrice, currentPrice, lots, String(row.instrument))
      const stressedPnl = calcTradePnl(String(row.direction), openPrice, stressedPrice, lots, String(row.instrument))
      const pnlDelta = parseFloat((stressedPnl - currentPnl).toFixed(2))

      tradeRows.push({
        trade_id: row.trade_id,
        account_id: row.account_id,
        account_uid: row.account_uid,
        account_type: row.account_type,
        full_name: row.full_name,
        email: row.email,
        instrument: row.instrument,
        direction: row.direction,
        lot_size: lots,
        current_price: roundPrice(currentPrice, row.instrument),
        stressed_price: roundPrice(stressedPrice, row.instrument),
        current_pnl: currentPnl,
        stressed_pnl: stressedPnl,
        pnl_delta: pnlDelta
      })

      const agg = byAccount.get(row.account_id) || {
        account_id: row.account_id,
        account_uid: row.account_uid,
        account_type: row.account_type,
        full_name: row.full_name,
        email: row.email,
        trade_count: 0,
        current_pnl: 0,
        stressed_pnl: 0,
        pnl_delta: 0
      }
      agg.trade_count += 1
      agg.current_pnl += currentPnl
      agg.stressed_pnl += stressedPnl
      agg.pnl_delta += pnlDelta
      byAccount.set(row.account_id, agg)
    }

    const accounts = Array.from(byAccount.values()).map(a => ({
      ...a,
      current_pnl: parseFloat(a.current_pnl.toFixed(2)),
      stressed_pnl: parseFloat(a.stressed_pnl.toFixed(2)),
      pnl_delta: parseFloat(a.pnl_delta.toFixed(2))
    })).sort((a, b) => a.pnl_delta - b.pnl_delta)

    const totalCurrent = tradeRows.reduce((s, t) => s + (t.current_pnl || 0), 0)
    const totalStressed = tradeRows.reduce((s, t) => s + (t.stressed_pnl || 0), 0)
    const totalDelta = totalStressed - totalCurrent

    res.json({
      generated_at: new Date(),
      params: {
        shock_pct: shockPct,
        slippage_points: slippagePoints,
        instrument: instrument || 'all'
      },
      summary: {
        open_trades: tradeRows.length,
        affected_accounts: accounts.length,
        current_total_pnl: parseFloat(totalCurrent.toFixed(2)),
        stressed_total_pnl: parseFloat(totalStressed.toFixed(2)),
        pnl_delta: parseFloat(totalDelta.toFixed(2))
      },
      by_account: accounts.slice(0, 300),
      top_trade_impacts: [...tradeRows]
        .sort((a, b) => a.pnl_delta - b.pnl_delta)
        .slice(0, 300)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to run stress simulation' })
  }
})

router.get('/scheduled-reports', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT
         id, report_key, title, channel, recipients, schedule_cron, timezone,
         enabled, last_run_at, next_run_at, created_by, created_at, updated_at
       FROM admin_scheduled_reports
       ORDER BY enabled DESC, updated_at DESC, id DESC
       LIMIT 500`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load scheduled reports' })
  }
})

router.post('/scheduled-reports', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      id = null,
      report_key,
      title,
      channel = 'email',
      recipients = '',
      schedule_cron = '0 9 * * *',
      timezone = 'UTC',
      enabled = true,
      next_run_at = null,
      created_by = 'admin'
    } = req.body || {}

    if (!report_key || String(report_key).trim().length < 2) {
      return res.status(400).json({ error: 'report_key is required (min 2 chars)' })
    }
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 chars)' })
    }
    const safeChannel = ['email', 'web', 'webhook'].includes(String(channel)) ? String(channel) : 'email'
    const nextRun = next_run_at ? new Date(next_run_at) : null
    const parsedNextRun = nextRun && !Number.isNaN(nextRun.getTime()) ? nextRun.toISOString() : null

    const normalizedRecipients = Array.isArray(recipients)
      ? recipients.map(v => String(v || '').trim()).filter(Boolean).join(',')
      : String(recipients || '').trim()

    let saved
    if (id && Number.isFinite(parseInt(id, 10))) {
      const update = await pool.query(
        `UPDATE admin_scheduled_reports
            SET report_key = $2,
                title = $3,
                channel = $4,
                recipients = $5,
                schedule_cron = $6,
                timezone = $7,
                enabled = $8,
                next_run_at = $9::timestamptz,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          parseInt(id, 10),
          String(report_key).trim(),
          String(title).trim(),
          safeChannel,
          normalizedRecipients,
          String(schedule_cron || '0 9 * * *').trim(),
          String(timezone || 'UTC').trim(),
          toBool(enabled, true),
          parsedNextRun
        ]
      )
      if (update.rows.length === 0) return res.status(404).json({ error: 'Scheduled report not found' })
      saved = update.rows[0]
    } else {
      const insert = await pool.query(
        `INSERT INTO admin_scheduled_reports
          (report_key, title, channel, recipients, schedule_cron, timezone, enabled, next_run_at, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, NOW())
         RETURNING *`,
        [
          String(report_key).trim(),
          String(title).trim(),
          safeChannel,
          normalizedRecipients,
          String(schedule_cron || '0 9 * * *').trim(),
          String(timezone || 'UTC').trim(),
          toBool(enabled, true),
          parsedNextRun,
          String(created_by || 'admin').trim()
        ]
      )
      saved = insert.rows[0]
    }

    try {
      await appendImmutableAudit(pool, {
        eventType: 'scheduled_report_saved',
        entityType: 'scheduled_report',
        entityId: String(saved.id),
        payload: {
          report_key: saved.report_key,
          enabled: !!saved.enabled,
          channel: saved.channel
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(saved)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save scheduled report' })
  }
})

router.post('/scheduled-reports/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' })
    const updated = await pool.query(
      `UPDATE admin_scheduled_reports
          SET enabled = NOT enabled,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Scheduled report not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'scheduled_report_toggled',
        entityType: 'scheduled_report',
        entityId: String(id),
        payload: { enabled: !!updated.rows[0].enabled }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(updated.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle scheduled report' })
  }
})

// admin_emergency_kill handler
router.get('/emergency-kill/status', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap([
      'emergency_kill_enabled',
      'emergency_kill_last_triggered_at',
      'emergency_kill_last_reset_at'
    ])
    const openTrades = await pool.query(`SELECT COUNT(*)::int AS c FROM trades WHERE status = 'open'`)
    res.json({
      enabled: toBool(settings.emergency_kill_enabled, false),
      last_triggered_at: settings.emergency_kill_last_triggered_at || null,
      last_reset_at: settings.emergency_kill_last_reset_at || null,
      open_trades: parseInt(openTrades.rows[0]?.c || 0, 10)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load emergency kill status' })
  }
})

router.post('/emergency-kill/execute', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const dryRun = toBool(req.body?.dry_run, false)
    const confirmPhrase = String(req.body?.confirm_phrase || '').trim()
    if (!dryRun && confirmPhrase !== 'KILL ALL TRADES') {
      return res.status(400).json({ error: 'confirm_phrase must be exactly "KILL ALL TRADES"' })
    }

    const preview = await pool.query(
      `SELECT account_id::text AS account_id, COUNT(*)::int AS open_trades
       FROM trades
       WHERE status = 'open'
       GROUP BY account_id
       ORDER BY COUNT(*) DESC`
    )
    const openTradeCount = preview.rows.reduce((sum, r) => sum + parseInt(r.open_trades || 0, 10), 0)
    if (dryRun) {
      return res.json({
        dry_run: true,
        open_trades: openTradeCount,
        affected_accounts: preview.rows.length,
        by_account: preview.rows
      })
    }

    await client.query('BEGIN')
    const accountIdsResult = await client.query(
      `SELECT DISTINCT account_id::text AS account_id FROM trades WHERE status = 'open'`
    )

    let closedTrades = 0
    let totalPnl = 0
    for (const row of accountIdsResult.rows) {
      const closeResult = await forceCloseOpenTradesForAccount(client, row.account_id)
      closedTrades += closeResult.closedCount
      totalPnl += closeResult.totalPnl
    }

    await upsertSetting(client, 'emergency_kill_enabled', 'true')
    await upsertSetting(client, 'emergency_kill_last_triggered_at', new Date().toISOString())

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_executed',
        entityType: 'system',
        entityId: 'global',
        payload: {
          closed_trades: closedTrades,
          affected_accounts: accountIdsResult.rows.length,
          total_pnl: parseFloat(totalPnl.toFixed(2))
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({
      dry_run: false,
      closed_trades: closedTrades,
      affected_accounts: accountIdsResult.rows.length,
      total_pnl: parseFloat(totalPnl.toFixed(2)),
      emergency_kill_enabled: true
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to execute emergency kill switch' })
  } finally {
    client.release()
  }
})

router.post('/emergency-kill/reset', authenticateAdmin, adminAccountActionLimiter, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()

    await client.query('BEGIN')
    await upsertSetting(client, 'emergency_kill_enabled', 'false')
    await upsertSetting(client, 'emergency_kill_last_reset_at', new Date().toISOString())

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_reset',
        entityType: 'system',
        entityId: 'global',
        payload: {}
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json({
      emergency_kill_enabled: false,
      last_reset_at: new Date().toISOString()
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reset emergency kill switch' })
  } finally {
    client.release()
  }
})

module.exports = router
