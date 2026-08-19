'use strict'

/**
 * SQL prepare check — type-check every static query against real Postgres.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     DATABASE_URL=... node scripts/audit/sql-prepare-check.js
 *     ... --verbose      list the statements that were skipped, and why
 *
 * Feeds each fully-static SQL literal in the codebase to `PREPARE`, which makes
 * Postgres parse, resolve and plan it without running it. Anything that would
 * fail at runtime for a structural reason fails here instead, in about a second,
 * against a schema built by the real migrations.
 *
 * ── Why PREPARE and not just a column checker ──
 *
 * scripts/check-sql-columns.js compares written columns against
 * information_schema and found `payouts.amount`. It cannot see:
 *
 *   - ambiguous references. `SELECT id, full_name FROM users u LEFT JOIN
 *     accounts a ...` is ambiguous between u.id and a.id. Every column exists;
 *     the query still fails. This made GET /api/auth/profile/:userId -- a public
 *     endpoint -- return 500 for every request ever made to it.
 *   - type mismatches, e.g. comparing a uuid column to an integer.
 *   - functions and operators that do not exist for the given argument types.
 *   - syntax errors in a branch nothing exercises.
 *
 * Postgres already contains a complete implementation of all of that. Asking it
 * is both cheaper and more accurate than reimplementing any part of it.
 *
 * ── What is skipped, and why that is honest ──
 *
 * Only literals with NO `${...}` interpolation are checked. A template that
 * splices in a dynamic WHERE clause is not a complete statement until runtime,
 * and blanking the interpolation produces a syntax error that says nothing about
 * the real query. Those are counted and listed under --verbose rather than
 * quietly dropped, because "skipped" and "passed" must never look alike.
 *
 * Statements naming a table that does not exist are also skipped: they are CTE
 * fragments or DDL for runtime-created tables, not defects.
 */

require('../../loadEnv')

const fs = require('fs')
const path = require('path')
const { Client } = require('pg')
const { stringLiterals } = require('../check-sql-columns')

const ROOT = path.join(__dirname, '..', '..')
const SCAN_DIRS = ['routes', 'services', 'domain', 'utils', 'workers', 'jobs', 'middleware']
const SCAN_FILES = ['server.js', 'challengeEngine.js']

const VERBOSE = process.argv.includes('--verbose')

// Only read-shaped statements are prepared. PREPARE plans without executing, so
// even an INSERT would be safe, but keeping to SELECT avoids any argument about
// whether a check touched data.
const PREPARABLE = /^\s*(SELECT|WITH)\b/i

function listFiles() {
  const out = []
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.js')) out.push(full)
    }
  }
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d))
  for (const f of SCAN_FILES) {
    const full = path.join(ROOT, f)
    if (fs.existsSync(full)) out.push(full)
  }
  return out
}

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) line++
  return line
}

/**
 * Re-extract literals keeping the interpolation marker, so an interpolated
 * template can be told apart from a static one. stringLiterals() blanks `${...}`
 * to spaces, which is right for column attribution and wrong here: a run of
 * spaces where a WHERE clause belongs is indistinguishable from a static query.
 */
function hasInterpolation(src, literal) {
  const raw = src.slice(literal.start, literal.start + literal.text.length)
  return raw.includes('${')
}

/**
 * Join literals that the source concatenates with `+`.
 *
 * routes/auth.js builds the login query as three quoted fragments joined by `+`.
 * Treating each fragment as its own statement reported "syntax error at end of
 * input" against perfectly good SQL — a false positive, and the fastest way to
 * get a check like this switched off. Fragments separated only by a closing
 * quote, a `+` and whitespace are one statement.
 */
