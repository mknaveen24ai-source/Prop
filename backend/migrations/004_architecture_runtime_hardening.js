exports.up = async function(knex) {
  // tenant_price_feeds belongs to the tenant system that 008 removes, so it is
  // absent from a database provisioned from scratch.
  //
  // These three statements used to be `.catch(() => {})`, which cannot work:
  // knex runs each migration inside a transaction, and in Postgres ANY statement
  // error aborts the whole transaction. Catching the JavaScript rejection left
  // the transaction dead, so the createTable below failed with `current
  // transaction is aborted, commands ignored until end of transaction block` —
  // and migration 004 became the point at which a clean provision stopped.
  //
  // Invisible on every existing environment, where the table did exist when 004
  // first ran and where 004 is already recorded as applied.
  if (await knex.schema.hasTable('tenant_price_feeds')) {
    await knex.raw(`
      ALTER TABLE tenant_price_feeds
      ALTER COLUMN spread_markup_points_json DROP NOT NULL
    `)

    await knex.raw(`
      ALTER TABLE tenant_price_feeds
      ALTER COLUMN spread_markup_points_json DROP DEFAULT
    `)

    await knex.raw(`
      UPDATE tenant_price_feeds
         SET spread_markup_points_json = NULL
       WHERE spread_markup_points_json = '{}'::jsonb
    `)
  }

  const exists = await knex.schema.hasTable('idempotency_requests')
  if (!exists) {
    await knex.schema.createTable('idempotency_requests', (table) => {
      table.bigIncrements('id').primary()
      table.bigInteger('tenant_id').nullable().index()
      table.text('actor_id').nullable().index()
      table.text('scope').notNullable()
      table.text('idempotency_key').notNullable()
      table.text('status').notNullable().defaultTo('started')
      table.integer('response_status').nullable()
      table.jsonb('response_body_json').notNullable().defaultTo('{}')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.unique(['scope', 'idempotency_key', 'tenant_id', 'actor_id'], {
        indexName: 'idempotency_requests_scope_key_actor_uq'
      })
    })
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idempotency_requests_created_idx
      ON idempotency_requests(created_at DESC)
  `)
}

exports.down = async function(knex) {
  await knex.raw(`DROP INDEX IF EXISTS idempotency_requests_created_idx`)
  await knex.schema.dropTableIfExists('idempotency_requests')
  // Guarded rather than caught, for the same reason as up(): a swallowed error
  // still leaves the migration's transaction aborted.
  if (await knex.schema.hasTable('tenant_price_feeds')) {
    await knex.raw(`
      ALTER TABLE tenant_price_feeds
      ALTER COLUMN spread_markup_points_json SET DEFAULT '{}'::jsonb
    `)
    await knex.raw(`
      UPDATE tenant_price_feeds
         SET spread_markup_points_json = '{}'::jsonb
       WHERE spread_markup_points_json IS NULL
    `)
    await knex.raw(`
      ALTER TABLE tenant_price_feeds
      ALTER COLUMN spread_markup_points_json SET NOT NULL
    `)
  }
}
