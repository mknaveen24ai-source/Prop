// Guards against a tracked file importing an untracked one.
//
// This is the "works on my machine" failure: a module exists in your working
// tree, everything you run passes, you commit the file that imports it but not
// the module itself, and the branch is dead on a fresh clone. It happened on
// this branch — routes/trades.js was committed while services/tradeEngine.js,
// services/tradeShared.js and utils/tradeIndex.js were still untracked.
//
// Local checks cannot see this because they run against the working tree. CI
// would catch it, but only once a PR to main exists. This runs in `npm run
// check`, so it fails before the commit rather than days later.
//
// Sibling of verify-admin-bindings.js, which checks the complementary problem:
// a module that exists but does not export the name being destructured.
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.resolve(__dirname, '../..')

// Comments and strings both contain require() calls that are not real imports:
// several services document their own import line in a JSDoc block, and the
// codegen scripts under tools/ build import lines as string literals to splice
// into other files.
//
// A regex cannot tell those apart from real imports, because the real import's
// own argument is itself a string. So scan once and record the span of every
// comment and string literal; a require( whose keyword starts inside one of
// those spans is not code. The argument quotes of a genuine require sit inside
// the match but the `require` keyword itself does not, which is what makes the
// distinction work.
function nonCodeSpans(source) {
  const spans = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      spans.push([i, stop]); i = stop; continue
    }
    if (c === '/' && next === '/') {
      let end = source.indexOf('\n', i)
      if (end === -1) end = source.length
      spans.push([i, end]); i = end; continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === c) break
        // An unterminated single/double quote means we mis-detected a quote
        // (an apostrophe in a comment we already skipped, say) — bail at the
        // newline rather than swallowing the rest of the file.
        if (c !== '`' && source[j] === '\n') break
        j++
      }
      spans.push([i, j + 1]); i = j + 1; continue
    }
    i++
  }
  return spans
}

function trackedFiles() {
  return execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean)
}

const tracked = new Set(trackedFiles())
const jsFiles = [...tracked].filter((f) => f.startsWith('backend/') && f.endsWith('.js'))

const failures = []

for (const file of jsFiles) {
  const absolute = path.join(REPO_ROOT, file)
  if (!fs.existsSync(absolute)) continue // staged deletion

  const source = fs.readFileSync(absolute, 'utf8')
  const spans = nonCodeSpans(source)
  const insideNonCode = (index) => spans.some(([s, e]) => index >= s && index < e)

  for (const m of source.matchAll(/require\(\s*['"](\.[^'"]*)['"]\s*\)/g)) {
    if (insideNonCode(m.index)) continue

    const spec = m[1]
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
    const candidates = [resolved, `${resolved}.js`, `${resolved}.json`, `${resolved}/index.js`]
    if (!candidates.some((c) => tracked.has(c))) {
      const line = source.slice(0, m.index).split('\n').length
      failures.push({ file, line, spec, resolved })
    }
  }
}

if (failures.length) {
  console.error('Tracked files importing untracked modules:\n')
  for (const f of failures) {
    console.error(`  ${f.file}:${f.line}`)
    console.error(`    require('${f.spec}')  ->  ${f.resolved}  (not tracked by git)`)
  }
  console.error('\nEither `git add` the missing module, or fix the path if it is wrong.')
  process.exit(1)
}

console.log(`tracked requires OK (${jsFiles.length} files)`)
