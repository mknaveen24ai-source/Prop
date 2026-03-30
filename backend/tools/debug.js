/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const pool = require('../db');

async function check() {
  try {
    const res = await pool.query('SELECT id, account_uid FROM accounts LIMIT 5');
    console.log(res.rows);
  } catch (e) {
    console.error(e);
  } finally {
    pool.end();
  }
}
check();
