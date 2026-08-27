import type { JsonValue } from '@propfirm/contracts'
import type { Request as ExpressRequest } from 'express'
import type { QueryResult, QueryResultRow } from 'pg'
import pool = require('../db')
import logger = require('./logger')
import { jsonValueSchema, parseExternal } from '../validation/unknown'

interface Queryable {
  query: <Row extends QueryResultRow>(
    sql: string,
    values?: unknown[]
  ) => Promise<QueryResult<Row>>
}

interface PresentRow extends QueryResultRow {
  present: boolean
}

interface ClaimIdRow extends QueryResultRow {
  id: string
}

interface ExistingClaimRow extends QueryResultRow {
  id: string
  status: string
  response_status: number | string | null
  response_body_json: unknown
}

interface IdempotencyOptions {
  scope: unknown
  actorId?: unknown
  idempotencyKey: unknown
}

type BeginIdempotencyResult =
  | { enabled: false }
  | { enabled: false; required: true; error: string }
  | { enabled: true; claimId: string }
  | { enabled: true; replay: true; responseStatus: number; responseBody: JsonValue }
  | { enabled: true; inProgress: true }

interface ReapResult {
  stale: number
  expired: number
}

function isQueryable(value: unknown): value is Queryable {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return typeof (value as Record<string, unknown>).query === 'function'
}

/**
 * How long a claim may sit in 'started' before the reaper treats it as abandoned.
 *
 * A claim goes 'started' → 'completed' inside one request. It can only be left
 * behind if the process died mid-request, and without a reaper that row is
 * permanent: every retry of that Idempotency-Key gets 409 "already being
 * processed", forever. For a withdrawal that means a trader who can never
 * resubmit.
 *
 * Fifteen minutes is far longer than any of these endpoints can legitimately
 * take, so a row this old is dead by definition rather than slow.
 */
const STALE_CLAIM_MS = Math.max(
  60 * 1000,
  parseInt(process.env.IDEMPOTENCY_STALE_CLAIM_MS || '', 10) || 15 * 60 * 1000
)

/**
 * How long a COMPLETED claim is kept for replay detection.
 *
 * Nothing ever deleted these, so the table grew with every payout, trade open
 * and account creation for the life of the deployment. Seven days is well past
 * any client's retry horizon.
 */
const COMPLETED_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  parseInt(process.env.IDEMPOTENCY_RETENTION_MS || '', 10) || 7 * 24 * 60 * 60 * 1000
)

let infrastructureVerified = false

/**
 * Confirm the table exists. It does NOT create it.
 *
 * This used to issue CREATE TABLE / ALTER TABLE / CREATE INDEX from the request
 * path. That is how `idempotency_requests_scope_key_actor_uq` ended up with two
 * competing definitions under one name (see migration 035): whichever of the
 * migration and this DDL ran first won, and the other was silently skipped by
 * IF NOT EXISTS.
 *
 * Migrations are the schema of record (finding C-02), so this now fails loudly
 * and points at them rather than papering over a database that never migrated.
 */
