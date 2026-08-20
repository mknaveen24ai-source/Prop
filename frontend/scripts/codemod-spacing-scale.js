#!/usr/bin/env node
'use strict'

/**
 * Codemod: hardcoded spacing px -> --space-* tokens.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/codemod-spacing-scale.js            # dry run
 *     node scripts/codemod-spacing-scale.js --write    # apply
 *
 * Sibling of codemod-type-scale.js and follows the same rule: rewrite ONLY where
 * the value already sits exactly on the scale, so nothing moves on screen and
 * the diff needs no visual review.
 *
 * ── Shorthand is all-or-nothing ──
 *
 * `padding: '8px 12px'` becomes `var(--space-2) var(--space-4)` because both
 * halves are on the scale. `padding: '8px 10px'` is left entirely alone: 10px
 * has no token, and rewriting half of a declaration would leave
 * `var(--space-2) 10px` -- a line that looks tokenised, reviews as done, and
 * still carries the drift. Half-migrated is worse than untouched, because it
 * stops looking like work remaining.
 *
 * ── What is deliberately skipped ──
 *
 * 0 and 1px: 0 is "none" and 1px is a hairline rule. Neither is a spacing step,
 * and forcing them onto the scale would turn every hairline into 4px.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const TOKENS = path.join(SRC, 'styles', 'tokens.css')
const WRITE = process.argv.includes('--write')

const SPACING_PROPS = /(padding|margin|gap|rowGap|columnGap)([A-Za-z]*):\s*'([0-9px\s]+)'/g

function readSpacingScale() {
  const css = fs.readFileSync(TOKENS, 'utf8')
  const map = new Map()
  const re = /--(space-[0-9]+):\s*([0-9.]+)px/gi
  let m
  while ((m = re.exec(css))) map.set(parseFloat(m[2]), m[1])
  return map
}

function jsxFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsx')) out.push(full)
    }
  }
  walk(SRC)
  return out
}

function main() {
  const scale = readSpacingScale()
  if (scale.size === 0) {
    console.error('No --space-* tokens found in tokens.css.')
    process.exit(2)
  }

  let replaced = 0
  let skippedMixed = 0
  const skippedValues = {}
  const touched = []

  for (const file of jsxFiles()) {
    const before = fs.readFileSync(file, 'utf8')
    let count = 0

    const after = before.replace(SPACING_PROPS, (match, prop, suffix, value) => {
      const parts = value.trim().split(/\s+/)
      if (parts.length === 0) return match

      const rewritten = []
      let allMappable = true

      for (const part of parts) {
        const px = parseFloat(part)
        if (!/^[0-9.]+px$/.test(part)) { allMappable = false; break }
        // 0 and 1px stay literal, and do not disqualify the declaration.
        if (px === 0 || px === 1) { rewritten.push(part); continue }
        const token = scale.get(px)
        if (!token) {
          allMappable = false
          skippedValues[part] = (skippedValues[part] || 0) + 1
          break
        }
        rewritten.push('var(--' + token + ')')
      }

      if (!allMappable) {
        skippedMixed++
        return match
      }
      // Nothing actually changed (all 0/1px) -- leave the source alone.
      if (rewritten.join(' ') === value.trim()) return match

      count++
      return prop + suffix + ": '" + rewritten.join(' ') + "'"
    })

    if (count > 0) {
      replaced += count
      touched.push([path.relative(ROOT, file).split(path.sep).join('/'), count])
      if (WRITE) fs.writeFileSync(file, after)
    }
  }

  console.log(WRITE ? 'Applied' : 'Dry run (pass --write to apply)')
  console.log('='.repeat(64))
  console.log('  declarations tokenised    ' + replaced + '  across ' + touched.length + ' files')
  console.log('  left alone (off-scale)    ' + skippedMixed)
  console.log('')
  console.log('  Blocking values, by frequency:')
  for (const [value, n] of Object.entries(skippedValues).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const px = parseFloat(value)
    const below = [...scale.keys()].filter((v) => v < px).sort((a, b) => b - a)[0]
    const above = [...scale.keys()].filter((v) => v > px).sort((a, b) => a - b)[0]
    // 2px and 3px sit BELOW the smallest step, so there is no lower neighbour.
    // They are usually optical nudges -- an icon off a baseline, a tight badge --
    // rather than layout spacing, and rounding them up to 4px would visibly
    // fatten every badge on the platform. Reported as having no floor rather
    // than pretending there is one.
    const range = below === undefined
      ? 'below the scale floor (--' + scale.get(above) + ' is ' + above + 'px)'
      : 'between --' + scale.get(below) + ' (' + below + 'px) and --' + scale.get(above) + ' (' + above + 'px)'
    console.log('    ' + value.padEnd(7) + ' x' + String(n).padEnd(4) + '  ' + range)
  }
  console.log('')
  console.log('  Top files changed:')
  for (const [file, n] of touched.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log('    ' + String(n).padStart(4) + '  ' + file)
  }
  console.log('='.repeat(64))
}

main()
