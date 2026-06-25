'use strict'
/**
 * Admin Misc Analytics Sub-Router
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



// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/suspicious-accounts', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
    // FIX (BUG-H3): Wired to real DB query — returns genuinely flagged/banned accounts
    const result = await pool.query(`
      SELECT
        a.id, a.user_id, a.account_type, a.account_size, a.status,
        a.review_flagged, a.review_flag_reason, a.created_at,
        u.email, u.full_name, u.is_banned
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE (a.review_flagged = true OR u.is_banned = true)
        AND ($1::bigint IS NULL OR COALESCE(a.tenant_id, u.tenant_id, $1) = $1)
      ORDER BY a.created_at DESC
      LIMIT 500
    `, [tenantId]);
    res.json({
      total_flags: result.rows.filter(r => r.review_flagged).length,
      flagged: result.rows
    });
  } catch (err) {
    logger.error('Suspicious accounts error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load suspicious accounts' });
  }
});

router.get('/audit-log', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table
    await ensureFeatureTables()
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000)
    const offset = parseInt(req.query.offset || '0', 10)
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json,
              prev_hash, entry_hash, created_at
       FROM admin_immutable_audit
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    logger.error('Audit log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

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

router.get('/platform-analytics', authenticateAdmin, requireTenantAdminOrSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
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
      WHERE ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)
    `, [tenantId]);
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

router.get('/bbook', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
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
        AND ($1::bigint IS NULL OR COALESCE(a.tenant_id, $1) = $1)
      ORDER BY t.close_time DESC NULLS LAST, t.id DESC
      LIMIT 120
    `, [tenantId])

    res.json(result.rows)
  } catch (err) {
    logger.error('Bbook positions error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/bbook-report', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
    const q1 = await pool.query(`
      SELECT COALESCE(SUM(p.amount_payable), 0) as paid
      FROM payouts p
      JOIN users u ON u.id = p.user_id
      WHERE p.status = 'paid'
        AND ($1::bigint IS NULL OR COALESCE(u.tenant_id, $1) = $1)
    `, [tenantId]);
    const q2 = await pool.query(`
      SELECT
        COUNT(*) FILTER(WHERE status='failed') as fails,
        COUNT(*) FILTER(WHERE status='active' AND account_type='funded') as active
      FROM accounts
      WHERE ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)
    `, [tenantId]);
    // FIX (BUG-L8): Replaced hardcoded 0 values with real PnL sums from trades table
    const q3 = await pool.query(`
      SELECT
        COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl > 0 AND t.status = 'closed'), 0) AS gross_profit,
        ABS(COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl < 0 AND t.status = 'closed'), 0)) AS gross_loss
      FROM trades t
      JOIN accounts a ON a.id = t.account_id
      WHERE ($1::bigint IS NULL OR COALESCE(a.tenant_id, $1) = $1)
    `, [tenantId]);

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
