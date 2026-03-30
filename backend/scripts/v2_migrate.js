const { Pool } = require('pg');
require('dotenv').config({ path: '.env' });
console.log('Using DB URL:', process.env.DATABASE_URL);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const c = await pool.connect();
  try {
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS parent_trade_id INTEGER');
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS is_partial BOOLEAN DEFAULT false');
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission NUMERIC(15,2) DEFAULT 0');
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS notes TEXT');
    await c.query("ALTER TABLE trades ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb");
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_activation_price NUMERIC(15,5)');
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_step_pips INTEGER');
    await c.query('ALTER TABLE trades ADD COLUMN IF NOT EXISTS slippage_pips NUMERIC(5,2) DEFAULT 0');

    console.log('Trades table altered successfully.');

    // Upsert platform settings manually
    const addSetting = async (k, v) => {
      const res = await c.query('SELECT value FROM platform_settings WHERE key = $1', [k]);
      if (res.rows.length === 0) {
        await c.query('INSERT INTO platform_settings (key, value) VALUES ($1, $2)', [k, v]);
        console.log(`Setting ${k} added.`);
      } else {
        console.log(`Setting ${k} exists.`);
      }
    };

    await addSetting('dynamic_commission_per_lot', '3.00');
    await addSetting('slippage_simulator_enabled', 'false');
    await addSetting('slippage_max_pips_adverse', '2.0');

    console.log('MIGRATION:OK');
  } catch (err) {
    console.error('MIGRATION_ERROR:', err.message);
  } finally {
    c.release();
    pool.end();
  }
}

run();
