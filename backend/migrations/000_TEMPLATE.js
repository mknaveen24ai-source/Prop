/**
 * Template Migration - Copy and modify this when creating new migrations
 * 
 * Usage:
 *   npm run migrate:make add_column_to_trades
 *   
 * Then update the generated file with your changes
 */

exports.up = async function(knex) {
  // Example: Adding a column
  // await knex.schema.table('trades', (table) => {
  //   table.string('new_column').notNullable().defaultTo('')
  // })

  // Example: Creating a new table
  // await knex.schema.createTable('new_table', (table) => {
  //   table.increments('id').primary()
  //   table.text('name').notNullable()
  //   table.timestamps()
  // })

  // Example: Creating an index
  // await knex.schema.table('trades', (table) => {
  //   table.index('user_id')
  // })

  // Example: Running raw SQL
  // await knex.raw('ALTER TABLE trades ADD CONSTRAINT check_status CHECK (status IN (?, ?))', ['open', 'closed'])

  console.log('✓ Migration applied')
  return true
}

exports.down = async function(knex) {
  // Reverse the change above
  // await knex.schema.table('trades', (table) => {
  //   table.dropColumn('new_column')
  // })

  console.log('✓ Migration rolled back')
  return true
}
