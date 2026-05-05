exports.up = async function(knex) {
  await knex.raw(`
    ALTER TABLE tenant_price_feeds
    ALTER COLUMN spread_markup_points_json DROP NOT NULL
  `).catch(() => {})

  await knex.raw(`
    ALTER TABLE tenant_price_feeds
    ALTER COLUMN spread_markup_points_json DROP DEFAULT
  `).catch(() => {})

  await knex.raw(`
    UPDATE tenant_price_feeds
       SET spread_markup_points_json = NULL
     WHERE spread_markup_points_json = '{}'::jsonb
  `).catch(() => {})

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
  await knex.raw(`
    ALTER TABLE tenant_price_feeds
    ALTER COLUMN spread_markup_points_json SET DEFAULT '{}'::jsonb
  `).catch(() => {})
  await knex.raw(`
    UPDATE tenant_price_feeds
       SET spread_markup_points_json = '{}'::jsonb
     WHERE spread_markup_points_json IS NULL
  `).catch(() => {})
  await knex.raw(`
    ALTER TABLE tenant_price_feeds
    ALTER COLUMN spread_markup_points_json SET NOT NULL
  `).catch(() => {})
}
