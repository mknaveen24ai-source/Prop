/**
 * The single source of truth for viewport breakpoints.
 *
 * CSS custom properties cannot be used inside `@media` conditions, so the
 * stylesheets cannot read these values — they mirror the same literals with a
 * `/* bp: md *\/`-style comment. When a threshold changes here it must be
 * changed in the stylesheets too; grep for the pixel value.
 *
 * Scale (max-width semantics, matching the desktop-first codebase):
 *   xs  <  480   small phone            (iPhone SE portrait)
 *   sm  480-767  phone                  (most phones portrait)
 *   md  768-1023 tablet portrait
 *   lg  1024-1279 tablet landscape / small laptop
 *   xl  >= 1280  desktop
 *
 * Anything below `md` is treated as "mobile" by the app shell: the trader
 * sidebar becomes a bottom tab bar and the trading terminal switches to its
 * purpose-built mobile layout.
 */
export const BREAKPOINTS = Object.freeze({
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
})

/** Ordered smallest → largest. `xs` is the implicit floor below `sm`. */
export const BREAKPOINT_KEYS = Object.freeze(['xs', 'sm', 'md', 'lg', 'xl'])

/** Below this width the app uses mobile layouts. */
export const MOBILE_MAX = BREAKPOINTS.md - 1

/**
 * Resolve a pixel width to a breakpoint key.
 * Kept pure and export-ed so tests can assert the boundaries without a DOM.
 */
export function keyForWidth(width) {
  if (width < BREAKPOINTS.sm) return 'xs'
  if (width < BREAKPOINTS.md) return 'sm'
  if (width < BREAKPOINTS.lg) return 'md'
  if (width < BREAKPOINTS.xl) return 'lg'
  return 'xl'
}

/** Media query string matching a breakpoint key, for `window.matchMedia`. */
export function queryForKey(key) {
  switch (key) {
    case 'xs': return `(max-width: ${BREAKPOINTS.sm - 1}px)`
    case 'sm': return `(min-width: ${BREAKPOINTS.sm}px) and (max-width: ${BREAKPOINTS.md - 1}px)`
    case 'md': return `(min-width: ${BREAKPOINTS.md}px) and (max-width: ${BREAKPOINTS.lg - 1}px)`
    case 'lg': return `(min-width: ${BREAKPOINTS.lg}px) and (max-width: ${BREAKPOINTS.xl - 1}px)`
    case 'xl': return `(min-width: ${BREAKPOINTS.xl}px)`
    default: return '(min-width: 0px)'
  }
}
