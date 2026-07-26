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
      { size: 5000, quota: 50, used: 12, remaining: 38, locked: false }
    ])

    const fiveK = rows.find((row) => row.size === 5000)
    const tenK = rows.find((row) => row.size === 10000)

    expect(fiveK).toMatchObject({
      size: 5000,
      quota: 50,
      used: 12,
      remaining: 38,
      locked: false
    })
    expect(tenK.locked).toBe(true)
  })
})
