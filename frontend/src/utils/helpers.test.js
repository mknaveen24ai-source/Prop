import { describe, it, expect } from 'vitest'
import {
  formatDate,
  calculateDrawdown,
  isValidEmail,
  isValidPassword,
  sleep
} from './helpers'

describe('Utility Functions - helpers.js', () => {
  describe('formatDate', () => {
    it('should format valid dates correctly', () => {
      const result = formatDate(new Date('2026-04-04T12:00:00Z'))
      expect(result).toBeTruthy()
      expect(typeof result).toBe('string')
      expect(result.length).toBeGreaterThan(0)
    })

    it('should handle null/undefined inputs', () => {
      expect(formatDate(null)).toBeTruthy()
      expect(formatDate(undefined)).toBeTruthy()
    })
  })

  describe('calculateDrawdown', () => {
    it('should calculate correct drawdown percentage', () => {
      expect(calculateDrawdown(9000, 10000, 10000)).toBe(10)
    })

    it('should return 0 when current equals peak', () => {
      expect(calculateDrawdown(10000, 10000, 10000)).toBe(0)
    })

    it('should handle negative balances', () => {
      const result = calculateDrawdown(-1000, 10000, 10000)
      expect(result).toBeGreaterThan(0)
      expect(result).toBeLessThanOrEqual(100)
    })

    it('should handle zero starting balance', () => {
      expect(calculateDrawdown(1000, 1000, 0)).not.toBeUndefined()
    })
  })

  describe('isValidEmail', () => {
    it('should accept valid emails', () => {
      expect(isValidEmail('test@example.com')).toBe(true)
      expect(isValidEmail('user.name@domain.org')).toBe(true)
    })

    it('should reject invalid emails', () => {
      expect(isValidEmail('invalid')).toBe(false)
      expect(isValidEmail('@domain.com')).toBe(false)
      expect(isValidEmail('user@')).toBe(false)
      expect(isValidEmail('')).toBe(false)
    })
  })

  describe('isValidPassword', () => {
    it('should accept strong passwords', () => {
      const result = isValidPassword('StrongP@ss1')
      expect(result.valid).toBe(true)
      expect(result.errors.length).toBe(0)
    })

    it('should reject weak passwords', () => {
      const result = isValidPassword('weak')
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('should check all password requirements', () => {
      const result = isValidPassword('short')
      expect(result.errors.some(e => e.includes('8 characters'))).toBe(true)
      expect(result.errors.some(e => e.includes('uppercase'))).toBe(true)
      expect(result.errors.some(e => e.includes('number'))).toBe(true)
    })
  })

  describe('sleep', () => {
    it('should resolve after specified time', async () => {
      const start = Date.now()
      await sleep(50)
      expect(Date.now() - start).toBeGreaterThanOrEqual(45) // 5ms tolerance
    })
  })
})
