import { useSyncExternalStore } from 'react'
import { BREAKPOINTS, BREAKPOINT_KEYS, keyForWidth } from '../styles/breakpoints'

/**
 * Viewport-breakpoint awareness for components that need to *restructure* on
 * mobile, not merely restyle. Restyling should stay in CSS media queries — this
 * hook exists for the cases CSS cannot express, e.g. the trading terminal
 * swapping a three-column desk for a segmented single-pane layout.
 *
 * Implemented with `useSyncExternalStore` so the value is read during render
 * (no first-paint flash of the wrong layout) and stays consistent under
 * concurrent rendering.
 *
 * Uses `matchMedia` rather than a resize listener: the browser only notifies on
 * an actual threshold crossing, so a drag-resize does not fire a render per
 * pixel. Same `addEventListener('change')` pattern the marquee already uses in
 * TradingPanel.jsx for prefers-reduced-motion.
 */

const MEDIA_QUERIES = BREAKPOINT_KEYS.map((key) => {
  switch (key) {
    case 'xs': return `(max-width: ${BREAKPOINTS.sm - 1}px)`
    case 'sm': return `(min-width: ${BREAKPOINTS.sm}px) and (max-width: ${BREAKPOINTS.md - 1}px)`
    case 'md': return `(min-width: ${BREAKPOINTS.md}px) and (max-width: ${BREAKPOINTS.lg - 1}px)`
    case 'lg': return `(min-width: ${BREAKPOINTS.lg}px) and (max-width: ${BREAKPOINTS.xl - 1}px)`
    default: return `(min-width: ${BREAKPOINTS.xl}px)`
  }
})

function subscribe(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}

  const lists = MEDIA_QUERIES.map((q) => window.matchMedia(q))
  lists.forEach((list) => list.addEventListener('change', onChange))
  return () => lists.forEach((list) => list.removeEventListener('change', onChange))
}

function getSnapshot() {
  if (typeof window === 'undefined') return 'xl'
  // matchMedia is the subscription mechanism, but innerWidth is the cheaper and
  // more reliable read — jsdom in particular reports matches: false for every
  // query unless the test explicitly stubs matchMedia.
  return keyForWidth(window.innerWidth)
}

// Server/prerender default. Desktop is the safer guess: the mobile terminal is
// a deliberate opt-in, and rendering it for a desktop user would be the more
// jarring of the two mistakes.
function getServerSnapshot() {
  return 'xl'
}

/**
 * @returns {'xs'|'sm'|'md'|'lg'|'xl'} the current breakpoint key.
 */
export function useBreakpoint() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/**
 * True below the `md` threshold (768px) — phones in portrait, and small phones
 * in landscape. This is the boundary the app shell already uses for the trader
 * bottom tab bar, so layouts stay in agreement.
 */
export function useIsMobile() {
  const bp = useBreakpoint()
  return bp === 'xs' || bp === 'sm'
}

/**
 * True at or below the given breakpoint key, e.g. `useIsAtMost('md')` covers
 * phones and tablet-portrait.
 */
export function useIsAtMost(key) {
  const bp = useBreakpoint()
  return BREAKPOINT_KEYS.indexOf(bp) <= BREAKPOINT_KEYS.indexOf(key)
}

export default useBreakpoint
