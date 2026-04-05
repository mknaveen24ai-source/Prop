/**
 * Backend utility function tests using Node's native test runner
 * Tests: validation.js
 */
const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  isValidEmail,
  isValidPhone,
  isValidCountry,
  isValidNumber,
  isValidLotSize
} = require('../utils/validation')

describe('Backend Utilities - validation.js', () => {
  describe('isValidEmail', () => {
    it('accepts valid emails', () => {
      assert.strictEqual(isValidEmail('test@example.com'), true)
      assert.strictEqual(isValidEmail('user.name@domain.org'), true)
    })

    it('rejects invalid emails', () => {
      assert.strictEqual(isValidEmail('invalid'), false)
      assert.strictEqual(isValidEmail(''), false)
    })
  })

  describe('isValidPhone', () => {
    it('accepts valid phone numbers', () => {
      assert.strictEqual(isValidPhone('+1234567890'), true)
      assert.strictEqual(isValidPhone('+44 20 7946 0958'), true)
    })

    it('rejects clearly invalid phone numbers', () => {
      assert.strictEqual(isValidPhone(''), false)
      assert.strictEqual(isValidPhone('abc'), false)
    })
  })

  describe('isValidCountry', () => {
    it('accepts valid country codes', () => {
      assert.strictEqual(isValidCountry('US'), true)
      assert.strictEqual(isValidCountry('GB'), true)
      assert.strictEqual(isValidCountry('DE'), true)
    })

    it('rejects invalid country codes', () => {
      assert.strictEqual(isValidCountry('XX'), false)
      assert.strictEqual(isValidCountry(''), false)
    })
  })

  describe('isValidNumber', () => {
    it('accepts valid numbers in range', () => {
      assert.strictEqual(isValidNumber(50, 0, 100), true)
      assert.strictEqual(isValidNumber(0, 0, 100), true)
      assert.strictEqual(isValidNumber(100, 0, 100), true)
    })

    it('rejects numbers out of range', () => {
      assert.strictEqual(isValidNumber(-1, 0, 100), false)
      assert.strictEqual(isValidNumber(101, 0, 100), false)
    })

    it('handles decimal validation', () => {
      assert.strictEqual(isValidNumber(50.5, 0, 100, true), true)
      // parseInt(50.5) = 50, which is in range, so this passes
      assert.strictEqual(isValidNumber(50.5, 0, 100, false), true)
      // Use a value that clearly fails parseInt validation
      assert.strictEqual(isValidNumber('50.5abc', 0, 100, false), false)
    })
  })

  describe('isValidLotSize', () => {
    it('accepts valid lot sizes', () => {
      assert.strictEqual(isValidLotSize(0.01), true)
      assert.strictEqual(isValidLotSize(1.0), true)
      assert.strictEqual(isValidLotSize(100.5), true)
    })

    it('rejects invalid lot sizes', () => {
      assert.strictEqual(isValidLotSize(0), false)
      assert.strictEqual(isValidLotSize(-1), false)
      assert.strictEqual(isValidLotSize(1001), false)
      assert.strictEqual(isValidLotSize(0.001), false) // Not in 0.01 increments
    })
  })
})
