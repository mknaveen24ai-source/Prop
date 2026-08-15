#!/usr/bin/env node
'use strict'
/**
 * Generate migrations/000_core_schema.sql (audit finding C-02)
 * ─────────────────────────────────────────────────────────────────────────────
 * Run once, against a known-good database, then commit the output.
 *
 *     npm run schema:dump
 *
 * Requires `pg_dump` on PATH and DATABASE_URL set. Writes schema only — no
 * rows, no owners, no grants — so the file is portable across environments and
 * safe to commit.
 *
 * It also audits the column types that hold money, because that is the question
 * the audit could not answer from source: if `current_balance` turns out to be
 * `double precision`, every Decimal.js guarantee in the application is discarded
 * at the storage layer, and no amount of care in calculatePnL can fix it.
 */

require('../loadEnv')

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const pool = require('../db')

const OUTPUT = path.join(__dirname, '..', 'migrations', '000_core_schema.sql')

// Every column that holds an amount of money, and the table it lives on.
const MONEY_COLUMNS = [
  ['accounts', 'current_balance'],
  ['accounts', 'starting_balance'],
  ['accounts', 'peak_balance'],
  ['accounts', 'account_size'],
  ['accounts', 'profit_target'],
  ['trades', 'demo_pnl'],
  ['trades', 'commission'],
  ['trades', 'open_price'],
  ['trades', 'close_price'],
  ['payouts', 'amount_requested'],
  ['payouts', 'amount_payable']
]

const EXACT_TYPES = new Set(['numeric', 'decimal'])

async function auditMoneyColumns() {
  console.log('\nMoney column types')
  console.log('='.repeat(64))

  const result = await pool.query(
    `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (${
          MONEY_COLUMNS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
        })`,
    MONEY_COLUMNS.flat()
  )

  const found = new Map(result.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
  let inexact = 0
  let missing = 0

  for (const [table, column] of MONEY_COLUMNS) {
    const key = `${table}.${column}`
    const row = found.get(key)
    if (!row) {
      missing++
      console.log(`  ? ${key.padEnd(34)} not found`)
      continue
    }
    const precision = row.numeric_precision != null
      ? `(${row.numeric_precision},${row.numeric_scale})`
      : ''
    if (EXACT_TYPES.has(row.data_type)) {
      console.log(`  ✓ ${key.padEnd(34)} ${row.data_type}${precision}`)
    } else {
      inexact++
      console.log(`  ✗ ${key.padEnd(34)} ${row.data_type}  <-- BINARY FLOAT`)
    }
  }

  if (inexact > 0) {
    console.log(`\n  ${inexact} money column(s) use a binary float type.`)
    console.log('  Every Decimal.js guarantee in the application is lost at the')
    console.log('  storage layer for these. Migrate them to NUMERIC(15,2) before')
    console.log('  treating the balances as authoritative.')
  }
  if (missing > 0) {
    console.log(`\n  ${missing} expected column(s) were not found — check the names above`)
    console.log('  against the real schema; this list was derived from application code.')
  }
  return inexact
}

function dumpSchema() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL is not set')

  console.log('\nRunning pg_dump (schema only)...')
  const sql = execFileSync('pg_dump', [
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    '--no-comments',
    '--schema=public',
    connectionString
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  // knex_migrations tracks which migrations have run. Including it would make a
  // fresh database believe it had already applied everything.
  const filtered = sql
    .split(/\n(?=CREATE |ALTER |COPY |--)/)
    .filter((chunk) => !/knex_migrations/i.test(chunk))
    .join('\n')

  const header = [
    '--',
    '-- Core schema — committed dump (audit finding C-02).',
    '--',
    '-- Regenerate with: npm run schema:dump',
    '-- Applied by migrations/000_core_schema.js, which no-ops when the tables',
    '-- already exist. Do not hand-edit: write a new migration instead.',
    '--',
    `-- Generated: ${new Date().toISOString()}`,
    '--',
    ''
  ].join('\n')

  fs.writeFileSync(OUTPUT, header + filtered, 'utf8')
  const tables = (filtered.match(/CREATE TABLE/g) || []).length
  console.log(`  wrote ${path.relative(process.cwd(), OUTPUT)} — ${tables} tables, ${Math.round(filtered.length / 1024)} KB`)
}

async function main() {
  console.log('Core schema dump (C-02)')
  console.log('='.repeat(64))
  dumpSchema()
  const inexact = await auditMoneyColumns()

  console.log('\n' + '='.repeat(64))
  console.log('Next: commit migrations/000_core_schema.sql.')
  console.log('CI will then verify a clean database migrates from empty on every PR.')
  if (inexact > 0) console.log(`\nWARNING: ${inexact} money column(s) are binary floats — see above.`)
  console.log('')
  return 0
}

main()
  .then(async (code) => { await pool.end().catch(() => {}); process.exit(code) })
  .catch(async (error) => {
    console.error('\nFailed:', error.message)
    if (/ENOENT/.test(error.message)) {
      console.error('pg_dump was not found on PATH. Install the postgresql client tools.')
    }
    await pool.end().catch(() => {})
    process.exit(1)
  })
