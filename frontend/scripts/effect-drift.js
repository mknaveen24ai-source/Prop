#!/usr/bin/env node
/**
 * Ratchet for `react-hooks/set-state-in-effect`.
 *
 * ── Why this is a ratchet and not a gate ─────────────────────────────────────
 *
 * `npm run lint:correctness` gates every other correctness rule at zero. This
 * one rule is held to a ceiling instead, for the same reason `design:drift:ci`
 * is: the remaining hits are not defects, and pretending otherwise would mean
 * either turning the check off or bulk-editing working code.
 *
 * Every one of them was read. They are all the same shape:
 *
 *     useEffect(() => { fetchThing() }, [])
 *
 * where `fetchThing` sets a loading flag before its first `await`. That is the
 * documented, correct way to synchronise with an external system — the rule's
 * own message says so — but the compiler cannot see past the synchronous
 * setState at the top of the async function, so it reports every one.
 *
 * The genuine anti-pattern the rule exists to catch is state *derived from
 * props* being copied into an effect. Those were fixed rather than counted; the
 * residue here is the fetch-on-mount idiom, which the architectural fix is
 * TanStack Query (see src/hooks/useApiQuery.js), not a hundred disable
 * comments. Each migration to that hook lowers this number.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 *
 * The number may only go DOWN. Lower `--max` in package.json in the same commit
 * that lowers the count, exactly as `design:drift:ci` requires. A change that
 * adds a new set-state-in-effect fails here instead of being noticed a year
 * later.
 *
 *   node scripts/effect-drift.js            # report
 *   node scripts/effect-drift.js --detail   # every occurrence
 *   node scripts/effect-drift.js --max 102  # CI ceiling
 */
const path = require('node:path')
const { ESLint } = require('eslint')
const reactHooks = require('eslint-plugin-react-hooks')

const RULE = 'react-hooks/set-state-in-effect'
const argv = process.argv.slice(2)
const DETAIL = argv.includes('--detail')
const maxIndex = argv.indexOf('--max')
const MAX = maxIndex === -1 ? null : Number(argv[maxIndex + 1])

async function main() {
  const eslint = new ESLint({
    cwd: path.join(__dirname, '..'),
    // Only this rule is on. Reusing the main config and filtering afterwards
    // would work too, but would spend a full lint of every other rule to count
    // one -- and would silently change meaning if the base config ever turned
    // this rule off.
    overrideConfigFile: path.join(__dirname, '..', 'eslint.config.mjs'),
    // The plugin has to be re-declared here: an override block is its own flat
    // config object, and rule ids are resolved against the plugins that block
    // declares, not against the ones the base config happened to register.
    overrideConfig: {
      files: ['**/*.{js,jsx}'],
      plugins: { 'react-hooks': reactHooks },
      rules: { [RULE]: 'warn' }
    }
  })

  const results = await eslint.lintFiles(['.'])
  const hits = []
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId !== RULE) continue
      hits.push({
        file: path.relative(path.join(__dirname, '..'), result.filePath).split(path.sep).join('/'),
        line: message.line
      })
    }
  }

  const byFile = new Map()
  for (const hit of hits) byFile.set(hit.file, (byFile.get(hit.file) || 0) + 1)

  const line = '─'.repeat(72)
  console.log(line)
  console.log('  set-state-in-effect ratchet')
  console.log(line)
  console.log('')
  console.log('  total          ' + String(hits.length).padStart(5))
  console.log('  files          ' + String(byFile.size).padStart(5))
  if (MAX !== null) console.log('  ceiling        ' + String(MAX).padStart(5))
  console.log('')

  if (DETAIL) {
    for (const hit of hits) console.log('    ' + hit.file + ':' + hit.line)
  } else {
    console.log('  Most affected files')
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    for (const [file, count] of top) {
      console.log('    ' + String(count).padStart(3) + '  ' + file)
    }
    console.log('')
    console.log('  Run with --detail for every occurrence.')
  }
  console.log(line)

  if (MAX !== null && hits.length > MAX) {
    console.error('')
    console.error('  FAIL: ' + hits.length + ' set-state-in-effect findings exceeds the ceiling of ' + MAX + '.')
    console.error('  This number may only go down. If you removed some, lower --max in')
    console.error('  package.json in the same commit.')
    process.exitCode = 1
    return
  }
  if (MAX !== null && hits.length < MAX) {
    console.log('')
    console.log('  ' + (MAX - hits.length) + ' below the ceiling — lower --max to ' + hits.length + ' in package.json to lock the gain in.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
