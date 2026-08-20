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

const { isColorAllowlisted, COLOR_ALLOWLIST, SUPPRESSION_PATTERN } =
  require('../design-tokens.config.js')

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

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

/** Pull a numeric px scale out of tokens.css: --space-1: 4px -> Set{4, 8, ...}. */
function readScale(css, prefix) {
  const values = new Set()
  // `-[a-z0-9-]+` rather than `-[a-z0-9]+`: the spacing scale gained fractional
  // half-steps (--space-1-5), and a pattern stopping at the first hyphen would
  // silently skip every one while still reporting a scale.
  const re = new RegExp('--' + prefix + '-[a-z0-9-]+:' + '\\s*([0-9.]+)px', 'gi')
  let m
  while ((m = re.exec(css))) values.add(parseFloat(m[1]))
  return values
}

/**
 * Per-line opt-out: `design-drift-allow: <reason>` in a comment on the same line
 * or the line above.
 *
 * Preferred over the file-level allowlist, which is blunt: allowlisting
 * Transparency.jsx for its chart fallbacks would also hide a genuinely
 * hardcoded colour added to it next week. A line-level marker sits next to the
 * thing it excuses, and a reviewer reading the diff sees the reason without
 * opening another file.
 *
 * The reason is mandatory. A bare marker is not honoured -- an opt-out nobody
 * had to justify is how a checker quietly stops checking.
 */
function suppressionReason(lines, lineNumber) {
  // Same line, then up to three lines above. A one-line lookback was too tight:
  // a two-line reason puts the marker on the FIRST of the two, which is already
  // out of range, and the exception silently failed to apply.
  const candidates = [
    lines[lineNumber - 1],
    lines[lineNumber - 2],
    lines[lineNumber - 3],
    lines[lineNumber - 4]
  ]
  for (const line of candidates) {
    if (!line) continue
    const m = line.match(SUPPRESSION_PATTERN)
    if (m && m[1].length > 0) return m[1]
  }
  return null
}

/**
 * Blank out comments, preserving byte offsets so line numbers stay correct.
 *
 * Without this the checker reads its own documentation as evidence: the comment
 * explaining why CertificateCelebrationModal's gold ramp was REPLACED cited the
 * four hex values it removed, and all four were promptly re-reported as
 * hardcoded colours. A checker that flags the note explaining a fix teaches
 * people not to write the note.
 *
 * String-aware on purpose. A naive scan for "//" treats the slashes in
 * `href="https://..."` as the start of a comment and blanks the rest of that
 * line, silently hiding every violation after it -- a false PASS, which is the
 * one result this tool must never produce.
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null

  while (i < src.length) {
    const ch = src[i]

    if (quote) {
      if (ch === '\\') { out += src.slice(i, i + 2); i += 2; continue }
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

      const re = /#[0-9a-fA-F]{3,8}\b/g
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
