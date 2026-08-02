// Setup Platform Settings - Run once to initialize admin panel
const pool = require('./db')

async function setupPlatformSettings() {
  console.log('=== Setting Up Platform Settings ===\n')
  
  try {
    // Ensure platform_settings table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
    console.log('✓ platform_settings table ready')

    // Insert admin token version
    await pool.query(`
      INSERT INTO platform_settings (key, value)
      VALUES ('admin_token_version', '1')
      ON CONFLICT (key) DO NOTHING
    `)
    console.log('✓ admin_token_version initialized')

    // Insert other required settings
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
      ['price_history_retain_days', '7']
    ]

    for (const [key, value] of settings) {
      await pool.query(`
        INSERT INTO platform_settings (key, value)
        VALUES ($1, $2)
        ON CONFLICT (key) DO NOTHING
      `, [key, value])
      console.log(`✓ ${key} = ${value}`)
    }

    console.log('\n=== Setup Complete ===')
    console.log('\nAdmin panel should now work correctly.')
    console.log('To reset admin sessions, run:')
    console.log("  UPDATE platform_settings SET value = (value::int + 1)::text WHERE key = 'admin_token_version';")
    
  } catch (err) {
    console.error('Setup error:', err.message)
  }
  
  process.exit(0)
}

setupPlatformSettings()

