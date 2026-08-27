#!/usr/bin/env node
'use strict'

/**
 * SQL column checker
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     DATABASE_URL=... node scripts/check-sql-columns.js
 *
 * Extracts every table.column reference the application's SQL actually writes,
 * and diffs it against information_schema on a live database.
 *
 * ── Why this exists ──
 *
 * `payouts.updated_at` did not exist in any migration, yet four code paths wrote
 * it (domain/payout.js approve, and reject/flag/unflag in routes/admin/payouts.js).
 * Every admin payout approve/reject/flag/unflag returned 500 against a correctly
 * provisioned database. Nothing caught it, because the payout tests mock the pg
 * pool — no SQL on that path had ever executed against real Postgres. It surfaced
 * only when someone happened to boot against a real database.
 *
 * A green test suite says nothing about whether a column exists. This does.
 *
 * ── What it parses ──
 *
 * Only text INSIDE string literals that look like SQL. An earlier draft scanned a
 * window of raw source after each SQL verb and ran straight off the end of the
 * string into the surrounding JavaScript, reporting `trades.push`, `payouts.js`
 * and `accounts.length` as missing columns. Bounding the scan to the literal is
 * what makes the output trustworthy enough to gate CI on.
 *
 * Within a literal it attributes a column only when the owning table is certain:
 *
 *   INSERT INTO t (a, b, c)      -> t.a, t.b, t.c
 *   UPDATE t SET a = $1, b = $2  -> t.a, t.b
 *   alias.col, with alias resolved through that literal's FROM/JOIN/UPDATE
 *
 * Bare column names in a SELECT list are NOT attributed: a multi-table join makes
 * the owning table ambiguous, and guessing would produce false positives. That is
 * an accepted blind spot. The failure mode this guards is a write to a column
 * nobody created, and writes are always attributable.
 *
 * A CTE name (`WITH recent AS (...)`) shadows nothing in information_schema, so
 * names bound by WITH are collected and excluded — otherwise every CTE column
 * would be reported missing.
 *
 * Run it against a FRESHLY PROVISIONED database, not a long-lived dev one. A dev
 * database accumulates columns from hand-run ALTERs and from migrations later
 * edited; only a clean `npm run db:provision` proves what production gets.
 */

require('../loadEnv')

const fs = require('fs')
const path = require('path')
const { Client } = require('pg')

const ROOT = path.join(__dirname, '..')
const SCAN_DIRS = ['routes', 'services', 'domain', 'utils', 'workers', 'jobs', 'middleware']
const SCAN_FILES = ['server.js', 'challengeEngine.ts']

// Postgres system columns exist on every table but are absent from
// information_schema.columns.
const SYSTEM_COLUMNS = new Set(['ctid', 'xmin', 'xmax', 'cmin', 'cmax', 'tableoid', 'oid'])

// Identifiers that look like columns but are SQL, not schema.
const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'as', 'on',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'cross', 'lateral',
  'group', 'order', 'by', 'having', 'limit', 'offset', 'union', 'all', 'distinct',
  'case', 'when', 'then', 'else', 'end', 'exists', 'between', 'like', 'ilike',
  'asc', 'desc', 'nulls', 'first', 'last', 'with', 'recursive', 'returning',
  'insert', 'into', 'values', 'update', 'set', 'delete', 'conflict', 'do',
  'nothing', 'excluded', 'default', 'true', 'false', 'coalesce', 'count', 'sum',
  'avg', 'min', 'max', 'now', 'interval', 'cast', 'using', 'for', 'of', 'skip',
  'locked', 'share', 'current_timestamp', 'current_date', 'array', 'any', 'only',
  'unnest', 'generate_series', 'date_trunc', 'extract', 'over', 'partition'
])

// A literal must contain one of these to be treated as SQL at all.
const SQL_SHAPE = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i

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
 * Pull every string literal out of a JS source: template literals, single- and
 * double-quoted. Returns [{ text, start }]. Interpolations inside a template are
 * blanked to spaces so a `${cond ? 'a' : 'b'}` fragment cannot masquerade as SQL,
 * while byte offsets stay aligned with the original file for line numbers.
 */
