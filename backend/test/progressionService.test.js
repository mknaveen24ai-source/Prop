const test = require('node:test')
const assert = require('node:assert/strict')
const {
  normalizeProgressionSettings,
  buildPromotionPlan,
  promotePassedAccount
} = require('../services/progressionService')

test('normalizeProgressionSettings applies defaults', () => {
  const settings = normalizeProgressionSettings({})
  assert.equal(settings.phase2_profit_target_pct, 5)
  assert.equal(settings.phase2_max_drawdown_pct, 10)
  assert.equal(settings.phase2_day_limit, 30)
  assert.equal(settings.funded_max_drawdown_pct, 5)
})

test('buildPromotionPlan creates phase2 plan for phase1 account', () => {
  const acc = { account_type: 'phase1', tenant_id: 7, user_id: 'u1', account_size: 10000 }
  const settings = normalizeProgressionSettings({ phase2_profit_target_pct: '8', phase2_max_drawdown_pct: '9', phase2_day_limit: '20' })
  const plan = buildPromotionPlan(acc, settings)
  assert.ok(plan)
  assert.match(plan.sql, /INSERT INTO accounts/i)
  assert.equal(plan.values[0], 7)
  assert.equal(plan.values[1], 'u1')
  assert.equal(plan.values[2], 10000)
  assert.equal(plan.values[3], 800)
  assert.equal(plan.values[4], 9)
  assert.equal(plan.socketEvent, 'phase1_passed')
})

test('buildPromotionPlan creates funded plan for phase2 account', () => {
  const acc = { account_type: 'phase2', tenant_id: 11, user_id: 'u2', account_size: 5000 }
  const settings = normalizeProgressionSettings({ funded_max_drawdown_pct: '4' })
  const plan = buildPromotionPlan(acc, settings)
  assert.ok(plan)
  assert.equal(plan.values[0], 11)
  assert.equal(plan.values[1], 'u2')
  assert.equal(plan.values[2], 5000)
  assert.equal(plan.values[3], 4)
  assert.equal(plan.socketEvent, 'phase2_passed')
})

test('promotePassedAccount runs insert and bbook update', async () => {
  const calls = []
  const mockDb = {
    async query(sql, values) {
      calls.push({ sql, values })
      if (/RETURNING id/i.test(sql)) {
        return { rows: [{ id: 'new-account-1' }] }
      }
      return { rows: [] }
    }
  }

  const acc = { account_type: 'phase1', tenant_id: 3, user_id: 'u3', account_size: 2000 }
  const settings = normalizeProgressionSettings({ phase2_profit_target_pct: '10', phase2_max_drawdown_pct: '10', phase2_day_limit: '30' })

  const result = await promotePassedAccount(mockDb, acc, settings)

  assert.equal(result.new_account_id, 'new-account-1')
  assert.equal(result.event, 'phase1_passed')
  assert.equal(calls.length, 2)
})
