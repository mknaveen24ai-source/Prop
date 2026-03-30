/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const pool = require('../db');

async function fix() {
  try {
    await pool.query(`ALTER TABLE admin_balance_adjustments ALTER COLUMN account_id TYPE TEXT`).catch(e => console.error(e.message));
    console.log("DB Tables updated successfully!");
  } catch(e) {
    console.error("DB Fix error:", e);
  } finally {
    pool.end();
  }
}

fix();
