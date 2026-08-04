const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const logger = require('../utils/logger')
const { sanitizeString } = require('../utils/validation')
const {
  fetchAllCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon
} = require('../utils/coupons')
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = require('./admin')._internals

async function auditLog(req, eventType, entityId, payload) {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'coupon',
      entityId: String(entityId),
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (err) {
    logger.warn('[admin-coupons] Non-critical audit log failed:', { error: err.message })
  }
}

function parseOptionalInt(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : NaN
}

function parseOptionalFloat(value) {
  if (value === undefined || value === null || value === '') return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

function parseOptionalDate(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

// GET /admin/coupons
router.get('/coupons', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const coupons = await fetchAllCoupons()
    res.json({ coupons })
  } catch (err) {
    logger.error('[admin-coupons] Failed to list coupons:', { error: err.message })
    res.status(500).json({ error: 'Failed to load coupons' })
  }
})

// POST /admin/coupons
router.post('/coupons', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const code = String(req.body?.code || '').trim().toUpperCase()
    const discountType = String(req.body?.discount_type || '').trim().toLowerCase()
    const discountValue = parseFloat(req.body?.discount_value)

    if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
      return res.status(400).json({ error: 'Code must be 3-40 characters: letters, numbers, - or _ only' })
    }
    if (!['percent', 'fixed'].includes(discountType)) {
      return res.status(400).json({ error: 'discount_type must be "percent" or "fixed"' })
    }
    if (!Number.isFinite(discountValue) || discountValue <= 0) {
      return res.status(400).json({ error: 'A valid discount_value is required' })
    }
    if (discountType === 'percent' && discountValue > 100) {
      return res.status(400).json({ error: 'Percent discount cannot exceed 100' })
    }

    const maxRedemptions = parseOptionalInt(req.body?.max_redemptions)
    if (Number.isNaN(maxRedemptions) || maxRedemptions === 0 || (maxRedemptions !== null && maxRedemptions < 1)) {
      return res.status(400).json({ error: 'max_redemptions must be a positive integer, or left blank for unlimited' })
    }

    const minOrderAmount = parseOptionalFloat(req.body?.min_order_amount)
    if (Number.isNaN(minOrderAmount) || (minOrderAmount !== null && minOrderAmount < 0)) {
      return res.status(400).json({ error: 'min_order_amount must be a non-negative number' })
    }

    const expiresAt = parseOptionalDate(req.body?.expires_at)
    if (expiresAt === undefined) {
      return res.status(400).json({ error: 'Invalid expires_at date' })
    }

    const description = sanitizeString(String(req.body?.description || '').trim(), 300) || null

    const coupon = await createCoupon({
      code,
      description,
      discount_type: discountType,
      discount_value: discountValue,
      max_redemptions: maxRedemptions,
      min_order_amount: minOrderAmount,
      expires_at: expiresAt,
      created_by: getAdminActorLabel(req.admin)
    })

    await auditLog(req, 'coupon_created', coupon.id, { code, discount_type: discountType, discount_value: discountValue })
    res.status(201).json(coupon)
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'A coupon with this code already exists' })
    logger.error('[admin-coupons] Failed to create coupon:', { error: err.message })
    res.status(500).json({ error: 'Failed to create coupon' })
  }
})

// PATCH /admin/coupons/:id
router.patch('/coupons/:id', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const body = req.body || {}
    const patch = {}

    if (body.description !== undefined) {
      patch.description = sanitizeString(String(body.description || '').trim(), 300) || null
    }
    if (body.discount_type !== undefined) {
      const v = String(body.discount_type).trim().toLowerCase()
      if (!['percent', 'fixed'].includes(v)) return res.status(400).json({ error: 'Invalid discount_type' })
      patch.discount_type = v
    }
    if (body.discount_value !== undefined) {
      const v = parseFloat(body.discount_value)
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: 'Invalid discount_value' })
      patch.discount_value = v
    }
    if (body.max_redemptions !== undefined) {
      const v = parseOptionalInt(body.max_redemptions)
      if (Number.isNaN(v) || v === 0 || (v !== null && v < 1)) return res.status(400).json({ error: 'Invalid max_redemptions' })
      patch.max_redemptions = v
    }
    if (body.min_order_amount !== undefined) {
      const v = parseOptionalFloat(body.min_order_amount)
      if (Number.isNaN(v) || (v !== null && v < 0)) return res.status(400).json({ error: 'Invalid min_order_amount' })
      patch.min_order_amount = v
    }
    if (body.expires_at !== undefined) {
      const v = parseOptionalDate(body.expires_at)
      if (v === undefined) return res.status(400).json({ error: 'Invalid expires_at date' })
      patch.expires_at = v
    }
    if (body.is_active !== undefined) patch.is_active = !!body.is_active

    const coupon = await updateCoupon(req.params.id, patch)
    if (!coupon) return res.status(404).json({ error: 'Coupon not found' })

    await auditLog(req, 'coupon_updated', coupon.id, { changes: patch })
    res.json(coupon)
  } catch (err) {
    logger.error('[admin-coupons] Failed to update coupon:', { error: err.message })
    res.status(500).json({ error: 'Failed to update coupon' })
  }
})

// DELETE /admin/coupons/:id
router.delete('/coupons/:id', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    const deleted = await deleteCoupon(req.params.id)
    if (!deleted) return res.status(404).json({ error: 'Coupon not found' })
    await auditLog(req, 'coupon_deleted', req.params.id, { code: deleted.code })
    res.json({ message: 'Coupon deleted' })
  } catch (err) {
    logger.error('[admin-coupons] Failed to delete coupon:', { error: err.message })
    res.status(500).json({ error: 'Failed to delete coupon' })
  }
})

module.exports = router
