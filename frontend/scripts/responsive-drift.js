#!/usr/bin/env node
'use strict'

/**
 * Responsive / mobile drift counter.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/responsive-drift.js              # summary
 *     node scripts/responsive-drift.js --detail     # every violation, file:line
 *     node scripts/responsive-drift.js --json
 *     node scripts/responsive-drift.js --max <n>    # exit 1 above n (CI ratchet)
 *
 * ── Why this exists ──
 *
 * The brief that prompted this work scored "Responsive / Mobile" at 65% and set
 * the target at 100%. As with the UI-consistency brief before it, neither number
 * was recomputable and several supporting claims did not survive contact with
 * the tree:
 *
 *   - "~2,900 inline style objects contain hardcoded pixel dimensions" -- the
 *     frontend has 3,174 inline style objects in total, of which 272 carry a
 *     hardcoded px dimension. Its own example, `flexDirection: 'row'`, appears
 *     zero times.
 *   - "Pure browser single-page app, add a Web App Manifest" -- public/manifest.json
 *     already existed, complete with maskable icon, shortcuts and standalone
 *     display, linked from index.html.
 *   - "Add a dedicated Mobile Bottom Navigation Bar" -- .sidebar-mobile-bottom
 *     had already shipped, safe-area padding included.
 *
 * Acting on those numbers would have meant rebuilding working code while the
 * real defects went untouched. So this script replaces the percentage with
 * counts a person can reproduce, each of which shrinks for a specific reason.
 *
 * ── What it deliberately does NOT check ──
 *
 * Tap-target size. Whether a control ends up 44px tall depends on inherited
 * line-height, padding shorthand, box-sizing and which of six stylesheets wins
 * the cascade -- a static approximation would be confidently wrong in both
 * directions. That measurement belongs in a real browser at a real viewport,
 * and lives in e2e/tests/responsive.spec.js, which reads its device matrix from
 * the same source of truth this file does.
 */

const fs = require('fs')
const path = require('path')

const {
  SRC, filesWithExt, rel,
  stripComments, stripCssComments, lineOf, suppressionReason, readToken
} = require('./lib/source.js')
const { testViewports, narrowest, mobileMax } = require('./lib/viewports.js')

const TOKENS = path.join(SRC, 'styles', 'tokens.css')

const DETAIL = process.argv.includes('--detail')
const JSON_OUT = process.argv.includes('--json')
const MAX = (() => {
  const i = process.argv.indexOf('--max')
  return i === -1 ? null : parseInt(process.argv[i + 1], 10)
})()

/**
 * Mirrors `design-drift-allow:` deliberately, down to the mandatory reason.
 * A separate marker rather than a shared one, so silencing a layout exception
 * cannot also silence a token violation that happens to sit on the same line.
 */
const SUPPRESSION = /responsive-drift-allow:[ \t]*(\S.*?)[ \t]*(?:\*\/|$)/m

const NL = String.fromCharCode(10)

/* ── check 1: inline dimensions that cannot fit the narrowest device ───────── */
/*
 * Only `width` and `minWidth` are counted. `maxWidth` is a ceiling -- it can
 * never force a box wider than its container, so counting it would pad the
 * number with values that are not merely harmless but actively correct.
 *
 * The threshold is the narrowest viewport in the device matrix, not a constant
 * typed here. An element at or above it cannot fit that device however the CSS
 * around it is written, which is what separates a defect from a preference.
 */
/*
 * A fixed width is only a defect when nothing caps it. These two shapes look
 * like a hardcoded dimension and are not:
 *
 *   width: '300px', maxWidth: '100%'     grows to 300, shrinks below freely
 *   width: '600px', maxWidth: '95vw'     same, against the viewport
 *
 * Both are the correct way to write a preferred width, and `maxWidth` wins
 * whenever the container is narrower -- so neither can overflow anything.
 * Counting them made three of the first seven findings unfixable by definition:
 * the only way to "resolve" one would be to delete the cap, which is the
 * opposite of the intended change.
 *
 * This is the same correction design-drift.js already carries for
 * `var(--rule, #3A3733)`, and for the same reason -- a checker whose findings
 * cannot be acted on trains people to stop reading it.
 */
