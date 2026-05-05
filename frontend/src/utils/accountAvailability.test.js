import { describe, expect, it } from 'vitest'
import { buildUnavailableAvailabilityRows, normalizeAvailabilityRows } from './accountAvailability'

describe('account availability helpers', () => {
  it('does not invent open tiers when availability is unavailable', () => {
    const rows = buildUnavailableAvailabilityRows()
    expect(rows.every((row) => row.locked === true)).toBe(true)
    expect(rows.every((row) => row.remaining === 0)).toBe(true)
  })

  it('normalizes sparse API data into a canonical row shape', () => {
    const rows = normalizeAvailabilityRows([
      { size: 1000, quota: 50, used: 12, remaining: 38, locked: false }
    ])

    const oneK = rows.find((row) => row.size === 1000)
    const twoK = rows.find((row) => row.size === 2000)

    expect(oneK).toMatchObject({
      size: 1000,
      quota: 50,
      used: 12,
      remaining: 38,
      locked: false
    })
    expect(twoK.locked).toBe(true)
  })
})
