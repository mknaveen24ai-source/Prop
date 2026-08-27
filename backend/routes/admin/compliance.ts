// Admin enforcement actions, payout fraud scores, device link graph.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

import type {
  ApplyEnforcementResponseDto,
  DeviceGraphEdgeDto,
  DeviceGraphEdgeType,
  DeviceGraphNodeDto,
  DeviceGraphNodeType,
  DeviceGraphResponseDto,
  EnforcementAction,
  EnforcementEventDto,
  FraudRiskLevel,
  IsoTimestamp,
  JsonValue,
  LegacyErrorResponse,
  PayoutFraudScoreDto
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  Router
} from 'express'
import type { PoolClient, QueryResultRow } from 'pg'
import pool = require('../../db')
import { authenticateAdmin, requireSuperAdmin } from '../middleware'
import logger = require('../../utils/logger')
import '../../loadEnv'
import { jsonValueSchema, parseExternal } from '../../validation/unknown'
import { z } from 'zod'

type EnforcementStatus = 'applied' | 'failed'

interface EnforcementEventRow extends QueryResultRow {
  id: string
  rule_id: string | null
  account_id: string | null
  user_id: string | null
  action: string
  payload_json: unknown
  status: string
  message: string | null
  created_at: Date | string
}

interface AccountEnforcementRow extends QueryResultRow {
  id: string
  user_id: string
  status: string
}

interface PayoutFraudRow extends QueryResultRow {
  id: string
  user_id: string
  account_id: string
  amount_requested: string
  status: string
  requested_at: Date | string
  full_name: string
  email: string
  kyc_status: string | null
  account_size: string
  account_created_at: Date | string
}

interface CountRow extends QueryResultRow {
  c: number
}

interface LoginIpRow extends QueryResultRow {
  ip_address: string
}

interface LoginGraphRow extends QueryResultRow {
  user_id: string
  ip_address: string
  logged_in_at: Date | string
}

interface TradeGraphRow extends QueryResultRow {
  user_id: string
  account_id: string
  ip_address: string
  logged_at: Date | string
}

interface PayoutFraudSignals {
  openTradeCount: number
  recentTradeCount: number
  sharedUsers: number
}

interface SchemaApi {
  ensureFeatureTables: () => Promise<void>
}

interface AuditApi {
  appendImmutableAudit: (
    client: PoolClient,
    payload: {
      eventType: string
      entityType: string
      entityId: string
      payload: Record<string, JsonValue>
    }
  ) => Promise<unknown>
}

interface TradeOpsApi {
  forceCloseOpenTradesForAccount: (
    client: PoolClient,
    accountId: string
  ) => Promise<{ closedCount: number; totalPnl: number }>
}

interface ComplianceTestApi {
  applyEnforcementHandler: (
    req: ExpressRequest<Record<string, never>, ApplyEnforcementResponseDto | LegacyErrorResponse, unknown>,
    res: ExpressResponse<ApplyEnforcementResponseDto | LegacyErrorResponse>
  ) => Promise<void | ExpressResponse<LegacyErrorResponse>>
  buildPayoutFraudScore: (
    row: PayoutFraudRow,
    signals: PayoutFraudSignals,
    nowMs?: number
  ) => PayoutFraudScoreDto
  buildDeviceLinkGraph: (
    loginRows: LoginGraphRow[],
    tradeRows: TradeGraphRow[],
    focusUserId: string | null,
    generatedAt?: IsoTimestamp
  ) => DeviceGraphResponseDto
}

interface ComplianceRouter extends Router {
  __test__: ComplianceTestApi
}

const { ensureFeatureTables } = require('./shared/schema') as SchemaApi
const { appendImmutableAudit } = require('./shared/audit') as AuditApi
const { forceCloseOpenTradesForAccount } = require('./shared/tradeOps') as TradeOpsApi

