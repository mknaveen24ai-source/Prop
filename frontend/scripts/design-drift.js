#!/usr/bin/env node
'use strict'

/**
 * Design-token drift counter.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/design-drift.js              # summary
 *     node scripts/design-drift.js --detail     # every violation, with file:line
 *     node scripts/design-drift.js --json
 *     node scripts/design-drift.js --max <n>    # exit 1 above n violations (CI ratchet)
 *
 * ── Why this exists ──
 *
 * The brief that prompted this work put UI consistency at "74%" and the target at
 * "100%". Neither number was measurable, and several of its supporting claims
 * turned out to be wrong: it described thousands of raw hex colours in inline
 * styles, when the whole frontend contains 63 hex literals and 1,423 inline
 * styles already using var(--token).
 *
 * A percentage nobody can recompute drifts on its own. This script is the
 * definition of done: it counts specific, addressable violations, and every step
 * of the cleanup has to move a figure printed here.
 *
 * ── The scales are READ FROM tokens.css, never hardcoded ──
 *
 * That same brief asserted an 8-point spacing scale with --space-3 at 16px. The
 * real scale is 4-point and --space-3 is 12px. Had this script carried its own
 * copy of the scale it could have been wrong in exactly that way while reporting
 * full marks. Parsing the stylesheet means the checker and the tokens cannot
 * disagree.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')
const TOKENS = path.join(SRC, 'styles', 'tokens.css')

const DETAIL = process.argv.includes('--detail')
const JSON_OUT = process.argv.includes('--json')
const MAX = (() => {
  const i = process.argv.indexOf('--max')
  return i === -1 ? null : parseInt(process.argv[i + 1], 10)
})()

const { isColorAllowlisted, COLOR_ALLOWLIST, SUPPRESSION_PATTERN, hexColorScanner } =
  require('../design-tokens.config.js')

// Scanning primitives are shared with responsive-drift.js rather than copied
// into each. See scripts/lib/source.js for why: comment stripping is the
// subtlest step in either checker, and a divergence between two copies of it
// produces the one result neither tool may ever produce -- a false pass.
const {
  filesWithExt,
  rel,
  stripComments,
  stripCssComments,
  lineOf,
  readScale,
  suppressionReason: reasonFor
} = require('./lib/source.js')

const jsxFiles = () => filesWithExt(['.jsx'])

/**
 * Stylesheets are scanned too, and tokens.css itself is excluded.
 *
 * Leaving CSS out was a blind spot with an awkward shape: the checker enforced
 * the type scale in every component while components/ui/ui.css -- the design
 * system's own stylesheet, the thing components are supposed to defer to --
 * carried 22 hardcoded font sizes, and admin.css another 50. Holding JSX to a
 * standard the stylesheets do not meet is how a rule gets argued with.
 *
 * tokens.css is where the scale is DEFINED, so every value in it is a
 * definition rather than a use.
 */
function cssFiles() {
  return filesWithExt(['.css']).filter((f) => !f.endsWith('tokens.css'))
}

/**
 * Local wrapper so call sites stay `suppressionReason(lines, line)`; the shared
 * helper takes the marker pattern as an argument because the two checkers use
 * different markers.
 */
function suppressionReason(lines, lineNumber) {
  return reasonFor(lines, lineNumber, SUPPRESSION_PATTERN)
}

