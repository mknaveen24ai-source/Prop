// Promotion review queue — the admin gate between passing a challenge and
// getting the next account.
//
// These endpoints were deleted wholesale in the multi-tenant teardown
// (commit 5366dc4) because they took getScopedTenantId/requireTenantAdminOrSuperAdmin,
// but AdminPromotionReviews.jsx, its App.jsx route and its sidebar entry all
// survived — so the page 404'd on every load and showed "Failed to load
// promotion reviews". The service layer underneath
// (services/tenantMonthlyQuotaService.js) was never removed, so this file is
// mostly re-exposing SQL that has been sitting there unreachable.
//
// Mounted at the router root by ./index.js — the admin URL space is flat, so
// every path below is absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const logger = require('../../utils/logger')
const { authenticateAdmin, requireAdminCapability } = require('../middleware')
const { emitAdminEvent } = require('../../utils/realtime')
const { fetchStepModels, ensureStepModelInfrastructure } = require('../../utils/stepModels')
const { ensureFeatureTables } = require('./shared/schema')
const {
  listPromotionReviews,
  getPromotionReviewForUpdate,
  markPromotionReviewRejected
} = require('../../services/tenantMonthlyQuotaService')
const {
  fetchProgressionSettings,
  approvePromotionReview
} = require('../../services/progressionService')
const { appendImmutableAudit, getAdminActorLabel, buildAdminActorPayload } = require('./shared/audit')

const ALLOWED_STATUSES = new Set(['pending', 'approved', 'rejected', 'all'])

