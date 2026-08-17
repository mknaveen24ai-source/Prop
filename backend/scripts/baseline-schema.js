#!/usr/bin/env node
'use strict'
/**
 * Provision a clean database from the committed schema (audit finding C-02)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     npm run schema:baseline        # then: npx knex migrate:latest
 *
 * ── Why `knex migrate:latest` alone cannot do this ──
 *
 * migrations/000_core_schema.sql is a dump of the CURRENT schema — the state
 * after every migration in the directory has already run. Replaying 001..034 on
 * top of it does not reproduce history, it re-applies finished steps to a
 * finished schema, and the ones that assumed an intermediate state fail:
 *
 *   005  indexes tenant_monthly_quotas(tenant_id), a column 008 later drops —
 *        so it is absent from the dump and the index cannot be built.
 *
 * That is not a bug in 005. It is what "replay history onto the end state"
 * always produces, and patching each migration to tolerate the final schema is
 * both endless and a good way to break the real upgrade path for existing
 * environments, which is the one that actually matters.
 *
 * So this script does what the situation calls for: apply the dump, then record
 * every migration the dump already contains as applied. `migrate:latest`
 * afterwards is a no-op — and any migration added AFTER the dump was taken runs
 * normally, which is the behaviour you want from then on.
 *
 * ── Safety ──
 *
 * Refuses to touch a database that already has an `accounts` table. Baselining
 * a live environment would mark migrations complete without running them, so
 * this fails closed rather than asking.
 */

require('../loadEnv')

const fs = require('fs')
const path = require('path')
const pool = require('../db')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations')
const SCHEMA_FILE = path.join(MIGRATIONS_DIR, '000_core_schema.sql')
const MANIFEST_FILE = path.join(MIGRATIONS_DIR, '000_core_schema.manifest.json')
const MIGRATIONS_TABLE = 'knex_migrations'

/**
 * Migrations whose effects the dump ALREADY contains.
 *
 * Read from the manifest that schema:dump writes, not from the directory
 * listing. Those two are the same set only until someone adds a migration after
 * the dump was taken — and stamping that one would record it as applied without
 * ever running it, leaving its changes missing from every clean database with
 * nothing to indicate why.
 *
 * No manifest means an old dump: fall back to the directory listing, but say so,
 * because that is the guess described above rather than a fact.
 */
function baselinedMigrations() {
  if (fs.existsSync(MANIFEST_FILE)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'))
    if (Array.isArray(manifest.migrations) && manifest.migrations.length > 0) {
      return { names: manifest.migrations, source: 'manifest' }
    }
  }

  // Every .js file, with no exclusions — the set has to match knex's own
  // enumeration or the difference is silently run afterwards. That includes
  // 000_TEMPLATE.js, which knex does not treat as special however much it looks
  // like documentation.
  const names = fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
  return { names, source: 'directory' }
}

async function main() {
  console.log('\nSchema baseline (C-02)')
  console.log('='.repeat(56))

  if (!fs.existsSync(SCHEMA_FILE)) {
    throw new Error(
      'migrations/000_core_schema.sql is missing.\n' +
      'Generate it from a known-good database with: npm run schema:dump'
    )
  }

  const provisioned = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'accounts'
    ) AS present
  `)
  if (provisioned.rows[0].present) {
    console.error(
      '\nRefusing to baseline: this database already has an `accounts` table.\n' +
      'Baselining marks migrations applied WITHOUT running them, which on a live\n' +
      'database would silently skip real schema changes.\n' +
      '\n' +
      'For an existing environment the correct command is `npx knex migrate:latest`.\n'
    )
    process.exitCode = 1
    return
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    console.log('\nApplying migrations/000_core_schema.sql...')
    await client.query(fs.readFileSync(SCHEMA_FILE, 'utf8'))

    // Knex's own bookkeeping tables, created here because knex has not run yet.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        batch INTEGER,
        migration_time TIMESTAMPTZ
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}_lock (
        index SERIAL PRIMARY KEY,
        is_locked INTEGER
      )
    `)
    const lock = await client.query(`SELECT COUNT(*)::int AS n FROM ${MIGRATIONS_TABLE}_lock`)
    if (lock.rows[0].n === 0) {
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE}_lock (is_locked) VALUES (0)`)
    }

    const { names, source } = baselinedMigrations()
    await client.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (name, batch, migration_time)
       SELECT unnest($1::text[]), 1, NOW()`,
      [names]
    )

    await client.query('COMMIT')

    console.log(`  applied — ${names.length} migrations recorded as baselined (from ${source})`)
    if (source === 'directory') {
      console.warn(
        '\n  WARNING: no 000_core_schema.manifest.json, so every migration file on disk was\n' +
        '  recorded as applied. Any migration added since the dump was taken has now been\n' +
        '  marked done WITHOUT running. Regenerate with `npm run schema:dump` to fix this.'
      )
    }
    console.log('\nNext: npx knex migrate:latest')
    console.log('      (runs anything added after the dump was taken)')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error('\nBaseline failed:', error.message)
    process.exitCode = 1
    await pool.end().catch(() => {})
  })
