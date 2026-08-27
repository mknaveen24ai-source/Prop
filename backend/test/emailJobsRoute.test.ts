import assert from 'node:assert/strict'
import test from 'node:test'
import router = require('../routes/admin/emailJobs')

void test('email-job list query preserves current paging, defaults, and filters', () => {
  assert.deepEqual(router.__test__.buildEmailJobsListQuery({ status: 'failed' }, { page: 2, pageSize: 50 }), {
    page: 2,
    pageSize: 50,
    search: '',
    sort: 'created_at',
    order: 'desc',
    filters: {
      status: 'failed',
      template_key: null,
      delivery_type: null
    }
  })
})

void test('email-job identifiers preserve the legacy parseInt behavior while rejecting invalid ids', () => {
  assert.equal(router.__test__.parseEmailJobId('42'), 42)
  assert.equal(router.__test__.parseEmailJobId('42legacy'), 42)
  assert.equal(router.__test__.parseEmailJobId('0'), null)
  assert.equal(router.__test__.parseEmailJobId('invalid'), null)
  assert.equal(router.__test__.parseEmailJobId(42), null)
})

void test('only existing retryable email-job statuses can be re-queued', () => {
  for (const status of ['retry', 'dead', 'failed', 'FAILED']) {
    assert.equal(router.__test__.isRetryableEmailJobStatus(status), true)
  }
  for (const status of ['pending', 'sending', 'sent', null]) {
    assert.equal(router.__test__.isRetryableEmailJobStatus(status), false)
  }
})
