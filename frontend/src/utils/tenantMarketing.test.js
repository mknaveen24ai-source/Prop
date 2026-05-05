import { describe, expect, it } from 'vitest'
import { getTenantLandingCopy, isPaidTenant } from './tenantMarketing'

describe('tenant marketing copy', () => {
  it('returns free-model copy for the default free tenant', () => {
    const tenant = {
      settings: {
        requires_payment: 'false',
        challenge_checkout_mode: 'free',
        marketing_mode: 'free',
      }
    }

    expect(isPaidTenant(tenant)).toBe(false)
    expect(getTenantLandingCopy(tenant).heroTitleHighlight).toBe('Free.')
  })

  it('returns paid-model copy when checkout is required', () => {
    const tenant = {
      settings: {
        requires_payment: 'true',
        challenge_checkout_mode: 'paid',
        challenge_fee_amount: '99',
        challenge_fee_currency: 'USD',
        challenge_fee_label: '$99',
        marketing_mode: 'paid',
      }
    }

    const copy = getTenantLandingCopy(tenant)
    expect(isPaidTenant(tenant)).toBe(true)
    expect(copy.calculatorLead).toContain('$99')
    expect(copy.heroTitleHighlight).toBe('Firm-Backed Capital.')
  })
})
