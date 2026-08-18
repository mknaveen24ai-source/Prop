#!/usr/bin/env node
'use strict'
/**
 * Detect SQL parameters bound to columns of conflicting types
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     node scripts/check-param-type-collisions.js
 *
 * ── The bug this catches ──
 *
 * `accounts.id` and `trades.account_id` are uuid. `trade_logs.account_id`,
 * `daily_pnl_records.account_id`, `disputes.account_id` and the admin_* tables
 * are text. That split is real and long-standing.
 *
 * A single statement that compares the SAME parameter to both is a runtime
 * failure, not a warning. Postgres resolves a parameter's type ONCE, from the
 * first context that determines it, so:
 *
 *     WHERE trades.account_id     = $1     -- $1 is now uuid
 *     WHERE trade_logs.account_id = $1     -- text = uuid  →  ERROR
 *
 * This shipped in routes/trades/open.js and broke EVERY trade open with a 500.
 * Nothing caught it: the unit tests mock the database, lint cannot see inside a
 * SQL string, and it only fires against a real Postgres with both tables
 * present.
 *
 * The fix is a cast on the PARAMETER (`$1::text`), never on the column — a cast
 * on the column would make the index unusable on the hot path.
 *
 * ── Scope ──
 *
 * Column types come from migrations/000_core_schema.sql, the schema of record,
 * so this tracks the real database rather than a hand-maintained list. Only
 * same-named columns compared to the same parameter within one SQL literal are
 * considered; a parameter already carrying an explicit `::cast` is treated as
 * deliberate and skipped.
 *
 * It reports what it can prove from a string, which is not everything. A clean
 * run is not proof that no such collision exists — it is proof that none of the
 * ones visible in a single template literal does.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const BACKEND_DIR = path.join(__dirname, '..')
const SCHEMA_FILE = path.join(BACKEND_DIR, 'migrations', '000_core_schema.sql')

// Columns worth tracking: ones that exist on many tables with inconsistent types.
const TRACKED_COLUMNS = ['account_id', 'user_id', 'trade_id']

/** table → { column → type }, read from the committed schema dump. */
function loadSchemaTypes() {
  if (!fs.existsSync(SCHEMA_FILE)) {
    throw new Error(
      'migrations/000_core_schema.sql is missing — cannot determine column types.\n' +
      'Generate it with: npm run schema:dump'
    )
  }
  const types = {}
  let table = null
  for (const line of fs.readFileSync(SCHEMA_FILE, 'utf8').split('\n')) {
    const create = line.match(/^CREATE TABLE public\.([a-z_0-9]+)/)
    if (create) { table = create[1]; types[table] = {}; continue }
    if (line.startsWith(')')) { table = null; continue }
    if (!table) continue
    const column = line.match(/^\s+([a-z_0-9]+)\s+([a-z ]+(?:\(\d+\))?)/)
    if (!column) continue
    const name = column[1]
    if (!TRACKED_COLUMNS.includes(name)) continue
    const raw = column[2].trim()
    // Everything that is not uuid is compared as text/varchar for our purposes.
    types[table][name] = raw === 'uuid' ? 'uuid' : 'text'
  }
  return types
}

/**
 * The table a comparison belongs to.
 *
 * Approximated by the nearest FROM/JOIN/UPDATE/INTO before it. That is right for
 * the single-table sub-selects this codebase uses throughout and wrong for a
 * multi-table join with an ambiguous unqualified column — which is why an
 * explicitly qualified `alias.column` is preferred when present.
 */
function tableFor(body, index, qualifier) {
  if (qualifier) return qualifier.toLowerCase()
  const before = body.slice(0, index)
  const tables = [...before.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+(?:ONLY\s+)?([a-z_0-9]+)/gi)]
  return tables.length ? tables[tables.length - 1][1].toLowerCase() : null
}

function sourceFiles() {
  const listed = execFileSync('git', ['ls-files', '*.js'], { cwd: BACKEND_DIR }).toString()
  return listed.split('\n').filter((file) =>
    file &&
    !file.startsWith('test/') &&
    !file.startsWith('migrations/') &&
    !file.startsWith('node_modules/')
  )
}

function main() {
  const schema = loadSchemaTypes()
  const findings = []

  for (const file of sourceFiles()) {
    const full = path.join(BACKEND_DIR, file)
    let src
    try { src = fs.readFileSync(full, 'utf8') } catch { continue }

    for (const literal of src.matchAll(/`([^`]*)`/g)) {
      const body = literal[1]
      if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue

      // param number → set of types it is compared against
      const paramTypes = new Map()

      for (const column of TRACKED_COLUMNS) {
        const pattern = new RegExp(
          `(?:([a-z_0-9]+)\\.)?\\b${column}\\s*=\\s*\\$(\\d+)(::[a-z]+)?`,
          'gi'
        )
        for (const match of body.matchAll(pattern)) {
          if (match[3]) continue                       // explicit cast — deliberate
          const table = tableFor(body, match.index, match[1])
          if (!table || !schema[table]) continue
          const type = schema[table][column]
          if (!type) continue
          const key = `$${match[2]}`
          if (!paramTypes.has(key)) paramTypes.set(key, new Map())
          paramTypes.get(key).set(type, `${table}.${column}`)
        }
      }

      for (const [param, types] of paramTypes) {
        if (types.size < 2) continue
        const line = src.slice(0, literal.index).split('\n').length
        findings.push({
          file,
          line,
          param,
          columns: [...types.entries()].map(([type, col]) => `${col} (${type})`)
        })
      }
    }
  }

  console.log('\nSQL parameter type-collision check')
  console.log('='.repeat(60))

  if (findings.length === 0) {
    console.log('\nNo parameter is compared to both a uuid and a text column.\n')
    return 0
  }

  for (const finding of findings) {
    console.log(`\n  ${finding.file}:${finding.line}`)
    console.log(`    ${finding.param} is compared to columns of different types:`)
    for (const column of finding.columns) console.log(`      ${column}`)
    console.log(`    Postgres resolves ${finding.param} once — this fails at runtime.`)
    console.log(`    Fix: cast the PARAMETER at the mismatched site, e.g. ${finding.param}::text`)
  }
  console.log(`\n${findings.length} collision(s) found.\n`)
  return 1
}

if (require.main === module) {
  try {
    process.exit(main())
  } catch (error) {
    console.error('\nCheck could not run:', error.message)
    process.exit(1)
  }
}

module.exports = { loadSchemaTypes }
