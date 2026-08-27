import type { JsonValue } from '@propfirm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import pool = require('../db')
import logger = require('../utils/logger')
import { emitAdminEvent } from '../utils/realtime'
import { jsonValueSchema, parseExternal, parseUnknownJson } from '../validation/unknown'

type Queryable = Pick<Pool | PoolClient, 'query'>

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

interface ViolationRow extends QueryResultRow {
  id: string
  violation_key: string
  violation_type: string
  severity: string
  status: string
  account_id: string | null
  user_id: string | null
  trade_id: string | null
  instrument: string | null
  source: string
  message: string
  payload_json: unknown
}

interface AccountEnforcementRow extends QueryResultRow {
  id: string
  user_id: string
  status: string
  review_flagged: boolean
  review_flag_reason: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isQueryable(value: unknown): value is Queryable {
  return isRecord(value) && typeof value.query === 'function'
}

function normalizedPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function socketJson(value: unknown, label: string): JsonValue {
  return parseExternal(
    jsonValueSchema,
    parseUnknownJson(JSON.stringify(value)),
    label
  )
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

let _violationTablesReady = false

function normalizeKeyPart(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
}

function buildViolationKey(parts: unknown): string {
  const ordered = Array.isArray(parts) ? parts : []
  return ordered.map(normalizeKeyPart).join('|')
}

async function ensureViolationTables(): Promise<void> {
  if (_violationTablesReady) return

  await (async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_rules (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 100,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_rules_enabled_priority
      ON admin_rules(enabled, priority ASC)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_rule_violations (
      id BIGSERIAL PRIMARY KEY,
      violation_key TEXT NOT NULL UNIQUE,
      violation_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      account_id TEXT,
      user_id TEXT,
      trade_id TEXT,
      instrument TEXT,
      source TEXT NOT NULL DEFAULT 'system',
      message TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      hit_count INTEGER NOT NULL DEFAULT 1,
      first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      resolution_note TEXT,
      resolution_type TEXT NOT NULL DEFAULT 'resolved'
    )
  `)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS violation_key TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS violation_type TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium'`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS account_id TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS user_id TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS trade_id TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS instrument TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'system'`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS message TEXT NOT NULL DEFAULT ''`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 1`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS first_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS last_detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS resolution_note TEXT`)
  await pool.query(`ALTER TABLE admin_rule_violations ADD COLUMN IF NOT EXISTS resolution_type TEXT NOT NULL DEFAULT 'resolved'`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS admin_rule_violations_violation_key_uq
      ON admin_rule_violations(violation_key)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_rule_violations_status_detected
      ON admin_rule_violations(status, last_detected_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_rule_violations_account_type
      ON admin_rule_violations(account_id, violation_type, last_detected_at DESC)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_enforcement_events (
      id BIGSERIAL PRIMARY KEY,
      rule_id BIGINT REFERENCES admin_rules(id) ON DELETE SET NULL,
      account_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'applied',
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS account_id TEXT`)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS user_id TEXT`)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS action TEXT`)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS payload_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied'`)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS message TEXT`)
  await pool.query(`ALTER TABLE admin_enforcement_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_admin_enforcement_events_created
      ON admin_enforcement_events(created_at DESC)
  `)

  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flag_reason TEXT`)

  _violationTablesReady = true
  })()
}

async function recordEnforcementEvent(
  clientOrPayload: Queryable | Record<string, unknown>,
  maybePayload?: Record<string, unknown>
): Promise<EnforcementEventRow | null> {
  const usingClient = !!maybePayload
  const client = usingClient && isQueryable(clientOrPayload) ? clientOrPayload : pool
  const payload = normalizedPayload(usingClient ? maybePayload : clientOrPayload)
  await ensureViolationTables()

  const parsedRuleId = parseInt(String(payload.ruleId ?? ''), 10)
  const result = await client.query<EnforcementEventRow>(
    `INSERT INTO admin_enforcement_events (rule_id, account_id, user_id, action, payload_json, status, message)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING *`,
    [
      Number.isFinite(parsedRuleId) ? parsedRuleId : null,
      payload.accountId ? String(payload.accountId) : null,
      payload.userId ? String(payload.userId) : null,
      String(payload.action || 'unknown_action'),
      JSON.stringify(payload.payload || {}),
      String(payload.status || 'applied'),
      String(payload.message || '')
    ]
  )
  // `RETURNING *` on a plain INSERT cannot come back empty against a real
  // Postgres, so an empty result means the query layer is not what we think it
  // is (a mocked pool, a row-suppressing trigger). Degrade instead of throwing:
  // the callers below are audit-trail writers wrapped in safeRecord* helpers,
  // and a raised TypeError here only buries the actual cause.
  const event = result.rows[0]
  if (!event) {
    logger.warn('[violation-engine] Enforcement event insert returned no row; skipping admin broadcast', {
      action: String(payload.action || 'unknown_action'),
      accountId: payload.accountId ? String(payload.accountId) : null
    })
    return null
  }
  emitAdminEvent('admin_enforcement_event', socketJson(event, 'admin enforcement event row'))
  emitAdminEvent('admin_alert', {
    type: 'violation',
    event: 'enforcement_applied',
    account_id: event.account_id,
    user_id: event.user_id,
    action: event.action
  })
  return event
}

async function recordViolation(input: unknown): Promise<ViolationRow | null> {
  await ensureViolationTables()

  const payload = normalizedPayload(input)
  const violationKey = buildViolationKey([
    payload.dedupeKey || payload.violationType,
    payload.accountId,
    payload.userId,
    payload.tradeId,
    payload.instrument
  ])

  const result = await pool.query<ViolationRow>(
    `INSERT INTO admin_rule_violations (
       violation_key, violation_type, severity, status, account_id, user_id,
       trade_id, instrument, source, message, payload_json
     )
     VALUES ($1, $2, $3, 'open', $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (violation_key) DO UPDATE
       SET severity = EXCLUDED.severity,
           status = 'open',
           source = EXCLUDED.source,
           message = EXCLUDED.message,
           payload_json = EXCLUDED.payload_json,
           hit_count = admin_rule_violations.hit_count + 1,
           last_detected_at = NOW(),
           resolved_at = NULL,
           resolution_note = NULL,
           -- BUG-03 FIX: Keep the original resolution_type on re-detection.
           -- Previously this was set to 'resolved' even when re-opening a violation,
           -- corrupting the audit trail (resolution_type describes HOW it was resolved).
           resolution_type = admin_rule_violations.resolution_type
     RETURNING *`,
    [
      violationKey,
      String(payload.violationType || 'unknown_violation'),
      String(payload.severity || 'medium'),
      payload.accountId ? String(payload.accountId) : null,
      payload.userId ? String(payload.userId) : null,
      payload.tradeId ? String(payload.tradeId) : null,
      payload.instrument ? String(payload.instrument) : null,
      String(payload.source || 'system'),
      String(payload.message || ''),
      JSON.stringify(payload.payload || {})
    ]
  )

  // See recordEnforcementEvent — the ON CONFLICT DO UPDATE has no WHERE, so
  // this always returns a row in production. Guarded for the same reason.
  const violation = result.rows[0]
  if (!violation) {
    logger.warn('[violation-engine] Violation insert returned no row; skipping admin broadcast', {
      violationType: String(payload.violationType || 'unknown_violation'),
      accountId: payload.accountId ? String(payload.accountId) : null
    })
    return null
  }
  emitAdminEvent('admin_violation_updated', socketJson(violation, 'admin violation row'))
  emitAdminEvent('admin_alert', {
    type: 'violation',
    event: 'violation_recorded',
    account_id: violation.account_id,
    user_id: violation.user_id,
    violation_type: violation.violation_type,
    severity: violation.severity,
    status: violation.status
  })

  return violation
}

async function applyAccountEnforcement(input: unknown): Promise<EnforcementEventRow | null> {
  const payload = normalizedPayload(input)
  await ensureViolationTables()
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const accountResult = await client.query<AccountEnforcementRow>(
      `SELECT id, user_id, status, review_flagged, review_flag_reason
         FROM accounts
        WHERE id = $1
        FOR UPDATE`,
      [String(payload.accountId)]
    )

    const account = accountResult.rows[0]
    if (!account) {
      throw new Error('Account not found')
    }

    const action = String(payload.action || '')
    const reason = String(payload.reason || '')
    let message = ''

    if (action === 'lock_account') {
      await client.query(
        `UPDATE accounts
            SET status = CASE WHEN status = 'active' THEN 'locked' ELSE status END,
                review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, reason || 'Locked by automation']
      )
      message = 'Account locked by automation'
    } else if (action === 'flag_for_review') {
      const mergedReason = account.review_flag_reason
        ? `${account.review_flag_reason} | ${reason || 'Flagged by automation'}`
        : (reason || 'Flagged by automation')

      await client.query(
        `UPDATE accounts
            SET review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, mergedReason]
      )
      message = 'Account flagged for review by automation'
    } else {
      throw new Error(`Unsupported enforcement action: ${action}`)
    }

    const event = await recordEnforcementEvent(client, {
      ruleId: payload.ruleId,
      accountId: account.id,
      userId: account.user_id,
      action,
      status: 'applied',
      message,
      payload: payload.payload || {}
    })

    await client.query('COMMIT')
    return event
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('[violation-engine] Enforcement failed:', { error: errorMessage(error), accountId: payload.accountId, action: payload.action })
    throw error
  } finally {
    client.release()
  }
}

const violationEngine = {
  applyAccountEnforcement,
  buildViolationKey,
  ensureViolationTables,
  recordEnforcementEvent,
  recordViolation
}

export = violationEngine
