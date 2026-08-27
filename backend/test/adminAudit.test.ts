import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAdminActorPayload,
  buildAuditHash,
  getAdminActorLabel,
  normalizeAuditPayload
} from '../routes/admin/shared/audit'

void test('admin actor helpers preserve fallback labels and nullable payload fields', () => {
  assert.equal(getAdminActorLabel({ role: 'risk_admin', email: 'risk@example.com' }), 'risk_admin:risk@example.com')
  assert.equal(getAdminActorLabel(undefined), 'admin:unknown')
  assert.deepEqual(buildAdminActorPayload({ adminId: 'admin-1', role: 'super_admin' }), {
    admin_id: 'admin-1',
    role: 'super_admin',
    email: null,
    full_name: null
  })
})

void test('audit payload normalization is deterministic and survives circular input', () => {
  assert.equal(normalizeAuditPayload({ b: 2, a: 1 }), '{"b":2,"a":1}')
  const circular: { self?: unknown } = {}
  circular.self = circular
  assert.equal(normalizeAuditPayload(circular), '{}')
})

void test('audit hashes preserve the exact chained field ordering', () => {
  const input = {
    prevHash: 'prev',
    eventType: 'account_locked',
    entityType: 'account',
    entityId: 'account-1',
    payloadText: '{"reason":"risk"}',
    createdAt: '2026-08-27T00:00:00.000Z'
  }
  assert.equal(buildAuditHash(input), buildAuditHash(input))
  assert.notEqual(buildAuditHash(input), buildAuditHash({ ...input, entityId: 'account-2' }))
})