function stringLiterals(src) {
  const out = []
  const quote = { 96: 96, 39: 39, 34: 34 } // ` ' "
  let i = 0
  while (i < src.length) {
    const code = src.charCodeAt(i)

    // Skip comments so commented-out SQL is not scanned.
    if (code === 47 && src.charCodeAt(i + 1) === 47) {
      while (i < src.length && src.charCodeAt(i) !== 10) i++
      continue
    }
    if (code === 47 && src.charCodeAt(i + 1) === 42) {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }

    if (!quote[code]) { i++; continue }

    const open = code
    const start = i + 1
    let j = start
    let text = ''
    let closed = false
    while (j < src.length) {
      const c = src.charCodeAt(j)
      if (c === 92) { text += '  '; j += 2; continue }          // escape
      if (c === open) { closed = true; break }
      if (open !== 96 && c === 10) break                         // unterminated
      if (open === 96 && c === 36 && src.charCodeAt(j + 1) === 123) {
        // ${ ... } — blank it, tracking brace depth
        let depth = 1
        let k = j + 2
        while (k < src.length && depth > 0) {
          const d = src.charCodeAt(k)
          if (d === 123) depth++
          else if (d === 125) depth--
          k++
        }
        text += ' '.repeat(k - j)
        j = k
        continue
      }
      text += src[j]
      j++
    }
    if (closed && text.length > 0) out.push({ text, start })
    i = closed ? j + 1 : j
  }
  return out
}

/** Record one reference. `refs` maps 'table.column' -> Set of 'file:line'. */
function record(refs, table, column, file, line) {
  const t = String(table || '').toLowerCase()
  const c = String(column || '').toLowerCase()
  if (!t || !c) return
  if (SQL_KEYWORDS.has(c) || SQL_KEYWORDS.has(t)) return
  if (SYSTEM_COLUMNS.has(c)) return
  if (!/^[a-z_][a-z0-9_]*$/.test(t) || !/^[a-z_][a-z0-9_]*$/.test(c)) return
  const key = `${t}.${c}`
  if (!refs.has(key)) refs.set(key, new Set())
  refs.get(key).add(`${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}`)
}

/** Names bound by WITH ... AS ( — these are not real tables. */
function cteNames(sql) {
  const names = new Set()
  const re = /(?:\bWITH\b(?:\s+RECURSIVE)?|,)\s*([a-z_][a-z0-9_]*)\s+AS\s*(?:MATERIALIZED\s*)?\(/gi
  let m
  while ((m = re.exec(sql))) names.add(m[1].toLowerCase())
  return names
}

/** Alias map for one SQL literal: 'a' -> 'accounts', plus each table as itself. */
function aliasMap(sql, ctes) {
  const aliases = new Map()
  const re = /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi
  let m
  while ((m = re.exec(sql))) {
    const table = m[1].toLowerCase()
    if (SQL_KEYWORDS.has(table) || ctes.has(table)) continue
    aliases.set(table, table)
    const alias = (m[2] || '').toLowerCase()
    if (alias && !SQL_KEYWORDS.has(alias) && !ctes.has(alias)) aliases.set(alias, table)
  }
  // A CTE alias must win over an identically-named real table.
  for (const cte of ctes) aliases.delete(cte)
  return aliases
}

/** Split on commas at paren depth 0. */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = '' }
    else current += ch
  }
  parts.push(current)
  return parts
}

