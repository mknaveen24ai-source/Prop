const pool = require('./db')

async function checkTables() {
  try {
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name LIKE 'chat_%'
    `)
    console.log('Chat tables:', res.rows)
    
    if (res.rows.length === 0) {
      console.log('\nNo chat tables found - they will be created on first API call')
    } else {
      console.log('\nChat tables exist and ready to use')
    }
  } catch (err) {
    console.error('Error:', err.message)
  }
  process.exit(0)
}

checkTables()
