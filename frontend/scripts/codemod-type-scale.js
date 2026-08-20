#!/usr/bin/env node
'use strict'

/**
 * Codemod: hardcoded fontSize px -> type scale tokens.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/codemod-type-scale.js            # dry run, prints the diff summary
 *     node scripts/codemod-type-scale.js --write    # apply
 *
 * ── Scope: EXACT MATCHES ONLY ──
 *
 * This rewrites `fontSize: '13px'` to `fontSize: 'var(--fs-base)'` and nothing
 * else. A value is rewritten only when the scale contains that exact pixel size,
 * so the rendered result is byte-identical and the diff needs no visual review.
 *
 * The off-scale sizes -- 9.5, 10.5, 11.5, 12.5, 13.5, 15, 17, 19, 21, 23, 26,
 * 32, 34, 38px -- are deliberately NOT touched. Each would shift by 1-4px, which
 * is a design decision per surface, not a find-and-replace. Running this leaves
 * them behind on purpose so `design-drift.js` keeps reporting them until someone
 * has actually looked.
 *
 * That split is the whole point. Mixing 898 invisible replacements with 184
 * visible ones produces a diff nobody can review, and the visible ones then ship
 * unexamined inside it.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const TOKENS = path.join(SRC, 'styles', 'tokens.css')
const WRITE = process.argv.includes('--write')

/** Read px -> token name straight from tokens.css, so the two cannot diverge. */
function readTypeScale() {
  const css = fs.readFileSync(TOKENS, 'utf8')
  const map = new Map()
  const re = /--(fs-[a-z0-9]+):\s*([0-9.]+)px/gi
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
  const scale = readTypeScale()
  if (scale.size === 0) {
    console.error('No --fs-* tokens found in tokens.css. Define the type scale first.')
    process.exit(2)
  }

  let replaced = 0
  let skipped = 0
  const skippedValues = {}
  const touched = []

  for (const file of jsxFiles()) {
    const before = fs.readFileSync(file, 'utf8')
    let count = 0

    const after = before.replace(/fontSize:\s*'([0-9.]+)px'/g, (match, px) => {
      const token = scale.get(parseFloat(px))
      if (!token) {
        skipped++
        skippedValues[px + 'px'] = (skippedValues[px + 'px'] || 0) + 1
        return match
      }
      count++
      return "fontSize: 'var(--" + token + ")'"
    })

    if (count > 0) {
      replaced += count
      touched.push([path.relative(ROOT, file).split(path.sep).join('/'), count])
      if (WRITE) fs.writeFileSync(file, after)
    }
  }

  console.log(WRITE ? 'Applied' : 'Dry run (pass --write to apply)')
  console.log('='.repeat(62))
  console.log('  exact-match replacements  ' + replaced + '  across ' + touched.length + ' files')
  console.log('  left for human review     ' + skipped)
  console.log('')
  console.log('  Left behind, by value:')
  for (const [value, n] of Object.entries(skippedValues).sort((a, b) => b[1] - a[1])) {
    const px = parseFloat(value)
    const nearest = [...scale.keys()].reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a))
    console.log('    ' + value.padEnd(8) + ' x' + String(n).padEnd(4) +
      '  nearest token --' + scale.get(nearest) + ' (' + nearest + 'px, ' +
      (nearest > px ? '+' : '') + (nearest - px).toFixed(1) + 'px)')
  }
  console.log('')
  console.log('  Top files changed:')
  for (const [file, n] of touched.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log('    ' + String(n).padStart(4) + '  ' + file)
  }
  console.log('='.repeat(62))
}

main()
