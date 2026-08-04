const test = require('node:test')
const assert = require('node:assert/strict')
const {
  ensureBbookPnlConflictTarget,
  normalizeProgressionSettings,
  buildPromotionPlan,
  promotePassedAccount,
  __test__
} = require('../services/progressionService')

test.beforeEach(() => {
  __test__.resetBbookPnlConflictTargetReady()
})

test('normalizeProgressionSettings applies defaults', () => {
  const settings = normalizeProgressionSettings({})
  assert.equal(settings.phase2_profit_target_pct, 5)
  assert.equal(settings.phase2_max_drawdown_pct, 10)
  assert.equal(settings.phase2_day_limit, 30)
  assert.equal(settings.funded_max_drawdown_pct, 5)
})

// Mocks the account_id_sequences upsert (see utils/accountIds.js) so
// generateAccountUid() can run against an in-memory counter instead of a
// real DB connection.
function createMockDb() {
  const sequences = new Map()
  const calls = []
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values })
      if (/INSERT INTO account_id_sequences/i.test(sql)) {
        const category = values[0]
        const next = (sequences.get(category) || 0) + 1
        sequences.set(category, next)
        return { rows: [{ last_value: next }] }
      }
      if (/RETURNING id/i.test(sql)) {
        return { rows: [{ id: 'new-account-1' }] }
      }
      return { rows: [] }
    }
  }
}

test('buildPromotionPlan creates phase2 plan for phase1 account (legacy fallback, no step model)', async () => {
  const acc = { account_type: 'phase1', user_id: 'u1', account_size: 10000 }
  const settings = normalizeProgressionSettings({ phase2_profit_target_pct: '8', phase2_max_drawdown_pct: '9', phase2_day_limit: '20' })
  const plan = await buildPromotionPlan(acc, settings, createMockDb())
  assert.ok(plan)
  assert.match(plan.sql, /INSERT INTO accounts/i)
  assert.equal(plan.values[0], 'u1')
  assert.equal(plan.values[1], 10000)
  assert.equal(plan.values[2], 800)
  assert.equal(plan.values[3], 9)
  assert.equal(plan.values[5], '2SP200001')
  assert.equal(plan.socketEvent, 'phase1_passed')
})

test('buildPromotionPlan creates funded plan for phase2 account (legacy fallback, no step model)', async () => {
  const acc = { account_type: 'phase2', user_id: 'u2', account_size: 5000 }
  const settings = normalizeProgressionSettings({ funded_max_drawdown_pct: '4' })
  const plan = await buildPromotionPlan(acc, settings, createMockDb())
  assert.ok(plan)
  assert.equal(plan.values[0], 'u2')
  assert.equal(plan.values[1], 5000)
  assert.equal(plan.values[2], 4)
  assert.equal(plan.values[3], 'F2-00001')
  assert.equal(plan.socketEvent, 'phase2_passed')
})

test('promotePassedAccount runs insert and bbook update', async () => {
  const mockDb = createMockDb()
  const { calls } = mockDb

  const acc = { account_type: 'phase1', user_id: 'u3', account_size: 2000 }
  const settings = normalizeProgressionSettings({ phase2_profit_target_pct: '10', phase2_max_drawdown_pct: '10', phase2_day_limit: '30' })

  const result = await promotePassedAccount(mockDb, acc, settings)

  assert.equal(result.new_account_id, 'new-account-1')
  assert.equal(result.event, 'phase1_passed')
  assert.ok(calls.some((call) => /CREATE UNIQUE INDEX IF NOT EXISTS bbook_pnl_date_uq/i.test(call.sql)))
  assert.ok(calls.some((call) => /INSERT INTO accounts/i.test(call.sql)))
  assert.ok(calls.some((call) => /ON CONFLICT \(date\)/i.test(call.sql)))
})

test('ensureBbookPnlConflictTarget creates the conflict target used by promotion upserts', async () => {
  const calls = []
  const mockDb = {
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [] }
    }
  }

  await ensureBbookPnlConflictTarget(mockDb)

  assert.ok(calls.some((call) => /CREATE TABLE IF NOT EXISTS bbook_pnl/i.test(call.sql)))
  assert.ok(calls.some((call) => /DELETE FROM bbook_pnl/i.test(call.sql)))
  assert.ok(calls.some((call) => /CREATE UNIQUE INDEX IF NOT EXISTS bbook_pnl_date_uq ON bbook_pnl\(date\)/i.test(call.sql)))
})
