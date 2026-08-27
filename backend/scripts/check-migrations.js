#!/usr/bin/env node

/**
 * Quick migration setup validator and info printer
 * Usage: node scripts/check-migrations.js
 */

const fs = require('fs')

console.log('\n╔══════════════════════════════════════════════════════════════╗')
console.log('║       DATABASE MIGRATION FRAMEWORK - SETUP CHECK             ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')

const checks = [
  {
    name: 'knexfile.js exists',
    check: () => fs.existsSync('knexfile.js')
  },
  {
    name: 'migrations/ directory exists',
    check: () => fs.existsSync('migrations') && fs.statSync('migrations').isDirectory()
  },
  {
    name: 'Baseline migration exists',
    check: () => fs.existsSync('migrations/001_baseline_schema.js')
  },
  {
    name: 'dbMigration utility exists',
    check: () => fs.existsSync('utils/dbMigration.js')
  },
  {
    name: 'MIGRATIONS.md guide exists',
    check: () => fs.existsSync('MIGRATIONS.md')
  },
  {
    name: 'package.json has migrate scripts',
    check: () => {
      const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
      return pkg.scripts && pkg.scripts.migrate && pkg.dependencies && pkg.dependencies.knex
    }
  }
]

let passed = 0
let failed = 0

for (const check of checks) {
  const result = check.check()
  const icon = result ? '✓' : '✗'
  const color = result ? '\x1b[32m' : '\x1b[31m'
  const reset = '\x1b[0m'
  
  console.log(`${color}${icon}${reset} ${check.name}`)
  
  if (result) passed++
  else failed++
}

console.log('\n' + '─'.repeat(64))
console.log(`\nResult: ${passed} passed, ${failed} failed\n`)

if (failed === 0) {
  console.log('✓ All setup checks passed!\n')
  console.log('🚀 Next steps:')
  console.log('   1. npm install')
  console.log('   2. npm run migrate:list')
  console.log('   3. npm run migrate')
  console.log('   4. npm run dev\n')
} else {
  console.log('⚠️  Some checks failed. Run: npm install\n')
}

// Show quick command reference
console.log('╔══════════════════════════════════════════════════════════════╗')
console.log('║                    QUICK REFERENCE                           ║')
console.log('╠══════════════════════════════════════════════════════════════╣')
console.log('║ npm run migrate:list    → View migration status              ║')
console.log('║ npm run migrate         → Apply all pending migrations       ║')
console.log('║ npm run migrate:make    → Create a new migration             ║')
console.log('║ npm run migrate:rollback→ Revert last migration               ║')
console.log('║ npm run migrate:status  → Show detailed status                ║')
console.log('╚══════════════════════════════════════════════════════════════╝\n')
