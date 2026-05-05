# 📋 Database Migration System - PropFirm Backend

Your backend now includes a professional, production-ready database migration framework powered by **Knex.js**. This eliminates the need for ad-hoc SQL scripts and ensures all schema changes are version-controlled and reproducible.

## 🎯 What's Changed

**New Files:**
- `knexfile.js` - Knex configuration
- `migrations/` - Directory for all database migrations
- `utils/dbMigration.js` - Migration helper utilities
- `scripts/check-migrations.js` - Setup validator
- `scripts/validate-migrations.sh` - Bash validation script
- `scripts/list-migrations.js` - Migration status viewer
- `MIGRATIONS.md` - Comprehensive guide with examples
- `DATABASE_MIGRATION_SETUP.md` - Step-by-step setup guide

**Updated Files:**
- `package.json` - Added `knex` dependency and migration scripts

## ⚡ Quick Start (5 minutes)

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Check Setup
```bash
node scripts/check-migrations.js
```
You should see all checks pass.

### 3. View Migration Status
```bash
npm run migrate:list
```
Shows: `✓ COMPLETED 001_baseline_schema.js`

### 4. Apply Baseline Migration
```bash
npm run migrate
```
This creates the `platform_settings` table and initializes all default settings.

### 5. Done! 🎉
Your database schema is now version-controlled.

## 📚 Common Commands

| Command | Purpose |
|---------|---------|
| `npm run migrate` | Apply all pending migrations |
| `npm run migrate:list` | View status (✓ applied vs ⏳ pending) |
| `npm run migrate:make <name>` | Create a new migration |
| `npm run migrate:rollback` | Undo last migration (dev only) |
| `npm run migrate:status` | Detailed knex status info |

## 📝 Creating Your First Migration

When you need to add a new column or table:

```bash
npm run migrate:make add_settlement_details_table
```

This creates `migrations/002_add_settlement_details_table.js`. Edit it:

```javascript
exports.up = async function(knex) {
  await knex.schema.createTable('settlement_details', (table) => {
    table.increments('id').primary()
    table.integer('trade_id').references('id').inTable('trades').onDelete('CASCADE')
    table.decimal('settled_pnl', 15, 2)
    table.text('notes')
    table.timestamps()
  })
  
  console.log('✓ settlement_details table created')
}

exports.down = async function(knex) {
  await knex.schema.dropTable('settlement_details')
  console.log('✓ settlement_details table dropped')
}
```

Then apply it:
```bash
npm run migrate
npm run migrate:list  # Verify ✓ COMPLETED
```

## 🔄 Integration with Server (Recommended)

To automatically run migrations when your server starts:

1. Open `backend/server.js`
2. Add at the top (after requires):
   ```javascript
   const { initializeDatabase } = require('./utils/dbMigration')
   ```
3. Before `app.listen()`, add:
   ```javascript
   // Initialize database
   await initializeDatabase()
   ```

Now migrations run automatically on server startup! 🚀

## 📖 Documentation

- **[MIGRATIONS.md](./MIGRATIONS.md)** - Complete guide with 10+ examples
- **[DATABASE_MIGRATION_SETUP.md](./DATABASE_MIGRATION_SETUP.md)** - Step-by-step setup
- **[000_TEMPLATE.js](./migrations/000_TEMPLATE.js)** - Migration template

## ✨ Key Features

✓ **Version Control** - All schema changes tracked in `knex_migrations` table
✓ **Rollbacks** - Easily undo changes with `npm run migrate:rollback`
✓ **Batch Tracking** - Know exactly which migrations were applied together
✓ **Production Safe** - Prevents accidental schema changes in production
✓ **Team Friendly** - Pull migrations from git, apply consistently across all environments
✓ **Easy Debugging** - CLI tools show exactly what's been applied

## 🚨 Important Notes

⚠️ **Never manually edit migration files after they're applied**
- If you need to change something, create a new migration instead

⚠️ **Always write rollback functions**
- Test them: `npm run migrate:rollback` then `npm run migrate`

⚠️ **Don't commit platform_settings defaults to git**
- These are tracked as-is; modify via admin panel instead

✓ **For production deployment:**
- Run `npm run migrate` in your CI/CD pipeline
- Or have server auto-run migrations on startup (recommended)

## 🔍 Troubleshooting

**Migrations not applying?**
```bash
npm run migrate:status  # Check for errors
npm run migrate:list    # View detailed status
```

**Can't find migration file?**
- Must be in `backend/migrations/`
- Must end with `.js`
- Must have `exports.up` and `exports.down`

**Permission denied?**
- Check `.env` DATABASE_URL credentials
- Database user needs CREATE, ALTER, DROP permissions

**Want to start fresh?** (development only)
```bash
npm run migrate:rollback  # Rollback all
npm run migrate           # Reapply
```

## 📊 What Gets Tracked

When you run a migration, Knex.js automatically:
1. Creates `knex_migrations` table (if it doesn't exist)
2. Records migration name and batch number
3. Records timestamp
4. Never deletes old records (for history)

View migration history:
```sql
SELECT * FROM knex_migrations ORDER BY name DESC;
```

## 🎓 Example: Real-World Migration

Here's a real migration you might create:

```javascript
// migrations/002_add_risk_management_fields.js

exports.up = async function(knex) {
  // Add columns to existing table
  await knex.schema.table('trades', (table) => {
    table.decimal('risk_per_trade', 10, 5).defaultTo(0)
    table.integer('daily_loss_limit').defaultTo(0)
    table.boolean('risk_limit_hit').defaultTo(false)
  })
  
  // Create new table for risk history
  await knex.schema.createTable('risk_history', (table) => {
    table.increments('id').primary()
    table.integer('user_id').references('id').inTable('users')
    table.date('date').notNullable()
    table.unique(['user_id', 'date'])
    table.timestamps()
  })
  
  // Create index for performance
  await knex.schema.table('risk_history', (table) => {
    table.index('user_id')
    table.index('date')
  })
  
  console.log('✓ Risk management fields added')
}

exports.down = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.dropColumn('risk_per_trade')
    table.dropColumn('daily_loss_limit')
    table.dropColumn('risk_limit_hit')
  })
  
  await knex.schema.dropTable('risk_history')
  
  console.log('✓ Risk management fields removed')
}
```

Apply it:
```bash
npm run migrate
npm run migrate:list
```

## 🚀 Next Phase: Data Seeding

Once migrations are stable, you can add seed data files in `seeds/` directory:

```javascript
// seeds/001_platform_defaults.js
exports.seed = async function(knex) {
  await knex('platform_settings')
    .insert({ key: 'feature_xyz_enabled', value: 'true' })
    .onConflict('key').merge()
}
```

Then run: `npx knex seed:run`

## 📞 Need Help?

See the documentation files:
1. `MIGRATIONS.md` - Detailed reference with 10+ examples
2. `DATABASE_MIGRATION_SETUP.md` - Step-by-step walkthrough
3. [Knex.js Docs](http://knexjs.org/#Migrations-API) - Official reference

---

**Status: ✓ Ready to use**  
**Framework: Knex.js 3.1.0**  
**Database: PostgreSQL**  
**Last Updated: 2026-04-10**
