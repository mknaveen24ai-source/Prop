/**
 * Core schema (audit finding C-02)
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing in this repository ever created `users`, `accounts`, `trades` or
 * `payouts`. 001_baseline_schema.js, despite the name, creates only
 * platform_settings; utils/bootstrap.js only ALTERs tables it assumes exist;
 * and 002_hot_path_indexes.js indexes `trades` directly. So on an empty
 * database `knex migrate:latest` failed at 002 with
 * `relation "trades" does not exist`.
 *
 * The schema for every money table therefore lived only inside whatever
 * database was hand-built once: no reproducible environment, no staging, no
 * disaster recovery, and no reviewable source of truth for the column types
 * that hold customer balances.
 *
 * This migration applies `000_core_schema.sql`, the committed dump of that
 * schema. Generate it with:
 *
 *     npm run schema:dump          # writes migrations/000_core_schema.sql
 *
 * It is a no-op on any database that already has the tables, so it is safe to
 * apply to production — existing environments record it and move on.
 *
 * ── Provisioning a CLEAN database uses `npm run schema:baseline`, not this ──
 *
 * The dump is the schema as it is TODAY, i.e. after every migration here has
 * already run. Applying it and then replaying 001..034 on top re-runs finished
 * steps against a finished schema, and the ones that assumed an intermediate
 * state fail — 005 indexes tenant_monthly_quotas(tenant_id), a column 008 later
 * drops, so it is not in the dump and the index cannot be built.
 *
 * scripts/baseline-schema.js applies the dump and records those migrations as
 * already applied, which is the only ordering that works. This file stays for
 * the existing-environment path, where it correctly no-ops.
 */

const fs = require('fs')
const path = require('path')

const SCHEMA_FILE = path.join(__dirname, '000_core_schema.sql')

exports.up = async function (knex) {
  const existing = await knex.raw(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'accounts'
    ) AS present
  `)

  if (existing.rows[0].present) {
    // Already-provisioned database (including every current environment).
    // Recording this migration without touching anything is the whole point.
    console.log('✓ core schema already present — nothing to apply')
    return true
  }

  if (!fs.existsSync(SCHEMA_FILE)) {
    throw new Error(
      'migrations/000_core_schema.sql is missing, and this database has no core tables.\n' +
      '\n' +
      'This is audit finding C-02: the repository cannot currently provision its\n' +
      'own database. Generate the file from a known-good environment with:\n' +
      '\n' +
      '    npm run schema:dump\n' +
      '\n' +
      'then commit migrations/000_core_schema.sql.'
    )
  }

  // Reaching here means a clean database is being provisioned through
  // migrate:latest, which cannot work — see the header. Fail with the command
  // that does, rather than applying the dump and letting 005 fail confusingly
  // several migrations later.
  throw new Error(
    'This database has no core tables, so it is being provisioned from scratch.\n' +
    '\n' +
    '`knex migrate:latest` cannot do that: 000_core_schema.sql is the CURRENT\n' +
    'schema, and replaying the later migrations on top of it re-applies finished\n' +
    'steps to a finished schema (005 indexes a column 008 drops, and fails).\n' +
    '\n' +
    'Use:\n' +
    '\n' +
    '    npm run schema:baseline     # applies the dump, records migrations as applied\n' +
    '    npx knex migrate:latest     # then runs anything newer than the dump\n'
  )
}

exports.down = async function () {
  // Deliberately not reversible. Rolling this back would drop every table
  // holding customer balances, and no migration should be one typo away from
  // that. Restore from a backup instead.
  throw new Error('000_core_schema is not reversible — restore from a backup instead')
}
