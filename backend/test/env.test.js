const test = require('node:test')
const assert = require('node:assert/strict')

const { getUnsafeProductionEnvVars, isUnsafeTrustProxy } = require('../env')

function withEnv(overrides, fn) {
  const previous = {}
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key]
    if (overrides[key] === undefined) delete process.env[key]
    else process.env[key] = overrides[key]
  }
  try {
    fn()
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

test('production env safety flags weak/default secrets', () => {
  withEnv({
    JWT_SECRET: 'your-secret-key-min-32-characters-long-generate-random',
    ADMIN_JWT_SECRET: 'short',
    TOTP_ENCRYPTION_KEY: 'not-hex',
    KYC_FILE_ENCRYPTION_KEY: 'your-kyc-key',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/propfirm',
    SMTP_USER: 'a68d12001@smtp-brevo.com',
    SMTP_FROM: 'a68d12001@smtp-brevo.com',
    TRUST_PROXY: 'false',
    ADMIN_PASSWORD: 'password'
  }, () => {
    const unsafe = getUnsafeProductionEnvVars()
    assert.equal(unsafe.includes('JWT_SECRET'), true)
    assert.equal(unsafe.includes('ADMIN_JWT_SECRET'), true)
    assert.equal(unsafe.includes('TOTP_ENCRYPTION_KEY'), true)
    assert.equal(unsafe.includes('KYC_FILE_ENCRYPTION_KEY'), true)
    assert.equal(unsafe.includes('DATABASE_URL'), true)
    assert.equal(unsafe.includes('SMTP_FROM'), true)
    assert.equal(unsafe.includes('TRUST_PROXY'), true)
    assert.equal(unsafe.includes('ADMIN_PASSWORD'), true)
  })
})

test('production env safety accepts strong-looking runtime values', () => {
  withEnv({
    JWT_SECRET: 'a'.repeat(64),
    ADMIN_JWT_SECRET: 'b'.repeat(64),
    TOTP_ENCRYPTION_KEY: 'c'.repeat(64),
    KYC_FILE_ENCRYPTION_KEY: 'd'.repeat(64),
    DATABASE_URL: 'postgresql://app_user:safe-password@db.internal:5432/propfirm',
    SMTP_USER: 'a68d12001@smtp-brevo.com',
    SMTP_FROM: 'support@example.com',
    TRUST_PROXY: 'true',
    ADMIN_PASSWORD: 'Str0ngAdminPass!Str0ngAdminPass!'
  }, () => {
    assert.deepEqual(getUnsafeProductionEnvVars(), [])
  })
})

// Regression guard: env.js used to demand the literal string 'true', which
// contradicted docker-compose.yml's shipped TRUST_PROXY=1 default and made
// `npm run deploy:preflight` impossible to pass on the documented config.
// These values must stay in sync with server.js's resolveTrustProxySetting().
test('TRUST_PROXY accepts every value server.js resolves to an enabled setting', () => {
  for (const value of ['true', '1', 'on', 'yes', '2', '10', '10.0.0.0/8', 'loopback']) {
    assert.equal(isUnsafeTrustProxy(value), false, `${value} should be accepted`)
  }
})

test('TRUST_PROXY flags only values that disable proxy trust', () => {
  for (const value of ['false', '0', 'off', 'no', 'FALSE', ' Off ']) {
    assert.equal(isUnsafeTrustProxy(value), true, `${value} should be flagged`)
  }
})

test('the documented docker-compose TRUST_PROXY default passes preflight', () => {
  withEnv({
    JWT_SECRET: 'a'.repeat(64),
    ADMIN_JWT_SECRET: 'b'.repeat(64),
    TOTP_ENCRYPTION_KEY: 'c'.repeat(64),
    KYC_FILE_ENCRYPTION_KEY: 'd'.repeat(64),
    DATABASE_URL: 'postgresql://app_user:safe-secret@db.internal:5432/propfirm',
    SMTP_USER: 'a68d12001@smtp-brevo.com',
    SMTP_FROM: 'support@example.com',
    TRUST_PROXY: '1',
    ADMIN_PASSWORD: 'Str0ngAdminPass!Str0ngAdminPass!'
  }, () => {
    assert.deepEqual(getUnsafeProductionEnvVars(), [])
  })
})

test('production env safety still flags a weak ADMIN_PASSWORD even when everything else is strong', () => {
  withEnv({
    JWT_SECRET: 'a'.repeat(64),
    ADMIN_JWT_SECRET: 'b'.repeat(64),
    TOTP_ENCRYPTION_KEY: 'c'.repeat(64),
    KYC_FILE_ENCRYPTION_KEY: 'd'.repeat(64),
    DATABASE_URL: 'postgresql://app_user:safe-password@db.internal:5432/propfirm',
    SMTP_USER: 'a68d12001@smtp-brevo.com',
    SMTP_FROM: 'support@example.com',
    TRUST_PROXY: 'true',
    ADMIN_PASSWORD: 'changeme'
  }, () => {
    assert.deepEqual(getUnsafeProductionEnvVars(), ['ADMIN_PASSWORD'])
  })
})
