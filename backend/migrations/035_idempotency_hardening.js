/**
 * Idempotency hardening (audit findings P2-11 / P2-12 / P3-20)
 * ─────────────────────────────────────────────────────────────────────────────
 * Three problems, one root cause: `idempotency_requests` had two competing
 * definitions and no retention.
 *
 * 1. TWO INDEXES, ONE NAME. Migration 004 created
 *    `idempotency_requests_scope_key_actor_uq` as a plain 4-column unique
 *    (scope, idempotency_key, tenant_id, actor_id). utils/idempotency.js created
 *    an index with the SAME NAME over a different expression
 *    (scope, idempotency_key, COALESCE(actor_id, '')). Whichever ran first won,
 *    and the other became a silent no-op because of `IF NOT EXISTS`.
 *
 *    That is not academic: beginIdempotentRequest now uses ON CONFLICT to close
 *    the insert race, and ON CONFLICT infers its target from the index. Against
 *    the wrong shape it raises `no unique or exclusion constraint matching the
 *    ON CONFLICT specification` — turning every duplicate-key request on a money
 *    endpoint into a 500. So the shape has to be pinned rather than assumed.
 *
 * 2. NO RETENTION. Nothing ever deleted a row. The table grows with every
 *    payout, trade open and account creation, forever.
 *
 * 3. RUNTIME DDL. utils/idempotency.js issued CREATE TABLE / CREATE INDEX from
 *    the request path. Migrations are the schema of record now (finding C-02),
 *    so that DDL is removed and this migration owns the shape.
 */

const UQ_INDEX = 'idempotency_requests_scope_key_actor_uq'

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('idempotency_requests')
  if (!hasTable) {
    await knex.schema.createTable('idempotency_requests', (table) => {
      table.bigIncrements('id').primary()
      table.text('actor_id').nullable()
      table.text('scope').notNullable()
      table.text('idempotency_key').notNullable()
      table.text('status').notNullable().defaultTo('started')
      table.integer('response_status').nullable()
      table.jsonb('response_body_json').notNullable().defaultTo('{}')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
  }

  // Normalise the unique index to the expression form the application relies on.
  // Dropped and recreated rather than left alone: on a database where 004 won,
  // the name exists with the wrong columns and every IF NOT EXISTS since has
  // skipped silently.
  const existing = await knex.raw(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ?`,
    [UQ_INDEX]
  )
  const indexDef = existing.rows[0]?.indexdef || ''
  const isExpressionForm = /COALESCE\(actor_id/i.test(indexDef)

  if (indexDef && !isExpressionForm) {
    await knex.raw(`DROP INDEX IF EXISTS ??`, [UQ_INDEX])
  }

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${UQ_INDEX}
      ON idempotency_requests (scope, idempotency_key, COALESCE(actor_id, ''))
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idempotency_requests_created_idx
      ON idempotency_requests (created_at DESC)
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idempotency_requests_scope_idx
      ON idempotency_requests (scope, created_at DESC)
  `)

  // Drives the stale-claim reaper: it only ever looks at rows still 'started',
  // which in a healthy system is a handful at any moment.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idempotency_requests_started_created_idx
      ON idempotency_requests (created_at)
      WHERE status = 'started'
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idempotency_requests_started_created_idx`)
  // The unique index and the table itself are left alone: they predate this
  // migration, and dropping them would take the replay protection with them.
}
