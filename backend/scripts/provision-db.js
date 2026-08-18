#!/usr/bin/env node
'use strict'
/**
 * Provision the database — correct on an empty one AND an existing one
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     npm run db:provision
 *
 * This is the ONLY database command a deployment should ever run. It is what
 * the compose `migrate` service and the Railway `startCommand` invoke, and it
 * is safe to run on every boot.
 *
 * ── The bug this exists to fix ──
 *
 * `npm run migrate` (knex migrate:latest) CANNOT provision a clean database, and
 * fails loudly by design: migrations/000_core_schema.js throws when it finds no
 * core tables, because the dump it would apply is the schema as it is TODAY and
 * replaying 001..NNN on top of a finished schema re-runs finished steps — 005
 * indexes a column 008 later drops, so it is absent from the dump and the index
 * cannot be built.
 *
 * Clean provisioning is therefore baseline-then-migrate, which is two commands.
 * Every caller was running only the second one:
 *
 *   - docker-compose.yml's `migrate` service ran `npm run migrate`. On a fresh
 *     volume it exited non-zero, and because `backend` waits on it via
 *     `service_completed_successfully`, NOTHING in the stack ever started.
 *   - backend/railway.json ran `npm run migrate && node server.js`, same result.
 *
 * CI did not catch it because .github/workflows/ci.yml open-coded
 * baseline-then-migrate in the workflow file — proving the migrations work while
 * never testing the command production actually runs. That is why this file
 * exists and why CI now calls it instead.
 *
 * ── What it does ──
 *
 *   empty database    →  baseline (apply the dump, stamp the manifest)
 *                        then migrate:latest for anything newer than the dump
 *   existing database →  migrate:latest only
 *
 * then asserts the result with scripts/verify-schema.js in both cases, so a
 * provision that "succeeds" while leaving a money column as `double precision`
 * fails here rather than silently discarding Decimal.js precision in production.
 *
 * Emptiness is decided by baseline-schema.js's own `isProvisioned()`. Two probes
 * that could disagree is exactly how a baseline ends up running against a live
 * database and marking migrations applied without running them.
 */

require('../loadEnv')

const pool = require('../db')
const knexfile = require('../knexfile')
const { baselineSchema, isProvisioned } = require('./baseline-schema')
const { verifySchema } = require('./verify-schema')

const ENVIRONMENT = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
  ? 'production'
  : 'development'

async function runMigrations() {
  // The knex API rather than a spawned `npx knex`: one less process, a real
  // error object instead of an exit code, and it uses the same knexfile the
  // `migrate` npm script does.
  const knex = require('knex')(knexfile[ENVIRONMENT])
  try {
    const [batch, applied] = await knex.migrate.latest()
    if (applied.length === 0) {
      console.log('  no pending migrations')
    } else {
      console.log(`  batch ${batch} — ${applied.length} migration(s) applied:`)
      for (const name of applied) console.log(`    ${name}`)
    }
  } finally {
    await knex.destroy()
  }
}

async function main() {
  console.log('\nDatabase provisioning')
  console.log('='.repeat(56))

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — nothing to provision.')
  }

  const provisioned = await isProvisioned()

  if (provisioned) {
    console.log('\nExisting database detected (core tables present).')
    console.log('\nApplying pending migrations...')
    await runMigrations()
  } else {
    console.log('\nEmpty database detected — provisioning from the committed schema.')
    const applied = await baselineSchema()
    if (!applied) {
      // baselineSchema only declines when the database turned out to be
      // provisioned after all, which isProvisioned() just said it was not.
      // Racing a second provisioner is the realistic cause, and continuing
      // would be guesswork.
      throw new Error('Baseline declined — the database changed underneath us. Re-run.')
    }
    console.log('\nApplying anything newer than the dump...')
    await runMigrations()
  }

  console.log('\nVerifying the result...')
  const failures = await verifySchema()
  if (failures !== 0) {
    throw new Error(`Schema verification failed with ${failures} problem(s) — see above.`)
  }

  console.log('='.repeat(56))
  console.log('Database provisioned.\n')
}

main()
  .then(async () => { await pool.end().catch(() => {}); process.exit(0) })
  .catch(async (error) => {
    console.error('\nProvisioning failed:', error.message)
    await pool.end().catch(() => {})
    process.exit(1)
  })
