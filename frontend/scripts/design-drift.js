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

/**
 * Files where a raw colour literal is correct, with the reason it is correct.
 *
 * An allowlist without reasons becomes a place to hide things. Each entry has to
 * survive being read aloud.
 */
const COLOR_ALLOWLIST = [
  ['src/ErrorBoundary.jsx',
    'renders after the app has thrown; the stylesheet and its custom properties may never have loaded'],
  ['src/components/admin/CertificateLayoutEditor.jsx',
    'hex IS the data here - the admin picks colours for certificate fields'],
  ['src/components/admin/ClusterGraph.jsx',
    'paints to canvas, which cannot resolve CSS custom properties'],
  ['src/BrandingContext.jsx',
    'ships the fallback brand palette the tokens themselves are derived from']
]

function isAllowlisted(relPath) {
  return COLOR_ALLOWLIST.some(([file]) => relPath === file)
}

/** Every .jsx under src/. */
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

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

/** Pull a numeric px scale out of tokens.css: --space-1: 4px -> Set{4, 8, ...}. */
function readScale(css, prefix) {
  const values = new Set()
  const re = new RegExp('--' + prefix + '-[a-z0-9]+:\\s*([0-9.]+)px', 'gi')
  let m
  while ((m = re.exec(css))) values.add(parseFloat(m[1]))
  return values
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
  const findings = { color: [], fontSize: [], spacing: [] }

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8')
    const relPath = rel(file)

    // ── hardcoded colour ────────────────────────────────────────────────────
    if (!isAllowlisted(relPath)) {
      const re = /#[0-9a-fA-F]{3,8}\b/g
      let m
      while ((m = re.exec(src))) {
        findings.color.push({ file: relPath, line: lineOf(src, m.index), value: m[0] })
      }
    }

    // ── font size off the scale ─────────────────────────────────────────────
    {
      const re = /fontSize:\s*'([0-9.]+)px'/g
      let m
      while ((m = re.exec(src))) {
        const value = parseFloat(m[1])
        if (fontScale.size === 0 || !fontScale.has(value)) {
          findings.fontSize.push({ file: relPath, line: lineOf(src, m.index), value: m[1] + 'px' })
        }
      }
    }

    // ── spacing off the scale ───────────────────────────────────────────────
    // Handles the shorthand forms too: `padding: '8px 10px'` accounts for 406
    // uses on its own, and counting only single values would understate the
    // surface by more than half.
    {
      const re = /(padding|margin|gap|rowGap|columnGap)[A-Za-z]*:\s*'([0-9px\s]+)'/g
      let m
      while ((m = re.exec(src))) {
        const parts = m[2].match(/([0-9.]+)px/g) || []
        for (const part of parts) {
          const value = parseFloat(part)
          // 0 and 1px are legitimate outside a spacing scale: 0 is "none" and
          // 1px is a hairline rule, not a spacing step.
          if (value === 0 || value === 1) continue
          if (!spaceScale.has(value)) {
            findings.spacing.push({ file: relPath, line: lineOf(src, m.index), value: part, prop: m[1] })
          }
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

  const total = findings.color.length + findings.fontSize.length + findings.spacing.length
  const result = {
    scales: {
      spacing: [...spaceScale].sort((a, b) => a - b),
      fontSize: [...fontScale].sort((a, b) => a - b)
    },
    filesScanned: files.length,
    violations: {
      color: findings.color.length,
      fontSize: findings.fontSize.length,
      spacing: findings.spacing.length,
      total
    },
    adoption,
    skeletonUsers,
    allowlisted: COLOR_ALLOWLIST.length,
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
  console.log('  files scanned          ' + r.filesScanned + ' .jsx under src/')
  console.log('  spacing scale          ' + (r.scales.spacing.join(', ') || '(none found)'))
  console.log('  font-size scale        ' + (r.scales.fontSize.join(', ') || '(NONE DEFINED - see step 1)'))
  console.log('')
  console.log('  Violations')
  console.log('    hardcoded colour     ' + String(r.violations.color).padStart(5) +
    '   (' + r.allowlisted + ' files allowlisted with a reason)')
  console.log('    font-size off scale  ' + String(r.violations.fontSize).padStart(5))
  console.log('    spacing off scale    ' + String(r.violations.spacing).padStart(5))
  console.log('    ' + 'total'.padEnd(20) + ' ' + String(r.violations.total).padStart(5))
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
