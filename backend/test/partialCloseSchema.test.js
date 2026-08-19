const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Partial closes returned 500 for every trader, because
// `trades.parent_trade_id` was `integer` while `trades.id` is `uuid`.
// routes/trades/close.js inserts the parent's uuid into that column, so
// Postgres rejected the insert and rolled the whole close back:
//
//     invalid input syntax for type integer: "b9aa1b25-6266-42c3-8f97-24e400fdbf87"
//
// The trader saw "Could not close trade" and kept the position at full size.
// Scaling out of a winner or halving a loser was impossible platform-wide.
//
// Nothing caught it because the trade tests mock the pg pool, so that INSERT had
// never run against real Postgres. Migration 038 converts the column.
//
// These tests guard the shape of the fix in the places a future change could
// undo it. The behavioural proof is a real partial close against a live
// database — see scripts/audit/race-conditions.js and the audit report — since
// asserting it here would require the mocked pool that hid the bug.

const MIGRATION = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '038_fix_parent_trade_id_type.js'), 'utf8'
)
const CORE_SCHEMA = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '000_core_schema.sql'), 'utf8'
)

test('migration 038 converts parent_trade_id to uuid', () => {
  assert.match(MIGRATION, /ALTER COLUMN parent_trade_id TYPE uuid/,
    'the column must end up uuid, matching trades.id')
})

test('migration 038 refuses rather than discarding data it cannot convert', () => {
  // USING NULL is only safe because every write to the column failed, so it is
  // empty everywhere. If some database somewhere does hold values, the deploy
  // must stop rather than silently drop them.
  assert.match(MIGRATION, /COUNT\(\*\)::int AS non_null FROM trades WHERE parent_trade_id IS NOT NULL/,
    'up must count non-null values before converting')
  assert.match(MIGRATION, /throw new Error\(/, 'up must refuse when any exist')
})

test('migration 038 down also refuses rather than orphaning partial closes', () => {
  const down = MIGRATION.slice(MIGRATION.indexOf('exports.down'))
  assert.match(down, /non_null > 0/, 'down must check before destroying uuid links')
  assert.match(down, /throw new Error\(/, 'down must refuse rather than null them out')
})

test('the partial-close insert still writes parent_trade_id', () => {
  // If this INSERT ever stops carrying the link, partial closes silently lose
  // their parent and the fix above becomes pointless.
  const close = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'trades', 'close.js'), 'utf8'
  )
  assert.match(close, /parent_trade_id/, 'close.js must record the parent of a partial close')
  assert.match(close, /is_partial/, 'and must mark the child row as partial')
})

test('the schema of record still shows the pre-fix type, so 038 is required', () => {
  // 000_core_schema.sql is a dump of production and is deliberately NOT edited
  // in place — the migration is what moves a database forward. This asserts the
  // two have not been conflated: if someone hand-edits the baseline to uuid,
  // a fresh provision would skip 038 and diverge from an upgraded database.
  const trades = CORE_SCHEMA.slice(
    CORE_SCHEMA.indexOf('CREATE TABLE public.trades'),
    CORE_SCHEMA.indexOf('CREATE TABLE public.trades') + 3000
  )
  if (trades.includes('parent_trade_id')) {
    assert.match(trades, /parent_trade_id\s+integer/,
      'baseline should still carry the original type; migration 038 is what converts it')
  }
})
