const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const logger = require('../utils/logger')
const { sanitizeString } = require('../utils/validation')
const { fetchReferralSeasonBySlugOrId, computeReferralSeasonStandings, fetchReferralSeasonLeaderboard } = require('../utils/referralSeasons')
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = require('./admin')._internals

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

async function auditLog(req, eventType, entityId, payload) {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'referral_season',
      entityId: String(entityId),
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (err) {
    logger.warn('[admin-referral-seasons] Non-critical audit log failed:', { error: err.message })
  }
}

// GET /admin/referral-seasons
router.get('/referral-seasons', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT s.*, COUNT(rse.id)::int AS entry_count
         FROM referral_seasons s
         LEFT JOIN referral_season_entries rse ON rse.season_id = s.id
        GROUP BY s.id
        ORDER BY s.created_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    logger.error('[admin-referral-seasons] Failed to list seasons:', { error: err.message })
    res.status(500).json({ error: 'Failed to load referral seasons' })
  }
})

// POST /admin/referral-seasons
router.post('/referral-seasons', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const body = req.body || {}
    const title = sanitizeString(String(body.title || '').trim(), 200)
    if (!title) return res.status(400).json({ error: 'Title is required' })

    const startAt = new Date(body.start_at)
    const endAt = new Date(body.end_at)
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
      return res.status(400).json({ error: 'Valid start_at and end_at (end after start) are required' })
    }

    let slug = slugify(body.slug || title)
    const existingSlug = await pool.query('SELECT id FROM referral_seasons WHERE slug = $1', [slug])
    if (existingSlug.rows.length > 0) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    const result = await pool.query(
      `INSERT INTO referral_seasons (slug, title, description, start_at, end_at, prize_pool_json, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING *`,
      [
        slug, title, sanitizeString(String(body.description || ''), 2000) || null,
        startAt.toISOString(), endAt.toISOString(),
        JSON.stringify(body.prize_pool || []), getAdminActorLabel(req.admin)
      ]
    )

    const season = result.rows[0]
    await auditLog(req, 'referral_season_created', season.id, { title, slug, start_at: startAt, end_at: endAt })
    res.status(201).json(season)
  } catch (err) {
    logger.error('[admin-referral-seasons] Failed to create season:', { error: err.message })
    res.status(500).json({ error: 'Failed to create referral season' })
  }
})

// GET /admin/referral-seasons/:id
router.get('/referral-seasons/:id', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const season = await fetchReferralSeasonBySlugOrId(req.params.id)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })

    const leaderboard = season.status === 'completed'
      ? await fetchReferralSeasonLeaderboard(season.id)
      : await computeReferralSeasonStandings(pool, season, { persist: false })

    res.json({ ...season, leaderboard })
  } catch (err) {
    logger.error('[admin-referral-seasons] Failed to load season detail:', { error: err.message })
    res.status(500).json({ error: 'Failed to load referral season' })
  }
})

// PATCH /admin/referral-seasons/:id
router.patch('/referral-seasons/:id', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const season = await fetchReferralSeasonBySlugOrId(req.params.id)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })

    const body = req.body || {}
    const isLocked = season.status !== 'upcoming'
    const fields = []
    const values = []
    let i = 1

    function set(column, value) {
      fields.push(`${column} = $${i}`)
      values.push(value)
      i += 1
    }

    if (body.description !== undefined) set('description', sanitizeString(String(body.description || ''), 2000) || null)
    if (body.prize_pool !== undefined) set('prize_pool_json', JSON.stringify(body.prize_pool))

    if (!isLocked) {
      if (body.title !== undefined) {
        const title = sanitizeString(String(body.title || '').trim(), 200)
        if (!title) return res.status(400).json({ error: 'Title cannot be empty' })
        set('title', title)
      }
      if (body.start_at !== undefined) {
        const startAt = new Date(body.start_at)
        if (Number.isNaN(startAt.getTime())) return res.status(400).json({ error: 'Invalid start_at' })
        set('start_at', startAt.toISOString())
      }
      if (body.end_at !== undefined) {
        const endAt = new Date(body.end_at)
        if (Number.isNaN(endAt.getTime())) return res.status(400).json({ error: 'Invalid end_at' })
        set('end_at', endAt.toISOString())
      }
    }

    if (fields.length === 0) return res.status(400).json({ error: 'No editable fields provided' })

    values.push(season.id)
    const result = await pool.query(
      `UPDATE referral_seasons SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      values
    )

    await auditLog(req, 'referral_season_updated', season.id, { changes: body, was_locked: isLocked })
    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin-referral-seasons] Failed to update season:', { error: err.message })
    res.status(500).json({ error: 'Failed to update referral season' })
  }
})

// POST /admin/referral-seasons/:id/cancel
router.post('/referral-seasons/:id/cancel', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const season = await fetchReferralSeasonBySlugOrId(req.params.id)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })
    if (!['upcoming', 'active'].includes(season.status)) {
      return res.status(400).json({ error: 'Only upcoming or active seasons can be cancelled' })
    }

    await pool.query(`UPDATE referral_seasons SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [season.id])
    await auditLog(req, 'referral_season_cancelled', season.id, {})
    res.json({ message: 'Referral season cancelled' })
  } catch (err) {
    logger.error('[admin-referral-seasons] Failed to cancel season:', { error: err.message })
    res.status(500).json({ error: 'Failed to cancel referral season' })
  }
})

module.exports = router
