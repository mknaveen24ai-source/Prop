import { describe, it, expect } from 'vitest'
import { keyForWidth, BREAKPOINTS } from '../styles/breakpoints'

// The hook itself is a thin useSyncExternalStore wrapper over keyForWidth; the
// boundaries are where the bugs live, so they get pinned explicitly. An
// off-by-one here silently sends a tablet the phone layout (or worse, sends a
// phone the desktop trading desk).
describe('keyForWidth', () => {
  it('classifies the device widths the responsive QA matrix uses', () => {
    expect(keyForWidth(320)).toBe('xs')  // iPhone SE (1st gen)
    expect(keyForWidth(375)).toBe('xs')  // iPhone SE (2nd) / 12 mini
    expect(keyForWidth(390)).toBe('xs')  // iPhone 14
    expect(keyForWidth(414)).toBe('xs')  // iPhone Plus
    expect(keyForWidth(600)).toBe('sm')  // large phone / small tablet
    expect(keyForWidth(768)).toBe('md')  // iPad portrait
    expect(keyForWidth(1024)).toBe('lg') // iPad landscape
    expect(keyForWidth(1280)).toBe('xl') // desktop
    expect(keyForWidth(1440)).toBe('xl')
  })

  it('puts each breakpoint value at the START of its own band', () => {
    expect(keyForWidth(BREAKPOINTS.sm - 1)).toBe('xs')
    expect(keyForWidth(BREAKPOINTS.sm)).toBe('sm')
    expect(keyForWidth(BREAKPOINTS.md - 1)).toBe('sm')
    expect(keyForWidth(BREAKPOINTS.md)).toBe('md')
    expect(keyForWidth(BREAKPOINTS.lg - 1)).toBe('md')
    expect(keyForWidth(BREAKPOINTS.lg)).toBe('lg')
    expect(keyForWidth(BREAKPOINTS.xl - 1)).toBe('lg')
    expect(keyForWidth(BREAKPOINTS.xl)).toBe('xl')
  })

  it('treats everything below md as mobile — the shell and terminal agree on this', () => {
    const mobile = (w) => ['xs', 'sm'].includes(keyForWidth(w))
    expect(mobile(375)).toBe(true)
    expect(mobile(767)).toBe(true)
    expect(mobile(768)).toBe(false)
  })
})
