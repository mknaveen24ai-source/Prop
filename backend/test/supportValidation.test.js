const test = require('node:test')
const assert = require('node:assert/strict')

const {
  normalizeSupportCategory,
  normalizeSupportReplyPayload,
  normalizeSupportTicketPayload
} = require('../utils/supportValidation')

test('support ticket payload is sanitized and length-limited', () => {
  const payload = normalizeSupportTicketPayload({
    category: 'trading',
    subject: `<script>alert('x')</script>${'a'.repeat(200)}`,
    message: `<img src=x onerror=alert(1)>${'b'.repeat(5000)}`,
    email: 'Trader@Example.COM',
    name: `<b>Trader</b>`
  })

  assert.deepEqual(payload.errors, [])
  assert.equal(payload.value.category, 'trading')
  assert.equal(payload.value.email, 'trader@example.com')
  assert.equal(payload.value.subject.includes('<script>'), false)
  assert.equal(payload.value.message.includes('<img'), false)
  assert.equal(payload.value.name.includes('<b>'), false)
  assert.equal(payload.value.subject.length <= 160, true)
  assert.equal(payload.value.message.length <= 4000, true)
})

test('support ticket payload rejects invalid optional email and defaults bad category', () => {
  const payload = normalizeSupportTicketPayload({
    category: 'hacked',
    subject: 'Need help',
    message: 'Please help me with my account.',
    email: 'not-an-email'
  })

  assert.equal(payload.value.category, 'other')
  assert.deepEqual(payload.errors, ['Email must be valid'])
})

test('support reply payload sanitizes html and requires message', () => {
  const clean = normalizeSupportReplyPayload({ message: '<script>alert(1)</script>' })
  assert.deepEqual(clean.errors, [])
  assert.equal(clean.value.message.includes('<script>'), false)

  const empty = normalizeSupportReplyPayload({ message: '' })
  assert.deepEqual(empty.errors, ['Reply message is required'])
})

test('support categories are allowlisted', () => {
  assert.equal(normalizeSupportCategory('kyc'), 'kyc')
  assert.equal(normalizeSupportCategory('PAYOUT'), 'payout')
  assert.equal(normalizeSupportCategory('anything-else'), 'other')
})
