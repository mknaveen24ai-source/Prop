import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAllowedAccountLinkActions,
  mapAccountLinkCluster
} from '../routes/admin/shared/accountLinkList'

const row = {
  id: '21',
  cluster_key: 'cluster-key',
  score: 88,
  confidence: 'high',
  member_user_ids: ['user-1', 'user-2'],
  member_count: 2,
  signal_types: ['device'],
  signal_summary: { device: 2 },
  status: 'open',
  first_detected_at: new Date('2026-08-26T00:00:00.000Z'),
  last_detected_at: '2026-08-27T00:00:00.000Z',
  resolved_at: null,
  resolved_by: null,
  resolution_note: null,
  member_emails: ['a@example.com', 'b@example.com'],
  member_names: ['A', 'B'],
  evidence_count: '3'
}

void test('account-link clusters validate JSON and map IDs, counts, and timestamps explicitly', () => {
  const mapped = mapAccountLinkCluster(row)
  assert.equal(mapped.id, '21')
  assert.equal(mapped.evidence_count, 3)
  assert.equal(mapped.first_detected_at, '2026-08-26T00:00:00.000Z')
  assert.deepEqual(mapped.signal_summary, { device: 2 })
})

void test('account-link actions preserve open and resolved behavior', () => {
  assert.deepEqual(buildAllowedAccountLinkActions({ status: 'open' }), [
    'view_evidence',
    'view_graph',
    'confirm_sharing',
    'mark_false_positive',
    'mark_monitoring'
  ])
  assert.deepEqual(buildAllowedAccountLinkActions({ status: 'confirmed_sharing' }), [
    'view_evidence',
    'view_graph',
    'reopen_cluster'
  ])
})

void test('account-link signal-summary validation rejects non-JSON database values', () => {
  assert.throws(
    () => mapAccountLinkCluster({ ...row, signal_summary: undefined }),
    /Invalid account_link_clusters\.signal_summary/
  )
})