async function ensureIdempotencyInfrastructure(): Promise<void> {
  if (infrastructureVerified) return

  const result = await pool.query<PresentRow>(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'idempotency_requests'
    ) AS present
  `)

  if (!result.rows[0]?.present) {
    throw new Error(
      'idempotency_requests is missing. Replay protection on payouts, trade opens ' +
      'and account creation cannot work without it. Run `npx knex migrate:latest`.'
    )
  }

  infrastructureVerified = true
}

/**
 * Delete abandoned claims and expired completed ones.
 *
 * Run from the scheduler. Returns what it removed so a spike in `stale` is
 * visible — in a healthy system that number is zero, and a non-zero one means
 * requests are dying mid-flight.
 */
async function reapIdempotencyClaims(): Promise<ReapResult> {
  const stale = await pool.query<ClaimIdRow>(
    `DELETE FROM idempotency_requests
      WHERE status = 'started'
        AND created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      RETURNING id`,
    [STALE_CLAIM_MS]
  )

  const expired = await pool.query<ClaimIdRow>(
    `DELETE FROM idempotency_requests
      WHERE status = 'completed'
        AND created_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      RETURNING id`,
    [COMPLETED_RETENTION_MS]
  )

  const staleCount = stale.rowCount ?? 0
  const expiredCount = expired.rowCount ?? 0
  if (staleCount > 0) {
    logger.warn('[idempotency] reaped abandoned claims — requests are dying mid-flight', {
      count: staleCount,
      olderThanMs: STALE_CLAIM_MS
    })
  }

  return { stale: staleCount, expired: expiredCount }
}

function getIdempotencyKey(req: Pick<ExpressRequest, 'headers'>): string | null {
  const rawValue = req.headers['idempotency-key'] || req.headers['Idempotency-Key']
  const normalized = String(rawValue || '').trim()
  return normalized || null
}

// FIX (H-03): scopes where a missing key is an error, not a licence to skip the
// guard. Previously beginIdempotentRequest returned { enabled: false } for any
// request without the header and the handler carried on with no replay
// protection at all. The SPA does send it — but the API is reachable directly,
// and for these three a replay is a duplicate withdrawal, a duplicate position
// or a duplicate account.
//
// Note on affiliate payouts: the SPA sends an 'affiliate-payouts:request' key,
// but routes/affiliates.js never calls this module — so listing that scope here
// would be inert config that reads as protection. It is left out deliberately.
// That endpoint is instead serialised by a pg_advisory_xact_lock plus a
// pending-request check inside its transaction, which covers the concurrent
// duplicate case if not the general retry case. Worth converting to a real
// idempotency claim, but that is a change to an endpoint outside this fix.
const STRICT_SCOPES = new Set([
  'trades:open',
  'payouts:request',
  'accounts:create'
])

function isStrictScope(scope: unknown): boolean {
  return STRICT_SCOPES.has(String(scope || ''))
}

async function beginIdempotentRequest(clientOrPool: unknown, {
  scope,
  actorId = null,
  idempotencyKey
}: IdempotencyOptions): Promise<BeginIdempotencyResult> {
  const db = isQueryable(clientOrPool) ? clientOrPool : pool
  const key = String(idempotencyKey || '').trim()
  if (!key) {
    // Money scopes fail closed; everything else keeps the old opt-in behaviour.
    if (isStrictScope(scope)) {
      return {
        enabled: false,
        required: true,
        error: 'An Idempotency-Key header is required for this request.'
      }
    }
    return { enabled: false }
  }

  const normalizedActorId = actorId == null ? null : String(actorId)

  // Claim first, ask questions second.
  //
  // This was SELECT-then-INSERT, which is not atomic: two concurrent requests
  // carrying the same key both missed the SELECT, both INSERTed, and the second
  // hit the unique index. That surfaced as a 500 rather than the 409 the caller
  // is written to handle — on a withdrawal endpoint, where a 500 is exactly what
  // makes a client retry.
  //
  // ON CONFLICT DO NOTHING makes winning the claim a single atomic step. The
  // conflict target must match migration 035's expression index exactly.
  const inserted = await db.query<ClaimIdRow>(
    `INSERT INTO idempotency_requests (
       actor_id, scope, idempotency_key, status
     ) VALUES (
       $1, $2, $3, 'started'
     )
     ON CONFLICT (scope, idempotency_key, COALESCE(actor_id, '')) DO NOTHING
     RETURNING id`,
    [normalizedActorId, String(scope), key]
  )

  if (inserted.rows.length > 0) {
    const insertedRow = inserted.rows[0]
    if (!insertedRow) throw new Error('Idempotency claim insert returned no row')
    return {
      enabled: true,
      claimId: insertedRow.id
    }
  }

  // Someone else holds the claim — either finished (replay it) or in flight.
  const existing = await db.query<ExistingClaimRow>(
    `SELECT id, status, response_status, response_body_json
       FROM idempotency_requests
      WHERE scope = $1
        AND idempotency_key = $2
        AND COALESCE(actor_id, '') = COALESCE($3::text, '')
      LIMIT 1`,
    [String(scope), key, normalizedActorId]
  )

  const row = existing.rows[0]
  if (row && row.status === 'completed') {
    return {
      enabled: true,
      replay: true,
      responseStatus: parseInt(String(row.response_status || 200), 10),
      responseBody: parseExternal(
        jsonValueSchema,
        row.response_body_json || {},
        'idempotency response JSON'
      )
    }
  }

  // Includes the case where the row vanished between the two statements (the
  // reaper, or a concurrent rollback). Reporting in-progress is the safe answer:
  // it asks the caller to retry rather than letting a second withdrawal through.
  return {
    enabled: true,
    inProgress: true
  }
}

async function completeIdempotentRequest(
  clientOrPool: unknown,
  claimId: unknown,
  responseStatus: unknown,
  responseBody: unknown
): Promise<void> {
  if (!claimId) return
  const db = isQueryable(clientOrPool) ? clientOrPool : pool
  const validatedResponse = parseExternal(
    jsonValueSchema,
    responseBody || {},
    'idempotency response JSON'
  )
  await db.query(
    `UPDATE idempotency_requests
        SET status = 'completed',
            response_status = $2,
            response_body_json = $3::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [claimId, parseInt(String(responseStatus || 200), 10), JSON.stringify(validatedResponse)]
  )
}

async function abandonIdempotentRequest(clientOrPool: unknown, claimId: unknown): Promise<void> {
  if (!claimId) return
  const db = isQueryable(clientOrPool) ? clientOrPool : pool
  await db.query(`DELETE FROM idempotency_requests WHERE id = $1`, [claimId])
}

export {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  ensureIdempotencyInfrastructure,
  getIdempotencyKey,
  isStrictScope,
  reapIdempotencyClaims,
  COMPLETED_RETENTION_MS,
  STALE_CLAIM_MS,
  STRICT_SCOPES
}
