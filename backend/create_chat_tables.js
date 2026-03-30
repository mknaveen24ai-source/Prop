// Create Chat Tables
const pool = require('./db')
const { ensureChatTables } = require('./routes/chat')

async function createChatTables() {
  console.log('=== Creating Chat Tables ===\n')
  
  try {
    await ensureChatTables()
    console.log('✓ Chat tables created successfully')
    
    const res = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_name LIKE 'chat_%'
      ORDER BY table_name
    `)
    
    console.log('\nTables created:')
    res.rows.forEach(row => console.log(`  - ${row.table_name}`))
    
    // Verify column types
    const columns = await pool.query(`
      SELECT table_name, column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name IN ('chat_conversations', 'chat_messages')
      AND column_name IN ('user_id', 'conversation_id')
      ORDER BY table_name, ordinal_position
    `)
    
    console.log('\nColumn types:')
    columns.rows.forEach(row => {
      console.log(`  ${row.table_name}.${row.column_name}: ${row.data_type}`)
    })
    
    console.log('\n✓ Chat system ready!')
    
  } catch (err) {
    console.error('Error:', err.message)
    console.error(err.stack)
  }
  
  process.exit(0)
}

createChatTables()
