'use strict'
/**
 * Admin Advanced Risk & Fraud Sub-Router
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
const { sanitizeString } = require('../../utils/validation')
const { getKycContentType, readKycFileBuffer } = require('../../utils/secureKycStorage')
const path = require('path')
const fs = require('fs')
const { fetchProgressionSettings, approvePromotionReview, createPendingPromotionReview } = require('../../services/progressionService')


// ── Routes ─────────────────────────────────────────────────────────────────────
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
      } catch (_) {}

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

router.get('/news-protection', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
      block_new_orders: toBool(s.news_protection_block_new_orders, true),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load news protection settings' })
  }
})

router.post('/news-protection', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
    } catch (_) {}
    await client.query('COMMIT')
    res.json({ message: 'News protection settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save news protection settings' })
  } finally {
    client.release()
  }
})

router.get('/rollover-guard', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
      block_new_orders: toBool(s.rollover_guard_block_new_orders, true),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rollover guard settings' })
  }
})

router.post('/rollover-guard', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
    } catch (_) {}
    await client.query('COMMIT')
    res.json({ message: 'Rollover guard settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save rollover guard settings' })
  } finally {
    client.release()
  }
})

router.get('/slippage-monitor', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
        updated_at: r.updated_at || null,
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
      sample_count: sampleCount,
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load slippage monitor' })
  }
})

router.get('/feed-anomalies', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
        wide_spread: wide,
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

router.get('/challenge-funnel', authenticateAdmin, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE account_type = 'phase1') AS phase1_total,
         COUNT(*) FILTER (WHERE account_type = 'phase1' AND status = 'passed') AS phase1_passed,
         COUNT(*) FILTER (WHERE account_type = 'phase2') AS phase2_total,
         COUNT(*) FILTER (WHERE account_type = 'phase2' AND status = 'passed') AS phase2_passed,
         COUNT(*) FILTER (WHERE account_type = 'funded') AS funded_total,
         COUNT(*) FILTER (WHERE account_type = 'funded' AND status = 'active') AS funded_active,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_total,
         COUNT(*) FILTER (WHERE status = 'expired') AS expired_total
       FROM accounts`
    )

    const r = totals.rows[0] || {}
    const phase1Total = parseInt(r.phase1_total || 0, 10)
    const phase1Passed = parseInt(r.phase1_passed || 0, 10)
    const phase2Total = parseInt(r.phase2_total || 0, 10)
    const phase2Passed = parseInt(r.phase2_passed || 0, 10)
    const fundedTotal = parseInt(r.funded_total || 0, 10)
    const fundedActive = parseInt(r.funded_active || 0, 10)
    const failedTotal = parseInt(r.failed_total || 0, 10)
    const expiredTotal = parseInt(r.expired_total || 0, 10)

    const phase1PassRate = phase1Total > 0 ? parseFloat(((phase1Passed / phase1Total) * 100).toFixed(2)) : 0
    const phase2PassRate = phase2Total > 0 ? parseFloat(((phase2Passed / phase2Total) * 100).toFixed(2)) : 0
    const fundedActivationRate = fundedTotal > 0 ? parseFloat(((fundedActive / fundedTotal) * 100).toFixed(2)) : 0

    res.json({
      generated_at: new Date(),
      funnel: {
        phase1_total: phase1Total,
        phase1_passed: phase1Passed,
        phase1_pass_rate: phase1PassRate,
        phase2_total: phase2Total,
        phase2_passed: phase2Passed,
        phase2_pass_rate: phase2PassRate,
        funded_total: fundedTotal,
        funded_active: fundedActive,
        funded_activation_rate: fundedActivationRate,
      },
      outcomes: {
        failed_total: failedTotal,
        expired_total: expiredTotal,
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load challenge funnel' })
  }
})

router.get('/cohort-analytics', authenticateAdmin, async (req, res) => {
  try {
    const monthsBackRaw = parseInt(req.query.months || '12', 10)
    const monthsBack = Number.isFinite(monthsBackRaw) ? Math.max(3, Math.min(24, monthsBackRaw)) : 12
    const cohorts = await pool.query(
      `WITH user_base AS (
         SELECT
           u.id,
           DATE_TRUNC('month', u.created_at) AS cohort_month,
           CASE
             WHEN COALESCE(NULLIF(TRIM(u.referred_by), ''), '') <> '' THEN 'referral'
             ELSE 'direct'
           END AS source,
           COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
           COALESCE(u.kyc_status, 'pending') AS kyc_status
         FROM users u
         WHERE u.created_at >= NOW() - make_interval(months => $1::int)
       ),
       account_agg AS (
         SELECT
           a.user_id,
           COUNT(*)::int AS accounts_opened,
           COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
         FROM accounts a
         GROUP BY a.user_id
       ),
       payout_agg AS (
         SELECT
           p.user_id,
           COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric AS paid_out
         FROM payouts p
         GROUP BY p.user_id
       )
       SELECT
         ub.cohort_month,
         ub.source,
         ub.country,
         COUNT(*)::int AS signups,
         COUNT(*) FILTER (WHERE ub.kyc_status = 'approved')::int AS kyc_approved,
         COALESCE(SUM(COALESCE(aa.accounts_opened, 0)), 0)::int AS accounts_opened,
         COALESCE(SUM(COALESCE(aa.funded_accounts, 0)), 0)::int AS funded_accounts,
         COALESCE(SUM(COALESCE(pa.paid_out, 0)), 0)::numeric AS paid_out
       FROM user_base ub
       LEFT JOIN account_agg aa ON aa.user_id = ub.id
       LEFT JOIN payout_agg pa ON pa.user_id = ub.id
       GROUP BY ub.cohort_month, ub.source, ub.country
       ORDER BY ub.cohort_month DESC, signups DESC`,
      [monthsBack]
    )

    const rows = cohorts.rows.map(r => ({
      cohort_month: r.cohort_month,
      source: r.source,
      country: r.country,
      signups: parseInt(r.signups || 0, 10),
      kyc_approved: parseInt(r.kyc_approved || 0, 10),
      accounts_opened: parseInt(r.accounts_opened || 0, 10),
      funded_accounts: parseInt(r.funded_accounts || 0, 10),
      paid_out: parseFloat(r.paid_out || 0),
    }))

    const monthlyMap = new Map()
    const countryMap = new Map()
    for (const r of rows) {
      const monthKey = r.cohort_month ? new Date(r.cohort_month).toISOString().slice(0, 7) : 'unknown'
      const m = monthlyMap.get(monthKey) || {
        month: monthKey,
        signups: 0,
        kyc_approved: 0,
        funded_accounts: 0,
        paid_out: 0
      }
      m.signups += r.signups
      m.kyc_approved += r.kyc_approved
      m.funded_accounts += r.funded_accounts
      m.paid_out += r.paid_out
      monthlyMap.set(monthKey, m)

      const c = countryMap.get(r.country) || { country: r.country, signups: 0 }
      c.signups += r.signups
      countryMap.set(r.country, c)
    }

    const monthly = Array.from(monthlyMap.values())
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(m => ({
        ...m,
        kyc_approval_rate: m.signups > 0 ? parseFloat(((m.kyc_approved / m.signups) * 100).toFixed(2)) : 0
      }))
    const top_countries = Array.from(countryMap.values())
      .sort((a, b) => b.signups - a.signups)
      .slice(0, 12)

    res.json({
      generated_at: new Date(),
      months_back: monthsBack,
      cohorts: rows,
      monthly,
      top_countries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cohort analytics' })
  }
})

router.get('/aml-velocity', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `WITH active_users AS (
         SELECT DISTINCT user_id::text FROM login_logs WHERE logged_in_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM trade_logs WHERE logged_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM payouts WHERE requested_at >= NOW() - INTERVAL '7 days'
       ),
       login_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '1 hour')::int AS login_1h,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours')::int AS login_24h,
           COUNT(DISTINCT ip_address) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours' AND ip_address IS NOT NULL)::int AS unique_ip_24h
         FROM login_logs
         GROUP BY user_id::text
       ),
       trade_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '1 hour')::int AS trade_1h,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '24 hours')::int AS trade_24h
         FROM trade_logs
         GROUP BY user_id::text
       ),
       payout_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days')::int AS payout_req_7d,
           COALESCE(SUM(amount_requested) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days'), 0)::numeric AS payout_amt_7d
         FROM payouts
         GROUP BY user_id::text
       ),
       account_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*)::int AS accounts_total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_accounts
         FROM accounts
         GROUP BY user_id::text
       )
       SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(l.login_1h, 0)::int AS login_1h,
         COALESCE(l.login_24h, 0)::int AS login_24h,
         COALESCE(l.unique_ip_24h, 0)::int AS unique_ip_24h,
         COALESCE(t.trade_1h, 0)::int AS trade_1h,
         COALESCE(t.trade_24h, 0)::int AS trade_24h,
         COALESCE(p.payout_req_7d, 0)::int AS payout_req_7d,
         COALESCE(p.payout_amt_7d, 0)::numeric AS payout_amt_7d,
         COALESCE(a.accounts_total, 0)::int AS accounts_total,
         COALESCE(a.active_accounts, 0)::int AS active_accounts
       FROM active_users au
       JOIN users u ON u.id::text = au.user_id
       LEFT JOIN login_agg l ON l.user_id = u.id::text
       LEFT JOIN trade_agg t ON t.user_id = u.id::text
       LEFT JOIN payout_agg p ON p.user_id = u.id::text
       LEFT JOIN account_agg a ON a.user_id = u.id::text
       ORDER BY
         (COALESCE(l.login_1h, 0) + COALESCE(l.login_24h, 0) + COALESCE(t.trade_1h, 0) + COALESCE(t.trade_24h, 0) + COALESCE(p.payout_req_7d, 0)) DESC,
         COALESCE(p.payout_amt_7d, 0) DESC
       LIMIT 300`
    )

    const rows = []
    for (const r of result.rows) {
      let riskScore = 0
      const flags = []

      if (r.login_1h >= 8) { riskScore += 25; flags.push('High login burst (1h)') }
      if (r.login_24h >= 25) { riskScore += 15; flags.push('High login velocity (24h)') }
      if (r.unique_ip_24h >= 4) { riskScore += 20; flags.push('Many unique IPs (24h)') }
      if (r.trade_1h >= 30) { riskScore += 20; flags.push('Trade burst (1h)') }
      if (r.trade_24h >= 120) { riskScore += 20; flags.push('High trade count (24h)') }
      if (r.payout_req_7d >= 2) { riskScore += 15; flags.push('Multiple payout requests (7d)') }
      if (parseFloat(r.payout_amt_7d || 0) >= 10000) { riskScore += 10; flags.push('Large payout amount (7d)') }
      if (String(r.kyc_status || '') !== 'approved') { riskScore += 10; flags.push('KYC not approved') }

      if (riskScore <= 0) continue
      rows.push({
        ...r,
        payout_amt_7d: parseFloat(r.payout_amt_7d || 0),
        risk_score: riskScore,
        risk_level: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
        flags
      })
    }

    rows.sort((a, b) => b.risk_score - a.risk_score)
    const sliced = rows.slice(0, 200)
    res.json({
      generated_at: new Date(),
      flagged_count: sliced.length,
      high_risk_count: sliced.filter(r => r.risk_level === 'high').length,
      medium_risk_count: sliced.filter(r => r.risk_level === 'medium').length,
      rows: sliced
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AML velocity checks' })
  }
})

router.get('/kyc-sla', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const tenantId = getScopedTenantId(req)
    const slaHoursRaw = parseInt(req.query.sla_hours || '24', 10)
    const slaHours = Number.isFinite(slaHoursRaw) ? Math.max(1, Math.min(168, slaHoursRaw)) : 24

    const pending = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(u.kyc_submitted_at, u.created_at))) / 3600.0 AS wait_hours,
         COUNT(a.id)::int AS accounts_total,
         COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.kyc_status = 'pending'
         AND ($1::bigint IS NULL OR COALESCE(u.tenant_id, $1) = $1)
       GROUP BY u.id, u.full_name, u.email, u.country, u.kyc_submitted_at, u.created_at
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) ASC
       LIMIT 600`,
      [tenantId]
    )

    const queue = pending.rows.map(r => {
      const waitHours = parseFloat(r.wait_hours || 0)
      const sla_status =
        waitHours >= slaHours * 2 ? 'breach'
          : waitHours >= slaHours ? 'overdue'
            : waitHours >= slaHours * 0.6 ? 'warning'
              : 'within_sla'
      return {
        ...r,
        wait_hours: parseFloat(waitHours.toFixed(2)),
        wait_minutes: Math.max(0, Math.floor(waitHours * 60)),
        sla_status
      }
    })

    const pendingTotal = queue.length
    const overdueCount = queue.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length
    const breachCount = queue.filter(r => r.sla_status === 'breach').length
    const avgWaitHours = pendingTotal > 0
      ? parseFloat((queue.reduce((s, r) => s + (r.wait_hours || 0), 0) / pendingTotal).toFixed(2))
      : 0

    res.json({
      generated_at: new Date(),
      sla_hours: slaHours,
      summary: {
        pending_total: pendingTotal,
        overdue_total: overdueCount,
        breach_total: breachCount,
        avg_wait_hours: avgWaitHours
      },
      queue
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC SLA queue' })
  }
})

router.get('/kyc-quality-flags', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const uploadsRoot = path.resolve(__dirname, '../uploads')
    const docs = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         u.id_document_path,
         u.id_document_back_path,
         u.selfie_path
       FROM users u
       WHERE ${buildKycDocumentPresencePredicate('u')}
         AND ($1::bigint IS NULL OR COALESCE(u.tenant_id, $1) = $1)
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) DESC
       LIMIT 500`,
      [tenantId]
    )

    function inspectRelativeFile(relPath) {
      if (!relPath) return { exists: false, size_bytes: 0, ext: '' }
      const raw = String(relPath).replace(/^[/\\]+/, '')
      const safe = raw.replace(/\.\./g, '')
      const abs = path.resolve(uploadsRoot, safe)
      if (!abs.startsWith(uploadsRoot + path.sep) && abs !== uploadsRoot) {
        return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
      }
      try {
        if (!fs.existsSync(abs)) return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
        const st = fs.statSync(abs)
        return { exists: true, size_bytes: st.size, ext: getOriginalKycExtension(raw) }
      } catch {
        return { exists: false, size_bytes: 0, ext: getOriginalKycExtension(raw) }
      }
    }

    const rows = docs.rows.map(r => {
      const idFile = inspectRelativeFile(r.id_document_path)
      const idBackFile = inspectRelativeFile(r.id_document_back_path)
      const selfieFile = inspectRelativeFile(r.selfie_path)
      const flags = []
      let qualityScore = 0

      if (!idFile.exists) { flags.push('Missing ID front document file'); qualityScore += 40 }
      if (!idBackFile.exists) { flags.push('Missing ID back document file'); qualityScore += 35 }
      if (!selfieFile.exists) { flags.push('Missing selfie file'); qualityScore += 50 }

      if (idFile.exists && !['.jpg', '.jpeg', '.png', '.pdf'].includes(idFile.ext)) {
        flags.push('Unexpected ID front document extension')
        qualityScore += 20
      }
      if (idBackFile.exists && !['.jpg', '.jpeg', '.png', '.pdf'].includes(idBackFile.ext)) {
        flags.push('Unexpected ID back document extension')
        qualityScore += 20
      }
      if (selfieFile.exists && !['.jpg', '.jpeg', '.png'].includes(selfieFile.ext)) {
        flags.push('Unexpected selfie extension')
        qualityScore += 25
      }
      if (idFile.exists && idFile.ext !== '.pdf' && idFile.size_bytes < 70 * 1024) {
        flags.push('ID front image file very small')
        qualityScore += 20
      }
      if (idBackFile.exists && idBackFile.ext !== '.pdf' && idBackFile.size_bytes < 70 * 1024) {
        flags.push('ID back image file very small')
        qualityScore += 20
      }
      if (selfieFile.exists && selfieFile.size_bytes < 60 * 1024) {
        flags.push('Selfie file very small')
        qualityScore += 25
      }
      if (idFile.exists && idBackFile.exists && selfieFile.exists && (idFile.size_bytes + idBackFile.size_bytes + selfieFile.size_bytes) < 240 * 1024) {
        flags.push('Combined KYC payload unusually small')
        qualityScore += 15
      }

      const submittedAt = r.submitted_at ? new Date(r.submitted_at) : null
      if (submittedAt && String(r.kyc_status || '') === 'pending') {
        const ageHours = (Date.now() - submittedAt.getTime()) / 3600000
        if (ageHours >= 48) {
          flags.push('Pending review for more than 48 hours')
          qualityScore += 10
        }
      }

      return {
        ...r,
        id_file_exists: idFile.exists,
        id_file_size: idFile.size_bytes,
        back_file_exists: idBackFile.exists,
        back_file_size: idBackFile.size_bytes,
        selfie_file_exists: selfieFile.exists,
        selfie_file_size: selfieFile.size_bytes,
        quality_score: qualityScore,
        risk_level: qualityScore >= 60 ? 'high' : qualityScore >= 30 ? 'medium' : 'low',
        flags
      }
    }).sort((a, b) => b.quality_score - a.quality_score)

    res.json({
      generated_at: new Date(),
      summary: {
        total_profiles: rows.length,
        high_risk_count: rows.filter(r => r.risk_level === 'high').length,
        medium_risk_count: rows.filter(r => r.risk_level === 'medium').length,
        missing_file_count: rows.filter(r => !r.id_file_exists || !r.back_file_exists || !r.selfie_file_exists).length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC quality flags' })
  }
})

router.get('/immutable-audit', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const countResult = await pool.query(`SELECT COUNT(*)::int AS c FROM admin_immutable_audit`)
    if ((countResult.rows[0]?.c || 0) === 0) {
      try {
        await appendImmutableAudit(pool, {
          eventType: 'audit_chain_initialized',
          entityType: 'system',
          entityId: 'bootstrap',
          payload: { initialized_at: new Date().toISOString() }
        })
      } catch (_) {}
    }

    const result = await pool.query(
      `SELECT
         id,
         event_type,
         entity_type,
         entity_id,
         actor,
         payload_json,
         payload_text,
         prev_hash,
         entry_hash,
         created_at
       FROM admin_immutable_audit
       ORDER BY id DESC
       LIMIT 500`
    )

    const descRows = result.rows
    const ascRows = [...descRows].reverse()
    let expectedPrev = 'GENESIS'
    let brokenLinks = 0
    const validatedAsc = ascRows.map(r => {
      const payloadText = String(r.payload_text || normalizeAuditPayload(r.payload_json || {}))
      const createdAt = r.created_at ? new Date(r.created_at).toISOString() : ''
      const expectedHash = buildAuditHash({
        prevHash: r.prev_hash,
        eventType: r.event_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payloadText,
        createdAt
      })
      const isValid = r.prev_hash === expectedPrev && r.entry_hash === expectedHash
      if (!isValid) brokenLinks += 1
      expectedPrev = r.entry_hash
      return { ...r, is_valid: isValid }
    })

    const entries = validatedAsc.reverse()
    res.json({
      generated_at: new Date(),
      integrity: {
        valid: brokenLinks === 0,
        broken_links: brokenLinks,
        checked_entries: validatedAsc.length,
        chain_head: entries[0]?.entry_hash || null
      },
      entries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load immutable audit log' })
  }
})

router.get('/four-eyes/queue', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT
         id, action_type, target_type, target_id, payload_json, requested_by,
         approvals_json, required_approvals, status, created_at, updated_at, decided_at,
         COALESCE(jsonb_array_length(approvals_json), 0)::int AS approvals_count
       FROM admin_four_eyes_requests
       ORDER BY created_at DESC
       LIMIT 300`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load 4-eyes queue' })
  }
})

router.post('/four-eyes/request', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      action_type,
      target_type = 'generic',
      target_id = '',
      payload = {},
      required_approvals = 2,
      requested_by = 'admin'
    } = req.body || {}

    if (!action_type || String(action_type).trim().length < 3) {
      return res.status(400).json({ error: 'action_type is required (min 3 chars)' })
    }
    const requiredApprovals = Math.max(2, Math.min(5, parseInt(required_approvals, 10) || 2))
    const ins = await pool.query(
      `INSERT INTO admin_four_eyes_requests
        (action_type, target_type, target_id, payload_json, requested_by, required_approvals, status, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', NOW())
       RETURNING *`,
      [
        String(action_type).trim(),
        String(target_type || 'generic').trim(),
        String(target_id || '').trim(),
        JSON.stringify(payload || {}),
        String(requested_by || 'admin').trim(),
        requiredApprovals
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'four_eyes_request_created',
        entityType: 'four_eyes_request',
        entityId: String(ins.rows[0].id),
        payload: {
          action_type: String(action_type).trim(),
          required_approvals: requiredApprovals
        }
      })
    } catch (_) {}
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create 4-eyes request' })
  }
})

router.post('/four-eyes/:id/decision', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const decision = String(req.body?.decision || '').trim().toLowerCase()
    const approver = String(req.body?.approver || 'admin').trim()
    const comment = String(req.body?.comment || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' })

    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT id, action_type, target_type, target_id, payload_json, requested_by,
              approvals_json, required_approvals, status, created_at, updated_at, decided_at
       FROM admin_four_eyes_requests WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }

    const current = currentResult.rows[0]
    if (current.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Request already ${current.status}` })
    }

    const approvals = Array.isArray(current.approvals_json) ? [...current.approvals_json] : []
    if (approvals.some(a => String(a.approver || '') === approver)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Approver has already submitted a decision' })
    }
    approvals.push({
      approver,
      decision,
      comment,
      at: new Date().toISOString()
    })

    const approvedCount = approvals.filter(a => a.decision === 'approve').length
    const rejectedCount = approvals.filter(a => a.decision === 'reject').length
    const needed = Math.max(2, parseInt(current.required_approvals || 2, 10))
    const nextStatus = rejectedCount > 0 ? 'rejected' : approvedCount >= needed ? 'approved' : 'pending'
    const decidedAt = nextStatus === 'pending' ? null : new Date().toISOString()

    const update = await client.query(
      `UPDATE admin_four_eyes_requests
          SET approvals_json = $2::jsonb,
              status = $3,
              decided_at = $4::timestamptz,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *,
                  COALESCE(jsonb_array_length(approvals_json), 0)::int AS approvals_count`,
      [id, JSON.stringify(approvals), nextStatus, decidedAt]
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'four_eyes_decision_submitted',
        entityType: 'four_eyes_request',
        entityId: String(id),
        payload: {
          decision,
          approver,
          resulting_status: nextStatus,
          approvals_count: approvals.length
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json(update.rows[0])
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to submit 4-eyes decision' })
  } finally {
    client.release()
  }
})

router.get('/feature-flags', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, flag_key, description, enabled, rollout_pct, segment, updated_by,
              created_at, updated_at
       FROM admin_feature_flags ORDER BY flag_key ASC`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feature flags' })
  }
})

router.post('/feature-flags', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      flag_key,
      description = '',
      enabled = false,
      rollout_pct = 100,
      segment = 'all',
      updated_by = 'admin'
    } = req.body || {}
    if (!flag_key || String(flag_key).trim().length < 2) {
      return res.status(400).json({ error: 'flag_key is required (min 2 chars)' })
    }
    const rollout = Math.max(0, Math.min(100, parseInt(rollout_pct, 10) || 0))
    const upsert = await pool.query(
      `INSERT INTO admin_feature_flags
        (flag_key, description, enabled, rollout_pct, segment, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (flag_key)
       DO UPDATE SET
         description = EXCLUDED.description,
         enabled = EXCLUDED.enabled,
         rollout_pct = EXCLUDED.rollout_pct,
         segment = EXCLUDED.segment,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        String(flag_key).trim(),
        String(description || ''),
        toBool(enabled, false),
        rollout,
        String(segment || 'all'),
        String(updated_by || 'admin')
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'feature_flag_upserted',
        entityType: 'feature_flag',
        entityId: String(upsert.rows[0].id),
        payload: {
          flag_key: String(flag_key).trim(),
          enabled: toBool(enabled, false),
          rollout_pct: rollout
        }
      })
    } catch (_) {}
    res.json(upsert.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to save feature flag' })
  }
})

router.post('/feature-flags/:id/toggle', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid flag id' })
    const result = await pool.query(
      `UPDATE admin_feature_flags
          SET enabled = NOT enabled,
              updated_at = NOW(),
              updated_by = $2
        WHERE id = $1
        RETURNING *`,
      [id, String(req.body?.updated_by || 'admin')]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Feature flag not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'feature_flag_toggled',
        entityType: 'feature_flag',
        entityId: String(id),
        payload: {
          flag_key: result.rows[0].flag_key,
          enabled: !!result.rows[0].enabled
        }
      })
    } catch (_) {}
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle feature flag' })
  }
})

router.get('/notifications', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const status = req.query.status ? String(req.query.status) : null
    const params = []
    let where = ''
    if (status && status !== 'all') {
      params.push(status)
      where = `WHERE status = $1`
    }
    const result = await pool.query(
      `SELECT id, type, channel, title, message, audience, status, scheduled_for,
              sent_at, created_by, created_at
       FROM admin_notifications ${where} ORDER BY created_at DESC LIMIT 400`,
      params
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' })
  }
})

router.post('/notifications', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      type = 'info',
      channel = 'web',
      title = '',
      message,
      audience = 'all',
      scheduled_for = null,
      created_by = 'admin'
    } = req.body || {}
    if (!message || String(message).trim().length < 3) {
      return res.status(400).json({ error: 'message is required (min 3 chars)' })
    }
    const t = ['info', 'warning', 'success', 'error'].includes(String(type)) ? String(type) : 'info'
    const c = ['web', 'email', 'webhook'].includes(String(channel)) ? String(channel) : 'web'
    let scheduled = null
    if (scheduled_for) {
      const dt = new Date(scheduled_for)
      if (!Number.isNaN(dt.getTime())) scheduled = dt.toISOString()
    }
    const status = scheduled ? 'scheduled' : 'queued'
    const ins = await pool.query(
      `INSERT INTO admin_notifications
        (type, channel, title, message, audience, status, scheduled_for, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       RETURNING *`,
      [t, c, String(title || ''), String(message).trim(), String(audience || 'all'), status, scheduled, String(created_by || 'admin')]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'notification_created',
        entityType: 'notification',
        entityId: String(ins.rows[0].id),
        payload: { type: t, channel: c, status }
      })
    } catch (_) {}
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create notification' })
  }
})

router.post('/notifications/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid notification id' })
    if (!['queued', 'scheduled', 'sent', 'cancelled', 'read'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const update = await pool.query(
      `UPDATE admin_notifications
          SET status = $2,
              sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
        WHERE id = $1
        RETURNING *`,
      [id, status]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Notification not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'notification_status_updated',
        entityType: 'notification',
        entityId: String(id),
        payload: { status }
      })
    } catch (_) {}
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification status' })
  }
})

router.get('/cases', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const status = req.query.status ? String(req.query.status) : null
    const owner = req.query.owner ? String(req.query.owner) : null
    const params = []
    const filters = []
    if (status && status !== 'all') {
      params.push(status)
      filters.push(`status = $${params.length}`)
    }
    if (owner && owner !== 'all') {
      params.push(owner)
      filters.push(`owner = $${params.length}`)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const result = await pool.query(
      `SELECT id, source_type, source_id, title, severity, priority, status,
              owner, notes, created_by, created_at, updated_at, closed_at
       FROM admin_cases ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cases' })
  }
})

router.post('/cases', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      source_type = 'manual',
      source_id = '',
      title,
      severity = 'medium',
      priority = 'normal',
      owner = null,
      notes = '',
      created_by = 'admin'
    } = req.body || {}
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 chars)' })
    }
    const sev = ['low', 'medium', 'high', 'critical'].includes(String(severity)) ? String(severity) : 'medium'
    const prio = ['low', 'normal', 'high', 'urgent'].includes(String(priority)) ? String(priority) : 'normal'
    const ins = await pool.query(
      `INSERT INTO admin_cases
        (source_type, source_id, title, severity, priority, owner, notes, created_by, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', NOW())
       RETURNING *`,
      [
        String(source_type || 'manual'),
        String(source_id || ''),
        String(title).trim(),
        sev,
        prio,
        owner ? String(owner) : null,
        String(notes || ''),
        String(created_by || 'admin')
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_created',
        entityType: 'case',
        entityId: String(ins.rows[0].id),
        payload: { source_type: String(source_type || 'manual'), severity: sev, priority: prio }
      })
    } catch (_) {}
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create case' })
  }
})

router.post('/cases/:id/assign', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const owner = String(req.body?.owner || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid case id' })
    if (!owner) return res.status(400).json({ error: 'owner is required' })
    const update = await pool.query(
      `UPDATE admin_cases
          SET owner = $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, owner]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_assigned',
        entityType: 'case',
        entityId: String(id),
        payload: { owner }
      })
    } catch (_) {}
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign case owner' })
  }
})

router.post('/cases/:id/status', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid case id' })
    const allowed = ['open', 'in_progress', 'pending_external', 'resolved', 'closed']
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    const update = await pool.query(
      `UPDATE admin_cases
          SET status = $2,
              closed_at = CASE WHEN $2 IN ('resolved', 'closed') THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, status]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_status_updated',
        entityType: 'case',
        entityId: String(id),
        payload: { status }
      })
    } catch (_) {}
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update case status' })
  }
})

router.get('/dispute-workflow', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const scopedTenantId = getScopedTenantId(req)
    let rows = []
    try {
      const result = await pool.query(
        `SELECT
           d.id::text AS dispute_id,
           d.status,
           d.reason,
           d.description,
           d.admin_response,
           d.created_at,
           d.updated_at,
           u.full_name,
           u.email,
           u.trader_uid,
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
         WHERE ($1::bigint IS NULL OR COALESCE(d.tenant_id, $1) = $1)
         ORDER BY d.created_at DESC
         LIMIT 500`,
        [scopedTenantId]
      )
      rows = result.rows.map(r => {
        const ageHours = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) / 3600000 : 0
        const slaHours = Math.max(1, parseInt(r.sla_hours || 48, 10))
        const sla_status =
          ageHours >= slaHours * 1.75 ? 'breach'
            : ageHours >= slaHours ? 'overdue'
              : 'within_sla'
        return {
          ...r,
          age_hours: parseFloat(ageHours.toFixed(2)),
          sla_hours: slaHours,
          sla_status
        }
      })
    } catch (err) {
      if (err?.code !== '42P01') throw err
      rows = []
    }

    res.json({
      generated_at: new Date(),
      summary: {
        total: rows.length,
        open: rows.filter(r => r.status === 'open').length,
        under_review: rows.filter(r => r.status === 'under_review').length,
        resolved: rows.filter(r => r.status === 'resolved').length,
        rejected: rows.filter(r => r.status === 'rejected').length,
        overdue: rows.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length,
        breach: rows.filter(r => r.sla_status === 'breach').length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dispute workflow' })
  }
})

router.post('/dispute-workflow/:id/meta', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const disputeId = String(req.params.id || '').trim()
    if (!disputeId) return res.status(400).json({ error: 'Invalid dispute id' })
    const scopedTenantId = getScopedTenantId(req)

    const owner = req.body?.owner ? String(req.body.owner).trim() : null
    const priorityRaw = req.body?.priority ? String(req.body.priority).trim().toLowerCase() : 'normal'
    const priority = ['low', 'normal', 'high', 'urgent'].includes(priorityRaw) ? priorityRaw : 'normal'
    const slaHours = Math.max(1, Math.min(336, parseInt(req.body?.sla_hours || 48, 10) || 48))
    const notes = sanitizeString(String(req.body?.notes || ''), 2000)

    const disputeResult = await pool.query(
      `SELECT id
         FROM disputes
        WHERE id::text = $1
          AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
        LIMIT 1`,
      [disputeId, scopedTenantId]
    )
    if (disputeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Dispute not found' })
    }

    const upsert = await pool.query(
      `INSERT INTO admin_dispute_meta (dispute_id, owner, priority, sla_hours, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (dispute_id)
       DO UPDATE SET
         owner = EXCLUDED.owner,
         priority = EXCLUDED.priority,
         sla_hours = EXCLUDED.sla_hours,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [disputeId, owner, priority, slaHours, notes]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'dispute_meta_updated',
        entityType: 'dispute',
        entityId: disputeId,
        payload: { owner, priority, sla_hours: slaHours }
      })
    } catch (_) {}

    res.json(upsert.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update dispute metadata' })
  }
})

router.post('/dispute-workflow/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const disputeId = String(req.params.id || '').trim()
    if (!disputeId) return res.status(400).json({ error: 'Invalid dispute id' })
    const scopedTenantId = getScopedTenantId(req)
    const status = String(req.body?.status || '').trim()
    const adminResponse = sanitizeString(String(req.body?.admin_response || ''), 2000)
    const allowed = ['open', 'under_review', 'resolved', 'rejected']
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    }

    const result = await pool.query(
      `UPDATE disputes
          SET status = $2,
              admin_response = CASE WHEN $3 <> '' THEN $3 ELSE admin_response END,
              updated_at = NOW()
        WHERE id::text = $1
          AND ($4::bigint IS NULL OR COALESCE(tenant_id, $4) = $4)
        RETURNING *`,
      [disputeId, status, adminResponse, scopedTenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'dispute_status_updated',
        entityType: 'dispute',
        entityId: disputeId,
        payload: { status }
      })
    } catch (_) {}

    res.json(result.rows[0])
  } catch (err) {
    if (err?.code === '42P01') return res.status(404).json({ error: 'Disputes table not found' })
    res.status(500).json({ error: 'Failed to update dispute status' })
  }
})

router.post('/stress-simulator', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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

router.get('/scheduled-reports', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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

router.post('/scheduled-reports', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
    } catch (_) {}

    res.json(saved)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save scheduled report' })
  }
})

router.post('/scheduled-reports/:id/toggle', authenticateAdmin, requireSuperAdmin, async (req, res) => {
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
    } catch (_) {}
    res.json(updated.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle scheduled report' })
  }
})

router.get('/emergency-kill/status', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap([
      'emergency_kill_enabled',
      'emergency_kill_last_triggered_at',
      'emergency_kill_last_reset_at',
      'copier_enabled'
    ])
    const openTrades = await pool.query(`SELECT COUNT(*)::int AS c FROM trades WHERE status = 'open'`)
    res.json({
      enabled: toBool(settings.emergency_kill_enabled, false),
      last_triggered_at: settings.emergency_kill_last_triggered_at || null,
      last_reset_at: settings.emergency_kill_last_reset_at || null,
      copier_enabled: toBool(settings.copier_enabled, true),
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
    const copierEvents = []
    for (const row of accountIdsResult.rows) {
      const closeResult = await forceCloseOpenTradesForAccount(client, row.account_id, { copierEvents, source: 'admin_emergency_kill' })
      closedTrades += closeResult.closedCount
      totalPnl += closeResult.totalPnl
    }

    await upsertSetting(client, 'emergency_kill_enabled', 'true')
    await upsertSetting(client, 'emergency_kill_last_triggered_at', new Date().toISOString())
    await upsertSetting(client, 'copier_enabled', 'false')

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
    } catch (_) {}

    await client.query('COMMIT')
    await emitCopierEventsAfterCommit(copierEvents)
    res.json({
      dry_run: false,
      closed_trades: closedTrades,
      affected_accounts: accountIdsResult.rows.length,
      total_pnl: parseFloat(totalPnl.toFixed(2)),
      copier_enabled: false,
      emergency_kill_enabled: true
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to execute emergency kill switch' })
  } finally {
    client.release()
  }
})

router.post('/emergency-kill/reset', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const reEnableCopier = toBool(req.body?.reenable_copier, false)

    await client.query('BEGIN')
    await upsertSetting(client, 'emergency_kill_enabled', 'false')
    await upsertSetting(client, 'emergency_kill_last_reset_at', new Date().toISOString())
    if (reEnableCopier) {
      await upsertSetting(client, 'copier_enabled', 'true')
    }

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_reset',
        entityType: 'system',
        entityId: 'global',
        payload: { reenable_copier: reEnableCopier }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json({
      emergency_kill_enabled: false,
      copier_enabled: reEnableCopier ? true : undefined,
      last_reset_at: new Date().toISOString()
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reset emergency kill switch' })
  } finally {
    client.release()
  }
})

// -- KYC Document Viewer -----------------------------------------------------------------------
router.get('/kyc/document/:userId/:type', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const { userId, type } = req.params;
    const scopedTenantId = getScopedTenantId(req)

    await ensureFeatureTables()

    // kyc.js saves file paths into the `users` table.
    const documentColumns = {
      id: 'id_document_path',
      front: 'id_document_path',
      back: 'id_document_back_path',
      selfie: 'selfie_path'
    }
    const columnName = documentColumns[String(type || 'id').toLowerCase()]
    if (!columnName) {
      return res.status(400).json({ error: 'Invalid document type' })
    }

    const userRow = await pool.query(
      `SELECT ${columnName} AS doc_path, tenant_id
         FROM users
        WHERE id = $1
          AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)`,
      [userId, scopedTenantId]
    );

    if (userRow.rows.length === 0 || !userRow.rows[0].doc_path) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // kyc.js stores a relative path like "kyc/userId-id_document-xyz.jpg"
    // Strip any leading "uploads/" prefix in case the DB value includes it.
    const rawPath = userRow.rows[0].doc_path;
    const relPath = rawPath.replace(/^[\/\\\\]?uploads[\/\\\\]/, '');

    const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
    const absoluteFilePath = path.resolve(uploadsRoot, relPath);

    // Path traversal guard -- reject any path that escapes the uploads directory.
    if (!absoluteFilePath.startsWith(uploadsRoot + path.sep)) {
      logger.warn('[kyc-doc] Path traversal attempt blocked:', { rawPath, userId });
      return res.status(400).json({ error: 'Invalid document path' });
    }

    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'File physically missing from server disk' });
    }

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'kyc_document_viewed',
        entityType: 'user',
        entityId: String(userId),
        payload: { type: String(type || 'id') }
      })
    } catch (_) {}

    const { buffer } = readKycFileBuffer(absoluteFilePath)
    res.type(getKycContentType(absoluteFilePath)).send(buffer)
  } catch (err) {
    logger.error('[kyc-doc] Error serving document:', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve KYC document' });
  }
});
router.__test__ = {
  buildKycDocumentPresencePredicate
}
module.exports = router;

module.exports = router
