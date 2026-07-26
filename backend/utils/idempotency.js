const pool = require('../db')

let idempotencyInfrastructurePromise = null

async function ensureIdempotencyInfrastructure() {
  if (idempotencyInfrastructurePromise) return idempotencyInfrastructurePromise

  idempotencyInfrastructurePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS idempotency_requests (
        id BIGSERIAL PRIMARY KEY,
        actor_id TEXT,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'started',
        response_status INTEGER,
        response_body_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS actor_id TEXT`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS scope TEXT`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS idempotency_key TEXT`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'started'`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS response_status INTEGER`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS response_body_json JSONB NOT NULL DEFAULT '{}'::jsonb`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    await pool.query(`ALTER TABLE idempotency_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idempotency_requests_created_idx
        ON idempotency_requests(created_at DESC)
    `)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idempotency_requests_scope_idx
        ON idempotency_requests(scope, created_at DESC)
    `)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idempotency_requests_scope_key_actor_uq
        ON idempotency_requests(
          scope,
          idempotency_key,
          COALESCE(actor_id, '')
        )
    `)
  })().catch((error) => {
    idempotencyInfrastructurePromise = null
    throw error
  })

  return idempotencyInfrastructurePromise
}

function getIdempotencyKey(req) {
  const rawValue = req.headers['idempotency-key'] || req.headers['Idempotency-Key']
  const normalized = String(rawValue || '').trim()
  return normalized || null
}

async function beginIdempotentRequest(clientOrPool, {
  scope,
  actorId = null,
  idempotencyKey
}) {
  await ensureIdempotencyInfrastructure()
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  const key = String(idempotencyKey || '').trim()
  if (!key) {
    return { enabled: false }
  }

  const normalizedActorId = actorId == null ? null : String(actorId)
  const existing = await db.query(
    `SELECT id, status, response_status, response_body_json
       FROM idempotency_requests
      WHERE scope = $1
        AND idempotency_key = $2
        AND COALESCE(actor_id, '') = COALESCE($3::text, '')
      LIMIT 1`,
    [String(scope), key, normalizedActorId]
  )

  if (existing.rows.length > 0) {
    const row = existing.rows[0]
    if (row.status === 'completed') {
      return {
        enabled: true,
        replay: true,
        responseStatus: parseInt(row.response_status || 200, 10),
        responseBody: row.response_body_json || {}
      }
    }
    return {
      enabled: true,
      inProgress: true
    }
  }

  const inserted = await db.query(
    `INSERT INTO idempotency_requests (
       actor_id, scope, idempotency_key, status
     ) VALUES (
       $1, $2, $3, 'started'
     )
     RETURNING id`,
    [normalizedActorId, String(scope), key]
  )

  return {
    enabled: true,
    claimId: inserted.rows[0].id
  }
}

async function completeIdempotentRequest(clientOrPool, claimId, responseStatus, responseBody) {
  if (!claimId) return
  await ensureIdempotencyInfrastructure()
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  await db.query(
    `UPDATE idempotency_requests
        SET status = 'completed',
            response_status = $2,
            response_body_json = $3::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [claimId, parseInt(responseStatus || 200, 10), JSON.stringify(responseBody || {})]
  )
}

async function abandonIdempotentRequest(clientOrPool, claimId) {
  if (!claimId) return
  await ensureIdempotencyInfrastructure()
  const db = clientOrPool && typeof clientOrPool.query === 'function' ? clientOrPool : pool
  await db.query(`DELETE FROM idempotency_requests WHERE id = $1`, [claimId])
}

module.exports = {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  ensureIdempotencyInfrastructure,
  getIdempotencyKey
}