function isCapped(src, index) {
  const objStart = src.lastIndexOf('{{', index)
  if (objStart === -1) return false
  // Only look forward as far as the style object plausibly runs; a match far
  // outside it says nothing about this declaration.
  const objEnd = src.indexOf('}}', index)
  const scope = src.slice(objStart, objEnd === -1 ? index + 400 : objEnd)
  return /maxWidth:[ \t]*['"`][^'"`]*(%|vw|vmin|ch)/.test(scope) ||
         /maxWidth:[ \t]*['"`]?(min|clamp)\(/.test(scope)
}

function inlineOverflow(src, threshold) {
  const out = []
  const re = /\b(width|minWidth):[ \t]*'([0-9.]+)px'/g
  let m
  while ((m = re.exec(src))) {
    const value = parseFloat(m[2])
    if (value < threshold) continue
    if (m[1] === 'width' && isCapped(src, m.index)) continue
    out.push({ index: m.index, prop: m[1], value: m[2] + 'px' })
  }
  return out
}

/* ── check 2: tables with no mobile story ──────────────────────────────────── */
/*
 * A `<table>` needs one of two things below the md breakpoint: a wrapper that
 * scrolls it, or a card mode that replaces it. Neither is visible from the table
 * element alone, so this looks back over the markup that encloses it.
 *
 * The window is a heuristic and is documented as one. It is tuned to
 * over-report rather than under-report: a table wrapped six elements further up
 * reads as unwrapped and costs a human one look, which is the cheap failure.
 * The expensive failure would be calling an unwrapped table safe.
 */
const WRAPPER_HINTS = [
  'overflowx', 'overflow-x',
  'table-wrap', 'table-wrapper', 'lx-table-wrap', 'admin-table-wrapper',
  'table-scroll', 'mobilecard', 'mobile-card'
]

function unwrappedTables(src) {
  const out = []
  const re = /<table\b/g
  let m
  while ((m = re.exec(src))) {
    const before = src.slice(Math.max(0, m.index - 700), m.index).toLowerCase()
    const wrapped = WRAPPER_HINTS.some((h) => before.includes(h))
    if (!wrapped) out.push({ index: m.index, value: '<table> with no scroll wrapper or card mode' })
  }
  return out
}

/* ── check 3: screen-edge furniture with no safe-area padding ──────────────── */
/*
 * A `position: fixed` bar pinned to `bottom: 0` sits under the iPhone home
 * indicator, and one pinned to `top: 0` sits under the notch, unless it pads
 * itself clear. The tokens for this already exist in tokens.css; what is thin
 * is call sites, so the check is "does this rule reference one at all".
 *
 * ── fixed only, never sticky ──
 *
 * `fixed` is positioned against the viewport by definition, so a fixed element
 * at `bottom: 0` IS at the screen edge and the finding is sound without knowing
 * anything about its ancestors.
 *
 * `sticky` is positioned against its nearest scrolling ancestor, which no
 * static reading of a stylesheet can identify. Counting it reported `.admin-th`
 * and `thead th` -- sticky table headers, which are pinned to the top of a
 * scroll container and have never been near a notch. Four real findings arrived
 * alongside eight of those, and a checker that flags table headers as a
 * home-indicator bug is one people learn to skip. Sticky rules are still
 * surfaced, as a separate advisory that does not enter the total.
 *
 * Rule blocks are found by brace matching rather than by regex. A regex for
 * `{[^}]*}` stops at the first nested closing brace -- and @media wraps every
 * interesting rule in exactly that.
 */
function unsafeEdgeRules(css) {
  const violations = []
  const advisories = []
  const re = /position:[ \t]*(fixed|sticky)/g
  let m
  while ((m = re.exec(css))) {
    const open = css.lastIndexOf('{', m.index)
    if (open === -1) continue
    let depth = 1
    let i = open + 1
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
      i++
    }
    const block = css.slice(open, i)
    if (!/\b(bottom|top):[ \t]*0/.test(block)) continue
    if (block.includes('safe-')) continue

    const selStart = css.lastIndexOf('}', open) + 1
    const selector = css.slice(selStart, open).trim().split(NL).pop().trim() || '(rule)'
    const hit = { index: m.index, value: selector + ' -- ' + m[1] + ', no safe-area padding' }
    if (m[1] === 'fixed') violations.push(hit)
    else advisories.push(hit)
  }
  return { violations, advisories }
}

/* ── check 4: inline font sizes that re-trigger the iOS zoom ───────────────── */
/*
 * iOS Safari zooms the viewport when a focused form control renders below 16px
 * and never zooms back out. App.css and ui.css already guard against this with
 * a media query -- but an inline style beats a media query, so an inline
 * `fontSize` under the token on a control is the one way left to bring the bug
 * back.
 *
 * Scoped to form controls. A 9px inline label is fine, and counting it would
 * bury the handful that matter under sixty that do not.
 */
function iosZoomRisk(src, minFont) {
  const out = []
  const re = /<(input|select|textarea)\b/g
  let m
  while ((m = re.exec(src))) {
    // Bounded window rather than real tag parsing: a JSX attribute value can
    // contain '>' inside an expression, so scanning to the first '>' would cut
    // the tag short and miss the style prop that follows it.
    const tag = src.slice(m.index, m.index + 900)
    const stop = tag.search(/\/>/)
    const body = stop === -1 ? tag : tag.slice(0, stop)
    const f = body.match(/fontSize:[ \t]*'([0-9.]+)px'/)
    if (f && parseFloat(f[1]) < minFont) {
      out.push({
        index: m.index,
        value: '<' + m[1] + '> fontSize ' + f[1] + 'px is under ' + minFont + 'px'
      })
    }
  }
  return out
}

function main() {
  if (!fs.existsSync(TOKENS)) {
    console.error('tokens.css not found at ' + TOKENS)
    process.exit(2)
  }
  const tokens = fs.readFileSync(TOKENS, 'utf8')
  const touchMin = readToken(tokens, 'touch-min')
  const minFont = readToken(tokens, 'input-font-mobile')
  if (minFont === null || touchMin === null) {
    // Refusing to guess is the point of reading them. A default here would let
    // the checker keep reporting after its source of truth moved out from under
    // it -- passing for a reason that has nothing to do with the code.
    console.error('--touch-min / --input-font-mobile not found in tokens.css; refusing to guess.')
    process.exit(2)
  }
  const threshold = narrowest()

  const findings = { overflow: [], table: [], safeArea: [], iosZoom: [] }
  const suppressed = []
  const stickyAdvisories = []
  const jsx = filesWithExt(['.jsx'])
  const css = filesWithExt(['.css'])

  for (const file of jsx) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = stripComments(raw)
    const lines = raw.split(NL)
    const relPath = rel(file)

    const record = (bucket, hits) => {
      for (const hit of hits) {
        const line = lineOf(src, hit.index)
        const reason = suppressionReason(lines, line, SUPPRESSION)
        const entry = { file: relPath, line, value: hit.value, prop: hit.prop }
        if (reason) suppressed.push({ ...entry, reason })
        else findings[bucket].push(entry)
      }
    }

    record('overflow', inlineOverflow(src, threshold))
    record('table', unwrappedTables(src))
    record('iosZoom', iosZoomRisk(src, minFont))
  }

  for (const file of css) {
    const raw = fs.readFileSync(file, 'utf8')
    const src = stripCssComments(raw)
    const lines = raw.split(NL)
    const relPath = rel(file)

    const edges = unsafeEdgeRules(src)
    for (const hit of edges.violations) {
      const line = lineOf(src, hit.index)
      const reason = suppressionReason(lines, line, SUPPRESSION)
      const entry = { file: relPath, line, value: hit.value }
      if (reason) suppressed.push({ ...entry, reason })
      else findings.safeArea.push(entry)
    }
    for (const hit of edges.advisories) {
      stickyAdvisories.push({ file: relPath, line: lineOf(src, hit.index), value: hit.value })
    }
  }

  /* ── adoption ──────────────────────────────────────────────────────────────
   * Counted apart from violations because it measures the opposite thing: not
   * defects remaining, but reach of the fix. A card mode nothing calls is worth
   * zero however well it is written -- which is exactly the state Table.jsx's
   * `mobileCard` was found in: complete, correct, and used by two files.
   */
  const readAll = (f) => fs.readFileSync(f, 'utf8')
  const COMPONENTS = /(components[/\\]admin[/\\]AdminDataTable|components[/\\]ui[/\\]Table)\.jsx$/

  /*
   * A "table surface" is a page that puts a table in front of someone: one that
   * hand-rolls `<table>`, or one that mounts a shared table component. The two
   * component definitions themselves are excluded -- they are the mechanism,
   * not a surface, and counting them flatters the ratio by two.
   *
   * Card reach is credited through the component, not through the string. When
   * AdminDataTable defaults `mobileCard` on, all 28 pages that mount it gain a
   * card without a character changing in any of them; an earlier version of this
   * metric grepped for `mobileCard` and reported 3/25 for exactly that reason --
   * measuring which files mention a feature rather than which get it.
   */
  const surfaces = jsx.filter((f) => {
    if (COMPONENTS.test(f)) return false
    const s = readAll(f)
    return /<table\b/.test(s) || /AdminDataTable/.test(s)
  })
  const withCards = surfaces.filter((f) => {
    const s = readAll(f)
    if (/AdminDataTable/.test(s) && !/mobileCard=\{false\}/.test(s)) return true
    return /mobileCard/.test(s)
  })
  const adminPages = jsx.filter((f) => rel(f).includes('src/pages/admin/'))
  const adminWithTable = adminPages.filter((f) => /AdminDataTable|<table\b/.test(readAll(f)))

  const total = findings.overflow.length + findings.table.length +
    findings.safeArea.length + findings.iosZoom.length

  const result = {
    matrix: testViewports(),
    thresholds: { narrowestViewport: threshold, mobileMax: mobileMax(), touchMin, minFont },
    scanned: { jsx: jsx.length, css: css.length },
    violations: {
      overflow: findings.overflow.length,
      table: findings.table.length,
      safeArea: findings.safeArea.length,
      iosZoom: findings.iosZoom.length,
      total
    },
    adoption: {
      surfaces: surfaces.length,
      withCards: withCards.length,
      adminWithTable: adminWithTable.length,
      adminPages: adminPages.length
    },
    stickyAdvisories,
    suppressed,
    findings
  }

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  else report(result, findings)

  if (MAX !== null && total > MAX) {
    console.error(NL + 'responsive-drift: ' + total + ' violations exceeds the ceiling of ' + MAX + '.')
    process.exit(1)
  }
}

