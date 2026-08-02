/**
 * Initial baseline migration - captures current schema as of v1.0
 * 
 * Run this migration to set up all baseline tables.
 * Going forward, all schema changes should be done via new migrations.
 */

exports.up = async function(knex) {
  const tableExists = async (tableName) => {
    const result = await knex.raw(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = ?
      )
    `, [tableName])
    return result.rows[0].exists
  }

  // Platform Settings table
  if (!(await tableExists('platform_settings'))) {
    await knex.schema.createTable('platform_settings', (table) => {
      table.text('key').primary()
      table.text('value').notNullable()
    })
    console.log('✓ platform_settings table created')
  }

  // Insert default platform settings
  const settings = [
    ['phase1_profit_target_pct', '10'],
    ['phase1_max_drawdown_pct', '10'],
    ['phase1_day_limit', '30'],
    ['phase2_profit_target_pct', '5'],
    ['phase2_max_drawdown_pct', '5'],
    ['phase2_day_limit', '30'],
    ['funded_max_drawdown_pct', '4'],
    ['profit_share_pct', '75'],
    ['max_accounts_per_user', '5'],
    ['min_payout_amount', '50'],
    ['min_hold_seconds', '60'],
    ['forex_lots_per_1k', '0.10'],
    ['commodity_lots_per_1k', '0.02'],
    ['min_lot_size', '0.01'],
    ['max_trades_per_1k', '5'],
    ['max_open_positions', '10'],
    ['max_daily_trades', '20'],
    ['weekend_holding_enabled', 'true'],
    ['inactivity_auto_fail_enabled', 'true'],
    ['inactivity_fail_days', '30'],
    ['drawdown_type', 'trailing'],
    ['price_history_retain_days', '7'],
    ['dynamic_commission_per_lot', '3.00'],
    ['slippage_simulator_enabled', 'false'],
    ['slippage_max_pips_adverse', '2.0'],
    ['admin_token_version', '1']
  ]

  for (const [key, value] of settings) {
    await knex('platform_settings')
      .insert({ key, value })
      .onConflict('key')
      .merge()
    console.log(`✓ Setting ${key} = ${value}`)
  }

  return true
}

exports.down = async function(knex) {
  // Be careful with rollback - this drops all tables
  // Only use in development
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot rollback baseline migration in production')
  }

  await knex.schema.dropTableIfExists('platform_settings')
  console.log('✓ Rolled back to pre-baseline state')
  return true
}
