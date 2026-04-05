/**
 * Utility function tests using Node's native test runner
 * Tests: helpers.js functions
 */
const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  formatDate,
  calculateDrawdown,
  getRiskLevel,
  isValidEmail,
  isValidPassword,
  sleep
} = require('../src/utils/helpers')

describe('Utility Functions - helpers.js', () => {
  describe('formatDate', () => {
    it('should format valid dates correctly', () => {
      const date = new Date('2026-04-04T12:00:00Z')
      const result = formatDate(date)
      assert.ok(result)
      assert.strictEqual(typeof result, 'string')
      assert.ok(result.length > 0)
    })

    it('should handle null/undefined inputs', () => {
      assert.ok(formatDate(null))
      assert.ok(formatDate(undefined))
    })
  })

  describe('calculateDrawdown', () => {
    it('should calculate correct drawdown percentage', () => {
      const result = calculateDrawdown(9000, 10000, 10000)
      assert.strictEqual(result, 10)
    })

    it('should return 0 when current equals peak', () => {
      const result = calculateDrawdown(10000, 10000, 10000)
      assert.strictEqual(result, 0)
    })

    it('should handle negative balances', () => {
      const result = calculateDrawdown(-1000, 10000, 10000)
      assert.ok(result > 0)
      assert.ok(result <= 100)
    })

    it('should handle zero starting balance', () => {
      const result = calculateDrawdown(1000, 1000, 0)
      assert.ok(result !== undefined)
    })
  })

  describe('getRiskLevel', () => {
    it('should return critical for high drawdown usage', () => {
      const result = getRiskLevel(95, 10)
      assert.strictEqual(result.level, 'critical')
    })

    it('should return high for moderate drawdown usage', () => {
      const result = getRiskLevel(8, 10)
      assert.strictEqual(result.level, 'high')
    })

    it('should return safe for very low drawdown usage', () => {
      const result = getRiskLevel(1, 10)
      assert.strictEqual(result.level, 'safe')
    })

    it('should handle zero max drawdown', () => {
      const result = getRiskLevel(5, 0)
      assert.ok(result)
    })
  })

  describe('isValidEmail', () => {
    it('should accept valid emails', () => {
      assert.strictEqual(isValidEmail('test@example.com'), true)
      assert.strictEqual(isValidEmail('user.name@domain.org'), true)
    })

    it('should reject invalid emails', () => {
      assert.strictEqual(isValidEmail('invalid'), false)
      assert.strictEqual(isValidEmail('@domain.com'), false)
      assert.strictEqual(isValidEmail('user@'), false)
      assert.strictEqual(isValidEmail(''), false)
    })
  })

  describe('isValidPassword', () => {
    it('should accept strong passwords', () => {
      const result = isValidPassword('StrongP@ss1')
      assert.strictEqual(result.valid, true)
      assert.strictEqual(result.errors.length, 0)
    })

    it('should reject weak passwords', () => {
      const result = isValidPassword('weak')
      assert.strictEqual(result.valid, false)
      assert.ok(result.errors.length > 0)
    })

    it('should check all password requirements', () => {
      const result = isValidPassword('short')
      assert.ok(result.errors.some(e => e.includes('8 characters')))
      assert.ok(result.errors.some(e => e.includes('uppercase')))
      assert.ok(result.errors.some(e => e.includes('number')))
    })
  })

  describe('sleep', () => {
    it('should resolve after specified time', async () => {
      const start = Date.now()
      await sleep(50)
      const duration = Date.now() - start
      assert.ok(duration >= 45) // Allow 5ms tolerance
    })
  })
})
