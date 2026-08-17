const test = require('node:test')
const assert = require('node:assert/strict')
const {
  resolvePromotionTarget: resolveWithDeps,
  hasPromotionPath: hasPathWithDeps
} = require('../services/promotionTarget')

// The real lookup hits challenge_models (and runs its DDL bootstrap on first
// call), so these drive the injected loader instead. Note the module cannot be
// stubbed via require.cache: promotionTarget destructures fetchStepModelBySlug
// at import time, so whichever module requires it first wins — which is exactly
// what broke an earlier version of this file under --test-isolation=none.
const MODELS = {
  '1-step': { id: 1, slug: '1-step', name: 'One Step', steps: 1 },
  '2-step': { id: 2, slug: '2-step', name: 'Two Step', steps: 2 },
  '3-step': { id: 3, slug: '3-step', name: 'Three Step', steps: 3 }
}
const DEPS = { loadStepModel: async (slug) => MODELS[slug] || null }

const resolvePromotionTarget = (acc) => resolveWithDeps(acc, DEPS)
const hasPromotionPath = (acc) => hasPathWithDeps(acc, DEPS)

function account(overrides = {}) {
  return { id: 'acc-1', user_id: 'user-1', account_type: 'phase1', account_size: '100000', ...overrides }
}

// ─── Step-model-driven ladders ───────────────────────────────────────────────
// The whole point of the shared resolver: the target is read off the model's
// `steps`, not guessed from the current account_type.

test('a 3-step model walks phase1 -> phase2 -> phase3 -> funded', async () => {
  const walk = []
  for (const step of [1, 2, 3]) {
    const target = await resolvePromotionTarget(account({
      account_type: `phase${step}`, challenge_model_slug: '3-step', step_number: step
    }))
    walk.push(target.targetAccountType)
  }
  assert.deepEqual(walk, ['phase2', 'phase3', 'funded'])
})

test('a 2-step model goes to funded after phase2, never phase3', async () => {
  const phase1 = await resolvePromotionTarget(account({
    account_type: 'phase1', challenge_model_slug: '2-step', step_number: 1
  }))
  const phase2 = await resolvePromotionTarget(account({
    account_type: 'phase2', challenge_model_slug: '2-step', step_number: 2
  }))
  assert.equal(phase1.targetAccountType, 'phase2')
  assert.equal(phase2.targetAccountType, 'funded')
  assert.equal(phase2.isFinalPromotion, true)
})

test('a 1-step model goes straight to funded', async () => {
  const target = await resolvePromotionTarget(account({
    account_type: 'phase1', challenge_model_slug: '1-step', step_number: 1
  }))
  assert.equal(target.targetAccountType, 'funded')
  assert.equal(target.nextStep, null)
})

test('the promotion review and the created account agree on 3-step phase2', async () => {
  // The exact divergence this module exists to remove: the review row used to
  // be built from a hardcoded phase2 -> funded map while the account insert
  // derived phase3 from the step model.
  const acc = account({ account_type: 'phase2', challenge_model_slug: '3-step', step_number: 2 })
  const target = await resolvePromotionTarget(acc)
  assert.equal(target.targetAccountType, 'phase3')
  assert.equal(target.isFinalPromotion, false)
  assert.equal(target.nextStep, 3)
})

test('step_number wins over account_type when they disagree', async () => {
  // account_type is a label; step_number is what the ladder is indexed by.
  const target = await resolvePromotionTarget(account({
    account_type: 'phase1', challenge_model_slug: '3-step', step_number: 2
  }))
  assert.equal(target.targetAccountType, 'phase3')
})

test('a missing step_number is treated as step 1', async () => {
  const target = await resolvePromotionTarget(account({
    account_type: 'phase1', challenge_model_slug: '3-step', step_number: null
  }))
  assert.equal(target.targetAccountType, 'phase2')
})

// ─── Terminal account types ──────────────────────────────────────────────────

test('a funded account has no promotion path', async () => {
  assert.equal(await resolvePromotionTarget(account({
    account_type: 'funded', challenge_model_slug: '3-step', step_number: null
  })), null)
  assert.equal(await resolvePromotionTarget(account({ account_type: 'funded' })), null)
})

test('a competition account has no promotion path', async () => {
  assert.equal(await resolvePromotionTarget(account({ account_type: 'competition' })), null)
  assert.equal(await hasPromotionPath(account({ account_type: 'competition' })), false)
})

// ─── Legacy, pre-step-model accounts ─────────────────────────────────────────
// Admin-issued and replacement accounts never carry a challenge_model_slug.

test('legacy accounts fall back to the fixed ladder, including phase3', async () => {
  const targets = {}
  for (const type of ['phase1', 'phase2', 'phase3']) {
    targets[type] = (await resolvePromotionTarget(account({ account_type: type }))).targetAccountType
  }
  assert.deepEqual(targets, { phase1: 'phase2', phase2: 'funded', phase3: 'funded' })
})

test('an unknown step model slug falls back to the legacy ladder rather than throwing', async () => {
  const target = await resolvePromotionTarget(account({
    account_type: 'phase1', challenge_model_slug: 'does-not-exist', step_number: 1
  }))
  assert.equal(target.targetAccountType, 'phase2')
})

test('hasPromotionPath accepts every challenge phase and rejects terminal types', async () => {
  for (const type of ['phase1', 'phase2', 'phase3']) {
    assert.equal(await hasPromotionPath(account({ account_type: type })), true, `${type} should be promotable`)
  }
  for (const type of ['funded', 'competition', '', null]) {
    assert.equal(await hasPromotionPath(account({ account_type: type })), false, `${type} should not be promotable`)
  }
})
