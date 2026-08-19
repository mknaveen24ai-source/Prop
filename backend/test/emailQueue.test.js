const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildEmailMessage,
  isSupportedEmailTemplate,
  resolveMailTransportConfig,
  __resetMailTransporterForTests
} = require('../mailer')
const { __test__ } = require('../utils/emailQueue')

test.afterEach(() => {
  delete process.env.SMTP_HOST
  delete process.env.SMTP_PORT
  delete process.env.SMTP_USER
  delete process.env.SMTP_PASS
  delete process.env.SMTP_FROM
  delete process.env.SENDGRID_API_KEY
  __resetMailTransporterForTests()
})

test('email templates expose supported queue keys', () => {
  assert.equal(isSupportedEmailTemplate('password_reset'), true)
  assert.equal(isSupportedEmailTemplate('welcome_onboarding'), true)
  assert.equal(isSupportedEmailTemplate('challenge_expiry_reminder'), true)
  assert.equal(isSupportedEmailTemplate('challenge_inactivity_reminder'), true)
  assert.equal(isSupportedEmailTemplate('kyc_pending_reminder'), true)
  assert.equal(isSupportedEmailTemplate('payout_requested'), true)
  assert.equal(isSupportedEmailTemplate('phase_passed'), true)
  assert.equal(isSupportedEmailTemplate('unknown_template'), false)
})

test('buildEmailMessage composes password reset email payload', async () => {
  const message = await buildEmailMessage('password_reset', {
    toEmail: 'trader@example.com',
    resetLink: 'https://example.com/reset',
    resetToken: 'ABC123'
  })

  assert.equal(message.to, 'trader@example.com')
  assert.match(message.subject, /Password Reset Request/)
  assert.match(message.text, /ABC123/)
})

test('buildEmailMessage composes onboarding email payload', async () => {
  const message = await buildEmailMessage('welcome_onboarding', {
    toEmail: 'trader@example.com',
    fullName: 'Example Trader',
    traderUid: 'uid-123',
    affiliateCode: 'AFF123'
  })

  assert.equal(message.to, 'trader@example.com')
  assert.match(message.subject, /Welcome/)
  assert.match(message.html, /uid-123/)
  assert.match(message.html, /AFF123/)
})

test('buildEmailMessage composes payout requested email payload', async () => {
  const message = await buildEmailMessage('payout_requested', {
    toEmail: 'trader@example.com',
    fullName: 'Example Trader',
    amountRequested: 125,
    amountPayable: 100,
    paymentMethod: 'Crypto'
  })

  assert.equal(message.to, 'trader@example.com')
  assert.match(message.subject, /Payout Request Received/)
  assert.match(message.text, /\$125\.00/)
  assert.match(message.text, /\$100\.00/)
})

test('buildEmailMessage composes challenge expiry reminder payload', async () => {
  const message = await buildEmailMessage('challenge_expiry_reminder', {
    toEmail: 'trader@example.com',
    fullName: 'Example Trader',
    accountType: 'phase1',
    accountSize: 10000,
    daysRemaining: 3,
    phaseEndDate: '2026-05-09T23:59:59.000Z'
  })

  assert.equal(message.to, 'trader@example.com')
  assert.match(message.subject, /3 Day/)
  assert.match(message.text, /phase1/i)
})

test('buildEmailMessage composes challenge inactivity reminder payload', async () => {
  const message = await buildEmailMessage('challenge_inactivity_reminder', {
    toEmail: 'trader@example.com',
    fullName: 'Example Trader',
    accountType: 'phase2',
    accountSize: 5000,
    inactivityFailDays: 30,
    daysUntilFail: 7,
    lastActivityAt: '2026-05-01T00:00:00.000Z'
  })

  assert.equal(message.to, 'trader@example.com')
  assert.match(message.subject, /Inactivity Warning/)
  assert.match(message.text, /7 day/)
})

test('email queue retry schedule escalates then stops retrying', () => {
  assert.equal(__test__.computeRetryDelayMs(1), 60_000)
  assert.equal(__test__.computeRetryDelayMs(2), 5 * 60_000)
  assert.equal(__test__.computeRetryDelayMs(3), 15 * 60_000)
  assert.equal(__test__.computeRetryDelayMs(4), 60 * 60_000)
  assert.equal(__test__.computeRetryDelayMs(5), null)
})

test('email automation unique period keys use UTC date format', () => {
  assert.equal(__test__.buildUtcDateKey(new Date('2026-05-06T12:34:56.000Z')), '2026-05-06')
})

test('challenge expiry helper rounds up whole days remaining', () => {
  const now = new Date('2026-05-06T00:00:00.000Z')
  const endDate = new Date('2026-05-08T12:00:00.000Z')
  assert.equal(__test__.clampWholeDaysRemaining(endDate, now), 3)
})

test('resolveMailTransportConfig detects Brevo SMTP settings', () => {
  process.env.SMTP_HOST = 'smtp-relay.brevo.com'
  process.env.SMTP_PORT = '587'
  process.env.SMTP_USER = 'smtp-user'
  process.env.SMTP_PASS = 'smtp-pass'
  process.env.SMTP_FROM = 'support@example.com'

  const config = resolveMailTransportConfig()

  assert.equal(config.mode, 'smtp')
  assert.equal(config.provider, 'brevo')
  assert.equal(config.usesBrevo, true)
  assert.equal(config.host, 'smtp-relay.brevo.com')
  assert.equal(config.fromEmail, 'support@example.com')
})

test('resolveMailTransportConfig falls back to preview without SMTP or SendGrid', () => {
  const config = resolveMailTransportConfig()

  assert.equal(config.mode, 'preview')
  assert.equal(config.provider, 'local_preview')
  assert.equal(config.usesBrevo, false)
})