function main() {
  if (!fs.existsSync(TOKENS)) {
    console.error('tokens.css not found at ' + TOKENS)
    process.exit(2)
  }
  const css = fs.readFileSync(TOKENS, 'utf8')
  const spaceScale = readScale(css, 'space')
  const fontScale = readScale(css, 'fs')

  const files = jsxFiles()
  const findings = { color: [], fontSize: [], spacing: [], spacingLiteral: [] }
  const suppressed = []

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8')
    // Scan with comments blanked, but keep line numbers and suppression
    // markers resolving against the original, which still has them.
    const src = stripComments(raw)
    const srcLines = raw.split(String.fromCharCode(10))
    const relPath = rel(file)
    const record = (bucket, index, extra) => {
      const line = lineOf(src, index)
      const reason = suppressionReason(srcLines, line)
      if (reason) {
        suppressed.push({ file: relPath, line, reason, ...extra })
        return
      }
      findings[bucket].push({ file: relPath, line, ...extra })
    }

    // ── hardcoded colour ────────────────────────────────────────────────────
    //
    // A hex is only a violation when it is the ACTUAL value. Two shapes look
    // like hardcoded colour and are not:
    //
    //   var(--rule, #3A3733)          the CSS custom-property fallback
    //   getCssVar('--rule') || '#3A3733'   the same idea in JS, for canvas
    //
    // Both read the token first and fall back only if it cannot be resolved --
    // which is exactly what a chart painting to canvas has to do, since canvas
    // cannot resolve var(). Counting them made 12 of the 32 reported violations
    // unfixable by definition: removing the fallback would not tokenise
    // anything, it would just delete the safety net.
    //
    // Matched as patterns rather than by allowlisting the files, so a genuine
    // hardcoded colour added to Transparency.jsx tomorrow is still caught.
    if (!isColorAllowlisted(relPath)) {
      const fallbackRanges = []
      const fallbackPatterns = [
        /var\(\s*--[a-z0-9-]+\s*,\s*(#[0-9a-fA-F]{3,8})\s*\)/g,
        /\|\|\s*'(#[0-9a-fA-F]{3,8})'/g,
        /\|\|\s*"(#[0-9a-fA-F]{3,8})"/g,
        // A helper taking the token name and a fallback:
        //   readToken('--rule', '#3a3a3a')
        // Same semantic as the two above, different shape. Analytics.jsx builds
        // its whole canvas chart theme this way.
        /'--[a-z0-9-]+'\s*,\s*'(#[0-9a-fA-F]{3,8})'/g
      ]
      for (const pattern of fallbackPatterns) {
        let f
        while ((f = pattern.exec(src))) {
          const start = f.index + f[0].indexOf(f[1])
          fallbackRanges.push([start, start + f[1].length])
        }
      }
      const isFallback = (i) => fallbackRanges.some(([a, b]) => i >= a && i < b)

      // Only the four lengths CSS actually defines. The `{3,8}` range this
      // replaces also matched SEVEN hex characters, which is not a colour in
      // any syntax -- a trade ticket rendered as #4820194 was duly reported as
      // a hardcoded colour. Shared with the ESLint rule through
      // design-tokens.config.js so the two cannot drift apart on the question
      // of what a colour even is.
      const re = hexColorScanner()
      let m
      while ((m = re.exec(src))) {
        if (isFallback(m.index)) continue
        record('color', m.index, { value: m[0] })
      }
    }

    // ── font size off the scale ─────────────────────────────────────────────
    {
      const re = /fontSize:\s*'([0-9.]+)px'/g
      let m
      while ((m = re.exec(src))) {
        const value = parseFloat(m[1])
        if (fontScale.size === 0 || !fontScale.has(value)) {
          record('fontSize', m.index, { value: m[1] + 'px' })
        }
      }
    }

    // ── spacing ─────────────────────────────────────────────────────────────
    // Handles the shorthand forms too: `padding: '8px 10px'` accounts for 406
    // uses on its own, and counting only single values would understate the
    // surface by more than half.
    //
    // Split into two kinds, because they need different work. An ON-scale
    // literal like `padding: '16px'` renders correctly today and is a pure
    // rename to var(--space-4) -- scriptable, invisible. An OFF-scale literal
    // like `padding: '10px'` has no token and must move 2px one way or the
    // other, which is a judgement per surface.
    //
    // An earlier version counted only the off-scale kind, which matched neither
    // the fontSize check above nor the point of tokenising: a hardcoded 16px is
    // still a value that will not follow the scale if the scale ever changes.
    {
      // The value pattern is deliberately permissive. An earlier `'([0-9px\s]+)'`
      // required the WHOLE value to be digits, px and spaces, so it silently skipped
      // `padding: '20px clamp(16px, 4vw, 48px)'` and 16 others like it -- the counter
      // read 337 where the ESLint rule, which parses properly, read 365. A counter
      // that under-reports is the more dangerous direction: it makes the ceiling in
      // CI look met while drift accumulates behind it.
      const re = /(padding|margin|gap|rowGap|columnGap)[A-Za-z]*:\s*'([^']*)'/g
      let m
      while ((m = re.exec(src))) {
        const parts = m[2].match(/([0-9.]+)px/g) || []
        for (const part of parts) {
          const value = parseFloat(part)
          // 0 and 1px are legitimate outside a spacing scale: 0 is "none" and
          // 1px is a hairline rule, not a spacing step.
          if (value === 0 || value === 1) continue
          const bucket = spaceScale.has(value) ? 'spacingLiteral' : 'spacing'
          record(bucket, m.index, { value: part, prop: m[1] })
        }
      }
    }
  }

  // ── stylesheets ───────────────────────────────────────────────────────────
  // Same two scales, CSS syntax. Colour is not checked here: a stylesheet is
  // exactly where a raw colour SHOULD live, since that is what the tokens
  // themselves are made of.
  for (const file of cssFiles()) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = stripCssComments(raw)
    const srcLines = raw.split(String.fromCharCode(10))
    const relPath = rel(file)

    const record = (bucket, index, extra) => {
      const line = lineOf(src, index)
      const reason = suppressionReason(srcLines, line)
      if (reason) {
        suppressed.push({ file: relPath, line, reason, ...extra })
        return
      }
      findings[bucket].push({ file: relPath, line, ...extra })
    }

    {
      // Flags ANY hardcoded px, on-scale or not, matching how the JSX check
      // behaves. An earlier version here counted only off-scale values, so a
      // stylesheet full of `font-size: 13px` scored clean while the identical
      // value in a component was reported. Two rules for the same thing is how
      // a checker loses the argument.
      const re = /font-size:\s*([0-9.]+)px/gi
      let m
      while ((m = re.exec(src))) {
        record('fontSize', m.index, { value: m[1] + 'px' })
      }
    }

    {
      const re = /(padding|margin|gap|row-gap|column-gap)[a-z-]*:\s*([^;{}]+)[;}]/gi
      let m
      while ((m = re.exec(src))) {
        const parts = m[2].match(/([0-9.]+)px/g) || []
        for (const part of parts) {
          const value = parseFloat(part)
          if (value === 0 || value === 1) continue
          const bucket = spaceScale.has(value) ? 'spacingLiteral' : 'spacing'
          record(bucket, m.index, { value: part, prop: m[1] })
        }
      }
    }
  }

  // ── adoption of components that already exist ─────────────────────────────
  const adminPages = files.filter((f) => rel(f).includes('src/pages/admin/'))
  const adoption = {}
  for (const component of ['AdminDataTable', 'AdminModal', 'AdminBadge']) {
    const used = adminPages.filter((f) => fs.readFileSync(f, 'utf8').includes(component)).length
    adoption[component] = { used, of: adminPages.length }
  }
  const skeletonUsers = files.filter((f) => /Skeleton(Card|Table|Stats|Line|Text)/.test(fs.readFileSync(f, 'utf8'))).length

  const total = findings.color.length + findings.fontSize.length +
    findings.spacing.length + findings.spacingLiteral.length
  const result = {
    scales: {
      spacing: [...spaceScale].sort((a, b) => a - b),
      fontSize: [...fontScale].sort((a, b) => a - b)
    },
    filesScanned: files.length,
    cssScanned: cssFiles().length,
    violations: {
      color: findings.color.length,
      fontSize: findings.fontSize.length,
      spacing: findings.spacing.length,
      spacingLiteral: findings.spacingLiteral.length,
      total
    },
    adoption,
    skeletonUsers,
    allowlisted: COLOR_ALLOWLIST.length,
    suppressed,
    findings
  }

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  else report(result, findings)

  if (MAX !== null && total > MAX) {
    console.error('\ndesign-drift: ' + total + ' violations exceeds the ceiling of ' + MAX + '.')
    process.exit(1)
  }
}

