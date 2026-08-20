#!/usr/bin/env node
'use strict'

/**
 * Codemod: hardcoded px in stylesheets -> scale tokens.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/codemod-css-tokens.js            # dry run
 *     node scripts/codemod-css-tokens.js --write    # apply
 *
 * The CSS counterpart to codemod-type-scale.js and codemod-spacing-scale.js, and
 * it follows the same rule: rewrite ONLY where the value already sits exactly on
 * a scale, so nothing moves on screen.
 *
 * ── Why the stylesheets needed this too ──
 *
 * The JSX codemods left components/ui/ui.css carrying 22 hardcoded font sizes
 * and admin.css another 50, because the checker only ever looked at .jsx. That
 * is the wrong way round: ui.css is the design system's own stylesheet, the file
 * components are supposed to defer to. Holding JSX to a standard the stylesheets
 * do not meet is how a rule gets argued with.
 *
 * ── Skipped on purpose ──
 *
 * tokens.css, where the scales are DEFINED -- every value there is a definition,
 * not a use.
 *
 * Media query conditions. `@media (min-width: 768px)` is a breakpoint, not
 * spacing, and rewriting it to a spacing token would be nonsense that happens to
 * parse.
 *
 * Anything inside `calc()`, `clamp()` or `var()`. A token nested in another
 * function is legal but harder to read than the number it replaced, and the
 * `var(--space-4, 16px)` fallback form would otherwise get rewritten into
 * `var(--space-4, var(--space-4))`.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const TOKENS = path.join(SRC, 'styles', 'tokens.css')
const WRITE = process.argv.includes('--write')

const SPACING_PROP = /^(padding|margin|gap|row-gap|column-gap|inset)(-[a-z]+)?$/

function readScale(prefix) {
  const css = fs.readFileSync(TOKENS, 'utf8')
  const map = new Map()
  const re = new RegExp('--(' + prefix + '-[a-z0-9-]+):' + '\\s*([0-9.]+)px', 'gi')
  let m
  while ((m = re.exec(css))) map.set(parseFloat(m[2]), m[1])
  return map
}

function cssFiles() {
  const out = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.css') && !entry.name.endsWith('tokens.css')) out.push(full)
    }
  }
  walk(SRC)
  return out
}

/** Byte ranges to leave alone: media queries and nested functions. */
function protectedRanges(css) {
  const ranges = []
  const media = /@(media|supports|container)[^{]*\{/g
  let m
  while ((m = media.exec(css))) ranges.push([m.index, m.index + m[0].length])

  const fn = /(calc|clamp|min|max|var)\(/g
  while ((m = fn.exec(css))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < css.length; i++) {
      if (css[i] === '(') depth++
      else if (css[i] === ')') { depth--; if (depth === 0) break }
    }
    ranges.push([m.index, i + 1])
  }
  return ranges
}

function main() {
  const spaceScale = readScale('space')
  const fontScale = readScale('fs')
  if (spaceScale.size === 0 || fontScale.size === 0) {
    console.error('Scales not found in tokens.css.')
    process.exit(2)
  }

  let fontReplaced = 0
  let spaceReplaced = 0
  const skipped = {}
  const touched = []

  for (const file of cssFiles()) {
    const before = fs.readFileSync(file, 'utf8')
    const guarded = protectedRanges(before)
    const isProtected = (i) => guarded.some(([a, b]) => i >= a && i < b)
    let count = 0

    // font-size: 13px  ->  font-size: var(--fs-base)
    let after = before.replace(/font-size:(\s*)([0-9.]+)px/gi, (match, ws, px, offset) => {
      if (isProtected(offset)) return match
      const token = fontScale.get(parseFloat(px))
      if (!token) {
        skipped['font-size ' + px + 'px'] = (skipped['font-size ' + px + 'px'] || 0) + 1
        return match
      }
      count++
      fontReplaced++
      return 'font-size:' + ws + 'var(--' + token + ')'
    })

    // padding: 8px 12px  ->  padding: var(--space-2) var(--space-4)
    after = after.replace(
      /(^|[;{}\s])([a-z-]+):(\s*)([^;{}]+?)(?=[;}])/gi,
      (match, lead, prop, ws, value, offset) => {
        if (isProtected(offset)) return match
        if (!SPACING_PROP.test(prop.toLowerCase())) return match
        if (/var\(|calc\(|clamp\(/.test(value)) return match

        const parts = value.trim().split(/\s+/)
        const rewritten = []
        for (const part of parts) {
          const px = parseFloat(part)
          if (part === '0' || px === 0 || px === 1) { rewritten.push(part); continue }
          if (!/^[0-9.]+px$/.test(part)) return match
          const token = spaceScale.get(px)
          if (!token) {
            skipped[prop + ' ' + part] = (skipped[prop + ' ' + part] || 0) + 1
            return match
          }
          rewritten.push('var(--' + token + ')')
        }
        if (rewritten.join(' ') === value.trim()) return match
        count++
        spaceReplaced++
        return lead + prop + ':' + ws + rewritten.join(' ')
      }
    )

    if (count > 0) {
      touched.push([path.relative(ROOT, file).split(path.sep).join('/'), count])
      if (WRITE) fs.writeFileSync(file, after)
    }
  }

  console.log(WRITE ? 'Applied' : 'Dry run (pass --write to apply)')
  console.log('='.repeat(64))
  console.log('  font-size tokenised   ' + fontReplaced)
  console.log('  spacing tokenised     ' + spaceReplaced)
  console.log('  files changed         ' + touched.length)
  console.log('')
  console.log('  Left for review (off-scale):')
  for (const [what, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log('    ' + String(n).padStart(4) + '  ' + what)
  }
  console.log('')
  for (const [file, n] of touched.sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    console.log('    ' + String(n).padStart(4) + '  ' + file)
  }
  console.log('='.repeat(64))
}

main()
