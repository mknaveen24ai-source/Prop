#!/bin/bash
#
# Validate that database migrations are properly set up
# Usage: bash scripts/validate-migrations.sh
#

echo "🔍 Validating migration setup..."
echo ""

# Check if knexfile.js exists
if [ -f "knexfile.js" ]; then
    echo "✓ knexfile.js found"
else
    echo "✗ knexfile.js not found - run npm install first"
    exit 1
fi

# Check if migrations directory exists
if [ -d "migrations" ]; then
    echo "✓ migrations/ directory exists"
    
    migration_count=$(find migrations -name "*.js" | wc -l)
    echo "  └─ Found $migration_count migration files"
else
    echo "✗ migrations/ directory not found"
    exit 1
fi

# Check if node_modules/knex exists
if [ -d "node_modules/knex" ]; then
    echo "✓ knex package installed"
else
    echo "✗ knex not installed - run npm install"
    exit 1
fi

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
    echo "⚠️  DATABASE_URL not set in environment"
    echo "   Please set DATABASE_URL=postgresql://user:pass@host/db"
else
    echo "✓ DATABASE_URL is set"
fi

# Check if utils/dbMigration.js exists
if [ -f "utils/dbMigration.js" ]; then
    echo "✓ dbMigration utility found"
else
    echo "✗ utils/dbMigration.js not found"
    exit 1
fi

echo ""
echo "✓ All checks passed!"
echo ""
echo "Next steps:"
echo "  1. npm install"
echo "  2. npm run migrate:list"
echo "  3. npm run migrate"
echo ""
