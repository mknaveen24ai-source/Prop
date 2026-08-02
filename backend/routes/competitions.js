const express = require('express')
const router = express.Router()
const jwt = require('jsonwebtoken')
const pool = require('../db')
const logger = require('../utils/logger')
const { authenticateToken } = require('./middleware')
const { sanitizeString } = require('../utils/validation')
const { fetchCompetitionBySlugOrId, fetchCompetitionLeaderboard, createCompetitionEntry } = require('../utils/competitions')

// Best-effort auth: populates req.user if a valid token is present, but never
// blocks the request — competition listings/detail/leaderboard are public.
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const token = headerToken || (req.cookies ? req.cookies.token : null)
  if (!token || !process.env.JWT_SECRET) return next()
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    // ignore invalid/expired token — treat as anonymous
  }
  next()
}

function serializeCompetition(row, { participantCount = null } = {}) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    type: row.type,
    status: row.status,
    start_at: row.start_at,
    end_at: row.end_at,
    entry_fee: parseFloat(row.entry_fee || 0),
    starting_balance: parseFloat(row.starting_balance || 0),
    max_participants: row.max_participants,
    participant_count: participantCount,
    ranking_metric: row.ranking_metric,
    max_drawdown_pct: parseFloat(row.max_drawdown_pct || 0),
    daily_drawdown_pct: row.daily_drawdown_pct != null ? parseFloat(row.daily_drawdown_pct) : null,
    rules: row.rules_json || {},
    prize_pool: row.prize_pool_json || []
  }
}

// GET /api/competitions?status=upcoming|active|completed
router.get('/', async function (req, res) {
  try {
    const status = String(req.query.status || '').trim()
    const validStatuses = ['upcoming', 'active', 'completed', 'cancelled']
    const conditions = []
    const values = []
    if (validStatuses.includes(status)) {
      values.push(status)
      conditions.push(`c.status = $${values.length}`)
    } else {
      conditions.push(`c.status != 'cancelled'`)
    }
    const where = `WHERE ${conditions.join(' AND ')}`

    const result = await pool.query(
      `SELECT c.*, COUNT(ce.id) FILTER (WHERE ce.status IN ('active', 'completed'))::int AS participant_count
         FROM competitions c
         LEFT JOIN competition_entries ce ON ce.competition_id = c.id
         ${where}
        GROUP BY c.id
        ORDER BY c.start_at DESC
        LIMIT 100`,
      values
    )
    res.json(result.rows.map((row) => serializeCompetition(row, { participantCount: row.participant_count })))
  } catch (err) {
    logger.error('[competitions] Failed to list competitions:', { error: err.message })
    res.status(500).json({ error: 'Could not load competitions' })
  }
})

// GET /api/competitions/:slug
router.get('/:slug', optionalAuth, async function (req, res) {
  try {
    const competition = await fetchCompetitionBySlugOrId(req.params.slug)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS count FROM competition_entries WHERE competition_id = $1 AND status IN ('active', 'completed')`,
      [competition.id]
    )

    let myEntry = null
    if (req.user?.userId) {
      const entryResult = await pool.query(
        `SELECT id, status, account_id, final_rank, final_profit_pct, final_profit_usd
           FROM competition_entries WHERE competition_id = $1 AND user_id = $2`,
        [competition.id, req.user.userId]
      )
      myEntry = entryResult.rows[0] || null
    }

    res.json({
      ...serializeCompetition(competition, { participantCount: countResult.rows[0].count }),
      my_entry: myEntry
    })
  } catch (err) {
    logger.error('[competitions] Failed to load competition detail:', { error: err.message })
    res.status(500).json({ error: 'Could not load competition' })
  }
})

// GET /api/competitions/:slug/leaderboard
router.get('/:slug/leaderboard', async function (req, res) {
  try {
    const competition = await fetchCompetitionBySlugOrId(req.params.slug)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })
    const rows = await fetchCompetitionLeaderboard(competition.id)
    res.json(rows)
  } catch (err) {
    logger.error('[competitions] Failed to load leaderboard:', { error: err.message })
    res.status(500).json({ error: 'Could not load leaderboard' })
  }
})

// POST /api/competitions/:slug/join
router.post('/:slug/join', authenticateToken, async function (req, res) {
  const client = await pool.connect()
  try {
    const competition = await fetchCompetitionBySlugOrId(req.params.slug)
    if (!competition) {
      client.release()
      return res.status(404).json({ error: 'Competition not found' })
    }
    if (!['upcoming', 'active'].includes(competition.status)) {
      client.release()
      return res.status(400).json({ error: 'This competition is no longer accepting entries.' })
    }

    await client.query('BEGIN')

    const userResult = await client.query('SELECT id, kyc_status FROM users WHERE id = $1', [req.user.userId])
    if (!userResult.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }
    if (userResult.rows[0].kyc_status !== 'approved') {
      await client.query('ROLLBACK')
      return res.status(403).json({ error: 'KYC approval required before joining a competition' })
    }

    const { entryId, accountId } = await createCompetitionEntry(client, competition, req.user.userId)

    await client.query('COMMIT')
    res.json({ message: 'Joined competition', entry_id: entryId, account_id: accountId })
  } catch (err) {
    await client.query('ROLLBACK')
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You have already joined this competition.' })
    }
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message })
    }
    logger.error('[competitions] Failed to join competition:', { error: err.message })
    res.status(500).json({ error: 'Could not join competition' })
  } finally {
    client.release()
  }
})

// GET /api/competitions/vouchers/mine
// Lists the caller's prize vouchers (issued and redeemed) so the frontend can
// surface a "claim your prize" CTA without the user needing to already know
// a voucher code.
router.get('/vouchers/mine', authenticateToken, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT v.id, v.code, v.account_size, v.challenge_model_slug, v.status,
              v.issued_at, v.expires_at, v.redeemed_at,
              c.title AS competition_title, c.slug AS competition_slug, ce.final_rank
         FROM competition_prize_vouchers v
         JOIN competitions c ON c.id = v.competition_id
         LEFT JOIN competition_entries ce ON ce.id = v.competition_entry_id
        WHERE v.user_id = $1
        ORDER BY v.issued_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (err) {
    logger.error('[competitions] Failed to load vouchers:', { error: err.message })
    res.status(500).json({ error: 'Could not load vouchers' })
  }
})

module.exports = router
