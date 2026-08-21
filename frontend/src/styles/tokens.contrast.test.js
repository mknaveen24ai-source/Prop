import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * WCAG 2.1 contrast conformance for the colour tokens, asserted against the
 * real stylesheet.
 *
 * ── Why this test exists ─────────────────────────────────────────────────────
 *
 * An accessibility roadmap claimed `--muted` was the contrast problem. Measured,
 * `--muted` passes AA in both themes (5.57 / 5.05); the actual failures were
 * `--color-text-faint` at 2.46:1 in light mode and `--warn` at 3.48:1, neither
 * of which the roadmap mentioned. A number nobody can recompute is a number
 * that drifts, so the thresholds live here rather than in a document.
 *
 * It parses `tokens.css` rather than holding its own copy of the values. This
 * is the same discipline `designTokens.config.test.js` and `design-drift.js`
 * follow, and for the same reason recorded there: a checker with a private copy
 * of the scale can be wrong in exactly the way the brief was wrong while still
 * reporting full marks.
 *
 * ── What is deliberately NOT asserted ────────────────────────────────────────
 *
 * `--rule` (the hairline) is exempt. WCAG 1.4.11 covers boundaries required to
 * identify a control, not decorative separators, and the hairline rule is the
 * Ledger Desk's identity. Controls use `--rule-control`, which IS asserted.
 *
 * `--color-text-disabled` is exempt: 1.4.3 explicitly excludes inactive
 * controls.
 *
 * The target is AA (4.5:1 body text, 3:1 non-text). AAA would be 7:1 and would
 * require re-pitching --muted, --gain, --loss and --brand-primary in both
 * themes — a re-palette, not a fix.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CSS = fs.readFileSync(path.join(HERE, 'tokens.css'), 'utf8')

const AA_TEXT = 4.5
const AA_NON_TEXT = 3.0

/** Pull one theme's `--name: #hex;` declarations out of the sheet. */
function readTheme(selector) {
  const start = CSS.indexOf(selector)
  if (start === -1) throw new Error(`theme block not found: ${selector}`)
  const open = CSS.indexOf('{', start)
  // Token blocks contain no nested braces, so the next `}` closes the block.
  const end = CSS.indexOf('}', open)
  const block = CSS.slice(open, end)
  const tokens = {}
  for (const [, name, hex] of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) {
    // 4- and 8-digit forms carry alpha, which cannot be resolved without
    // knowing what is behind them. None of the tokens under test use them.
    if (hex.length === 5 || hex.length === 9) continue
    tokens[name] = hex
  }
  return tokens
}

function expand(hex) {
  const h = hex.replace('#', '')
  return h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
}

/** WCAG 2.1 relative luminance (§ definition of "relative luminance"). */
function luminance(hex) {
  const h = expand(hex)
  const [r, g, b] = [0, 1, 2]
    .map((i) => parseInt(h.substr(i * 2, 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

// Sanity-check the maths against the two anchors every WCAG implementation
// agrees on. Without this, a bug in luminance() makes every assertion below
// pass for the wrong reason.
describe('contrast maths', () => {
  it('matches the known reference ratios', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrast('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5)
    expect(contrast('#767676', '#FFFFFF')).toBeCloseTo(4.54, 1)
  })

  it('expands three-digit hex', () => {
    expect(contrast('#000', '#FFF')).toBeCloseTo(21, 5)
  })
})

// Text that must clear 4.5:1. `--color-text-disabled` and `--rule` are
// deliberately absent; see the header.
const TEXT_TOKENS = ['ink', 'muted', 'color-text-primary', 'color-text-secondary', 'color-text-muted', 'color-text-faint', 'gain', 'loss', 'warn']
// Boundaries that identify a control, which must clear 3:1.
const NON_TEXT_TOKENS = ['rule-control', 'brand-primary']

const THEMES = [
  ['dark (Charcoal Noir)', ':root,\n[data-theme="dark"]'],
  ['light (Rag Cotton White)', '[data-theme="light"]'],
]

describe.each(THEMES)('%s', (_label, selector) => {
  const tokens = readTheme(selector)
  // Both surfaces: cards sit on --paper-2, and the same text token is used on
  // both. Checking only the page background hides every card-on-surface case,
  // which is where the ratios are always worse.
  const surfaces = [
    ['--paper', tokens.paper],
    ['--paper-2', tokens['paper-2']],
  ]

  it('defines both surface colours', () => {
    expect(tokens.paper).toMatch(/^#[0-9A-Fa-f]{6}$/)
    expect(tokens['paper-2']).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  describe.each(surfaces)('on %s', (_surfaceName, surface) => {
    // Tokens that alias another token (`var(--ink)`) are not hex and so never
    // land in the parsed map; only literal values are checked here, which is
    // what we want — the alias is covered by its target.
    const textCases = TEXT_TOKENS.filter((t) => tokens[t]).map((t) => [t, tokens[t]])
    const nonTextCases = NON_TEXT_TOKENS.filter((t) => tokens[t]).map((t) => [t, tokens[t]])

    it.each(textCases)('--%s (%s) clears 4.5:1 for body text', (_name, hex) => {
      expect(contrast(hex, surface)).toBeGreaterThanOrEqual(AA_TEXT)
    })

    it.each(nonTextCases)('--%s (%s) clears 3:1 for a control boundary', (_name, hex) => {
      expect(contrast(hex, surface)).toBeGreaterThanOrEqual(AA_NON_TEXT)
    })
  })
})

describe('exemptions stay deliberate', () => {
  it('still defines --rule as a decorative hairline distinct from --rule-control', () => {
    // If these ever converge, the hairline has been "fixed" into a heavy border
    // and the design decision recorded above has been lost by accident.
    for (const [, selector] of THEMES) {
      const tokens = readTheme(selector)
      expect(tokens.rule).toBeDefined()
      expect(tokens['rule-control']).toBeDefined()
      expect(tokens.rule).not.toBe(tokens['rule-control'])
    }
  })
})
