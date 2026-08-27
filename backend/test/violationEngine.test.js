const test = require('node:test')
const assert = require('node:assert/strict')

const { buildViolationKey } = require('../services/violationEngine')
const pool = require('../db')

test('buildViolationKey normalizes casing and spacing', () => {
  const key = buildViolationKey([' Drawdown Breach ', 'ACC-1', 'User 7', '', 'XAUUSD'])
  assert.equal(key, 'drawdown_breach|acc-1|user_7||xauusd')
})

test('buildViolationKey is stable for missing values', () => {
  const key = buildViolationKey(['rapid_opposing_trades', null, undefined])
  assert.equal(key, 'rapid_opposing_trades||')
})

test('applyAccountEnforcement preserves rollback and release when an update fails', async () => {
  const violationEngine = require('../services/violationEngine')
  const originalPoolQuery = pool.query
  const originalConnect = pool.connect
  const statements = []
  let released = false
  const updateFailure = new Error('simulated account update failure')

  try {
    // Establish the engine's idempotent table-infrastructure flag without a
    // database. The transaction itself is exercised through a pinned client.
    pool.query = async () => ({ rows: [], rowCount: 0 })
    await violationEngine.ensureViolationTables()

    pool.connect = async () => ({
      query: async (sql) => {
        statements.push(sql)
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (String(sql).includes('SELECT id, user_id')) {
          return {
            rows: [{
              id: 'account-1',
              user_id: 'user-1',
              status: 'active',
              review_flagged: false,
              review_flag_reason: null
            }],
            rowCount: 1
          }
        }
        if (String(sql).includes('UPDATE accounts')) throw updateFailure
        throw new Error(`Unexpected SQL in rollback test: ${sql}`)
      },
      release: () => { released = true }
    })

    await assert.rejects(
      violationEngine.applyAccountEnforcement({
        accountId: 'account-1',
        action: 'lock_account',
        reason: 'test'
      }),
      (error) => error === updateFailure
    )

    assert.equal(statements[0], 'BEGIN')
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(released, true)
  } finally {
    pool.query = originalPoolQuery
    pool.connect = originalConnect
  }
})
