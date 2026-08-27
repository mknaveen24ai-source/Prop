import assert from 'node:assert/strict'
import test from 'node:test'
import bcrypt from 'bcryptjs'
import speakeasy from 'speakeasy'
import {
  checkRateLimit,
  clearAttempts,
  consumeBackupCode,
  generateSecret,
  recordFailure,
  verifyToken
} from '../utils/totp'

void test('generated TOTP secrets round-trip through the verifier', () => {
  const secret = generateSecret('trader@example.com')
  const token = speakeasy.totp({ secret: secret.base32, encoding: 'base32' })

  assert.equal(verifyToken(secret.base32, token), true)
  assert.match(secret.otpauthUrl ?? '', /^otpauth:\/\/totp\//u)
})

void test('backup-code JSON is unknown until its row shape validates', async () => {
  assert.deepEqual(await consumeBackupCode('CODE', null), { matched: false })
  assert.deepEqual(await consumeBackupCode('CODE', [{ hash: 42, used: false }]), { matched: false })
  assert.deepEqual(await consumeBackupCode('CODE', [{ hash: 'hash' }]), { matched: false })
})

void test('a matching backup code is consumed in validated output', async () => {
  const hash = await bcrypt.hash('A1B2C3D4E5', 4)
  const stored = [{ hash, used: false }]

  const result = await consumeBackupCode(' a1b2c3d4e5 ', stored)

  assert.equal(result.matched, true)
  if (!result.matched) return
  assert.equal(result.index, 0)
  assert.equal(result.updated[0]?.used, true)
  assert.equal(stored[0]?.used, false, 'validation output must not mutate parsed DB JSON input')
})

void test('TOTP attempt state locks on the fifth failure and can be cleared', () => {
  const ip = '203.0.113.81'
  clearAttempts(ip)
  for (let attempt = 0; attempt < 5; attempt += 1) recordFailure(ip)

  const blocked = checkRateLimit(ip)
  assert.equal(blocked.blocked, true)
  clearAttempts(ip)
  assert.deepEqual(checkRateLimit(ip), { blocked: false, count: 0 })
})
