'use strict'
/**
 * Admin Command Center Sub-Router
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
const Decimal = require('decimal.js')
const { emitAdminEvent } = require('../../utils/realtime')
const { invalidateAllUserTokens } = require('../../utils/tokenCache')


// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/risk-scores', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H2): Replaced RANDOM() with real calculations:
    //   - win_rate_pct: actual wins / closed trades
    //   - avg_hold_seconds: real avg from open_time/close_time
    //   - total_trades: real count, flagged_payouts: real count
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.full_name,
        u.email,
        a.id AS account_id,
        a.account_type,
        a.status AS account_status,
        a.review_flagged,
        COUNT(t.id) FILTER (WHERE t.status = 'closed')                             AS total_trades,
        COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)          AS winning_trades,
        CASE
          WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') = 0 THEN 0
          ELSE ROUND(
            COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
            / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
          )
        END AS win_rate_pct,
        COALESCE(ROUND(
          AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
          FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
        , 0), 0) AS avg_hold_seconds,
        COUNT(p.id) FILTER (WHERE p.is_flagged = true)                              AS flagged_payouts,
        COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)             AS total_pnl,
        -- Computed risk_score 0-100: higher score = more suspicious trader
        LEAST(100, (
          20
          + CASE
              WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
               AND ROUND(
                    COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
                    / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
                  ) > 70
              THEN 40 ELSE 0
            END
          + CASE
              WHEN COALESCE(ROUND(
                  AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
                  FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
              , 0), 9999) < 300
               AND COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
              THEN 20 ELSE 0
            END
          + CASE WHEN COUNT(p.id) FILTER (WHERE p.is_flagged = true) > 0 THEN 20 ELSE 0 END
          + CASE WHEN a.review_flagged THEN 20 ELSE 0 END
        )) AS risk_score
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      LEFT JOIN trades t ON t.account_id = a.id
      LEFT JOIN payouts p ON p.user_id = u.id
      WHERE a.status IN ('active', 'funded')
      GROUP BY u.id, u.full_name, u.email, a.id, a.account_type, a.status, a.review_flagged
      ORDER BY risk_score DESC, total_trades DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error('Risk scores error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

router.get('/account-health', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.id::text AS account_id,
        COALESCE(a.account_uid::text, a.id::text) AS account_uid,
        a.account_type,
        a.status AS account_status,
        COALESCE(a.account_size, 0)::numeric AS account_size,
        COALESCE(a.current_balance, 0)::numeric AS current_balance,
        COALESCE(a.peak_balance, 0)::numeric AS peak_balance,
        COALESCE(a.review_flagged, false) AS review_flagged,
        a.created_at,
        u.id::text AS user_id,
        u.full_name,
        u.email,
        COALESCE(u.kyc_status, 'pending') AS kyc_status,
        COALESCE(u.is_banned, false) AS is_banned,
        COALESCE(ts.closed_trades, 0)::int AS closed_trades,
        COALESCE(ts.winning_trades, 0)::int AS winning_trades,
        COALESCE(ts.win_rate_pct, 0)::numeric AS win_rate_pct,
        COALESCE(ts.avg_hold_seconds, 0)::numeric AS avg_hold_seconds,
        COALESCE(ts.total_pnl, 0)::numeric AS total_pnl,
        COALESCE(ps.flagged_payouts, 0)::int AS flagged_payouts,
        COALESCE(ds.open_disputes, 0)::int AS open_disputes
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN (
        SELECT
          t.account_id,
          COUNT(*) FILTER (WHERE t.status = 'closed')::int AS closed_trades,
          COUNT(*) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::int AS winning_trades,
          CASE
            WHEN COUNT(*) FILTER (WHERE t.status = 'closed') = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric)
              / NULLIF(COUNT(*) FILTER (WHERE t.status = 'closed'), 0) * 100, 2
            )
          END AS win_rate_pct,
          COALESCE(ROUND(
            AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
            FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL), 0
          ), 0) AS avg_hold_seconds,
          COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0) AS total_pnl
        FROM trades t
        GROUP BY t.account_id
      ) ts ON ts.account_id = a.id
      LEFT JOIN (
        SELECT p.account_id, COUNT(*) FILTER (WHERE p.is_flagged = true)::int AS flagged_payouts
        FROM payouts p
        GROUP BY p.account_id
      ) ps ON ps.account_id = a.id
      LEFT JOIN (
        SELECT d.account_id::text AS account_id, COUNT(*) FILTER (WHERE d.status IN ('open', 'under_review'))::int AS open_disputes
        FROM disputes d
        GROUP BY d.account_id::text
      ) ds ON ds.account_id = a.id::text
      WHERE a.status IN ('active', 'funded', 'locked')
      ORDER BY a.created_at DESC
      LIMIT 500
    `)

    const rows = result.rows.map(r => {
      const accountSize = parseFloat(r.account_size || 0)
      const currentBalance = parseFloat(r.current_balance || 0)
      const totalPnl = parseFloat(r.total_pnl || 0)
      const closedTrades = parseInt(r.closed_trades || 0, 10)
      const winRate = parseFloat(r.win_rate_pct || 0)
      const avgHoldSec = parseFloat(r.avg_hold_seconds || 0)
      const flaggedPayouts = parseInt(r.flagged_payouts || 0, 10)
      const openDisputes = parseInt(r.open_disputes || 0, 10)
      const accountAgeDays = r.created_at
        ? Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000))
        : 0

      let penalties = 0
      const reasons = []
      if (r.is_banned) { penalties += 70; reasons.push('User is banned') }
      if (r.account_status === 'locked') { penalties += 40; reasons.push('Account is locked') }
      if (r.review_flagged) { penalties += 25; reasons.push('Account flagged for manual review') }
      if (String(r.kyc_status) !== 'approved') { penalties += 15; reasons.push('KYC not approved') }
      if (flaggedPayouts > 0) { penalties += Math.min(30, flaggedPayouts * 10); reasons.push(`Flagged payouts: ${flaggedPayouts}`) }
      if (openDisputes > 0) { penalties += Math.min(25, openDisputes * 8); reasons.push(`Open disputes: ${openDisputes}`) }
      if (closedTrades >= 20 && winRate >= 75 && avgHoldSec > 0 && avgHoldSec < 180) {
        penalties += 15
        reasons.push('Unusually high win rate with very short holds')
      }
      if (accountSize > 0 && totalPnl <= -(accountSize * 0.12)) {
        penalties += 12
        reasons.push('Deep realized loss vs account size')
      }
      if (accountAgeDays <= 7 && closedTrades >= 40) {
        penalties += 10
        reasons.push('High activity on very new account')
      }

      const healthScore = Math.max(0, Math.min(100, 100 - penalties))
      const healthBand = healthScore >= 75 ? 'healthy' : healthScore >= 45 ? 'watch' : 'critical'
      return {
        ...r,
        account_size: accountSize,
        current_balance: currentBalance,
        total_pnl: parseFloat(totalPnl.toFixed(2)),
        closed_trades: closedTrades,
        win_rate_pct: parseFloat(winRate.toFixed(2)),
        avg_hold_seconds: parseFloat(avgHoldSec.toFixed(0)),
        flagged_payouts: flaggedPayouts,
        open_disputes: openDisputes,
        account_age_days: accountAgeDays,
        health_score: healthScore,
        health_band: healthBand,
        reasons
      }
    })

    const summary = {
      total: rows.length,
      healthy: rows.filter(r => r.health_band === 'healthy').length,
      watch: rows.filter(r => r.health_band === 'watch').length,
      critical: rows.filter(r => r.health_band === 'critical').length,
      avg_health_score: rows.length > 0
        ? parseFloat((rows.reduce((sum, r) => sum + r.health_score, 0) / rows.length).toFixed(2))
        : 0
    }

    rows.sort((a, b) => a.health_score - b.health_score)
    res.json({ generated_at: new Date(), summary, rows })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account health scores' })
  }
})

router.get('/command-center/accounts', authenticateAdmin, requireAdminCapability('command_center:read'), async (req, res) => {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req) || parsePositiveInteger(req.query.tenant, {
      fallback: null,
      min: 1,
      max: 2147483647
    })
    const conditions = []
    const values = []

    if (tenantId) {
      values.push(tenantId)
      conditions.push(`COALESCE(a.tenant_id, u.tenant_id, $${values.length}) = $${values.length}`)
    }
    if (req.query.status) {
      values.push(String(req.query.status).trim().toLowerCase())
      conditions.push(`LOWER(a.status) = $${values.length}`)
    }
    if (req.query.account_type) {
      values.push(String(req.query.account_type).trim().toLowerCase())
      conditions.push(`LOWER(a.account_type) = $${values.length}`)
    }
    const reviewFlagged = parseBooleanFilter(req.query.review_flagged)
    if (reviewFlagged !== null) {
      values.push(reviewFlagged)
      conditions.push(`COALESCE(a.review_flagged, FALSE) = $${values.length}`)
    }
    if (req.query.created_from) {
      values.push(String(req.query.created_from))
      conditions.push(`a.created_at >= $${values.length}::timestamptz`)
    }
    if (req.query.created_to) {
      values.push(String(req.query.created_to))
      conditions.push(`a.created_at < ($${values.length}::timestamptz + INTERVAL '1 day')`)
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`)
      conditions.push(`(
        LOWER(COALESCE(u.email, '')) LIKE $${values.length}
        OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
        OR LOWER(COALESCE(a.account_uid, '')) LIKE $${values.length}
        OR CAST(a.id AS TEXT) LIKE $${values.length}
      )`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = parsePositiveInteger(req.query.limit, { fallback: 200, min: 1, max: 500 })
    values.push(limit)

    const result = await pool.query(
      `SELECT a.id, a.tenant_id, a.user_id, a.account_type, a.account_size, a.status,
              a.current_balance, a.starting_balance, a.peak_balance, a.profit_target,
              a.max_drawdown_pct, a.phase_start_date, a.phase_end_date, a.account_uid,
              COALESCE(a.review_flagged, FALSE) AS review_flagged,
              a.review_flag_reason, a.created_at,
              u.email, u.full_name, COALESCE(u.is_banned, FALSE) AS is_banned,
              COALESCE((
                SELECT COUNT(*) FROM trades t WHERE t.account_id = a.id AND t.status = 'open'
              ), 0)::int AS open_trade_count
       FROM accounts a
       JOIN users u ON u.id = a.user_id
       ${where}
       ORDER BY
         CASE
           WHEN a.status = 'locked' THEN 0
           WHEN a.status = 'failed' THEN 1
           WHEN a.status = 'expired' THEN 2
           WHEN COALESCE(a.review_flagged, FALSE) = TRUE THEN 3
           ELSE 4
         END,
         a.created_at DESC
       LIMIT $${values.length}`,
      values
    )

    const rows = result.rows.map((row) => ({
      ...row,
      allowed_actions: buildAllowedAccountActions(row)
    }))

    res.json({
      summary: {
        total: rows.length,
        failed: rows.filter((row) => row.status === 'failed').length,
        locked: rows.filter((row) => row.status === 'locked').length,
        review_flagged: rows.filter((row) => row.review_flagged).length
      },
      rows
    })
  } catch (error) {
    logger.error('Command center accounts error:', { error: error.message })
    res.status(500).json({ error: 'Failed to load account recovery queue' })
  }
})

router.get('/command-center/users', authenticateAdmin, requireAdminCapability('command_center:read'), async (req, res) => {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req) || parsePositiveInteger(req.query.tenant, {
      fallback: null,
      min: 1,
      max: 2147483647
    })
    const conditions = []
    const values = []

    if (tenantId) {
      values.push(tenantId)
      conditions.push(`COALESCE(u.tenant_id, $${values.length}) = $${values.length}`)
    }
    const bannedFilter = parseBooleanFilter(req.query.is_banned)
    if (bannedFilter !== null) {
      values.push(bannedFilter)
      conditions.push(`COALESCE(u.is_banned, FALSE) = $${values.length}`)
    }
    if (req.query.kyc_status) {
      values.push(String(req.query.kyc_status).trim().toLowerCase())
      conditions.push(`LOWER(COALESCE(u.kyc_status, 'pending')) = $${values.length}`)
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`)
      conditions.push(`(
        LOWER(COALESCE(u.email, '')) LIKE $${values.length}
        OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
        OR CAST(u.id AS TEXT) LIKE $${values.length}
      )`)
    }

    const hasActiveAccounts = parseBooleanFilter(req.query.has_active_accounts)
    if (hasActiveAccounts !== null) {
      conditions.push(hasActiveAccounts
        ? `EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'active')`
        : `NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = u.id AND a.status = 'active')`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = parsePositiveInteger(req.query.limit, { fallback: 200, min: 1, max: 500 })
    values.push(limit)

    const result = await pool.query(
      `SELECT u.id, u.tenant_id, u.email, u.full_name, u.country, u.phone,
              COALESCE(u.kyc_status, 'pending') AS kyc_status,
              COALESCE(u.is_banned, FALSE) AS is_banned,
              u.created_at, COALESCE(u.token_version, 1) AS token_version,
              COALESCE((
                SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id
              ), 0)::int AS account_count,
              COALESCE((
                SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id AND a.status = 'active'
              ), 0)::int AS active_account_count
       FROM users u
       ${where}
       ORDER BY
         CASE WHEN COALESCE(u.is_banned, FALSE) = TRUE THEN 0 ELSE 1 END,
         u.created_at DESC
       LIMIT $${values.length}`,
      values
    )

    const rows = result.rows.map((row) => ({
      ...row,
      allowed_actions: buildAllowedUserActions(row)
    }))

    res.json({
      summary: {
        total: rows.length,
        banned: rows.filter((row) => row.is_banned).length,
        pending_kyc: rows.filter((row) => row.kyc_status === 'pending').length,
        with_active_accounts: rows.filter((row) => row.active_account_count > 0).length
      },
      rows
    })
  } catch (error) {
    logger.error('Command center users error:', { error: error.message })
    res.status(500).json({ error: 'Failed to load trader control queue' })
  }
})

router.get('/command-center/money-risk', authenticateAdmin, requireAdminCapability('command_center:read'), async (req, res) => {
  try {
    await ensureFeatureTables()
    await ensureViolationTables()

    const tenantId = getScopedTenantId(req) || parsePositiveInteger(req.query.tenant, {
      fallback: null,
      min: 1,
      max: 2147483647
    })
    const conditions = []
    const values = []

    if (tenantId) {
      values.push(tenantId)
      conditions.push(`COALESCE(p.tenant_id, u.tenant_id, $${values.length}) = $${values.length}`)
    }
    if (req.query.payout_status) {
      values.push(String(req.query.payout_status).trim().toLowerCase())
      conditions.push(`LOWER(p.status) = $${values.length}`)
    }
    const flaggedFilter = parseBooleanFilter(req.query.is_flagged)
    if (flaggedFilter !== null) {
      values.push(flaggedFilter)
      conditions.push(`COALESCE(p.is_flagged, FALSE) = $${values.length}`)
    }
    const openDisputesFilter = parseBooleanFilter(req.query.open_disputes)
    if (openDisputesFilter !== null) {
      conditions.push(openDisputesFilter
        ? `COALESCE(ds.open_disputes_count, 0) > 0`
        : `COALESCE(ds.open_disputes_count, 0) = 0`)
    }
    const criticalViolationsFilter = parseBooleanFilter(req.query.critical_violations)
    if (criticalViolationsFilter !== null) {
      conditions.push(criticalViolationsFilter
        ? `COALESCE(vs.critical_violations_count, 0) > 0`
        : `COALESCE(vs.critical_violations_count, 0) = 0`)
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search).trim().toLowerCase()}%`)
      conditions.push(`(
        LOWER(COALESCE(u.email, '')) LIKE $${values.length}
        OR LOWER(COALESCE(u.full_name, '')) LIKE $${values.length}
        OR CAST(p.id AS TEXT) LIKE $${values.length}
        OR CAST(p.account_id AS TEXT) LIKE $${values.length}
      )`)
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = parsePositiveInteger(req.query.limit, { fallback: 200, min: 1, max: 500 })
    values.push(limit)

    const result = await pool.query(
      `SELECT p.id, p.tenant_id, p.user_id, p.account_id, p.amount_requested, p.amount_payable,
              p.status, COALESCE(p.is_flagged, FALSE) AS is_flagged, p.flag_reason, p.admin_notes,
              p.requested_at, u.email, u.full_name,
              COALESCE(ds.open_disputes_count, 0)::int AS open_disputes_count,
              ds.latest_dispute_id AS dispute_id,
              COALESCE(vs.critical_violations_count, 0)::int AS critical_violations_count,
              vs.latest_violation_id
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN (
         SELECT d.account_id::text AS account_id,
                COUNT(*) FILTER (WHERE d.status IN ('open', 'under_review'))::int AS open_disputes_count,
                MAX(d.id) FILTER (WHERE d.status IN ('open', 'under_review')) AS latest_dispute_id
         FROM disputes d
         GROUP BY d.account_id::text
       ) ds ON ds.account_id = p.account_id::text
       LEFT JOIN (
         SELECT v.account_id::text AS account_id,
                COUNT(*) FILTER (WHERE v.status = 'open' AND v.severity = 'critical')::int AS critical_violations_count,
                MAX(v.id) FILTER (WHERE v.status = 'open') AS latest_violation_id
         FROM admin_rule_violations v
         GROUP BY v.account_id::text
       ) vs ON vs.account_id = p.account_id::text
       ${where}
       ORDER BY
         CASE
           WHEN COALESCE(p.is_flagged, FALSE) = TRUE THEN 0
           WHEN COALESCE(vs.critical_violations_count, 0) > 0 THEN 1
           WHEN COALESCE(ds.open_disputes_count, 0) > 0 THEN 2
           ELSE 3
         END,
         p.requested_at DESC
       LIMIT $${values.length}`,
      values
    )

    const rows = result.rows.map((row) => {
      const allowedActions = buildAllowedPayoutActions(row)
      if (row.latest_violation_id && row.critical_violations_count > 0) {
        allowedActions.push('waive_violation')
      }
      return {
        ...row,
        allowed_actions: [...new Set(allowedActions)]
      }
    })

    res.json({
      summary: {
        total: rows.length,
        pending: rows.filter((row) => row.status === 'pending').length,
        flagged: rows.filter((row) => row.is_flagged).length,
        with_open_disputes: rows.filter((row) => row.open_disputes_count > 0).length,
        with_critical_violations: rows.filter((row) => row.critical_violations_count > 0).length
      },
      rows
    })
  } catch (error) {
    logger.error('Command center money-risk error:', { error: error.message })
    res.status(500).json({ error: 'Failed to load money and risk queue' })
  }
})

router.post('/command-center/bulk-action', authenticateAdmin, requireAdminCapability('command_center:bulk'), async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    await ensureViolationTables()

    const entity = String(req.body?.entity || '').trim().toLowerCase()
    const action = String(req.body?.action || '').trim().toLowerCase()
    const reason = requireReasonText(req.body?.reason)
    const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {}
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map((value) => String(value || '').trim()).filter(Boolean))]
      : []

    if (!['account', 'user', 'payout', 'violation'].includes(entity)) {
      return res.status(400).json({ error: 'entity must be account, user, payout, or violation' })
    }
    if (!action) {
      return res.status(400).json({ error: 'action is required' })
    }
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ error: 'ids must contain between 1 and 100 items' })
    }

    const tenantId = getScopedTenantId(req) || parsePositiveInteger(req.body?.tenant || options?.tenant, {
      fallback: null,
      min: 1,
      max: 2147483647
    })
    const results = []

    for (const rawId of ids) {
      let postCommitInvalidateUserId = null

      try {
        await client.query('BEGIN')

        if (entity === 'account') {
          const account = await fetchAccountForAdmin(client, rawId, tenantId, { forUpdate: true })
          if (!account) throw createHttpError('Account not found', 404)

          const beforeSnapshot = normalizeAccountSnapshot(account)
          const normalizedTenantId = account.tenant_id || tenantId || 1
          const tenantSettings = await getTenantSettings(normalizedTenantId, [
            'phase1_day_limit',
            'phase2_day_limit',
            'phase1_profit_target_pct',
            'phase2_profit_target_pct',
            'phase1_max_drawdown_pct',
            'phase2_max_drawdown_pct',
            'funded_max_drawdown_pct'
          ])
          let closeResult = { closedCount: 0, totalPnl: 0 }
          let cancelledCount = 0
          let linkedAccountId = null
          let message = ''
          const copierEvents = []

          if (action === 'restore_active') {
            if (!['failed', 'locked'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only failed or locked accounts can be restored to active', 400)
            }
            await client.query(
              `UPDATE accounts
                  SET status = 'active',
                      review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id]
            )
            message = 'Account restored to active'
          } else if (action === 'restore_with_reset') {
            if (!['phase1', 'phase2'].includes(String(account.account_type || '').toLowerCase())) {
              throw createHttpError('Only phase1 and phase2 accounts can be reset and restored', 400)
            }
            if (!['failed', 'locked', 'expired'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only failed, locked, or expired accounts can be reset and restored', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_bulk_restore_with_reset' })
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Bulk Restore With Reset', { copierEvents, source: 'admin_bulk_restore_with_reset' })
            await client.query(
              `UPDATE accounts
                  SET status = 'active',
                      current_balance = starting_balance,
                      peak_balance = starting_balance,
                      phase_start_date = NOW(),
                      phase_end_date = $2,
                      review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, computePhaseEndDateForAccountType(account.account_type, tenantSettings)]
            )
            message = 'Account restored with reset'
          } else if (action === 'replace_account') {
            if (['active', 'passed'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only non-active accounts can be replaced', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_bulk_replace_account' })
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Bulk Replace Account', { copierEvents, source: 'admin_bulk_replace_account' })
            const replacement = await createAdminIssuedAccount(client, {
              tenantId: normalizedTenantId,
              userId: account.user_id,
              accountType: account.account_type,
              accountSize: account.account_size,
              settings: tenantSettings,
              overrides: {
                profit_target: account.profit_target,
                max_drawdown_pct: account.max_drawdown_pct
              }
            })
            linkedAccountId = replacement.id
            message = `Replacement account created (#${replacement.id})`
          } else if (action === 'lock_account') {
            await client.query(
              `UPDATE accounts
                  SET status = 'locked',
                      review_flagged = TRUE,
                      review_flag_reason = $2,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, reason]
            )
            message = 'Account locked'
          } else if (action === 'clear_review_flag') {
            await client.query(
              `UPDATE accounts
                  SET review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id]
            )
            message = 'Review flag cleared'
          } else if (action === 'extend_days') {
            const extensionDays = parsePositiveInteger(options?.days, { fallback: null, min: 1, max: 365 })
            if (!extensionDays) throw createHttpError('options.days must be provided for extend_days', 400)
            await client.query(
              `UPDATE accounts
                  SET phase_end_date = (
                    CASE
                      WHEN phase_end_date IS NULL OR phase_end_date < NOW() THEN NOW()
                      ELSE phase_end_date
                    END
                  ) + ($2 * INTERVAL '1 day'),
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id, extensionDays]
            )
            message = `Extended account by ${extensionDays} days`
          } else if (action === 'force_close_open_trades') {
            closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_bulk_force_close_open_trades' })
            message = `Force-closed ${closeResult.closedCount} open trades`
          } else {
            throw createHttpError(`Unsupported bulk account action: ${action}`, 400)
          }

          const afterAccount = await fetchAccountForAdmin(client, rawId, tenantId)
          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'account',
            entityId: String(rawId),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              tenant_scope: tenantId,
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeAccountSnapshot(afterAccount),
              closed_trades: closeResult.closedCount,
              cancelled_pending: cancelledCount,
              total_pnl: closeResult.totalPnl,
              linked_account_id: linkedAccountId
            }
          })

          await client.query('COMMIT')
          await emitCopierEventsAfterCommit(copierEvents)
          emitAdminEvent('admin_enforcement_event', {
            account_id: account.id,
            user_id: account.user_id,
            action,
            status: 'applied',
            message,
            tenant_id: normalizedTenantId
          }, normalizedTenantId)
          await emitSuperAdminPowerEvent(req, normalizedTenantId, {
            entity,
            entity_id: account.id,
            action,
            linked_account_id: linkedAccountId
          })

          results.push({
            id: rawId,
            success: true,
            message,
            new_account_id: linkedAccountId || null
          })
        } else if (entity === 'user') {
          const user = await fetchUserForAdmin(client, rawId, tenantId, { forUpdate: true })
          if (!user) throw createHttpError('User not found', 404)

          const beforeSnapshot = normalizeUserSnapshot(user)
          let message = ''
          let createdAccount = null
          let updatedUser = user

          if (action === 'ban') {
            const result = await client.query(
              `UPDATE users SET is_banned = TRUE WHERE id = $1
               RETURNING id, tenant_id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'Trader banned'
          } else if (action === 'unban') {
            const result = await client.query(
              `UPDATE users SET is_banned = FALSE WHERE id = $1
               RETURNING id, tenant_id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'Trader unbanned'
          } else if (action === 'revoke_sessions') {
            const result = await client.query(
              `UPDATE users
                  SET token_version = COALESCE(token_version, 1) + 1
                WHERE id = $1
                RETURNING id, tenant_id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            postCommitInvalidateUserId = user.id
            message = 'Trader sessions revoked'
          } else if (action === 'approve_kyc') {
            const result = await client.query(
              `UPDATE users
                  SET kyc_status = 'approved',
                      kyc_rejection_reason = NULL
                WHERE id = $1
                RETURNING id, tenant_id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'KYC approved'
          } else if (action === 'reject_kyc') {
            const result = await client.query(
              `UPDATE users
                  SET kyc_status = 'rejected',
                      kyc_rejection_reason = $2
                WHERE id = $1
                RETURNING id, tenant_id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id, reason]
            )
            updatedUser = result.rows[0]
            message = 'KYC rejected'
          } else if (action === 'manual_account') {
            const accountType = String(options?.account_type || 'phase1').trim().toLowerCase()
            const accountSize = parseInt(options?.account_size, 10)
            if (!['phase1', 'phase2', 'funded'].includes(accountType)) {
              throw createHttpError('options.account_type must be phase1, phase2, or funded', 400)
            }
            if (!Number.isFinite(accountSize) || !ADMIN_VALID_ACCOUNT_SIZES.includes(accountSize)) {
              throw createHttpError(`options.account_size must be one of: ${ADMIN_VALID_ACCOUNT_SIZES.join(', ')}`, 400)
            }
            const settings = await getTenantSettings(user.tenant_id || tenantId || 1, [
              'phase1_day_limit',
              'phase2_day_limit',
              'phase1_profit_target_pct',
              'phase2_profit_target_pct',
              'phase1_max_drawdown_pct',
              'phase2_max_drawdown_pct',
              'funded_max_drawdown_pct'
            ])
            createdAccount = await createAdminIssuedAccount(client, {
              tenantId: user.tenant_id || tenantId || 1,
              userId: user.id,
              accountType,
              accountSize,
              settings
            })
            message = `Manual ${accountType} account issued`
          } else {
            throw createHttpError(`Unsupported bulk user action: ${action}`, 400)
          }

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'user',
            entityId: String(user.id),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              tenant_scope: tenantId,
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeUserSnapshot(updatedUser),
              linked_account_id: createdAccount?.id || null
            }
          })

          await client.query('COMMIT')

          if (postCommitInvalidateUserId) {
            await invalidateAllUserTokens(postCommitInvalidateUserId)
          }
          await emitSuperAdminPowerEvent(req, updatedUser.tenant_id || tenantId, {
            entity,
            entity_id: user.id,
            action,
            linked_account_id: createdAccount?.id || null
          })

          results.push({
            id: rawId,
            success: true,
            message,
            new_account_id: createdAccount?.id || null
          })
        } else if (entity === 'payout') {
          const payout = await fetchPayoutForAdmin(client, rawId, tenantId, { forUpdate: true })
          if (!payout) throw createHttpError('Payout not found', 404)

          const beforeSnapshot = normalizePayoutSnapshot(payout)
          let updatedPayout = payout
          let message = ''

          if (action === 'flag_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET is_flagged = TRUE,
                      flag_reason = $2,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, tenant_id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, reason]
            )
            updatedPayout = result.rows[0]
            message = 'Payout flagged'
          } else if (action === 'unflag_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET is_flagged = FALSE,
                      flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, tenant_id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id]
            )
            updatedPayout = result.rows[0]
            message = 'Payout unflagged'
          } else if (action === 'approve_payout') {
            if (String(payout.status || '').toLowerCase() !== 'pending') {
              throw createHttpError('Only pending payouts can be approved', 400)
            }
            const accountBalance = await client.query(
              `SELECT current_balance, starting_balance FROM accounts WHERE id = $1 FOR UPDATE`,
              [payout.account_id]
            )
            if (accountBalance.rows.length === 0) throw createHttpError('Account not found for payout', 404)
            const availableProfit = new Decimal(accountBalance.rows[0].current_balance).minus(accountBalance.rows[0].starting_balance)
            if (availableProfit.lt(payout.amount_requested)) {
              throw createHttpError('Insufficient realized profit for payout', 400)
            }
            await client.query(
              `UPDATE accounts SET current_balance = current_balance - $1 WHERE id = $2`,
              [payout.amount_requested, payout.account_id]
            )
            const result = await client.query(
              `UPDATE payouts
                  SET status = 'paid',
                      paid_at = NOW(),
                      transaction_id = COALESCE($2, transaction_id),
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, tenant_id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, options?.transaction_id ? String(options.transaction_id) : null]
            )
            updatedPayout = result.rows[0]
            message = 'Payout approved'
          } else if (action === 'reject_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET status = 'rejected',
                      admin_notes = $2,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, tenant_id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, reason]
            )
            updatedPayout = result.rows[0]
            message = 'Payout rejected'
          } else {
            throw createHttpError(`Unsupported bulk payout action: ${action}`, 400)
          }

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'payout',
            entityId: String(payout.id),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              tenant_scope: tenantId,
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizePayoutSnapshot(updatedPayout)
            }
          })

          await client.query('COMMIT')
          await emitSuperAdminPowerEvent(req, updatedPayout.tenant_id || tenantId, {
            entity,
            entity_id: payout.id,
            action
          })

          results.push({
            id: rawId,
            success: true,
            message
          })
        } else if (entity === 'violation') {
          const violationId = parseInt(rawId, 10)
          if (!Number.isFinite(violationId) || violationId <= 0) {
            throw createHttpError('Invalid violation id', 400)
          }

          const violationResult = await client.query(
            `SELECT *
               FROM admin_rule_violations
              WHERE id = $1
                AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
              FOR UPDATE`,
            [violationId, tenantId]
          )
          if (violationResult.rows.length === 0) throw createHttpError('Violation not found', 404)

          const violation = violationResult.rows[0]
          const beforeSnapshot = normalizeViolationSnapshot(violation)
          const resolutionType = action === 'waive_violation'
            ? 'waived'
            : action === 'false_positive'
              ? 'false_positive'
              : action === 'resolve_violation'
                ? 'resolved'
                : null

          if (!resolutionType) {
            throw createHttpError(`Unsupported bulk violation action: ${action}`, 400)
          }

          const updateResult = await client.query(
            `UPDATE admin_rule_violations
                SET status = 'resolved',
                    resolved_at = NOW(),
                    resolution_note = $2,
                    resolution_type = $3,
                    payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
                      'resolution_type', $3,
                      'resolved_by_role', $4,
                      'resolved_tenant_scope', $5
                    )
              WHERE id = $1
              RETURNING *`,
            [violationId, reason, resolutionType, req.admin?.role || 'admin', tenantId]
          )
          const updatedViolation = updateResult.rows[0]

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'violation',
            entityId: String(violationId),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              tenant_scope: tenantId,
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeViolationSnapshot(updatedViolation)
            }
          })

          await client.query('COMMIT')
          emitAdminEvent('admin_violation_updated', updatedViolation, updatedViolation.tenant_id || tenantId)

          results.push({
            id: rawId,
            success: true,
            message: `Violation marked ${resolutionType.replace(/_/g, ' ')}`
          })
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        results.push({
          id: rawId,
          success: false,
          error: error.statusCode ? error.message : 'Bulk action failed'
        })
      }
    }

    res.json({
      entity,
      action,
      total: ids.length,
      succeeded: results.filter((row) => row.success).length,
      failed: results.filter((row) => !row.success).length,
      results
    })
  } catch (error) {
    logger.error('Command center bulk action error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to run bulk action' })
  } finally {
    client.release()
  }
})


module.exports = router
