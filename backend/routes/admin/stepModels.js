// Admin challenge step-model phases, scaling and pricing.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireSuperAdmin
} = require('../middleware')
const logger = require('../../utils/logger')
const { fetchStepModels, fetchStepModelBySlug, toggleStepModel } = require('../../utils/stepModels')
require('../../loadEnv')

const {
  getAdminActorLabel, appendImmutableAudit
} = require('./shared/audit')

// ─────────────────────────────────────────────────────────────────────────────
// Step-model (1-step / 2-step / 3-step challenge) admin management.
// Global/platform-wide — super-admin only.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/step-models', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const models = await fetchStepModels()
    res.json(models)
  } catch (err) {
    logger.error('[admin] Failed to load step models:', { error: err.message })
    res.status(500).json({ error: 'Failed to load step models' })
  }
})

router.post('/step-models/:slug/toggle', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const enabled = req.body?.enabled
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: '`enabled` (boolean) is required' })
    }
    const updated = await toggleStepModel(slug, enabled)
    if (!updated) return res.status(404).json({ error: 'Step model not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_toggled',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, enabled: !!updated.is_active }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
    res.json(updated)
  } catch (err) {
    logger.error('[admin] Failed to toggle step model:', { error: err.message })
    res.status(500).json({ error: 'Failed to toggle step model' })
  }
})

router.patch('/step-models/:slug/phases/:phaseIndex', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const phaseIndex = parseInt(req.params.phaseIndex, 10)
    if (!Number.isFinite(phaseIndex) || phaseIndex < 1) {
      return res.status(400).json({ error: 'Invalid phase index' })
    }

    const model = await fetchStepModelBySlug(slug)
    if (!model) return res.status(404).json({ error: 'Step model not found' })
    if (phaseIndex > model.steps) return res.status(400).json({ error: `This model only has ${model.steps} phase(s)` })

    const phaseIdx0 = phaseIndex - 1
    const profitTargets = Array.isArray(model.profit_targets_pct) ? [...model.profit_targets_pct] : []
    const timeLimits = Array.isArray(model.time_limits_days) ? [...model.time_limits_days] : []
    const consistencyByPhase = Array.isArray(model.consistency_max_day_pct_by_phase) ? [...model.consistency_max_day_pct_by_phase] : []

    const body = req.body || {}
    if (body.profit_target_pct !== undefined) profitTargets[phaseIdx0] = parseFloat(body.profit_target_pct)
    if (body.max_time_limit_days !== undefined) timeLimits[phaseIdx0] = parseInt(body.max_time_limit_days, 10)
    if (body.consistency_rule_pct !== undefined) consistencyByPhase[phaseIdx0] = parseFloat(body.consistency_rule_pct)

    const trailingMaxDrawdownPct = body.trailing_max_drawdown_pct !== undefined ? parseFloat(body.trailing_max_drawdown_pct) : model.max_drawdown_pct
    const dailyLossLimitPct = body.daily_loss_limit_pct !== undefined ? parseFloat(body.daily_loss_limit_pct) : model.daily_drawdown_pct
    const minTradingDays = body.min_trading_days !== undefined ? parseInt(body.min_trading_days, 10) : model.min_trading_days

    const result = await pool.query(
      `UPDATE challenge_models SET
         profit_targets_pct = $2::jsonb,
         time_limits_days = $3::jsonb,
         consistency_max_day_pct_by_phase = $4::jsonb,
         max_drawdown_pct = $5,
         daily_drawdown_pct = $6,
         min_trading_days = $7,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        model.id, JSON.stringify(profitTargets), JSON.stringify(timeLimits), JSON.stringify(consistencyByPhase),
        trailingMaxDrawdownPct, dailyLossLimitPct, minTradingDays
      ]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_phase_updated',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, phase_index: phaseIndex, changes: body }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin] Failed to update step model phase:', { error: err.message })
    res.status(500).json({ error: 'Failed to update step model phase' })
  }
})

// PATCH /admin/step-models/:slug/scaling
// Funded-stage scaling-plan config: milestone size, multiplier, real capital
// injection per milestone, and the account-size cap. Separate from
// /phases/:phaseIndex since scaling applies to the funded stage as a whole,
// not any one evaluation phase. Since scaling_increase_per_milestone_pct now
// wires up real money via challengeEngine.js's evaluateScalingPlan() +
// utils/balanceAdjustments.js, these fields are edited here explicitly rather
// than left as seed-only constants.
router.patch('/step-models/:slug/scaling', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const model = await fetchStepModelBySlug(slug)
    if (!model) return res.status(404).json({ error: 'Step model not found' })

    const body = req.body || {}
    const scalingEnabled = body.scaling_enabled !== undefined ? !!body.scaling_enabled : model.scaling_enabled
    const scalingTargetPct = body.scaling_target_pct !== undefined ? parseFloat(body.scaling_target_pct) : parseFloat(model.scaling_target_pct)
    const scalingMultiplier = body.scaling_multiplier !== undefined ? parseFloat(body.scaling_multiplier) : parseFloat(model.scaling_multiplier)
    const scalingIncreasePct = body.scaling_increase_per_milestone_pct !== undefined ? parseFloat(body.scaling_increase_per_milestone_pct) : parseFloat(model.scaling_increase_per_milestone_pct || 0)
    const scalingMaxAccountSize = body.scaling_max_account_size !== undefined ? parseInt(body.scaling_max_account_size, 10) : parseInt(model.scaling_max_account_size, 10)

    if (!(scalingTargetPct > 0)) return res.status(400).json({ error: 'scaling_target_pct must be a positive number' })
    if (!(scalingMultiplier > 1)) return res.status(400).json({ error: 'scaling_multiplier must be greater than 1' })
    if (scalingIncreasePct < 0) return res.status(400).json({ error: 'scaling_increase_per_milestone_pct cannot be negative' })
    if (!(scalingMaxAccountSize > 0)) return res.status(400).json({ error: 'scaling_max_account_size must be a positive number' })

    const result = await pool.query(
      `UPDATE challenge_models SET
         scaling_enabled = $2,
         scaling_target_pct = $3,
         scaling_multiplier = $4,
         scaling_increase_per_milestone_pct = $5,
         scaling_max_account_size = $6,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [model.id, scalingEnabled, scalingTargetPct, scalingMultiplier, scalingIncreasePct, scalingMaxAccountSize]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_scaling_updated',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, changes: body }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin] Failed to update step model scaling config:', { error: err.message })
    res.status(500).json({ error: 'Failed to update scaling config' })
  }
})

