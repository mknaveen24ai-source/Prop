// Admin news protection, rollover guard, slippage monitor, feed anomalies.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const {
  getSpreadPoints,
  getWideSpreadThreshold,
  getQuickMoveThreshold
} = require('../../constants')
require('../../loadEnv')

const {  getSettingsMap, upsertSetting, toBool } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')

router.get('/news-protection', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'news_protection_enabled',
      'news_protection_lookahead_minutes',
      'news_protection_max_lots_multiplier',
      'news_protection_block_new_orders',
    ]
    const s = await getSettingsMap(keys)
    res.json({
      enabled: toBool(s.news_protection_enabled, false),
      lookahead_minutes: parseInt(s.news_protection_lookahead_minutes || '3', 10),
      max_lots_multiplier: parseFloat(s.news_protection_max_lots_multiplier || '0.6'),
      block_new_orders: toBool(s.news_protection_block_new_orders, true)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load news protection settings' })
  }
})

router.post('/news-protection', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const body = req.body || {}
    await client.query('BEGIN')
    await upsertSetting(client, 'news_protection_enabled', toBool(body.enabled, false))
    await upsertSetting(client, 'news_protection_lookahead_minutes', Math.max(0, parseInt(body.lookahead_minutes || 3, 10)))
    await upsertSetting(client, 'news_protection_max_lots_multiplier', Math.max(0.05, parseFloat(body.max_lots_multiplier || 0.6)))
    await upsertSetting(client, 'news_protection_block_new_orders', toBool(body.block_new_orders, true))
    try {
      await appendImmutableAudit(client, {
        eventType: 'news_protection_updated',
        entityType: 'risk_setting',
        entityId: 'news_protection',
        payload: {
          enabled: toBool(body.enabled, false),
          lookahead_minutes: Math.max(0, parseInt(body.lookahead_minutes || 3, 10)),
          max_lots_multiplier: Math.max(0.05, parseFloat(body.max_lots_multiplier || 0.6)),
          block_new_orders: toBool(body.block_new_orders, true)
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    await client.query('COMMIT')
    res.json({ message: 'News protection settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save news protection settings' })
  } finally {
    client.release()
  }
})

router.get('/rollover-guard', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'rollover_guard_enabled',
      'rollover_guard_start_utc',
      'rollover_guard_end_utc',
      'rollover_guard_block_new_orders',
    ]
    const s = await getSettingsMap(keys)
    res.json({
      enabled: toBool(s.rollover_guard_enabled, true),
      start_utc: s.rollover_guard_start_utc || '21:55',
      end_utc: s.rollover_guard_end_utc || '22:05',
      block_new_orders: toBool(s.rollover_guard_block_new_orders, true)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rollover guard settings' })
  }
})

router.post('/rollover-guard', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const body = req.body || {}
    await client.query('BEGIN')
    await upsertSetting(client, 'rollover_guard_enabled', toBool(body.enabled, true))
    await upsertSetting(client, 'rollover_guard_start_utc', String(body.start_utc || '21:55'))
    await upsertSetting(client, 'rollover_guard_end_utc', String(body.end_utc || '22:05'))
    await upsertSetting(client, 'rollover_guard_block_new_orders', toBool(body.block_new_orders, true))
    try {
      await appendImmutableAudit(client, {
        eventType: 'rollover_guard_updated',
        entityType: 'risk_setting',
        entityId: 'rollover_guard',
        payload: {
          enabled: toBool(body.enabled, true),
          start_utc: String(body.start_utc || '21:55'),
          end_utc: String(body.end_utc || '22:05'),
          block_new_orders: toBool(body.block_new_orders, true)
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    await client.query('COMMIT')
    res.json({ message: 'Rollover guard settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save rollover guard settings' })
  } finally {
    client.release()
  }
})

router.get('/slippage-monitor', authenticateAdmin, async (req, res) => {
  try {
    const prices = await pool.query(
      `SELECT instrument, bid, ask, updated_at
         FROM price_feed`
    )
    const recent = await pool.query(
      `SELECT instrument, direction, open_price, close_price, open_time, close_time
         FROM trades
        WHERE status = 'closed'
          AND close_time >= NOW() - INTERVAL '24 hours'
          AND open_price IS NOT NULL
          AND close_price IS NOT NULL
        ORDER BY close_time DESC
        LIMIT 3000`
    )

    const spreadRows = prices.rows.map(r => {
      const bid = parseFloat(r.bid || 0)
      const ask = parseFloat(r.ask || 0)
      const spreadAbs = Math.max(0, ask - bid)
      const spreadPoints = getSpreadPoints(spreadAbs, r.instrument)
      const threshold = getWideSpreadThreshold(r.instrument)
      return {
        instrument: r.instrument,
        spread_points: parseFloat(spreadPoints.toFixed(2)),
        threshold_points: threshold,
        is_alert: spreadPoints > threshold,
        updated_at: r.updated_at || null
      }
    })

    let suspicious = 0
    let sampleCount = 0
    const byInstrument = {}
    for (const t of recent.rows) {
      const openPrice = parseFloat(t.open_price || 0)
      const closePrice = parseFloat(t.close_price || 0)
      const holdSec = Math.max(0, (new Date(t.close_time).getTime() - new Date(t.open_time).getTime()) / 1000)
      const points = getSpreadPoints(Math.abs(closePrice - openPrice), t.instrument)
      const quickMoveThreshold = getQuickMoveThreshold(t.instrument)
      sampleCount += 1

      if (!byInstrument[t.instrument]) byInstrument[t.instrument] = { instrument: t.instrument, trades: 0, avg_move_points: 0, suspicious_quick_moves: 0 }
      byInstrument[t.instrument].trades += 1
      byInstrument[t.instrument].avg_move_points += points

      if (holdSec < 60 && points > quickMoveThreshold) {
        suspicious += 1
        byInstrument[t.instrument].suspicious_quick_moves += 1
      }
    }

    const drift = Object.values(byInstrument).map(r => ({
      ...r,
      avg_move_points: r.trades > 0 ? parseFloat((r.avg_move_points / r.trades).toFixed(2)) : 0
    })).sort((a, b) => b.suspicious_quick_moves - a.suspicious_quick_moves)

    res.json({
      generated_at: new Date(),
      spread_monitor: spreadRows.sort((a, b) => (b.is_alert ? 1 : 0) - (a.is_alert ? 1 : 0)),
      drift_monitor: drift,
      suspicious_quick_moves: suspicious,
      sample_count: sampleCount
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load slippage monitor' })
  }
})

router.get('/feed-anomalies', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap(['feed_stale_threshold_seconds'])
    const staleThreshold = Math.max(5, parseInt(settings.feed_stale_threshold_seconds || '30', 10))

    const result = await pool.query(`SELECT instrument, bid, ask, updated_at FROM price_feed`)
    const now = Date.now()
    const rows = []
    let staleCount = 0
    let wideSpreadCount = 0

    for (const r of result.rows) {
      const bid = parseFloat(r.bid || 0)
      const ask = parseFloat(r.ask || 0)
      const spreadAbs = Math.max(0, ask - bid)
      const spreadPoints = getSpreadPoints(spreadAbs, r.instrument)
      const spreadThreshold = getWideSpreadThreshold(r.instrument)
      const ageSec = r.updated_at ? Math.max(0, Math.floor((now - new Date(r.updated_at).getTime()) / 1000)) : 999999
      const stale = ageSec > staleThreshold
      const wide = spreadPoints > spreadThreshold
      if (stale) staleCount += 1
      if (wide) wideSpreadCount += 1

      rows.push({
        instrument: r.instrument,
        bid,
        ask,
        spread_points: parseFloat(spreadPoints.toFixed(2)),
        spread_threshold: spreadThreshold,
        seconds_since_update: ageSec,
        stale,
        wide_spread: wide
      })
    }

    const anomalies = rows.filter(r => r.stale || r.wide_spread)
    res.json({
      generated_at: new Date(),
      stale_threshold_seconds: staleThreshold,
      stale_count: staleCount,
      wide_spread_count: wideSpreadCount,
      any_anomaly: anomalies.length > 0,
      instruments: rows,
      anomalies
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feed anomalies' })
  }
})

module.exports = router
