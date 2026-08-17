import { describe, expect, test } from 'vitest'
import { symbolTickerCopyCount } from './TradingPanel'

// The symbol ticker is a JS marquee: it advances scrollLeft and wraps by one
// copy's width. That only reads as motion while the rendered strip is wider
// than the visible row, and the copy count used to be hardcoded at two. That
// assumption held while the ticker carried all 45 instruments; it broke once
// the list was narrowed to the tradable (USD-quoted) subset, and broke harder
// with a category chip selected, where three or four symbols fit on screen with
// room to spare and the marquee silently stopped.
//
// The invariant these tests pin: for any non-empty symbol list, the rendered
// strip overflows the container.

const GAP = 8

/** Width of one copy of `count` symbol cards, matching the row's own layout. */
function copyWidth(count, cardWidth = 96) {
  return count * (cardWidth + GAP)
}

function strip(containerWidth, oneCopy) {
  return symbolTickerCopyCount(containerWidth, oneCopy) * oneCopy
}

describe('symbolTickerCopyCount', () => {
  test('a full 45-symbol list on a narrow row still scrolls', () => {
    const oneCopy = copyWidth(45)
    expect(strip(1200, oneCopy)).toBeGreaterThan(1200)
  })

  test('the 14 tradable symbols overflow a wide desktop row', () => {
    // The regression case: 14 * 104 = 1456px per copy, which a 1400px row
    // very nearly matches. Two copies happened to work here, but only just.
    const oneCopy = copyWidth(14)
    expect(strip(1400, oneCopy)).toBeGreaterThan(1400)
  })

  test('a 3-symbol category still overflows a wide row', () => {
    // Indices Spot after the USD-quoted filter: US30, USTEC, US500. One copy is
    // 312px against a 1400px row, so two copies left 776px of dead space and
    // the marquee never moved.
    const oneCopy = copyWidth(3)
    expect(oneCopy).toBeLessThan(1400)
    expect(strip(1400, oneCopy)).toBeGreaterThan(1400)
  })

  test('overflows across the full range of viewport widths', () => {
    for (const symbols of [1, 3, 4, 14, 45]) {
      const oneCopy = copyWidth(symbols)
      for (const width of [320, 768, 1024, 1440, 1920, 2560, 3840]) {
        expect(strip(width, oneCopy)).toBeGreaterThan(width)
      }
    }
  })

  test('never renders fewer than two copies — the wrap needs a second one', () => {
    expect(symbolTickerCopyCount(320, copyWidth(45))).toBe(2)
    expect(symbolTickerCopyCount(0, copyWidth(14))).toBe(2)
  })

  test('falls back to two copies before the first measurement lands', () => {
    // getBoundingClientRect returns 0 until layout runs; the rAF loop separately
    // guards on copyWidth > 0, so this only has to avoid dividing by zero.
    expect(symbolTickerCopyCount(1400, 0)).toBe(2)
    expect(symbolTickerCopyCount(1400, -1)).toBe(2)
    expect(symbolTickerCopyCount(1400, Number.NaN)).toBe(2)
  })
})
