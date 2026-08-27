// Admin actor labelling and the hash-chained immutable audit log.

import nodeCrypto from 'node:crypto'
import type { QueryResult, QueryResultRow } from 'pg'

interface SchemaApi {
  ensureFeatureTables: () => Promise<void>
}

interface Queryable {
  query: <Row extends QueryResultRow>(
    sql: string,
    values?: unknown[]
  ) => Promise<QueryResult<Row>>
}

interface AdminActor {
  adminId?: string | null
  role?: string | null
  email?: string | null
  full_name?: string | null
}

interface AdminActorPayload {
  admin_id: string | null
  role: string | null
  email: string | null
  full_name: string | null
}

interface AuditHashInput {
  prevHash: unknown
  eventType: unknown
  entityType: unknown
  entityId: unknown
  payloadText: unknown
  createdAt: unknown
}

interface AppendAuditInput {
  eventType: unknown
  entityType?: unknown
  entityId?: unknown
  actor?: unknown
  payload?: unknown
}

interface PreviousAuditRow extends QueryResultRow {
  entry_hash: string
}

const { ensureFeatureTables } = require('./schema') as SchemaApi

function getAdminActorLabel(admin: AdminActor | null | undefined): string {
  const role = String(admin?.role || 'admin')
  const identity = admin?.email || admin?.full_name || admin?.adminId || 'unknown'
  return `${role}:${identity}`
}

function buildAdminActorPayload(admin: AdminActor | null | undefined): AdminActorPayload {
  return {
    admin_id: admin?.adminId || null,
    role: admin?.role || null,
    email: admin?.email || null,
    full_name: admin?.full_name || null
  }
}

function normalizeAuditPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload || {})
  } catch (_error: unknown) {
    return '{}'
  }
}

function buildAuditHash({
  prevHash,
  eventType,
  entityType,
  entityId,
  payloadText,
  createdAt
}: AuditHashInput): string {
  const base = [
    String(prevHash || 'GENESIS'),
    String(eventType || ''),
    String(entityType || ''),
    String(entityId || ''),
    String(payloadText || '{}'),
    String(createdAt || '')
  ].join('|')
  return nodeCrypto.createHash('sha256').update(base).digest('hex')
}

async function appendImmutableAudit(
  db: Queryable,
  {
    eventType,
    entityType = '',
    entityId = '',
    actor = 'admin',
    payload = {}
  }: AppendAuditInput
): Promise<QueryResultRow | undefined> {
  await ensureFeatureTables()
  const payloadText = normalizeAuditPayload(payload)
  const previous = await db.query<PreviousAuditRow>(
    'SELECT entry_hash FROM admin_immutable_audit ORDER BY id DESC LIMIT 1'
  )
  const prevHash = previous.rows[0]?.entry_hash || 'GENESIS'
  const createdAt = new Date().toISOString()
  const entryHash = buildAuditHash({
    prevHash,
    eventType,
    entityType,
    entityId,
    payloadText,
    createdAt
  })
  const inserted = await db.query(
    `INSERT INTO admin_immutable_audit
      (event_type, entity_type, entity_id, actor, payload_json, payload_text, prev_hash, entry_hash, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz)
     RETURNING *`,
    [
      String(eventType || 'event'),
      String(entityType || ''),
      String(entityId || ''),
      String(actor || 'admin'),
      payloadText,
      payloadText,
      prevHash,
      entryHash,
      createdAt
    ]
  )
  return inserted.rows[0]
}

export {
  appendImmutableAudit,
  buildAdminActorPayload,
  buildAuditHash,
  getAdminActorLabel,
  normalizeAuditPayload
}
