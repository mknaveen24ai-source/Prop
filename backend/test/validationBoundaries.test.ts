import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isAdminClaims,
  isAdminPreTwoFactorClaims,
  isPreTwoFactorClaims,
  isUserClaims
} from '../validation/auth'
import {
  conversationIdSchema,
  instrumentSubscriptionsSchema,
  joinAccountSchema,
  typingStartSchema
} from '../validation/socket'
import { BoundaryValidationError, parseExternal, parseUnknownJson } from '../validation/unknown'
import { z } from 'zod'

const issuedAt = 1_700_000_000
const expiresAt = 1_700_003_600

void test('JWT claim guards validate decoded values after signature verification', () => {
  assert.equal(isUserClaims({
    userId: 'f49d58a7-e004-4993-97ab-04157818b766',
    email: 'trader@example.com',
    tv: 1,
    iat: issuedAt,
    exp: expiresAt
  }), true)
  assert.equal(isUserClaims({ userId: 'not-a-uuid', email: 'trader@example.com', tv: 1 }), false)

  assert.equal(isAdminClaims({
    adminId: null,
    role: 'super_admin',
    atv: 1,
    email: 'admin@example.com',
    full_name: 'Admin',
    src: 'env_fallback',
    iat: issuedAt,
    exp: expiresAt
  }), true)
})

void test('pre-2FA guards cannot be confused with full-session claims', () => {
  const userPreTwoFactor = {
    userId: 'f49d58a7-e004-4993-97ab-04157818b766',
    email: 'trader@example.com',
    type: 'pre_2fa',
    tv: 1,
    iat: issuedAt,
    exp: expiresAt
  }
  assert.equal(isPreTwoFactorClaims(userPreTwoFactor), true)
  assert.equal(isUserClaims(userPreTwoFactor), false)

  const adminPreTwoFactor = {
    adminId: '230a8f37-12a7-4366-830b-7c050119c1d8',
    role: 'super_admin',
    atv: 2,
    email: 'admin@example.com',
    full_name: 'Admin',
    src: 'platform_admin',
    type: 'pre_2fa_admin',
    iat: issuedAt,
    exp: expiresAt
  }
  assert.equal(isAdminPreTwoFactorClaims(adminPreTwoFactor), true)
  assert.equal(isAdminPreTwoFactorClaims({ ...adminPreTwoFactor, type: 'pre_2fa' }), false)
})

void test('socket payload validators accept only current bounded payload shapes', () => {
  assert.deepEqual(instrumentSubscriptionsSchema.parse(['EURUSD', 'XAUUSD']), ['EURUSD', 'XAUUSD'])
  assert.equal(instrumentSubscriptionsSchema.safeParse(new Array(101).fill('EURUSD')).success, false)
  assert.equal(joinAccountSchema.safeParse('f49d58a7-e004-4993-97ab-04157818b766').success, true)
  assert.equal(joinAccountSchema.safeParse('another-user-room').success, false)
  assert.deepEqual(typingStartSchema.parse({ conversationId: '42', isTyping: true }), {
    conversationId: 42,
    isTyping: true
  })
  assert.equal(conversationIdSchema.safeParse(0).success, false)
})

void test('JSON parsing returns unknown and schema validation is authoritative', () => {
  const input = parseUnknownJson('{"count":3}')
  const parsed = parseExternal(z.object({ count: z.number().int().positive() }), input, 'Redis fixture')
  assert.deepEqual(parsed, { count: 3 })
  assert.throws(
    () => parseExternal(z.object({ count: z.string() }), input, 'Redis fixture'),
    BoundaryValidationError
  )
})
