const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function runMigration() {
  console.log('Starting V2 DB Upgrade...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── trades table expansion ──
    const alters = [
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS parent_trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL;`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS is_partial BOOLEAN DEFAULT false;`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS commission NUMERIC(15,2) DEFAULT 0.00;`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS notes TEXT;`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_activation_price NUMERIC(15,5);`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_step_pips INTEGER;`,
      `ALTER TABLE trades ADD COLUMN IF NOT EXISTS slippage_pips NUMERIC(5,2) DEFAULT 0;`
    ];

    for (const ddl of alters) {
      console.log('Executing:', ddl);
      await client.query(ddl);
    }

    // ── platform settings expansion ──
    // Insert dynamic commission cost ($3/lot default)
    const settings = [
      `INSERT INTO platform_settings (key, value) VALUES ('dynamic_commission_per_lot', '3.00') ON CONFLICT (key) DO NOTHING;`,
      `INSERT INTO platform_settings (key, value) VALUES ('slippage_simulator_enabled', 'false') ON CONFLICT (key) DO NOTHING;`,
      `INSERT INTO platform_settings (key, value) VALUES ('slippage_max_pips_adverse', '2.0') ON CONFLICT (key) DO NOTHING;`
    ];

    for (const dml of settings) {
      console.log('Executing:', dml);
      await client.query(dml);
    }

    await client.query('COMMIT');
    console.log('V2 DB Migration successful.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
    pool.end();
  }
}

runMigration();