function distribution(list, key) {
  const counts = {}
  for (const f of list) counts[f[key]] = (counts[f[key]] || 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

function report(r, findings) {
  const line = '='.repeat(66)
  console.log('Design token drift')
  console.log(line)
  console.log('  files scanned          ' + r.filesScanned + ' .jsx, ' + r.cssScanned + ' .css under src/')
  console.log('  spacing scale          ' + (r.scales.spacing.join(', ') || '(none found)'))
  console.log('  font-size scale        ' + (r.scales.fontSize.join(', ') || '(NONE DEFINED - see step 1)'))
  console.log('')
  console.log('  Violations')
  console.log('    hardcoded colour     ' + String(r.violations.color).padStart(5) +
    '   (' + r.allowlisted + ' files allowlisted with a reason)')
  console.log('    font-size off scale  ' + String(r.violations.fontSize).padStart(5))
  console.log('    spacing off scale    ' + String(r.violations.spacing).padStart(5) +
    '   (needs a human - each moves 1-4px)')
  console.log('    spacing untokenised  ' + String(r.violations.spacingLiteral).padStart(5) +
    '   (already on scale - pure rename)')
  console.log('    ' + 'total'.padEnd(20) + ' ' + String(r.violations.total).padStart(5))
  if (r.suppressed.length > 0) {
    console.log('    suppressed inline    ' + String(r.suppressed.length).padStart(5) +
      '   (each with a stated reason)')
  }
  console.log('')
  console.log('  Adoption of components that already exist')
  for (const [name, a] of Object.entries(r.adoption)) {
    const pct = a.of === 0 ? 0 : Math.round((a.used / a.of) * 100)
    console.log('    ' + name.padEnd(20) + String(a.used).padStart(3) + ' / ' + a.of +
      ' admin pages  (' + pct + '%)')
  }
  console.log('    ' + 'Skeleton*'.padEnd(20) + String(r.skeletonUsers).padStart(3) + ' files')
  console.log('')

  if (!DETAIL) {
    console.log('  Most common off-scale values')
    const sizes = distribution(findings.fontSize, 'value').slice(0, 6)
    const spaces = distribution(findings.spacing, 'value').slice(0, 6)
    if (sizes.length) {
      console.log('    font-size   ' + sizes.map(([v, n]) => v + ' x' + n).join('   '))
    }
    if (spaces.length) {
      console.log('    spacing     ' + spaces.map(([v, n]) => v + ' x' + n).join('   '))
    }
    console.log('')
    console.log('  Run with --detail for every occurrence.')
  } else {
    for (const [kind, list] of Object.entries(findings)) {
      if (!list.length) continue
      console.log('  -- ' + kind + ' (' + list.length + ') --')
      for (const f of list) console.log('    ' + f.file + ':' + f.line + '  ' + f.value)
      console.log('')
    }
  }
  console.log(line)
}

main()
