/**
 * List all migrations and their status
 * 
 * Usage: npm run migrate:list
 */

require('../loadEnv')
const knex = require('knex')
const knexConfig = require('../knexfile')

const env = process.env.NODE_ENV || 'development'
const config = knexConfig[env]
const db = knex(config)

async function listMigrations() {
  try {
    console.log('\n📋 Migration Status\n')
    console.log('─'.repeat(60))

    // Get completed migrations
    const completed = await db('knex_migrations').select('name').orderBy('name')
    
    // Get all migration files
    const fs = require('fs')
    const path = require('path')
    const migrationsDir = path.join(__dirname, '../migrations')
    const allFiles = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.js') && !f.startsWith('0'))
      .filter(f => f !== '000_TEMPLATE.js')
      .sort()

    const completedNames = new Set(completed.map(m => m.name))

    if (allFiles.length === 0) {
      console.log('No migrations found\n')
      return
    }

    let completedCount = 0
    let pendingCount = 0

    for (const file of allFiles) {
      const status = completedNames.has(file) ? '✓ COMPLETED' : '⏳ PENDING'
      const color = completedNames.has(file) ? '\x1b[32m' : '\x1b[33m'
      const reset = '\x1b[0m'
      
      console.log(`${color}${status}${reset} ${file}`)
      
      if (completedNames.has(file)) completedCount++
      else pendingCount++
    }

    console.log('─'.repeat(60))
    console.log(`\nTotal: ${allFiles.length} | Completed: ${completedCount} | Pending: ${pendingCount}\n`)

    if (pendingCount > 0) {
      console.log('💡 Tip: Run "npm run migrate" to apply pending migrations\n')
    }

  } catch (err) {
    console.error('Error listing migrations:', err.message)
  } finally {
    await db.destroy()
  }
}

listMigrations()
