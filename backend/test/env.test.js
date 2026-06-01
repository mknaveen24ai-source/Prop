const test = require('node:test')
const assert = require('node:assert/strict')

const { getUnsafeProductionEnvVars } = require('../env')

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
    ADMIN_PASSWORD: undefined
  }, () => {
    assert.deepEqual(getUnsafeProductionEnvVars(), [])
  })
})
