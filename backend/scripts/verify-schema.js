#!/usr/bin/env node
'use strict'
/**
 * Post-migration schema assertions (audit finding C-02)
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs in CI against a database that has just been migrated from empty. Two
 * things it proves that `knex migrate:latest` exiting 0 does not:
 *
 *   1. The core money tables actually exist. Before C-02 was found, the
 *      migration chain "succeeded" on databases where they had been created by
 *      hand, and failed only on a genuinely clean one.
 *
 *   2. Every money column is an exact numeric type. A `double precision`
 *      balance column silently discards the Decimal.js precision the whole
 *      application layer is built around, and no amount of care in
 *      calculatePnL can compensate for it.
 *
 *     node scripts/verify-schema.js
 */

require('../loadEnv')

const pool = require('../db')

const REQUIRED_TABLES = [
  'users', 'accounts', 'trades', 'payouts',
  'platform_settings', 'platform_admins', 'trade_logs'
]

const MONEY_COLUMNS = [
  ['accounts', 'current_balance'],
  ['accounts', 'starting_balance'],
  ['accounts', 'peak_balance'],
  ['trades', 'demo_pnl'],
  ['payouts', 'amount_requested'],
  ['payouts', 'amount_payable']
]

const EXACT_TYPES = new Set(['numeric', 'decimal'])

async function main() {
  let failures = 0
  console.log('\nSchema verification')
  console.log('='.repeat(56))

  console.log('\nCore tables')
  const tables = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [REQUIRED_TABLES]
  )
  const present = new Set(tables.rows.map((row) => row.table_name))
  for (const table of REQUIRED_TABLES) {
    if (present.has(table)) {
      console.log(`  ✓ ${table}`)
    } else {
      failures++
      console.log(`  ✗ ${table} is missing`)
    }
  }

  console.log('\nMoney columns use an exact numeric type')
  const columns = await pool.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (${
          MONEY_COLUMNS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ')
        })`,
    MONEY_COLUMNS.flat()
  )
  const types = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]))
  for (const [table, column] of MONEY_COLUMNS) {
    const key = `${table}.${column}`
    const type = types.get(key)
    if (!type) {
      failures++
      console.log(`  ✗ ${key.padEnd(32)} not found`)
    } else if (EXACT_TYPES.has(type)) {
      console.log(`  ✓ ${key.padEnd(32)} ${type}`)
    } else {
      failures++
      console.log(`  ✗ ${key.padEnd(32)} ${type} — must be NUMERIC`)
    }
  }

  console.log('\n' + '='.repeat(56))
  if (failures === 0) {
    console.log('Schema verified: a clean database provisions correctly.\n')
    return 0
  }
  console.log(`${failures} check(s) failed.\n`)
  return 1
}

main()
  .then(async (code) => { await pool.end().catch(() => {}); process.exit(code) })
  .catch(async (error) => {
    console.error('\nVerification could not run:', error.message)
    await pool.end().catch(() => {})
    process.exit(1)
  })
