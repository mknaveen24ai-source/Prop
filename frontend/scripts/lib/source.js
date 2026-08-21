'use strict'

/**
 * Source-scanning primitives shared by `design-drift.js` and
 * `responsive-drift.js`.
 *
 * These were extracted rather than copied. `design-tokens.config.js` already
 * records what happens when two checkers keep separate ideas about the same
 * codebase — the drift script reported 0 hardcoded colours while ESLint
 * reported 10, and "the other tool says it's fine" became a way to dismiss
 * whichever number was inconvenient. Comment stripping is the subtlest step in
 * either checker and the easiest to get quietly wrong in one copy only.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..', '..')
const SRC = path.join(ROOT, 'src')

/** Every file under src/ with one of the given extensions. */
function filesWithExt(extensions) {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full)
    }
  }
  walk(SRC)
  return out
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

/**
 * Blank out comments, preserving byte offsets so line numbers stay correct.
 *
 * Without this a checker reads its own documentation as evidence: the comment
 * explaining why a gold ramp was REPLACED cited the four hex values it removed,
 * and all four were promptly re-reported as hardcoded colours. A checker that
 * flags the note explaining a fix teaches people not to write the note.
 *
 * String-aware on purpose. A naive scan for "//" treats the slashes in
 * `href="https://..."` as the start of a comment and blanks the rest of that
 * line, silently hiding every violation after it -- a false PASS, which is the
 * one result these tools must never produce.
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null

  while (i < src.length) {
    const ch = src[i]

    if (quote) {
      // charCode 92 is a backslash. Compared numerically rather than written as
      // a literal so this line survives being edited through a shell heredoc,
      // which collapses the escaped form and silently produces a syntax error.
      if (ch.charCodeAt(0) === 92) { out += src.slice(i, i + 2); i += 2; continue }
      if (ch === quote) quote = null
      out += ch
      i++
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      i++
      continue
    }

    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }

    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      while (i < stop) { out += src[i] === '\n' ? '\n' : ' '; i++ }
      continue
    }

    out += ch
    i++
  }
  return out
}

/** CSS has only block comments, and no string-quoting subtleties worth tracking. */
function stripCssComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      while (i < stop) { out += src[i] === String.fromCharCode(10) ? src[i] : ' '; i++ }
      continue
    }
    out += src[i]
    i++
  }
  return out
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/**
 * Per-line opt-out honoured on the same line or up to three above.
 *
 * The reason is mandatory. A bare marker is not honoured -- an opt-out nobody
 * had to justify is how a checker quietly stops checking.
 *
 * A one-line lookback was too tight: a two-line reason puts the marker on the
 * FIRST of the two, which is already out of range, and the exception silently
 * failed to apply.
 */
function suppressionReason(lines, lineNumber, pattern) {
  const candidates = [
    lines[lineNumber - 1],
    lines[lineNumber - 2],
    lines[lineNumber - 3],
    lines[lineNumber - 4]
  ]
  for (const line of candidates) {
    if (!line) continue
    const m = line.match(pattern)
    if (m && m[1].length > 0) return m[1]
  }
  return null
}

/** Pull a numeric px scale out of a stylesheet: --space-1: 4px -> Set{4, ...}. */
function readScale(css, prefix) {
  const values = new Set()
  // `[ \t]*` rather than `\s*`: these patterns are assembled from strings, and a
  // lone backslash in an assembled pattern is one shell edit away from being
  // eaten, which turns `\s` into a literal `s` and the scale into an empty set.
  // An explicit character class cannot degrade that way.
  //
  // `-[a-z0-9-]+` rather than `-[a-z0-9]+`: the spacing scale has fractional
  // half-steps (--space-1-5), and a pattern stopping at the first hyphen would
  // silently skip every one while still reporting a scale.
  const re = new RegExp('--' + prefix + '-[a-z0-9-]+:[ \t]*([0-9.]+)px', 'gi')
  let m
  while ((m = re.exec(css))) values.add(parseFloat(m[1]))
  return values
}

/** Single token lookup: readToken(css, 'touch-min') -> 44. */
function readToken(css, name) {
  const m = css.match(new RegExp('--' + name + ':[ \t]*([0-9.]+)px'))
  return m ? parseFloat(m[1]) : null
}

module.exports = {
  ROOT,
  SRC,
  filesWithExt,
  rel,
  stripComments,
  stripCssComments,
  lineOf,
  suppressionReason,
  readScale,
  readToken
}
