// Admin platform settings, price-feed health, incidents and rule engine.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const { adminDeleteLimiter } = require('./shared/rateLimiters')
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
  getExposureData
} = require('./shared/tradeOps')

router.get('/settings', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM platform_settings')
    const settings = {}
    result.rows.forEach(r => { settings[r.key] = r.value })
    res.json(settings)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

const WRITABLE_SETTINGS_KEYS = new Set([
  'challenge_start_requires_kyc', 'hide_unavailable_sizes_on_landing', 'sold_out_message',
  // 'promotion_requires_admin_review' was writable here but read nowhere, so the
  // toggle did nothing. Admin review is now unconditional — every passed
  // challenge raises a review — so the key is gone rather than left as a
  // control that silently has no effect.
  'promotion_review_sla_hours', 'failed_account_visibility_days',
  'passed_account_visibility_days', 'expired_account_visibility_days',
  'funded_max_drawdown_pct', 'profit_share_pct', 'payouts_enabled', 'min_payout_amount',
  'payout_request_cooldown_hours', 'payout_requires_kyc_approved', 'payout_requires_no_open_positions',
  'min_hold_seconds', 'min_lot_size', 'forex_lots_per_1k', 'commodity_lots_per_1k',
  'max_trades_per_1k', 'max_daily_trades', 'weekend_holding_enabled',
  'dynamic_commission_per_lot', 'commission_per_lot_json',
  'slippage_simulator_enabled', 'slippage_max_pips_adverse', 'slippage_max_pips_adverse_json',
  'news_protection_enabled', 'news_protection_block_new_orders', 'news_protection_lookahead_minutes',
  'rollover_guard_enabled', 'rollover_guard_block_new_orders',
  'support_response_sla_hours', 'dispute_submission_window_days', 'support_ticket_categories',
  'support_escalation_label', 'inactivity_auto_fail_enabled', 'inactivity_fail_days',
  'payment_provider', 'payment_provider_public_key', 'payment_provider_secret_key',
  'payment_provider_webhook_secret', 'payment_provider_account_id',
  'affiliate_program_enabled', 'affiliate_referred_discount_pct',
  'affiliate_min_payout_amount', 'affiliate_default_commission_pct'
]);

router.post('/settings', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(req.body).filter(key => WRITABLE_SETTINGS_KEYS.has(key));
    for (const key of keys) {
      await client.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(req.body[key])]
      );
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'settings_updated',
        entityType: 'platform_settings',
        entityId: 'global',
        payload: { keys }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    await client.query('COMMIT');
    res.json({ message: 'Settings saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to save settings' });
  } finally {
    client.release();
  }
});

