'use strict'

/**
 * Reads the viewport matrix and breakpoint scale out of
 * `src/styles/breakpoints.js`.
 *
 * ── Why parse instead of import ──
 *
 * `breakpoints.js` is an ES module that ships in the browser bundle; this file
 * is required by a CommonJS Node script and by a Playwright spec that lives in
 * a different npm project. Parsing sidesteps the module-system mismatch without
 * duplicating a second copy of the numbers into either consumer.
 *
 * It is also the house pattern: `scripts/design-drift.js` parses `tokens.css`
 * rather than hardcoding the spacing scale, precisely because the brief that
 * prompted it asserted an 8-point scale for a codebase built on a 4-point one.
 * A checker carrying its own copy of the thing it checks can report full marks
 * while being wrong about what it measured.
 *
 * Failure here is fatal rather than defaulted. A checker that silently falls
 * back to built-in numbers when its source of truth moves is the exact failure
 * this indirection exists to prevent.
 */

const fs = require('fs')
const path = require('path')

const BREAKPOINTS_FILE = path.join(__dirname, '..', '..', 'src', 'styles', 'breakpoints.js')

function read() {
  if (!fs.existsSync(BREAKPOINTS_FILE)) {
    throw new Error('breakpoints.js not found at ' + BREAKPOINTS_FILE)
  }
  return fs.readFileSync(BREAKPOINTS_FILE, 'utf8')
}

/** `{ name, width, height, label }` for every entry in TEST_VIEWPORTS. */
function testViewports() {
  const src = read()
  const block = src.slice(src.indexOf('TEST_VIEWPORTS'))
  const end = block.indexOf('])')
  if (end === -1) throw new Error('TEST_VIEWPORTS array not found in breakpoints.js')

  const out = []
  const re = /name:\s*'([a-z]+)'\s*,\s*width:\s*(\d+)\s*,\s*height:\s*(\d+)\s*,\s*label:\s*'([^']*)'/g
  let m
  while ((m = re.exec(block.slice(0, end)))) {
    out.push({ name: m[1], width: Number(m[2]), height: Number(m[3]), label: m[4] })
  }
  if (out.length === 0) throw new Error('TEST_VIEWPORTS parsed to an empty list')
  return out
}

/** `{ sm, md, lg, xl }` from the BREAKPOINTS object. */
function breakpoints() {
  const src = read()
  const start = src.indexOf('BREAKPOINTS = Object.freeze({')
  if (start === -1) throw new Error('BREAKPOINTS object not found in breakpoints.js')
  const block = src.slice(start, src.indexOf('})', start))

  const out = {}
  const re = /([a-z]{2}):\s*(\d+)/g
  let m
  while ((m = re.exec(block))) out[m[1]] = Number(m[2])
  if (Object.keys(out).length === 0) throw new Error('BREAKPOINTS parsed to an empty object')
  return out
}

/**
 * The narrowest width in the matrix. An inline dimension at or above this
 * cannot fit the smallest device the suite claims to cover.
 */
function narrowest() {
  return testViewports().reduce((min, v) => Math.min(min, v.width), Infinity)
}

/** Below this width the app uses mobile layouts — mirrors MOBILE_MAX. */
function mobileMax() {
  return breakpoints().md - 1
}

module.exports = { testViewports, breakpoints, narrowest, mobileMax, BREAKPOINTS_FILE }
