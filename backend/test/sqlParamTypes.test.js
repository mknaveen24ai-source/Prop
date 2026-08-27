const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// `accounts.id` and `trades.account_id` are uuid; `trade_logs.account_id`,
// `daily_pnl_records.account_id` and the admin_* tables are text. Postgres
// resolves a query parameter's type ONCE, from the first context that determines
// it — so a single statement comparing the same $1 to both kinds of column
// fails at runtime with `operator does not exist: text = uuid`.
//
// That shipped in routes/trades/open.js and broke EVERY trade open with a 500.
// Nothing caught it: the tests here mock the database, lint cannot see inside a
// SQL string, and it only reproduces against a real Postgres holding both
// tables. scripts/check-param-type-collisions.js is the guard, and `npm run
// check` runs it.
//
// These tests guard the guard. A detector that silently stops detecting is
// worse than no detector, because the check still reports success.

const BACKEND = process.env.BACKEND_SOURCE_ROOT
  ? path.resolve(process.env.BACKEND_SOURCE_ROOT)
  : path.join(__dirname, '..')
const SCRIPT = process.env.BACKEND_SOURCE_ROOT
  ? path.join(__dirname, '..', 'scripts', 'check-param-type-collisions.js')
  : path.join(BACKEND, 'scripts', 'check-param-type-collisions.js')

function runCheck() {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      cwd: BACKEND,
      env: { ...process.env, BACKEND_SOURCE_ROOT: BACKEND },
      encoding: 'utf8'
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout || '') }
  }
}

test('the repository is currently free of uuid/text parameter collisions', () => {
  const { code, stdout } = runCheck()
  assert.equal(code, 0, `check-param-type-collisions failed:\n${stdout}`)
  assert.match(stdout, /No parameter is compared to both a uuid and a text column/)
})

test('the detector still catches the exact query that broke every trade open', (t) => {
  // The real pre-fix snippet: $1 compared to trades.account_id (uuid) and
  // trade_logs.account_id (text) inside one statement.
  const backend = BACKEND
  const decoy = path.join(backend, 'utils', `__sqlparam_probe_${process.pid}.js`)

  fs.writeFileSync(decoy, `
    // Not loaded by anything — written only so the checker has something to find.
    module.exports = async function probe(client, accountId) {
      return client.query(\`
        SELECT
          (SELECT 1 FROM trades
            WHERE account_id = $1 AND status IN ('open', 'pending') LIMIT 1) AS open_trade,
          (SELECT COUNT(*)::int FROM trade_logs
            WHERE account_id = $1) AS trades_today\`,
        [accountId])
    }
  `)
  t.after(() => { fs.rmSync(decoy, { force: true }) })

  // The checker enumerates via `git ls-files`, so an untracked probe is
  // invisible to it. Add it to the index without committing.
  try {
    execFileSync('git', ['add', '-N', decoy], { cwd: backend, stdio: 'pipe' })
  } catch {
    t.skip('git is unavailable, so the detector cannot be exercised here')
    return
  }

  try {
    const { code, stdout } = runCheck()
    assert.equal(code, 1, 'the detector did not fail on a known-bad query')
    assert.match(stdout, /trades\.account_id \(uuid\)/)
    assert.match(stdout, /trade_logs\.account_id \(text\)/)
  } finally {
    execFileSync('git', ['rm', '--cached', '--force', '--quiet', decoy], { cwd: backend, stdio: 'pipe' })
  }
})

test('an explicit cast on the parameter is accepted as deliberate', (t) => {
  const backend = BACKEND
  const decoy = path.join(backend, 'utils', `__sqlparam_ok_${process.pid}.js`)

  // Identical to the failing query except for `$1::text` — which is the fix, and
  // must NOT be reported. A checker that flags the fix as well as the bug forces
  // people to disable it.
  fs.writeFileSync(decoy, `
    module.exports = async function probe(client, accountId) {
      return client.query(\`
        SELECT
          (SELECT 1 FROM trades
            WHERE account_id = $1 AND status IN ('open', 'pending') LIMIT 1) AS open_trade,
          (SELECT COUNT(*)::int FROM trade_logs
            WHERE account_id = $1::text) AS trades_today\`,
        [accountId])
    }
  `)
  t.after(() => { fs.rmSync(decoy, { force: true }) })

  try {
    execFileSync('git', ['add', '-N', decoy], { cwd: backend, stdio: 'pipe' })
  } catch {
    t.skip('git is unavailable, so the detector cannot be exercised here')
    return
  }

  try {
    const { code } = runCheck()
    assert.equal(code, 0, 'the cast form was reported as a collision — the fix must pass')
  } finally {
    execFileSync('git', ['rm', '--cached', '--force', '--quiet', decoy], { cwd: backend, stdio: 'pipe' })
  }
})

test('column types are read from the schema of record, not a hand-written list', () => {
  const { loadSchemaTypes } = require(SCRIPT)
  const types = loadSchemaTypes()

  // If these two ever agree, the whole bug class is gone and the checker is
  // harmless. If they disagree — as they do today — the checker must know.
  assert.equal(types.trades?.account_id, 'uuid')
  assert.equal(types.trade_logs?.account_id, 'text')
})
