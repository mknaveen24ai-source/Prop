const pool = require('./db');
async function check() {
  const res = await pool.query('SELECT key, value FROM platform_settings WHERE key LIKE \'%max_accounts%\'');
  console.log(res.rows);
  pool.end();
}
check();
