import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAllowedEmailJobActions, mapEmailJob } from '../routes/admin/shared/emailJobList'

const row = {
  id: '11',
  user_id: 'user-1',
  to_email: 'trader@example.com',
  template_key: 'welcome',
  payload_json: { fullName: 'Trader' },
  status: 'failed',
  attempt_count: '2',
  last_error: 'timeout',
  provider_message_id: null,
  preview_url: '/preview/11',
  unique_key: null,
  scheduled_for: new Date('2026-08-27T00:00:00.000Z'),
  last_attempt_at: null,
  sent_at: null,
  created_at: '2026-08-26T00:00:00.000Z',
  updated_at: new Date('2026-08-27T01:00:00.000Z'),
  full_name_hint: 'Trader',
  delivery_type: 'transactional' as const
}

void test('email-job rows validate JSON and map IDs and timestamps explicitly', () => {
  const mapped = mapEmailJob(row)
  assert.equal(mapped.id, '11')
  assert.equal(mapped.attempt_count, 2)
  assert.equal(mapped.scheduled_for, '2026-08-27T00:00:00.000Z')
  assert.equal(mapped.updated_at, '2026-08-27T01:00:00.000Z')
  assert.deepEqual(mapped.payload_json, { fullName: 'Trader' })
})

void test('email-job actions preserve retry and preview behavior', () => {
  assert.deepEqual(buildAllowedEmailJobActions(row), [
    'preview_email_job',
    'retry_email_job',
    'copy_preview_path'
  ])
  assert.deepEqual(buildAllowedEmailJobActions({ status: 'sent', preview_url: null }), [
    'preview_email_job'
  ])
})

void test('email-job JSONB validation rejects non-JSON database values', () => {
  assert.throws(() => mapEmailJob({ ...row, payload_json: undefined }), /Invalid email_jobs\.payload_json/)
})