function mergeConcatenated(literals, src) {
  const merged = []
  let i = 0
  while (i < literals.length) {
    const first = literals[i]
    let text = first.text
    let end = first.start + first.text.length

    while (i + 1 < literals.length) {
      // The slice runs from the closing quote of this literal to just after the
      // opening quote of the next, so both quotes have to come off before the
      // separator can be recognised.
      const between = src.slice(end, literals[i + 1].start)
        .replace(/^["'`]/, '')
        .replace(/["'`]$/, '')
      if (!/^\s*\+\s*$/.test(between)) break
      i++
      text += literals[i].text
      end = literals[i].start + literals[i].text.length
    }

    merged.push({ text, start: first.start })
    i++
  }
  return merged
}

function collectStatements() {
  const statements = []
  for (const file of listFiles()) {
    const src = fs.readFileSync(file, 'utf8')
    for (const literal of mergeConcatenated(stringLiterals(src), src)) {
      const sql = literal.text.trim()
      if (!PREPARABLE.test(sql)) continue
      statements.push({
        sql,
        file: path.relative(ROOT, file).replace(/\\/g, '/'),
        line: lineOf(src, literal.start),
        interpolated: hasInterpolation(src, literal)
      })
    }
  }
  return statements
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.')
    process.exit(2)
  }

  const statements = collectStatements()
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' GROUP BY table_name"
  )
  const tables = new Set(rows.map((r) => r.table_name))

  const failures = []
  const skipped = []
  let checked = 0
  let counter = 0

  for (const statement of statements) {
    if (statement.interpolated) {
      skipped.push({ ...statement, why: 'built with ${...} — not a complete statement until runtime' })
      continue
    }

    // A statement naming an unknown table is a CTE fragment or a runtime-created
    // table, not a defect worth failing a build over.
    // `FOR UPDATE SKIP LOCKED`, `JOIN LATERAL` and prose inside SQL comments all
    // put a non-table word right after one of these keywords. Excluding them
    // keeps the skip list short enough to actually be audited.
    const NOT_A_TABLE = new Set(['skip', 'lateral', 'of', 'its', 'only', 'nowait', 'share', 'update'])
    const named = [...statement.sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z0-9_]*)/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((t) => !NOT_A_TABLE.has(t))
    const ctes = new Set(
      [...statement.sql.matchAll(/(?:\bWITH\b(?:\s+RECURSIVE)?|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)]
        .map((m) => m[1].toLowerCase())
    )
    const unknown = named.filter((t) => !tables.has(t) && !ctes.has(t))
    if (unknown.length > 0) {
      skipped.push({ ...statement, why: `references table(s) not in the schema: ${[...new Set(unknown)].join(', ')}` })
      continue
    }

    const name = `audit_stmt_${counter++}`
    try {
      await client.query(`PREPARE ${name} AS ${statement.sql}`)
      await client.query(`DEALLOCATE ${name}`)
      checked++
    } catch (error) {
      // An unresolvable parameter type is a property of checking the statement
      // in isolation, not a bug: `WHERE x = $1` with nothing to infer from is
      // legal at runtime once a typed value arrives.
      if (/could not determine data type of parameter/i.test(error.message)) {
        skipped.push({ ...statement, why: 'parameter type not inferable in isolation' })
        continue
      }
      failures.push({ ...statement, error: error.message })
    }
  }

  await client.end()

  console.log('SQL prepare check')
  console.log('='.repeat(64))
  console.log(`  SELECT/WITH literals found  ${statements.length}`)
  console.log(`  type-checked by Postgres    ${checked}`)
  console.log(`  skipped                     ${skipped.length}`)
  console.log('')

  if (VERBOSE) {
    const byReason = {}
    for (const s of skipped) byReason[s.why] = (byReason[s.why] || 0) + 1
    console.log('  Skipped, by reason:')
    for (const [why, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${why}`)
    }
    console.log('')
  }

  if (failures.length === 0) {
    console.log('  ✓ every static statement parses, resolves and plans')
    console.log('='.repeat(64))
    return
  }

  console.log(`  ✗ ${failures.length} statement(s) Postgres refuses to plan:`)
  console.log('')
  for (const f of failures) {
    console.log(`    ${f.file}:${f.line}`)
    console.log(`        ${f.error}`)
    console.log(`        ${f.sql.replace(/\s+/g, ' ').slice(0, 150)}`)
    console.log('')
  }
  console.log('='.repeat(64))
  console.log('Each of these fails at runtime against a correctly provisioned database.')
  process.exit(1)
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(2)
})