router.patch('/step-models/:slug/pricing/:accountSize', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase()
    const accountSize = parseInt(req.params.accountSize, 10)
    const price = parseFloat(req.body?.price)
    const isActive = req.body?.is_active
    const isUnlimitedBody = req.body?.is_unlimited
    const slotLimitRaw = req.body?.slot_limit

    if (!Number.isFinite(accountSize)) return res.status(400).json({ error: 'Invalid account size' })
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Invalid price' })
    if (isUnlimitedBody !== undefined && typeof isUnlimitedBody !== 'boolean') {
      return res.status(400).json({ error: 'is_unlimited must be a boolean' })
    }

    // undefined = leave the column untouched; null/'' = explicitly clear it
    let slotLimit
    if (slotLimitRaw !== undefined) {
      if (slotLimitRaw === null || slotLimitRaw === '') {
        slotLimit = null
      } else {
        const parsed = parseInt(slotLimitRaw, 10)
        if (!Number.isFinite(parsed) || parsed < 0) {
          return res.status(400).json({ error: 'slot_limit must be a non-negative integer' })
        }
        slotLimit = parsed
      }
    }

    const model = await fetchStepModelBySlug(slug)
    if (!model) return res.status(404).json({ error: 'Step model not found' })

    const existing = await pool.query(
      `SELECT is_unlimited, slot_limit FROM challenge_model_pricing WHERE challenge_model_id = $1 AND account_size = $2`,
      [model.id, accountSize]
    )
    if (existing.rows.length === 0) return res.status(404).json({ error: 'No pricing row for this model/size' })

    const effectiveUnlimited = typeof isUnlimitedBody === 'boolean' ? isUnlimitedBody : existing.rows[0].is_unlimited
    const effectiveSlotLimit = slotLimit !== undefined ? slotLimit : existing.rows[0].slot_limit
    if (!effectiveUnlimited && (effectiveSlotLimit === null || effectiveSlotLimit === undefined)) {
      return res.status(400).json({ error: 'slot_limit is required when is_unlimited is false' })
    }

    const result = await pool.query(
      `UPDATE challenge_model_pricing
          SET price = $3,
              is_active = COALESCE($4, is_active),
              is_unlimited = COALESCE($5, is_unlimited),
              slot_limit = CASE WHEN $6 THEN $7 ELSE slot_limit END
        WHERE challenge_model_id = $1 AND account_size = $2
        RETURNING *`,
      [
        model.id, accountSize, price,
        typeof isActive === 'boolean' ? isActive : null,
        typeof isUnlimitedBody === 'boolean' ? isUnlimitedBody : null,
        slotLimit !== undefined, slotLimit ?? null
      ]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'step_model_pricing_updated',
        entityType: 'step_model',
        entityId: slug,
        actor: getAdminActorLabel(req.admin),
        payload: { slug, account_size: accountSize, price, is_unlimited: isUnlimitedBody, slot_limit: slotLimit }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin] Failed to update step model pricing:', { error: err.message })
    res.status(500).json({ error: 'Failed to update step model pricing' })
  }
})

module.exports = router
