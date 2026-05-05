/**
 * Database Migration Utility
 * 
 * Helper functions for running migrations programmatically
 * Can be called from server startup or CLI
 */

const knex = require('knex')
const logger = require('./utils/logger')
require('../loadEnv')

const knexConfig = require('./knexfile')
const env = process.env.NODE_ENV || 'development'

/**
 * Initialize database with migrations
 * Run this on server startup to ensure schema is up-to-date
 */
async function initializeDatabase() {
  const db = knex(knexConfig[env])

  try {
    logger.info('🔄 Running database migrations...')
    
    const [batchNumber, executedMigrations] = await db.migrate.latest()
    
    if (executedMigrations.length === 0) {
      logger.info('✓ Database is already up-to-date')
    } else {
      logger.info(`✓ Applied ${executedMigrations.length} migration(s) (batch ${batchNumber})`)
      executedMigrations.forEach(m => logger.info(`  ✓ ${m}`))
    }

    return true
  } catch (err) {
    logger.error('❌ Migration failed:', { error: err.message, stack: err.stack })
    throw new Error(`Database initialization failed: ${err.message}`)
  } finally {
    await db.destroy()
  }
}

/**
 * Get current migration status
 */
async function getMigrationStatus() {
  const db = knex(knexConfig[env])

  try {
    const applied = await db('knex_migrations').select('name')
    const status = {
      applied: applied.map(m => m.name),
      appliedCount: applied.length,
      timestamp: new Date().toISOString()
    }
    return status
  } finally {
    await db.destroy()
  }
}

/**
 * Rollback to previous migration (use with caution!)
 */
async function rollback() {
  if (env === 'production') {
    throw new Error('❌ Cannot rollback in production environment')
  }

  const db = knex(knexConfig[env])

  try {
    logger.warn('⚠️  Rolling back last migration...')
    const [batchNumber, rolledBackMigrations] = await db.migrate.rollback()
    
    logger.warn(`✓ Rolled back ${rolledBackMigrations.length} migration(s)`)
    rolledBackMigrations.forEach(m => logger.warn(`  ↩️  ${m}`))
    
    return rolledBackMigrations
  } finally {
    await db.destroy()
  }
}

module.exports = {
  initializeDatabase,
  getMigrationStatus,
  rollback
}
