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

/**
 * The device matrix the responsive checks run against.
 *
 * Lives here, beside the breakpoints, for the same reason `design-drift.js`
 * parses `tokens.css` instead of carrying its own copy of the spacing scale: a
 * checker holding a private copy of the thing it checks can be wrong and
 * confident at the same time. Both `scripts/responsive-drift.js` and
 * `e2e/tests/responsive.spec.js` read this list through
 * `scripts/lib/viewports.js`, so the static counter and the browser assertions
 * cannot end up testing different phones.
 *
 * `min` is the narrowest width any of them presents. It is what makes a fixed
 * inline width a defect rather than a preference: an element wider than this
 * cannot fit the narrowest device we claim to support, whatever CSS wraps it.
 *
 * 280 is the Galaxy Z Fold folded — the narrowest mainstream viewport in
 * existence. The target there is "nothing overflows the document", not
 * "everything is legible"; a 24-hour heatmap cannot be legible at 280px and
 * asserting that it is would only get the suite muted.
 */
export const TEST_VIEWPORTS = Object.freeze([
  Object.freeze({ name: 'foldable',  width: 280, height: 653, label: 'Galaxy Z Fold (folded)' }),
  Object.freeze({ name: 'compact',   width: 320, height: 568, label: 'iPhone SE / Galaxy S8' }),
  Object.freeze({ name: 'flagship',  width: 393, height: 852, label: 'iPhone 15 Pro / Galaxy S24' }),
  Object.freeze({ name: 'tablet',    width: 768, height: 1024, label: 'iPad Mini portrait' }),
  Object.freeze({ name: 'landscape', width: 852, height: 393, label: 'phone rotated 90deg' }),
])

/** Narrowest width in the matrix — the overflow threshold for static checks. */
export const NARROWEST_VIEWPORT = TEST_VIEWPORTS.reduce(
  (min, v) => Math.min(min, v.width),
  Infinity
)