function scanSql(sql, refs, file, baseLine, src, base) {
  const ctes = cteNames(sql)
  const at = (offset) => lineOf(src, base + offset)
  let m

  // INSERT INTO t (a, b, c)
  const insertRe = /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi
  while ((m = insertRe.exec(sql))) {
    const table = m[1].toLowerCase()
    if (ctes.has(table)) continue
    const line = at(m.index)
    for (const raw of m[2].split(',')) {
      const col = raw.trim()
      if (/^[a-z_][a-z0-9_]*$/i.test(col)) record(refs, table, col, file, line)
    }
  }

  // UPDATE t SET a = ..., b = ...
  const updateRe = /UPDATE\s+([a-z_][a-z0-9_]*)\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|$)/gi
  while ((m = updateRe.exec(sql))) {
    const table = m[1].toLowerCase()
    if (ctes.has(table)) continue
    const line = at(m.index)
    for (const part of splitTopLevel(m[2])) {
      const col = part.trim().split(/\s*=/)[0].trim()
      if (/^[a-z_][a-z0-9_]*$/i.test(col)) record(refs, table, col, file, line)
    }
  }

  // Qualified references: alias.column
  const aliases = aliasMap(sql, ctes)
  if (aliases.size > 0) {
    const qualRe = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi
    let q
    while ((q = qualRe.exec(sql))) {
      const table = aliases.get(q[1].toLowerCase())
      if (!table) continue
      record(refs, table, q[2], file, at(q.index))
    }
  }
  void baseLine
}

function scanFile(file, refs) {
  const src = fs.readFileSync(file, 'utf8')
  for (const literal of stringLiterals(src)) {
    if (!SQL_SHAPE.test(literal.text)) continue
    scanSql(literal.text, refs, file, lineOf(src, literal.start), src, literal.start)
  }
  return refs
}

/**
 * Parse one JavaScript source string and return a Map of 'table.column' ->
 * Set of line numbers. Exported so the parser can be tested without a database:
 * a detector that silently stops detecting is worse than no detector, because
 * the check still reports success.
 */
function extractReferences(source, label = 'inline.js') {
  const refs = new Map()
  for (const literal of stringLiterals(source)) {
    if (!SQL_SHAPE.test(literal.text)) continue
    scanSql(literal.text, refs, label, lineOf(source, literal.start), source, literal.start)
  }
  return refs
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.')
    process.exit(2)
  }

  const refs = new Map()
  const files = listFiles()
  for (const file of files) scanFile(file, refs)

  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  const { rows } = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
  )
  await client.end()

  const tables = new Set(rows.map((r) => r.table_name))
  const columns = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`))

  const verbose = process.argv.includes('--verbose')
  const unknownTables = new Set()
  const missing = []
  let checked = 0
  let skippedUnknownTable = 0

  for (const [key, sites] of refs) {
    const table = key.split('.')[0]
    // A table absent from the schema is a CTE, a subquery alias, or a parse
    // artefact — not a defect. Counting those as failures would make the check
    // noisy enough to be ignored, which is worse than a narrower check trusted.
    if (!tables.has(table)) {
      skippedUnknownTable++
      if (verbose) unknownTables.add(table)
      continue
    }
    checked++
    if (!columns.has(key)) missing.push([key, [...sites]])
  }

  console.log('SQL column check')
  console.log('='.repeat(64))
  console.log(`  files scanned            ${files.length}`)
  console.log(`  table.column references  ${refs.size}`)
  console.log(`  checked against schema   ${checked}`)
  console.log(`  skipped (unknown table)  ${skippedUnknownTable}`)
  if (verbose && unknownTables.size > 0) {
    console.log(`    names not in the schema: ${[...unknownTables].sort().join(', ')}`)
  }
  console.log('')

  if (missing.length === 0) {
    console.log('  ✓ every referenced column exists')
    console.log('='.repeat(64))
    return
  }

  console.log(`  ✗ ${missing.length} reference(s) to columns that do not exist:`)
  console.log('')
  for (const [key, sites] of missing.sort()) {
    console.log(`    ${key}`)
    for (const site of sites.slice(0, 6)) console.log(`        ${site}`)
    if (sites.length > 6) console.log(`        ... and ${sites.length - 6} more`)
  }
  console.log('')
  console.log('='.repeat(64))
  console.log('These will fail at runtime against a correctly provisioned database.')
  process.exit(1)
}

module.exports = { extractReferences, stringLiterals, cteNames, aliasMap }

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(2)
  })
}
