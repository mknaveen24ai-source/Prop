import { describe, expect, it } from 'vitest'
import { getTenantLandingCopy, isPaidTenant, getChallengeFeeDisplay } from './tenantMarketing'

describe('tenant marketing copy', () => {
  it('is always paid — no free tier exists', () => {
    expect(isPaidTenant()).toBe(true)
  })

  it('returns paid-model copy with no "free" wording anywhere', () => {
    const copy = getTenantLandingCopy()
    expect(copy.heroTitleHighlight).toBe('Your Own Capital.')
    const serialized = JSON.stringify(copy).toLowerCase()
    expect(serialized).not.toContain('free')
  })

  it('getChallengeFeeDisplay falls back to a non-free label when no override is configured', () => {
    expect(getChallengeFeeDisplay()).not.toMatch(/free/i)
    expect(getChallengeFeeDisplay()).toBe('From $4')
  })
})
