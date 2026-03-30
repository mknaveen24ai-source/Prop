const pool = require('./db');

async function migrateLogs() {
  try {
    console.log('Migrating trade_logs table...');
    await pool.query(`ALTER TABLE trade_logs ALTER COLUMN user_id TYPE TEXT`);
    await pool.query(`ALTER TABLE trade_logs ALTER COLUMN account_id TYPE TEXT`);

    console.log('Migrating login_logs table (if it exists)...');
    await pool.query(`ALTER TABLE login_logs ALTER COLUMN user_id TYPE TEXT`).catch(e => console.log('Notice login_logs.user_id:', e.message));

    console.log('Migration successful');
  } catch (error) {
    console.error('Migration failed:', error.message);
  } finally {
    pool.end();
  }
}
migrateLogs();
