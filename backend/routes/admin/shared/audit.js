// Admin actor labelling and the hash-chained immutable audit log, moved
// verbatim from routes/admin.js during the admin modularization.
const crypto = require('crypto')
const { ensureFeatureTables } = require('./schema')

function getAdminActorLabel(admin) {
  const role = String(admin?.role || 'admin')
  const identity = admin?.email || admin?.full_name || admin?.adminId || 'unknown'
  return `${role}:${identity}`
}

function buildAdminActorPayload(admin) {
  return {
    admin_id: admin?.adminId || null,
    role: admin?.role || null,
    email: admin?.email || null,
    full_name: admin?.full_name || null
  }
}
function normalizeAuditPayload(payload) {
  try {
    return JSON.stringify(payload || {})
  } catch {
    return '{}'
  }
}

function buildAuditHash({ prevHash, eventType, entityType, entityId, payloadText, createdAt }) {
  const base = [
    String(prevHash || 'GENESIS'),
    String(eventType || ''),
    String(entityType || ''),
    String(entityId || ''),
    String(payloadText || '{}'),
    String(createdAt || '')
  ].join('|')
  return crypto.createHash('sha256').update(base).digest('hex')
}

async function appendImmutableAudit(db, { eventType, entityType = '', entityId = '', actor = 'admin', payload = {} }) {
  await ensureFeatureTables()
  const payloadText = normalizeAuditPayload(payload)
  const prevResult = await db.query(`SELECT entry_hash FROM admin_immutable_audit ORDER BY id DESC LIMIT 1`)
  const prevHash = prevResult.rows[0]?.entry_hash || 'GENESIS'
  const createdAt = new Date().toISOString()
  const entryHash = buildAuditHash({ prevHash, eventType, entityType, entityId, payloadText, createdAt })
  const ins = await db.query(
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
  return ins.rows[0]
}

module.exports = {
  getAdminActorLabel,
  buildAdminActorPayload,
  normalizeAuditPayload,
  buildAuditHash,
  appendImmutableAudit
}
