// Account sharing / passing-service review queue.
//
// Surfaces the clusters produced by services/accountLinkingService.js: the list,
// a per-cluster evidence view, a link graph for investigation, and the resolve
// action. Mounted at the router root by ./index.js, so every path below stays
// absolute under /api/admin.
//
// Capabilities reuse the existing violation:* strings rather than introducing
// new ones — risk_ops already holds both read and resolve, and platform:* covers
// super_admin (see routes/middleware.js:23-28).

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireAdminCapability,
  requireSuperAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  getAdminActorLabel, buildAdminActorPayload, appendImmutableAudit
} = require('./shared/audit')
const {
  requireReasonText, wantsAdminListContract, parseListPaging,
  parseCsvListParam, emitSuperAdminPowerEvent
} = require('./shared/helpers')
const {
  buildAccountLinkListResult,
  buildAllowedAccountLinkActions,
  RESOLVABLE_STATUSES
} = require('./shared/accountLinkList')
const { adminModerationLimiter, adminBulkLimiter } = require('./shared/rateLimiters')
const { runAccountLinkingScan } = require('../../services/accountLinkingService')

// ── List ─────────────────────────────────────────────────────────────────────

router.get('/account-links', authenticateAdmin, requireAdminCapability('violation:read:scoped'), async function (req, res) {
  try {
    await ensureFeatureTables()
    const paging = parseListPaging(req)
    const minScore = Number(req.query?.min_score)

    const listResult = await buildAccountLinkListResult({
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          status: req.query?.status || null,
          confidence: req.query?.confidence || null,
          signal_types: parseCsvListParam(req.query?.signal_types || []),
          min_score: Number.isFinite(minScore) ? minScore : undefined
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin account-links fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch account links' })
  }
})

// ── Cluster detail + evidence ────────────────────────────────────────────────

router.get('/account-links/:clusterId', authenticateAdmin, requireAdminCapability('violation:read:scoped'), async function (req, res) {
  try {
    const clusterId = parseInt(req.params.clusterId, 10)
    if (!Number.isFinite(clusterId) || clusterId <= 0) {
      return res.status(400).json({ error: 'Valid cluster id is required' })
    }

    const clusterResult = await pool.query(
      `SELECT * FROM account_link_clusters WHERE id = $1`,
      [clusterId]
    )
    if (clusterResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cluster not found' })
    }
    const cluster = clusterResult.rows[0]

    const [evidenceResult, membersResult] = await Promise.all([
      pool.query(
        `SELECT id, evidence_type, evidence_value, evidence_label, user_ids,
                distinct_users, weight, detail, observed_at
           FROM account_link_evidence
          WHERE cluster_id = $1
          ORDER BY weight DESC, id ASC`,
        [clusterId]
      ),
      pool.query(
        `SELECT u.id::text AS id, u.email, u.full_name, u.country, u.kyc_status,
                u.is_banned, u.created_at,
                COALESCE(acc.account_count, 0) AS account_count,
                COALESCE(acc.flagged_count, 0) AS flagged_count
           FROM users u
           LEFT JOIN LATERAL (
             SELECT COUNT(*)::int AS account_count,
                    COUNT(*) FILTER (WHERE a.review_flagged)::int AS flagged_count
               FROM accounts a WHERE a.user_id = u.id
           ) acc ON TRUE
          WHERE u.id = ANY($1::uuid[])
          ORDER BY u.created_at ASC`,
        [cluster.member_user_ids]
      )
    ])

    res.json({
      cluster: {
        ...cluster,
        member_user_ids: (cluster.member_user_ids || []).map(String),
        allowed_actions: buildAllowedAccountLinkActions(cluster)
      },
      evidence: evidenceResult.rows.map(row => ({
        ...row,
        user_ids: (row.user_ids || []).map(String)
      })),
      members: membersResult.rows
    })
  } catch (error) {
    logger.error('Admin account-link detail error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch cluster detail' })
  }
})

// ── Link graph ───────────────────────────────────────────────────────────────
//
// Node/edge shape matches the existing /device-link-graph endpoint in
// compliance.js so the same rendering logic works for both.

router.get('/account-links/:clusterId/graph', authenticateAdmin, requireAdminCapability('violation:read:scoped'), async function (req, res) {
  try {
    const clusterId = parseInt(req.params.clusterId, 10)
    if (!Number.isFinite(clusterId) || clusterId <= 0) {
      return res.status(400).json({ error: 'Valid cluster id is required' })
    }

    const clusterResult = await pool.query(
      `SELECT id, member_user_ids FROM account_link_clusters WHERE id = $1`,
      [clusterId]
    )
    if (clusterResult.rows.length === 0) {
      return res.status(404).json({ error: 'Cluster not found' })
    }
    const memberIds = clusterResult.rows[0].member_user_ids || []

    const [usersResult, evidenceResult] = await Promise.all([
      pool.query(
        `SELECT id::text AS id, email, full_name FROM users WHERE id = ANY($1::uuid[])`,
        [memberIds]
      ),
      pool.query(
        `SELECT evidence_type, evidence_value, evidence_label, user_ids, weight
           FROM account_link_evidence
          WHERE cluster_id = $1
          ORDER BY weight DESC`,
        [clusterId]
      )
    ])

    const nodes = usersResult.rows.map(user => ({
      id: `user:${user.id}`,
      type: 'user',
      label: user.email,
      detail: user.full_name || null
    }))
    const edges = []

    // Each shared value becomes its own node, with an edge to every user that
    // presented it. That makes it visually obvious WHICH value ties the ring
    // together, rather than drawing an unexplained user-to-user line.
    evidenceResult.rows.forEach((item, position) => {
      const nodeId = `signal:${position}`
      nodes.push({
        id: nodeId,
        type: item.evidence_type,
        label: item.evidence_label || item.evidence_type,
        detail: item.evidence_type === 'simultaneous_execution' ? null : item.evidence_value,
        weight: item.weight
      })
      for (const userId of item.user_ids || []) {
        edges.push({
          source: `user:${String(userId)}`,
          target: nodeId,
          type: item.evidence_type,
          weight: item.weight
        })
      }
    })

    res.json({ nodes, edges, cluster_id: clusterId })
  } catch (error) {
    logger.error('Admin account-link graph error:', { error: error.message })
    res.status(500).json({ error: 'Could not build link graph' })
  }
})

// ── Resolve ──────────────────────────────────────────────────────────────────

router.post('/account-links/:clusterId/resolve',
  authenticateAdmin,
  requireAdminCapability('violation:resolve:scoped'),
  adminModerationLimiter,
  async function (req, res) {
    const client = await pool.connect()
    try {
      await ensureFeatureTables()
      const clusterId = parseInt(req.params.clusterId, 10)
      const reason = requireReasonText(req.body?.reason, 'resolution reason')
      const status = String(req.body?.status || '').toLowerCase()

      if (!Number.isFinite(clusterId) || clusterId <= 0) {
        return res.status(400).json({ error: 'Valid cluster id is required' })
      }
      if (!RESOLVABLE_STATUSES.includes(status)) {
        return res.status(400).json({
          error: `status must be one of: ${RESOLVABLE_STATUSES.join(', ')}`
        })
      }

      await client.query('BEGIN')

      const existing = await client.query(
        `SELECT * FROM account_link_clusters WHERE id = $1 FOR UPDATE`,
        [clusterId]
      )
      if (existing.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Cluster not found' })
      }
      const before = existing.rows[0]

      const isTerminal = status === 'confirmed_sharing' || status === 'false_positive'
      const updated = await client.query(
        `UPDATE account_link_clusters
            SET status          = $2,
                resolution_note = $3,
                resolved_by     = $4,
                resolved_at     = CASE WHEN $5::boolean THEN NOW() ELSE NULL END
          WHERE id = $1
          RETURNING *`,
        [clusterId, status, reason, getAdminActorLabel(req.admin), isTerminal]
      )
      const after = updated.rows[0]

      await appendImmutableAudit(client, {
        eventType: 'admin_account_link_resolved',
        entityType: 'account_link',
        entityId: String(clusterId),
        actor: getAdminActorLabel(req.admin),
        payload: {
          reason,
          status,
          actor: buildAdminActorPayload(req.admin),
          before_snapshot: {
            status: before.status,
            score: before.score,
            confidence: before.confidence,
            member_count: before.member_count
          },
          after_snapshot: {
            status: after.status,
            score: after.score,
            confidence: after.confidence,
            member_count: after.member_count
          },
          member_user_ids: (before.member_user_ids || []).map(String)
        }
      })

      await client.query('COMMIT')

      await emitSuperAdminPowerEvent(req, {
        entity: 'account_link',
        entity_id: clusterId,
        action: `resolve_${status}`
      })

      res.json({
        message: 'Cluster updated',
        cluster: {
          ...after,
          member_user_ids: (after.member_user_ids || []).map(String),
          allowed_actions: buildAllowedAccountLinkActions(after)
        }
      })
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      logger.error('Could not resolve account link cluster:', { error: error.message })
      res.status(error.statusCode || 500).json({
        error: error.statusCode ? error.message : 'Could not resolve cluster'
      })
    } finally {
      client.release()
    }
  })

// ── Manual scan ──────────────────────────────────────────────────────────────
//
// The scan runs on a 15-minute schedule; this exists so an admin investigating a
// live incident does not have to wait for the next tick. Super-admin only and
// bulk-rate-limited because it is the single most expensive query in the panel.

router.post('/account-links/scan',
  authenticateAdmin,
  requireSuperAdmin,
  adminBulkLimiter,
  async function (req, res) {
    try {
      const result = await runAccountLinkingScan()
      res.json({ message: 'Scan complete', ...result })
    } catch (error) {
      logger.error('Manual account link scan failed:', { error: error.message })
      res.status(500).json({ error: 'Scan failed' })
    }
  })

module.exports = router
