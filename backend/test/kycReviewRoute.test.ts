import assert from 'node:assert/strict'
import test from 'node:test'
import router = require('../routes/admin/kycReview')

void test('KYC SLA hours preserve legacy parsing and enforce the 1-to-168-hour bounds', () => {
  assert.equal(router.__test__.normalizeSlaHours(undefined), 24)
  assert.equal(router.__test__.normalizeSlaHours('0'), 1)
  assert.equal(router.__test__.normalizeSlaHours('72legacy'), 72)
  assert.equal(router.__test__.normalizeSlaHours('1000'), 168)
  assert.equal(router.__test__.normalizeSlaHours('invalid'), 24)
})

void test('KYC SLA thresholds preserve warning, overdue, and breach boundaries', () => {
  assert.equal(router.__test__.slaStatusForWait(14.39, 24), 'within_sla')
  assert.equal(router.__test__.slaStatusForWait(14.4, 24), 'warning')
  assert.equal(router.__test__.slaStatusForWait(24, 24), 'overdue')
  assert.equal(router.__test__.slaStatusForWait(48, 24), 'breach')
})

void test('KYC file inspection rejects traversal and preserves encrypted logical extensions', () => {
  assert.deepEqual(router.__test__.inspectRelativeFile('../../outside.jpg.enc'), {
    exists: false,
    size_bytes: 0,
    ext: '.jpg'
  })
  assert.deepEqual(router.__test__.inspectRelativeFile(null), {
    exists: false,
    size_bytes: 0,
    ext: ''
  })
})
