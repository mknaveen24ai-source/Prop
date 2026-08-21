import { describe, it, expect } from 'vitest'
import config from '../../design-tokens.config.js'

/**
 * The two design-token checkers -- scripts/design-drift.js and
 * eslint-rules/design-tokens.js -- share their definitions through
 * design-tokens.config.js precisely because they once disagreed: the script
 * reported 0 hardcoded colours while ESLint reported 10.
 *
 * These tests pin the shared definitions so a change to one cannot quietly
 * change what the other means by "a colour".
 */

const { hexColorScanner, HEX_COLOR_EXACT, isColorAllowlisted } = config

describe('hex colour definition', () => {
  it('accepts exactly the four lengths CSS defines', () => {
    for (const value of ['#fff', '#ffff', '#3A3733', '#3A373322']) {
      expect(HEX_COLOR_EXACT.test(value), value).toBe(true)
      expect(value.match(hexColorScanner()), value).toEqual([value])
    }
  })

  it('rejects lengths that are not a colour in any syntax', () => {
    // Seven hex characters is the one that mattered in practice: a trade
    // ticket rendered as #4820194 was reported as a hardcoded colour by the
    // `{3,8}` range this replaced.
    for (const value of ['#12345', '#4820194', '#4820201', '#1234567']) {
      expect(HEX_COLOR_EXACT.test(value), value).toBe(false)
      expect(value.match(hexColorScanner()), value).toBeNull()
    }
  })

  it('still finds a real colour inside a token fallback', () => {
    // design-drift excludes these separately, by position -- but it can only
    // do that if the scanner finds them first.
    expect('var(--rule, #3A3733)'.match(hexColorScanner())).toEqual(['#3A3733'])
  })

  it('returns a fresh scanner each call so /g lastIndex cannot leak', () => {
    const a = hexColorScanner()
    a.exec('#fff #000')
    const b = hexColorScanner()
    expect(b.lastIndex).toBe(0)
  })
})

describe('colour allowlist', () => {
  it('matches on a path suffix, so separators do not matter', () => {
    expect(isColorAllowlisted('src/ErrorBoundary.jsx')).toBe(true)
    expect(isColorAllowlisted(String.raw`E:\propfirm\frontend\src\ErrorBoundary.jsx`)).toBe(true)
    expect(isColorAllowlisted('src/pages/Analytics.jsx')).toBe(false)
  })

  it('states a reason for every entry', () => {
    for (const entry of config.COLOR_ALLOWLIST) {
      expect(entry.reason, entry.file).toBeTruthy()
    }
  })
})
