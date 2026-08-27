const pool = require('./db');

async function seed() {
  const sizes = [1000, 2500, 5000, 10000, 25000, 50000, 100000, 200000];
  for (const size of sizes) {
    const key = `max_accounts_${size}`;
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, '999999']
    );
  }
  console.log('Successfully seeded quotas to unlimited');
  pool.end();
}
seed();
