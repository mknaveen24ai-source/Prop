/**
 * The single answer to "what does this account get promoted INTO?".
 *
 * This used to be decided in two places that disagreed:
 *
 *   - progressionService.buildNextPhaseStepModelPlan derived it from the step
 *     model (`nextStep <= steps ? phaseN : funded`) and CREATED the account.
 *   - tenantMonthlyQuotaService.getTargetAccountType hardcoded phase1 -> phase2,
 *     phase2 -> funded and STORED that on the promotion review row, which is
 *     what the admin sees before clicking Approve.
 *
 * On a 3-step model those diverge: a passed phase2 account showed
 * "PHASE2 -> FUNDED" in the review queue but approving it created a phase3
 * account. The admin approved one thing and got another.
 *
 * Lives in its own module rather than in either service because
 * progressionService already requires tenantMonthlyQuotaService; putting it in
 * the latter would close an import cycle.
 */

const logger = require('../utils/logger')
const { fetchStepModelBySlug } = require('../utils/stepModels')

// Pre-step-model accounts (admin-issued and replacement accounts never carry a
// challenge_model_slug — see routes/admin/shared/listBuilders.js) have no model
// to consult, so they fall back to the original fixed two-step ladder. phase3 is
// included because admins can issue one directly even though no legacy
// three-step settings exist for it.
const LEGACY_LADDER = {
  phase1: 'phase2',
  phase2: 'funded',
  phase3: 'funded'
}

/**
 * @param {object} acc   an `accounts` row (needs account_type, and
 *                       challenge_model_slug/step_number when model-backed)
 * @param {object} [deps]
 * @param {function} [deps.loadStepModel]  step-model lookup; defaults to the
 *   real DB-backed one. Injectable so this stays unit-testable — stubbing the
 *   module in require.cache does not work here, because the import below is
 *   destructured at load time and whichever module pulls this in first wins.
 * @returns {Promise<null | {
 *   targetAccountType: string,   // 'phase2' | 'phase3' | ... | 'funded'
 *   nextStep: number|null,       // step_number for the new account, null when funded
 *   stepModel: object|null,      // the challenge_models row, when model-backed
 *   isFinalPromotion: boolean    // true when the target is a funded account
 * }>}  null when the account has no promotion path (funded, competition, ...)
 */
async function resolvePromotionTarget(acc, { loadStepModel = fetchStepModelBySlug } = {}) {
  const accountType = String(acc?.account_type || '').toLowerCase()
  if (!accountType) return null

  if (acc?.challenge_model_slug) {
    const stepModel = await loadStepModel(acc.challenge_model_slug)
    if (stepModel) {
      // A funded account is the end of the ladder — nothing above it.
      if (accountType === 'funded') return null

      const currentStep = parseInt(acc.step_number || 1, 10)
      const nextStep = currentStep + 1
      const steps = parseInt(stepModel.steps || 1, 10)

      return nextStep <= steps
        ? { targetAccountType: `phase${nextStep}`, nextStep, stepModel, isFinalPromotion: false }
        : { targetAccountType: 'funded', nextStep: null, stepModel, isFinalPromotion: true }
    }
    logger.error(
      `[progression] Account ${acc.id} references unknown step model "${acc.challenge_model_slug}" — falling back to legacy ladder.`
    )
  }

  const targetAccountType = LEGACY_LADDER[accountType]
  if (!targetAccountType) return null

  return {
    targetAccountType,
    nextStep: targetAccountType === 'funded' ? null : parseInt(targetAccountType.replace('phase', ''), 10),
    stepModel: null,
    isFinalPromotion: targetAccountType === 'funded'
  }
}

/** True when this account can be promoted at all. */
async function hasPromotionPath(acc, deps) {
  return (await resolvePromotionTarget(acc, deps)) !== null
}

module.exports = {
  resolvePromotionTarget,
  hasPromotionPath,
  LEGACY_LADDER
}