router.get('/price-feed-health', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT instrument, bid, ask, updated_at FROM price_feed');
    // FIX (BUG-L9): ticks_last_5min was hardcoded as 124. Now queries real count
    // from price_feed_history for each instrument over the last 5 minutes.
    const tickCounts = await pool.query(`
      SELECT instrument, COUNT(*) AS tick_count
      FROM price_feed_history
      WHERE recorded_at > NOW() - INTERVAL '5 minutes'
      GROUP BY instrument
    `);
    const tickMap = {};
    tickCounts.rows.forEach(r => { tickMap[r.instrument] = parseInt(r.tick_count || 0); });

    const mapped = result.rows.map(r => ({
      updated_at: r.updated_at || null,
      instrument: r.instrument,
      bid: r.bid,
      ask: r.ask,
      seconds_since_update: r.updated_at
        ? Math.max(0, Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 1000))
        : null,
      ticks_last_5min: tickMap[r.instrument] || 0,
      status: r.updated_at
        ? (Date.now() - new Date(r.updated_at).getTime() < 30000 ? 'operational' : 'stale')
        : 'unknown'
    }));
    res.json({ instruments: mapped });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/risk-dashboard', authenticateAdmin, async (req, res) => {
  try {
    const { exposureData, total_open_trades, total_floating_pnl } = await getExposureData(pool);

    res.json({
      exposure: exposureData,
      total_open_trades: total_open_trades,
      total_floating_pnl: total_floating_pnl,
      near_breach_accounts: [],
      near_target_accounts: [],
      updated_at: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/price-staleness', authenticateAdmin, async (req, res) => {
  res.json({ any_stale: false, stale_instruments: [] });
});

// ---------------------------------------------------------------------------
// FEATURE MODULES (MVP): Incident Center, Rule Builder, Auto Enforcement,
// Payout Fraud Scoring, Device/IP Link Graph
// ---------------------------------------------------------------------------

router.get('/incidents', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, title, severity, status, source, details, created_at, updated_at,
              acknowledged_at, resolved_at, acknowledged_by
       FROM admin_incidents ORDER BY created_at DESC LIMIT 300`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load incidents' })
  }
})

router.post('/incidents', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const { title, severity = 'medium', source = 'manual', details = '' } = req.body || {}
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'Title is required (min 3 chars)' })
    }
    const allowedSeverity = new Set(['low', 'medium', 'high', 'critical'])
    const sev = allowedSeverity.has(String(severity)) ? String(severity) : 'medium'

    const result = await pool.query(
      `INSERT INTO admin_incidents (title, severity, status, source, details, updated_at)
       VALUES ($1, $2, 'open', $3, $4, NOW())
       RETURNING *`,
      [String(title).trim(), sev, String(source || 'manual').trim(), String(details || '').trim()]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'incident_created',
        entityType: 'incident',
        entityId: String(result.rows[0].id),
        payload: {
          severity: sev,
          source: String(source || 'manual').trim()
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create incident' })
  }
})

router.post('/incidents/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const { status } = req.body || {}
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid incident id' })

    const allowed = new Set(['open', 'acknowledged', 'resolved'])
    if (!allowed.has(String(status))) return res.status(400).json({ error: 'Invalid status' })

    const isAck = status === 'acknowledged'
    const isResolved = status === 'resolved'
    const r = await pool.query(
      `UPDATE admin_incidents
          SET status = $1,
              updated_at = NOW(),
              acknowledged_at = CASE WHEN $2 THEN COALESCE(acknowledged_at, NOW()) ELSE acknowledged_at END,
              resolved_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
              acknowledged_by = CASE WHEN $2 THEN 'admin' ELSE acknowledged_by END
        WHERE id = $4
        RETURNING *`,
      [status, isAck, isResolved, id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Incident not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'incident_status_changed',
        entityType: 'incident',
        entityId: String(id),
        payload: { status: String(status) }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update incident status' })
  }
})

router.get('/rules', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const r = await pool.query(
      `SELECT id, name, scope, condition_json, action_json, enabled, priority,
              trigger_count, last_triggered_at, created_at, updated_at
       FROM admin_rules ORDER BY enabled DESC, priority ASC, created_at DESC LIMIT 500`
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rules' })
  }
})

router.post('/rules', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      name,
      scope = 'global',
      condition_json = {},
      action_json = {},
      enabled = true,
      priority = 100
    } = req.body || {}

    if (!name || String(name).trim().length < 3) {
      return res.status(400).json({ error: 'Rule name is required (min 3 chars)' })
    }

    const r = await pool.query(
      `INSERT INTO admin_rules (name, scope, condition_json, action_json, enabled, priority, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, NOW())
       RETURNING *`,
      [
        String(name).trim(),
        String(scope || 'global').trim(),
        JSON.stringify(condition_json || {}),
        JSON.stringify(action_json || {}),
        !!enabled,
        Number.isFinite(parseInt(priority, 10)) ? parseInt(priority, 10) : 100
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_created',
        entityType: 'rule',
        entityId: String(r.rows[0].id),
        payload: {
          name: String(name).trim(),
          scope: String(scope || 'global').trim()
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.status(201).json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create rule' })
  }
})

router.post('/rules/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid rule id' })
    const r = await pool.query(
      `UPDATE admin_rules
          SET enabled = NOT enabled,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Rule not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_toggled',
        entityType: 'rule',
        entityId: String(id),
        payload: { enabled: !!r.rows[0].enabled }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle rule' })
  }
})

router.delete('/rules/:id', authenticateAdmin, adminDeleteLimiter, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid rule id' })
    const r = await pool.query(`DELETE FROM admin_rules WHERE id = $1 RETURNING id`, [id])
    if (r.rows.length === 0) return res.status(404).json({ error: 'Rule not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_deleted',
        entityType: 'rule',
        entityId: String(id),
        payload: {}
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json({ message: 'Rule deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete rule' })
  }
})

router.post('/rules/reorder', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const orderedIdsRaw = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids : []
    const orderedIds = [...new Set(
      orderedIdsRaw
        .map(v => parseInt(v, 10))
        .filter(v => Number.isFinite(v))
    )]

    if (orderedIds.length === 0) {
      return res.status(400).json({ error: 'ordered_ids must be a non-empty array of rule ids' })
    }

    await client.query('BEGIN')
    await client.query(
      `UPDATE admin_rules r
          SET priority = src.ord * 10,
              updated_at = NOW()
         FROM (
           SELECT id::bigint AS id, ord::int AS ord
           FROM unnest($1::bigint[]) WITH ORDINALITY AS t(id, ord)
         ) src
        WHERE r.id = src.id`,
      [orderedIds]
    )
    const result = await client.query(
      `SELECT id, name, scope, condition_json, action_json, enabled, priority,
              trigger_count, last_triggered_at, created_at, updated_at
       FROM admin_rules ORDER BY enabled DESC, priority ASC, created_at DESC LIMIT 500`
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'rules_reordered',
        entityType: 'rule',
        entityId: 'bulk',
        payload: { ordered_ids: orderedIds.slice(0, 200) }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')
    res.json(result.rows)
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reorder rules' })
  } finally {
    client.release()
  }
})

module.exports = router
