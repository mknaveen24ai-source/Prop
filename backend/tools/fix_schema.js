/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const pool = require('../db');

async function fixSchema() {
  try {
    await pool.query(
      `ALTER TABLE IF EXISTS admin_balance_adjustments
       ALTER COLUMN account_id TYPE TEXT USING account_id::text`
    ).catch((e) => console.error(e.message));

    await pool.query(
      `ALTER TABLE IF EXISTS account_lot_overrides
       ALTER COLUMN account_id TYPE TEXT USING account_id::text`
    ).catch((e) => console.error(e.message));

    console.log('Schema columns aligned to TEXT');
  } catch (e) {
    console.error('Schema fix error:', e.message);
  } finally {
    pool.end();
  }
}

fixSchema();