function distribution(list, key) {
  const counts = {}
  for (const f of list) if (f[key]) counts[f[key]] = (counts[f[key]] || 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

function report(r, findings) {
  const rule = '='.repeat(66)
  const pad = (n) => String(n).padStart(5)
  console.log('Responsive / mobile drift')
  console.log(rule)
  console.log('  files scanned          ' + r.scanned.jsx + ' .jsx, ' + r.scanned.css + ' .css under src/')
  console.log('  device matrix          ' + r.matrix.map((v) => v.name + ' ' + v.width).join(', '))
  console.log('  overflow threshold     ' + r.thresholds.narrowestViewport +
    'px  (narrowest device in the matrix)')
  console.log('  mobile below           ' + (r.thresholds.mobileMax + 1) + 'px')
  console.log('  touch / input tokens   ' + r.thresholds.touchMin + 'px, ' + r.thresholds.minFont + 'px')
  console.log('')
  console.log('  Violations')
  console.log('    inline fixed width   ' + pad(r.violations.overflow) +
    '   (wider than the narrowest device; CSS cannot reach it)')
  console.log('    table, no mobile     ' + pad(r.violations.table) +
    '   (no scroll wrapper, no card mode)')
  console.log('    no safe-area pad     ' + pad(r.violations.safeArea) +
    '   (edge-pinned bar under notch / home indicator)')
  console.log('    iOS zoom risk        ' + pad(r.violations.iosZoom) +
    '   (inline fontSize under the token, on a control)')
  console.log('    ' + 'total'.padEnd(20) + ' ' + pad(r.violations.total))
  if (r.suppressed.length > 0) {
    console.log('    suppressed inline    ' + pad(r.suppressed.length) + '   (each with a stated reason)')
  }
  if (r.stickyAdvisories.length > 0) {
    console.log('')
    console.log('    sticky, unjudged     ' + pad(r.stickyAdvisories.length) +
      '   (advisory: sticky is relative to a scroll')
    console.log('                              ancestor a stylesheet cannot name. Not in the total.)')
  }
  console.log('')
  console.log('  Reach of the patterns that already exist')
  const a = r.adoption
  const pct = (x, y) => (y === 0 ? 0 : Math.round((x / y) * 100))
  console.log('    table surfaces       ' + String(a.surfaces).padStart(3) +
    '   (pages showing a table, not the components)')
  console.log('    reached by cards     ' + String(a.withCards).padStart(3) +
    ' / ' + a.surfaces + '  (' + pct(a.withCards, a.surfaces) + '%)')
  console.log('    admin pages w/ table ' + String(a.adminWithTable).padStart(3) +
    ' / ' + a.adminPages + ' admin pages  (' + pct(a.adminWithTable, a.adminPages) + '%)')
  console.log('')

  if (!DETAIL) {
    const widths = distribution(findings.overflow, 'value').slice(0, 6)
    if (widths.length) {
      console.log('  Most common fixed widths')
      console.log('    ' + widths.map(([v, n]) => v + ' x' + n).join('   '))
      console.log('')
    }
    console.log('  Run with --detail for every occurrence.')
  } else {
    for (const [kind, list] of Object.entries(findings)) {
      if (!list.length) continue
      console.log('  -- ' + kind + ' (' + list.length + ') --')
      for (const f of list) console.log('    ' + f.file + ':' + f.line + '  ' + f.value)
      console.log('')
    }
  }
  console.log(rule)
}

main()
