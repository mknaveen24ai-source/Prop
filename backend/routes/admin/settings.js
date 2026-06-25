'use strict'
/**
 * Admin Settings Sub-Router
 * Extracted from routes/admin.js for progressive modularization.
 * All shared helpers imported from the monolith via _internals bridge.
 */
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const logger = require('../../utils/logger')
const { DEFAULT_TENANT_SLUG } = require('../../utils/tenants')
const {
  authenticateAdmin,
  requireAdminCapability,
  requireSuperAdmin,
  requireTenantAdminOrSuperAdmin
} = require('../middleware')
const adminMonolith = require('../admin')
const {
  getScopedTenantId, getAdminActorLabel, buildAdminActorPayload, getAdminOwnerId,
  normalizeEntityId, normalizeAdminTag, normalizeEntityType, normalizeAdminEmail,
  parsePositiveInteger, parseBooleanFilter, parseCsvListParam, parseListPaging,
  buildPagination, paginateRows, facetCounts, toIsoOrNull, wantsAdminListContract,
  computeUserLifecycleStage, computeAccountLifecycleStage, computePayoutComplianceStatus,
  buildSavedViewCapabilities, normalizeAccountSnapshot, normalizeUserSnapshot,
  normalizePayoutSnapshot, buildAllowedAccountActions, buildAllowedUserActions,
  buildAllowedPayoutActions, emitCopierEventSafe, emitCopierEventsAfterCommit,
  buildCopierTradePayload, queueAdminCopierEvent, forceCloseOpenTradesForAccount,
  cancelPendingTradesForAccount, forceCloseTradeById, calcTradePnl,
  upsertAdminEntityMeta, computePhaseEndDateForAccountType, appendImmutableAudit,
  buildKycDocumentPresencePredicate, getExposureData, ensureFeatureTables,
  buildUserListResult, buildAccountListResult
} = adminMonolith._internals
const { emitAdminEvent } = require('../../utils/realtime')
const { DEFAULT_TENANT_SETTINGS, ensureTenantSettingsInfrastructure, getTenantSettingsMap, upsertTenantSettings } = require('../../utils/tenantSettings')


// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/settings', authenticateAdmin, requireTenantAdminOrSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
    if (tenantId) {
      const settings = await getTenantSettingsMap(tenantId)
      return res.json(settings)
    }

    const result = await pool.query('SELECT key, value FROM platform_settings')
    const settings = { ...DEFAULT_TENANT_SETTINGS }
    result.rows.forEach(r => { settings[r.key] = r.value })
    res.json(settings)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.get('/settings/account-availability', authenticateAdmin, requireTenantAdminOrSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req) || req.tenant?.id || 1
    const settings = await getTenantSettingsMap(tenantId)
    const sizes = await buildAccountAvailability(pool, tenantId, settings)

    res.json({
      tenant_id: tenantId,
      period_start: settings.max_accounts_period_start || null,
      period_end: settings.max_accounts_period_end || null,
      sizes
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account availability' })
  }
});

router.post('/settings', authenticateAdmin, requireTenantAdminOrSuperAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const tenantId = getScopedTenantId(req)
    await client.query('BEGIN');
    const keys = Object.keys(req.body);
    if (tenantId) {
      await upsertTenantSettings(client, tenantId, req.body)
    } else {
      for (const key of keys) {
        await client.query(
          `INSERT INTO platform_settings (key, value, updated_at) 
           VALUES ($1, $2, NOW()) 
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, String(req.body[key])]
        );
      }
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'settings_updated',
        entityType: tenantId ? 'tenant_settings' : 'platform_settings',
        entityId: tenantId ? String(tenantId) : 'global',
        payload: { keys, tenant_id: tenantId || null }
      })
    } catch (_) {}
    await client.query('COMMIT');
    res.json({ message: 'Settings saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to save settings' });
  } finally {
    client.release();
  }
});

router.use(quarantineLegacyGlobalAdminSurface)

router.get('/price-feed-health', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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

router.get('/risk-dashboard', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
    const { exposureData, total_open_trades, total_floating_pnl } = await getExposureData(pool, tenantId);

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

router.get('/price-staleness', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  res.json({ any_stale: false, stale_instruments: [] });
});

// ---------------------------------------------------------------------------
// FEATURE MODULES (MVP): Incident Center, Rule Builder, Auto Enforcement,
// Payout Fraud Scoring, Device/IP Link Graph
// ---------------------------------------------------------------------------

router.get('/incidents', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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

router.post('/incidents', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
    } catch (_) {}
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create incident' })
  }
})

router.post('/incidents/:id/status', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
    } catch (_) {}
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update incident status' })
  }
})


module.exports = router
