const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const logger = require('../utils/logger')
const { INSTRUMENTS } = require('../instruments')
const {
  getTenantSettingsMap,
  upsertTenantSettings,
  parseSpreadMarkupMap
} = require('../utils/tenantSettings')
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = require('./admin')._internals

const TIERS = ['challenge', 'funded', 'competition']

async function auditLog(req, eventType, payload) {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'trading_economics',
      entityId: 'global',
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (err) {
    logger.warn('[admin-trading-economics] Non-critical audit log failed:', { error: err.message })
  }
}

// Validates a {tier: {instrument|'*': number}} map, rejecting unknown tiers,
// unknown instruments (other than the '*' wildcard), and non-finite/negative values.
function validateTieredMap(map, label) {
  if (map === undefined || map === null) return {}
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw Object.assign(new Error(`${label} must be an object keyed by tier`), { statusCode: 400 })
  }
  for (const [tier, instrumentMap] of Object.entries(map)) {
    if (!TIERS.includes(tier)) {
      throw Object.assign(new Error(`${label}: unknown tier "${tier}"`), { statusCode: 400 })
    }
    if (instrumentMap === null || typeof instrumentMap !== 'object' || Array.isArray(instrumentMap)) {
      throw Object.assign(new Error(`${label}: tier "${tier}" must map to an object`), { statusCode: 400 })
    }
    for (const [instrument, value] of Object.entries(instrumentMap)) {
      if (instrument !== '*' && !INSTRUMENTS.includes(instrument)) {
        throw Object.assign(new Error(`${label}: unknown instrument "${instrument}"`), { statusCode: 400 })
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw Object.assign(new Error(`${label}: value for ${tier}/${instrument} must be a non-negative number`), { statusCode: 400 })
      }
    }
  }
  return map
}

// GET /admin/trading-economics
router.get('/trading-economics', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const settings = await getTenantSettingsMap(['commission_per_lot_json', 'slippage_max_pips_adverse_json', 'dynamic_commission_per_lot', 'slippage_max_pips_adverse'])
    res.json({
      commission_per_lot: parseSpreadMarkupMap(settings.commission_per_lot_json),
      slippage_max_pips_adverse: parseSpreadMarkupMap(settings.slippage_max_pips_adverse_json),
      default_commission_per_lot: parseFloat(settings.dynamic_commission_per_lot || 0),
      default_slippage_max_pips_adverse: parseFloat(settings.slippage_max_pips_adverse || 0),
      instruments: INSTRUMENTS,
      tiers: TIERS
    })
  } catch (err) {
    logger.error('[admin-trading-economics] Failed to load settings:', { error: err.message })
    res.status(500).json({ error: 'Failed to load trading economics settings' })
  }
})

// POST /admin/trading-economics
router.post('/trading-economics', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const body = req.body || {}
    const commissionMap = validateTieredMap(body.commission_per_lot, 'commission_per_lot')
    const slippageMap = validateTieredMap(body.slippage_max_pips_adverse, 'slippage_max_pips_adverse')

    await upsertTenantSettings(pool, {
      commission_per_lot_json: JSON.stringify(commissionMap),
      slippage_max_pips_adverse_json: JSON.stringify(slippageMap)
    })

    await auditLog(req, 'trading_economics_updated', { commission_per_lot: commissionMap, slippage_max_pips_adverse: slippageMap })
    res.json({ message: 'Trading economics settings updated', commission_per_lot: commissionMap, slippage_max_pips_adverse: slippageMap })
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message })
    }
    logger.error('[admin-trading-economics] Failed to update settings:', { error: err.message })
    res.status(500).json({ error: 'Failed to update trading economics settings' })
  }
})

module.exports = router
