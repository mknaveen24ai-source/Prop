'use strict'

/**
 * Shared configuration for the design-token checks.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read by BOTH `scripts/design-drift.js` and `eslint-rules/design-tokens.js`.
 *
 * The two checkers previously kept separate ideas of what was allowed and
 * promptly disagreed: the drift script reported 0 hardcoded colours while ESLint
 * reported 10, because the script allowlisted whole files and the rule had never
 * heard of the allowlist. Two tools contradicting each other about the same
 * codebase is worse than either one alone -- whichever number is inconvenient
 * gets dismissed as "the other tool says it's fine".
 *
 * One list, one set of reasons, both tools.
 */

/**
 * Files where a raw colour literal is correct.
 *
 * Every entry states why, because an allowlist without reasons becomes a place
 * to hide things. Prefer the inline `design-drift-allow: <reason>` marker where
 * only a line or two is involved -- a whole-file entry also excuses colours
 * added to that file tomorrow.
 */
const COLOR_ALLOWLIST = [
  {
    file: 'src/ErrorBoundary.jsx',
    reason: 'renders after the app has thrown; the stylesheet and its custom properties may never have loaded'
  },
  {
    file: 'src/components/admin/CertificateLayoutEditor.jsx',
    reason: 'hex IS the data here - the admin picks colours for certificate fields, and the swatches are the control'
  },
  {
    file: 'src/components/admin/ClusterGraph.jsx',
    reason: 'paints to canvas, which cannot resolve CSS custom properties'
  },
  {
    file: 'src/BrandingContext.jsx',
    reason: 'ships the fallback brand palette the tokens themselves are derived from'
  },
  {
    file: 'src/utils/deviceSignature.js',
    reason: 'canvas fingerprint seed - the colours are input to a hash, not anything a user sees, and changing them changes every device signature'
  }
]

/** Values that are not spacing steps and never should be. */
const SPACING_EXEMPT_PX = [
  0, // "none"
  1  // hairline rule
]

/**
 * Marker honoured by both checkers, on the same line or up to three above.
 * The reason is mandatory: a bare marker is ignored, because an opt-out nobody
 * had to justify is how a checker quietly stops checking.
 */
// The `m` flag matters. ESLint hands a rule the comment's INNER text, which for
// a multi-line block still contains newlines, so an unanchored `$` meant end of
// the whole comment -- a marker whose reason wrapped onto a second line simply
// failed to match. The drift script reads one line at a time and is unaffected
// either way, which is exactly how the two checkers ended up disagreeing.
const SUPPRESSION_PATTERN = /design-drift-allow:\s*(\S.*?)\s*(?:\*\/|$)/m

module.exports = {
  COLOR_ALLOWLIST,
  SPACING_EXEMPT_PX,
  SUPPRESSION_PATTERN,
  isColorAllowlisted(relPath) {
    const norm = String(relPath).split('\\').join('/')
    return COLOR_ALLOWLIST.some((entry) => norm.endsWith(entry.file))
  }
}