function parseStatus(raw) {
  const value = String(raw || 'pending').toLowerCase()
  return ALLOWED_STATUSES.has(value) ? value : 'pending'
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /promotion-reviews
// ─────────────────────────────────────────────────────────────────────────────
// Read-scoped rather than promotion-scoped: the scoped roles that can already
// see accounts should be able to see what is queued, without being able to act.
router.get('/promotion-reviews', authenticateAdmin, requireAdminCapability('account:read:scoped'), async function (req, res) {
  try {
    const rows = await listPromotionReviews(pool, {
      status: parseStatus(req.query?.status),
      month: req.query?.month || null
    })
    // Wrapped in { rows } — the page reads reviewsRes.data.rows.
    res.json({ rows, count: rows.length })
  } catch (error) {
    logger.error('Promotion review list error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch promotion reviews' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /promotion-reviews/:id/approve
// ─────────────────────────────────────────────────────────────────────────────
// Creates the next account. approvePromotionReview locks the source account
// FOR UPDATE, re-checks that it is still 'passed', and routes through
// promotePassedAccount — so the account created is resolved from the challenge
// model at approval time by the same code that filled in target_account_type
// when the review was raised (services/promotionTarget.js).
router.post('/promotion-reviews/:id/approve', authenticateAdmin, requireAdminCapability('account:promotion_review:scoped'), async function (req, res) {
  const reviewId = parseInt(req.params.id, 10)
  if (!Number.isFinite(reviewId)) {
    return res.status(400).json({ error: 'Invalid review id' })
  }

  // Both bootstraps run `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ...` on
  // the shared pool the first time they are called in a process. Left to fire
  // lazily they would do that from a *different* connection while the
  // transaction below holds SELECT ... FOR UPDATE on an accounts row — the
  // ALTER needs ACCESS EXCLUSIVE, waits on that row lock, and the whole approve
  // dies on statement_timeout. Warming them before BEGIN makes them no-ops by
  // the time the lock exists. They memoise, so this costs nothing after the
  // first call.
  await ensureStepModelInfrastructure()
  await ensureFeatureTables()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const review = await getPromotionReviewForUpdate(client, reviewId)
    if (!review) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Promotion review not found' })
    }

    const settings = await fetchProgressionSettings(client)
    const result = await approvePromotionReview(client, review, settings, {
      adminId: req.admin?.adminId || null,
      decisionNote: String(req.body?.note || '').trim() || null
    })

    await appendImmutableAudit(client, {
      eventType: 'promotion_review_approved',
      entityType: 'account',
      entityId: String(review.source_account_id),
      actor: getAdminActorLabel(req.admin),
      payload: {
        review_id: reviewId,
        from_account_type: review.from_account_type,
        target_account_type: review.target_account_type,
        created_account_id: result.new_account_id,
        actor: buildAdminActorPayload(req.admin)
      }
    })

    await client.query('COMMIT')

    emitAdminEvent('admin_promotion_review_updated', { review_id: reviewId, status: 'approved' })

    logger.info(
      `[promotion-review] #${reviewId} approved by ${getAdminActorLabel(req.admin)}: ` +
      `${review.from_account_type} -> ${review.target_account_type} (account ${result.new_account_id})`
    )

    res.json({
      message: `Promotion approved — ${review.target_account_type} account created`,
      review: result.review,
      new_account_id: result.new_account_id
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    // approvePromotionReview raises 400/404 for the "not pending" / "source not
    // passed" cases; anything else is genuinely unexpected.
    const status = Number.isFinite(error.statusCode) ? error.statusCode : 500
    if (status === 500) logger.error('Promotion review approve error:', { error: error.message, reviewId })
    res.status(status).json({ error: status === 500 ? 'Could not approve promotion' : error.message })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /promotion-reviews/:id/reject
// ─────────────────────────────────────────────────────────────────────────────
router.post('/promotion-reviews/:id/reject', authenticateAdmin, requireAdminCapability('account:promotion_review:scoped'), async function (req, res) {
  const reviewId = parseInt(req.params.id, 10)
  if (!Number.isFinite(reviewId)) {
    return res.status(400).json({ error: 'Invalid review id' })
  }

  // A rejection strands a trader who has already met the target, so it has to
  // say why. The page asks for the same minimum before it sends.
  const note = String(req.body?.note || '').trim()
  if (note.length < 5) {
    return res.status(400).json({ error: 'A clear rejection reason is required' })
  }

  // Same reason as approve: keep first-call DDL out of the locked transaction.
  await ensureFeatureTables()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const review = await getPromotionReviewForUpdate(client, reviewId)
    if (!review) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Promotion review not found' })
    }
    if (String(review.status || '').toLowerCase() !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Promotion review is not pending' })
    }

    const rejected = await markPromotionReviewRejected(client, reviewId, {
      adminId: req.admin?.adminId || null,
      decisionNote: note
    })

    await appendImmutableAudit(client, {
      eventType: 'promotion_review_rejected',
      entityType: 'account',
      entityId: String(review.source_account_id),
      actor: getAdminActorLabel(req.admin),
      payload: {
        review_id: reviewId,
        from_account_type: review.from_account_type,
        target_account_type: review.target_account_type,
        reason: note,
        actor: buildAdminActorPayload(req.admin)
      }
    })

    await client.query('COMMIT')

    emitAdminEvent('admin_promotion_review_updated', { review_id: reviewId, status: 'rejected' })

    logger.info(`[promotion-review] #${reviewId} rejected by ${getAdminActorLabel(req.admin)}: ${note}`)

    res.json({ message: 'Promotion rejected', review: rejected })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Promotion review reject error:', { error: error.message, reviewId })
    res.status(500).json({ error: 'Could not reject promotion' })
  } finally {
    client.release()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /account-batches
// ─────────────────────────────────────────────────────────────────────────────
// Feeds the page's quota stat cards. The monthly per-size allocation these
// originally read was removed with the tenant system; what gates account
// creation now is a LIFETIME slot pool per (model, size) —
// challenge_model_pricing.is_unlimited / slot_limit, already computed with
// usage by fetchStepModels().
//
// Sizes are aggregated across models so one row per account size lines up with
// what the cards count. A size is 'full' only when every model offering it is
// exhausted — if any model can still issue it, the size is still available.
//
// Advisory only: nothing here blocks approval. A trader who has already passed
// must not be stranded because the pool is full.
router.get('/account-batches', authenticateAdmin, requireAdminCapability('account:read:scoped'), async function (req, res) {
  try {
    const models = await fetchStepModels({ onlyEnabled: false })

    const bySize = new Map()
    for (const model of models) {
      for (const price of model.pricing || []) {
        const size = Number(price.account_size)
        if (!Number.isFinite(size)) continue

        const entry = bySize.get(size) || {
          account_size: size, used: 0, remaining: 0, slot_limit: 0, is_unlimited: false, models: []
        }
        entry.used += Number(price.used) || 0
        if (price.is_unlimited) {
          entry.is_unlimited = true
        } else {
          entry.slot_limit += Number(price.slot_limit) || 0
          entry.remaining += Number(price.remaining) || 0
        }
        entry.models.push({
          slug: model.slug,
          name: model.name,
          is_active: price.is_active,
          is_unlimited: price.is_unlimited,
          slot_limit: price.slot_limit,
          used: price.used,
          remaining: price.remaining,
          locked: price.locked
        })
        bySize.set(size, entry)
      }
    }

    const sizes = [...bySize.values()]
      .map((entry) => ({
        ...entry,
        remaining: entry.is_unlimited ? null : entry.remaining,
        slot_limit: entry.is_unlimited ? null : entry.slot_limit,
        state: entry.is_unlimited || entry.remaining > 0 ? 'available' : 'full'
      }))
      .sort((a, b) => a.account_size - b.account_size)

    res.json({ sizes, basis: 'challenge_model_pricing_slots' })
  } catch (error) {
    logger.error('Account batch quota error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch account size availability' })
  }
})

module.exports = router
