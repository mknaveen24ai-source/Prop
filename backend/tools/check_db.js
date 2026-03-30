/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const pool = require('../db');

async function check() {
  try {
    const res = await pool.query('SELECT id, user_id, pg_typeof(user_id) FROM support_tickets LIMIT 5');
    console.log(res.rows);
  } catch (err) {
    console.error(err.message);
  }
  pool.end();
}
check();
