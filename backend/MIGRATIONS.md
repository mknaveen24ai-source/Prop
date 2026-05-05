/**
 * Database Migration Guide and Quick Reference
 * 
 * This file documents how to use the migration system
 */

# Database Migration Framework

Your project now uses **Knex.js** for version-controlled database migrations. This ensures schema changes are tracked, reproducible, and can be rolled back if needed.

## Quick Start

### View Migration Status
```bash
npm run migrate:list
```
Shows which migrations have been applied and which are pending.

### Apply All Pending Migrations
```bash
npm run migrate
```
Runs all migrations in the `migrations/` folder that haven't been applied yet.

### Create a New Migration
```bash
npm run migrate:make add_column_to_trades
```
This creates a new migration file in the `migrations/` folder. Edit it and add your SQL:

```javascript
exports.up = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.string('settlement_type')
  })
}

exports.down = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.dropColumn('settlement_type')
  })
}
```

### Rollback Last Migration
```bash
npm run migrate:rollback
```
Reverts the most recently applied migration. Use with caution in production.

### View Current Migration Status
```bash
npm run migrate:status
```
Shows detailed status of all migrations.

## File Structure

```
backend/
├── migrations/
│   ├── 000_TEMPLATE.js           # Template for new migrations
│   ├── 001_baseline_schema.js    # Initial schema baseline
│   ├── 002_*.js                  # Future migrations (use sequential numbers)
│   └── ...
├── knexfile.js                   # Knex configuration
└── scripts/
    └── list-migrations.js        # Helper to view migration status
```

## Best Practices

1. **Always add both `up` and `down` functions** - This enables rollbacks
2. **Use descriptive names** - `add_trailing_stop_column` not `fix123`
3. **One logical change per migration** - Don't combine unrelated schema changes
4. **Test rollbacks** - Always test `npm run migrate:rollback` in development
5. **Number migrations sequentially** - Use format: `NNN_description.js`
6. **Add console.log statements** - Helps track what's happening during migration

## Migration Examples

### Adding a Column
```javascript
exports.up = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.numeric('slippage', 10, 5).defaultTo(0)
  })
}

exports.down = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.dropColumn('slippage')
  })
}
```

### Creating a New Table
```javascript
exports.up = async function(knex) {
  await knex.schema.createTable('commissions', (table) => {
    table.increments('id').primary()
    table.integer('trade_id').references('id').inTable('trades')
    table.decimal('amount', 10, 2)
    table.text('reason')
    table.timestamps()
  })
}

exports.down = async function(knex) {
  await knex.schema.dropTable('commissions')
}
```

### Adding an Index
```javascript
exports.up = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.index('user_id')
    table.index('created_at')
  })
}

exports.down = async function(knex) {
  await knex.schema.table('trades', (table) => {
    table.dropIndex('user_id')
    table.dropIndex('created_at')
  })
}
```

### Complex Schema with Constraints
```javascript
exports.up = async function(knex) {
  await knex.schema.table('accounts', (table) => {
    table.enum('status', ['active', 'suspended', 'closed'])
  })
  
  // Add unique constraint
  await knex.schema.table('users', (table) => {
    table.unique('email')
  })
}

exports.down = async function(knex) {
  await knex.schema.table('accounts', (table) => {
    table.dropColumn('status')
  })
  
  await knex.schema.table('users', (table) => {
    table.dropUnique('email')
  })
}
```

## Integration with Server

The migration framework is ready to use. Before deploying:

```bash
# Install dependencies (if not already done)
npm install

# Check migration list
npm run migrate:list

# Apply pending migrations to database
npm run migrate

# Start server
npm run dev
```

## Troubleshooting

### Migrations not showing in `npm run migrate:list`?
- Check that migration files are in `backend/migrations/`
- Verify they end with `.js`
- Ensure they have `exports.up` and `exports.down`

### Can't rollback?
- You can only rollback migrations that were successfully applied
- Check `npm run migrate:status` to see applied migrations
- Some migrations may not be rollback-safe (e.g., data deletions)

### Permission errors?
- Ensure `DATABASE_URL` in `.env` has proper credentials
- Check that the database user has `CREATE`, `ALTER`, and `DROP` permissions

### Migration stuck?
- Check database logs for the actual error
- Manually inspect the database: `SELECT * FROM knex_migrations;`
- If needed, you can manually delete a migration row to retry it

## Next Steps

1. Run `npm run migrate:list` to see current status
2. Run `npm run migrate` to apply baseline migration
3. Going forward, create a new migration for each schema change
4. Never manually run DDL - always use migrations

## Resources

- [Knex.js Documentation](http://knexjs.org/)
- [Knex.js Migration Guide](http://knexjs.org/#Migrations-API)
