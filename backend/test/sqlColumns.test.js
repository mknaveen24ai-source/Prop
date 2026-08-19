const test = require('node:test')
const assert = require('node:assert/strict')

const { extractReferences, stringLiterals, cteNames } = require('../scripts/check-sql-columns')

// `payouts.updated_at` was written by four code paths and created by no
// migration, so every admin payout approve/reject/flag/unflag returned 500
// against a correctly provisioned database. `payouts.amount` did the same to
// GET /api/admin/cohort-analytics. Neither was catchable by the test suite:
// the payout tests mock the pg pool, so no SQL on those paths had ever run.
//
// scripts/check-sql-columns.js is the guard, and CI runs it against a schema
// built by the real migrations. These tests guard the guard — specifically its
// two failure modes:
//
//   FALSE NEGATIVE — the parser stops seeing a write, and the check goes on
//   reporting success while the bug ships. This is the dangerous one.
//
//   FALSE POSITIVE — the parser reads JavaScript as SQL. The first draft did
//   exactly this, walking off the end of a template literal and reporting
//   `trades.push` and `payouts.js` as missing columns. Noise gets a check
//   switched off, so it matters nearly as much.

function keys(source) {
  return [...extractReferences(source).keys()].sort()
}

test('finds columns written by UPDATE ... SET', () => {
  const src = 'await pool.query(`UPDATE payouts SET status = $1, updated_at = NOW() WHERE id = $2`, [s, id])'
  assert.deepEqual(keys(src), ['payouts.status', 'payouts.updated_at'])
})

test('finds columns written by INSERT INTO ... (cols)', () => {
  const src = "await pool.query(`INSERT INTO certificates (public_id, user_id, kind) VALUES ($1,$2,$3)`)"
  assert.deepEqual(keys(src), ['certificates.kind', 'certificates.public_id', 'certificates.user_id'])
})

test('resolves table aliases through FROM and JOIN', () => {
  const src = 'const q = `SELECT p.amount_payable, a.current_balance FROM payouts p JOIN accounts a ON a.id = p.account_id`'
  assert.deepEqual(keys(src), [
    'accounts.current_balance',
    'accounts.id',
    'payouts.account_id',
    'payouts.amount_payable'
  ])
})

test('catches the real payouts.amount defect this audit found', () => {
  const src = [
    'const cohorts = await pool.query(`',
    '  WITH payout_agg AS (',
    "    SELECT p.user_id, SUM(p.amount) FILTER (WHERE p.status = 'paid') AS paid_out",
    '    FROM payouts p GROUP BY p.user_id',
    '  ) SELECT * FROM payout_agg`)'
  ].join('\n')
  assert.ok(extractReferences(src).has('payouts.amount'), 'must attribute p.amount to payouts')
})

test('does not attribute CTE names to real tables', () => {
  // `payout_agg` is bound by WITH, so payout_agg.paid_out must not be reported
  // as a missing column on a table of that name.
  const src = 'const q = `WITH payout_agg AS (SELECT 1 AS paid_out) SELECT payout_agg.paid_out FROM payout_agg`'
  assert.deepEqual(keys(src), [])
})

test('a CTE that shadows a real table name wins', () => {
  const src = 'const q = `WITH payouts AS (SELECT 1 AS synthetic) SELECT payouts.synthetic FROM payouts`'
  assert.ok(!extractReferences(src).has('payouts.synthetic'))
})

test('does not read JavaScript member access as SQL', () => {
  // The regression that made the first draft unusable: the scan ran past the
  // closing backtick and into the surrounding code.
  const src = [
    'const { rows } = await pool.query(`SELECT t.id FROM trades t WHERE t.account_id = $1`, [id])',
    'const ids = rows.map((r) => r.id)',
    'trades.push(rows.length)',
    "const svc = require('./payouts.js')"
  ].join('\n')
  assert.deepEqual(keys(src), ['trades.account_id', 'trades.id'])
})

test('ignores SQL inside comments', () => {
  const src = [
    '// UPDATE payouts SET removed_column = 1',
    '/* UPDATE payouts SET also_removed = 2 */',
    'const q = `SELECT p.id FROM payouts p`'
  ].join('\n')
  assert.deepEqual(keys(src), ['payouts.id'])
})

test('blanks template interpolations so they cannot masquerade as SQL', () => {
  // Assembled rather than written inline: a literal '${...}' inside a quoted
  // string is exactly what no-template-curly-in-string exists to catch, and
  // here the interpolation is the fixture, not a mistake.
  const interpolation = '${' + 'buildFilter({ a: 1 })' + '}'
  const src = 'const q = `SELECT t.id FROM trades t WHERE ' + interpolation + ' AND t.status = $1`'
  const found = keys(src)
  assert.ok(found.includes('trades.id'))
  assert.ok(found.includes('trades.status'))
  assert.ok(!found.some((k) => k.includes('buildFilter')))
})

test('bare unqualified columns are deliberately NOT attributed', () => {
  // The documented blind spot. `SELECT id FROM payouts` could be a join where
  // `id` belongs to another table, so guessing would produce false positives.
  // Writes — the class this guard exists for — are always attributable.
  assert.deepEqual(keys('const q = `SELECT id, status FROM payouts`'), [])
})

test('skips Postgres system columns, which are absent from information_schema', () => {
  const src = 'const q = `SELECT t.ctid, t.id FROM trades t`'
  assert.deepEqual(keys(src), ['trades.id'])
})

test('string literal extraction survives escapes and nested quotes', () => {
  const src = "const a = 'it\\'s fine'\nconst q = `SELECT id FROM users`"
  const sql = stringLiterals(src).filter((l) => /SELECT/.test(l.text))
  assert.equal(sql.length, 1)
  assert.match(sql[0].text, /SELECT id FROM users/)
})

test('cteNames picks up every branch of a multi-CTE statement', () => {
  const sql = 'WITH a AS (SELECT 1), b AS (SELECT 2), c AS MATERIALIZED (SELECT 3) SELECT * FROM a'
  assert.deepEqual([...cteNames(sql)].sort(), ['a', 'b', 'c'])
})

test('line numbers point at the statement, not the top of the file', () => {
  const src = ['', '', '', 'const q = `UPDATE payouts SET status = $1`'].join('\n')
  const sites = [...extractReferences(src).get('payouts.status')]
  assert.match(sites[0], /:4$/)
})