const requestRecordSchema = z.record(z.string(), z.unknown())

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function requestRecord(value: unknown): Record<string, unknown> {
  const parsed = requestRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function isoTimestamp(value: Date | string): IsoTimestamp {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapEnforcementEvent(row: EnforcementEventRow): EnforcementEventDto {
  return {
    id: String(row.id),
    rule_id: row.rule_id == null ? null : String(row.rule_id),
    account_id: row.account_id == null ? null : String(row.account_id),
    user_id: row.user_id == null ? null : String(row.user_id),
    action: String(row.action),
    payload_json: parseExternal(jsonValueSchema, row.payload_json, 'admin enforcement event payload'),
    status: String(row.status),
    message: row.message == null ? null : String(row.message),
    created_at: isoTimestamp(row.created_at)
  }
}

function isEnforcementAction(value: unknown): value is EnforcementAction {
  return value === 'lock_account' || value === 'force_close_open_trades' || value === 'flag_for_review'
}

function buildPayoutFraudScore(
  row: PayoutFraudRow,
  signals: PayoutFraudSignals,
  nowMs: number = Date.now()
): PayoutFraudScoreDto {
  let score = 0
  const reasons: string[] = []
  const amount = parseFloat(String(row.amount_requested || 0))
  const accountSize = parseFloat(String(row.account_size || 0))
  const accountAgeDays = Math.max(
    0,
    Math.floor((nowMs - new Date(row.account_created_at).getTime()) / (1000 * 60 * 60 * 24))
  )

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
  if (signals.openTradeCount > 0) {
    score += 10
    reasons.push('Open trades exist at payout request time')
  }
  if (signals.recentTradeCount >= 10) {
    score += 10
    reasons.push('High recent trade velocity')
  }
  if (signals.sharedUsers >= 3) {
    score += 20
    reasons.push('IP shared by multiple users')
  }

  const riskLevel: FraudRiskLevel = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    account_id: String(row.account_id),
    amount_requested: String(row.amount_requested),
    status: String(row.status),
    requested_at: isoTimestamp(row.requested_at),
    full_name: String(row.full_name),
    email: String(row.email),
    kyc_status: row.kyc_status == null ? null : String(row.kyc_status),
    account_size: String(row.account_size),
    account_created_at: isoTimestamp(row.account_created_at),
    score,
    risk_level: riskLevel,
    account_age_days: accountAgeDays,
    shared_ip_users: signals.sharedUsers,
    reasons
  }
}

function buildDeviceLinkGraph(
  loginRows: LoginGraphRow[],
  tradeRows: TradeGraphRow[],
  focusUserId: string | null,
  generatedAt: IsoTimestamp = new Date().toISOString()
): DeviceGraphResponseDto {
  const nodes = new Map<string, DeviceGraphNodeDto>()
  const edges = new Map<string, DeviceGraphEdgeDto>()
  function addNode(id: string, type: DeviceGraphNodeType, label: string): void {
    if (!nodes.has(id)) nodes.set(id, { id, type, label })
  }
  function addEdge(from: string, to: string, type: DeviceGraphEdgeType): void {
    const key = `${from}|${to}|${type}`
    const previous = edges.get(key)
    if (previous) previous.weight += 1
    else edges.set(key, { id: key, from, to, type, weight: 1 })
  }

  for (const row of loginRows) {
    const userId = String(row.user_id || '')
    const ip = String(row.ip_address || '')
    if (!userId || !ip) continue
    if (focusUserId && userId !== focusUserId) continue
    const userNode = `u:${userId}`
    const ipNode = `ip:${ip}`
    addNode(userNode, 'user', userId)
    addNode(ipNode, 'ip', ip)
    addEdge(userNode, ipNode, 'login_ip')
  }

  for (const row of tradeRows) {
    const userId = String(row.user_id || '')
    const accountId = String(row.account_id || '')
    const ip = String(row.ip_address || '')
    if (!userId || !ip) continue
    if (focusUserId && userId !== focusUserId) continue
    const userNode = `u:${userId}`
    const accountNode = `a:${accountId}`
    const ipNode = `ip:${ip}`
    addNode(userNode, 'user', userId)
    addNode(accountNode, 'account', accountId)
    addNode(ipNode, 'ip', ip)
    addEdge(userNode, ipNode, 'trade_ip')
    if (accountId) addEdge(accountNode, ipNode, 'account_ip')
    if (accountId) addEdge(userNode, accountNode, 'owns')
  }

  return {
    generated_at: generatedAt,
    nodes: Array.from(nodes.values()),
    edges: Array.from(edges.values())
  }
}

const router = express.Router() as ComplianceRouter

router.get('/enforcement/events', authenticateAdmin, requireSuperAdmin, async (
  _req: ExpressRequest<Record<string, never>, EnforcementEventDto[] | LegacyErrorResponse>,
  res: ExpressResponse<EnforcementEventDto[] | LegacyErrorResponse>
): Promise<void> => {
  try {
    await ensureFeatureTables()
    const result = await pool.query<EnforcementEventRow>(
      `SELECT id, rule_id, account_id, user_id, action, payload_json, status,
              message, created_at
       FROM admin_enforcement_events ORDER BY created_at DESC LIMIT 300`
    )
    res.json(result.rows.map(mapEnforcementEvent))
  } catch (_error: unknown) {
    res.status(500).json({ error: 'Failed to load enforcement events' })
  }
})

async function applyEnforcementHandler(
  req: ExpressRequest<Record<string, never>, ApplyEnforcementResponseDto | LegacyErrorResponse, unknown>,
  res: ExpressResponse<ApplyEnforcementResponseDto | LegacyErrorResponse>
): Promise<void | ExpressResponse<LegacyErrorResponse>> {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const body = requestRecord(req.body)
    const account_id = body.account_id
    const action = body.action
    const reason = body.reason ?? ''
    const rule_id = body.rule_id ?? null
    const rawPayload = body.payload || {}
    if (!account_id) return res.status(400).json({ error: 'account_id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })
    const payload = parseExternal(jsonValueSchema, rawPayload, 'admin enforcement request payload')

    await client.query('BEGIN')

    const accResult = await client.query<AccountEnforcementRow>(
      `SELECT id, user_id, status FROM accounts WHERE id = $1 FOR UPDATE`,
      [String(account_id)]
    )
    if (accResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const acc = accResult.rows[0]!
    let message = ''
    let eventStatus: EnforcementStatus = 'applied'

    if (isEnforcementAction(action) && action === 'lock_account') {
      await client.query(`UPDATE accounts SET status = 'locked', updated_at = NOW() WHERE id = $1`, [acc.id])
      message = 'Account locked'
    } else if (isEnforcementAction(action) && action === 'force_close_open_trades') {
      const closeResult = await forceCloseOpenTradesForAccount(client, acc.id)
      message = `Force-closed ${closeResult.closedCount} open trades; total P&L ${closeResult.totalPnl >= 0 ? '+' : ''}$${closeResult.totalPnl.toFixed(2)}`
    } else if (isEnforcementAction(action) && action === 'flag_for_review') {
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
      message = `Unsupported action: ${String(action)}`
    }

    const eventResult = await client.query<EnforcementEventRow>(
      `INSERT INTO admin_enforcement_events (rule_id, account_id, user_id, action, payload_json, status, message)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        Number.isFinite(parseInt(String(rule_id), 10)) ? parseInt(String(rule_id), 10) : null,
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
        [parseInt(String(rule_id), 10)]
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
          rule_id: Number.isFinite(parseInt(String(rule_id), 10)) ? parseInt(String(rule_id), 10) : null
        }
      })
    } catch (silentErr: unknown) { logger.warn("[admin] Non-critical operation failed silently:", { error: errorMessage(silentErr) }) }

    await client.query('COMMIT')
    const eventRow = eventResult.rows[0]
    if (!eventRow) throw new Error('Enforcement event insert returned no row')
    res.json({ message, event: mapEnforcementEvent(eventRow) })
  } catch (_error: unknown) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to apply enforcement action' })
  } finally {
    client.release()
  }
}

router.post('/enforcement/apply', authenticateAdmin, requireSuperAdmin, applyEnforcementHandler)

router.get('/payout-fraud-scores', authenticateAdmin, requireSuperAdmin, async (
  _req: ExpressRequest<Record<string, never>, PayoutFraudScoreDto[] | LegacyErrorResponse>,
  res: ExpressResponse<PayoutFraudScoreDto[] | LegacyErrorResponse>
): Promise<void> => {
  try {
    await ensureFeatureTables()
    const result = await pool.query<PayoutFraudRow>(
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

    const scored: PayoutFraudScoreDto[] = []
    for (const row of result.rows) {
      const openTrades = await pool.query<CountRow>(
        `SELECT COUNT(*)::int AS c FROM trades WHERE account_id = $1 AND status = 'open'`,
        [row.account_id]
      )

      const recentTrades = await pool.query<CountRow>(
        `SELECT COUNT(*)::int AS c
           FROM trades
          WHERE account_id = $1
            AND close_time >= NOW() - INTERVAL '24 hours'`,
        [row.account_id]
      )

      let sharedUsers = 1
      try {
        const lastLoginIp = await pool.query<LoginIpRow>(
          `SELECT ip_address FROM login_logs
            WHERE user_id = $1 AND ip_address IS NOT NULL
            ORDER BY logged_in_at DESC LIMIT 1`,
          [row.user_id]
        )
        const ip = lastLoginIp.rows[0]?.ip_address
        if (ip) {
          const shared = await pool.query<CountRow>(
            `SELECT COUNT(DISTINCT user_id)::int AS c
               FROM login_logs
              WHERE ip_address = $1
                AND logged_in_at >= NOW() - INTERVAL '30 days'`,
            [ip]
          )
          sharedUsers = shared.rows[0]?.c || 1
        }
      } catch (silentErr: unknown) { logger.warn("[admin] Non-critical operation failed silently:", { error: errorMessage(silentErr) }) }

      scored.push(buildPayoutFraudScore(row, {
        openTradeCount: openTrades.rows[0]?.c || 0,
        recentTradeCount: recentTrades.rows[0]?.c || 0,
        sharedUsers
      }))
    }

    scored.sort((a, b) => b.score - a.score)
    res.json(scored)
  } catch (_error: unknown) {
    res.status(500).json({ error: 'Failed to compute payout fraud scores' })
  }
})

router.get('/device-link-graph', authenticateAdmin, requireSuperAdmin, async (
  req: ExpressRequest<Record<string, never>, DeviceGraphResponseDto | LegacyErrorResponse, unknown, Record<string, unknown>>,
  res: ExpressResponse<DeviceGraphResponseDto | LegacyErrorResponse>
): Promise<void> => {
  try {
    await ensureFeatureTables()
    const query = requestRecord(req.query)
    const focusUserId = query.user_id ? String(query.user_id) : null

    const loginRows = await pool.query<LoginGraphRow>(
      `SELECT user_id, ip_address, logged_in_at
         FROM login_logs
        WHERE ip_address IS NOT NULL
          AND logged_in_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_in_at DESC
        LIMIT 3000`
    )
    const tradeRows = await pool.query<TradeGraphRow>(
      `SELECT user_id, account_id, ip_address, logged_at
         FROM trade_logs
        WHERE ip_address IS NOT NULL
          AND logged_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_at DESC
        LIMIT 3000`
    )

    res.json(buildDeviceLinkGraph(loginRows.rows, tradeRows.rows, focusUserId))
  } catch (_error: unknown) {
    res.status(500).json({ error: 'Failed to build device link graph' })
  }
})

router.__test__ = {
  applyEnforcementHandler,
  buildPayoutFraudScore,
  buildDeviceLinkGraph
}

export = router
