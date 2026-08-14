const express = require('express')
const router = express.Router()
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateToken } = require('./middleware')
const {
  fetchReferralSeasonBySlugOrId,
  computeReferralSeasonStandings,
  fetchReferralSeasonLeaderboard
} = require('../utils/referralSeasons')

function serializeSeason(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    start_at: row.start_at,
    end_at: row.end_at,
    ranking_metric: row.ranking_metric,
    prize_pool: row.prize_pool_json || []
  }
}

// GET /api/referral-seasons?status=upcoming|active|completed
router.get('/', async function (req, res) {
  try {
    const status = String(req.query.status || '').trim()
    const validStatuses = ['upcoming', 'active', 'completed', 'cancelled']
    const conditions = []
    const values = []
    if (validStatuses.includes(status)) {
      values.push(status)
      conditions.push(`status = $${values.length}`)
    } else {
      conditions.push(`status != 'cancelled'`)
    }
    const result = await pool.query(
      `SELECT * FROM referral_seasons WHERE ${conditions.join(' AND ')} ORDER BY start_at DESC LIMIT 100`,
      values
    )
    res.json(result.rows.map(serializeSeason))
  } catch (err) {
    logger.error('[referral-seasons] Failed to list seasons:', { error: err.message })
    res.status(500).json({ error: 'Could not load referral seasons' })
  }
})

// GET /api/referral-seasons/:slug
router.get('/:slug', authenticateToken, async function (req, res) {
  try {
    const season = await fetchReferralSeasonBySlugOrId(req.params.slug)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })

    // referral_season_entries rows only exist once the season is finalized
    // (computeReferralSeasonStandings is only called with persist:true from
    // referralSeasonEngine.js's finalizeSeason) — while upcoming/active, "my
    // entry" has to come from the same live standings the leaderboard uses.
    let myEntry = null
    if (season.status === 'completed') {
      const entryResult = await pool.query(
        `SELECT new_paying_referrals, final_rank FROM referral_season_entries WHERE season_id = $1 AND referrer_user_id = $2`,
        [season.id, req.user.userId]
      )
      myEntry = entryResult.rows[0] || null
    } else {
      const ranked = await computeReferralSeasonStandings(pool, season, { persist: false })
      const mine = ranked.find(row => row.referrer_user_id === req.user.userId)
      myEntry = mine ? { new_paying_referrals: mine.new_paying_referrals, final_rank: mine.rank } : null
    }

    res.json({
      ...serializeSeason(season),
      my_entry: myEntry
    })
  } catch (err) {
    logger.error('[referral-seasons] Failed to load season detail:', { error: err.message })
    res.status(500).json({ error: 'Could not load referral season' })
  }
})

// GET /api/referral-seasons/:slug/leaderboard
// Live-computed while upcoming/active (nothing to rank yet, or ranking can
// still move); frozen once completed (final_rank set at finalize time).
router.get('/:slug/leaderboard', async function (req, res) {
  try {
    const season = await fetchReferralSeasonBySlugOrId(req.params.slug)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })

    if (season.status === 'completed') {
      return res.json(await fetchReferralSeasonLeaderboard(season.id))
    }
    const ranked = await computeReferralSeasonStandings(pool, season, { persist: false })
    res.json(ranked)
  } catch (err) {
    logger.error('[referral-seasons] Failed to load leaderboard:', { error: err.message })
    res.status(500).json({ error: 'Could not load leaderboard' })
  }
})

// GET /api/referral-seasons/vouchers/mine
router.get('/vouchers/mine', authenticateToken, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT v.id, v.code, v.account_size, v.challenge_model_slug, v.status,
              v.issued_at, v.expires_at, v.redeemed_at,
              s.title AS season_title, s.slug AS season_slug, rse.final_rank
         FROM referral_season_prize_vouchers v
         JOIN referral_seasons s ON s.id = v.season_id
         LEFT JOIN referral_season_entries rse ON rse.id = v.season_entry_id
        WHERE v.user_id = $1
        ORDER BY v.issued_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (err) {
    logger.error('[referral-seasons] Failed to load vouchers:', { error: err.message })
    res.status(500).json({ error: 'Could not load vouchers' })
  }
})

module.exports = router
