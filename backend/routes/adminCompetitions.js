const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const pool = require('../db')
const { authenticateAdmin, requireSuperAdmin } = require('./middleware')
const logger = require('../utils/logger')
const { sanitizeString } = require('../utils/validation')
const { fetchCompetitionBySlugOrId, fetchCompetitionLeaderboard, computeCompetitionAnalytics, createCompetitionEntry } = require('../utils/competitions')
const { generateTraderUid } = require('../utils/traderIds')
const { applyBalanceAdjustment } = require('../utils/balanceAdjustments')
const { computeAndPersistRanking } = require('../competitionEngine')
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
      entityType: 'competition',
      entityId: String(entityId),
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (err) {
    logger.warn('[admin-competitions] Non-critical audit log failed:', { error: err.message })
  }
}

// GET /admin/competitions
router.get('/competitions', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT c.*, COUNT(ce.id) FILTER (WHERE ce.status IN ('active', 'completed'))::int AS participant_count
         FROM competitions c
         LEFT JOIN competition_entries ce ON ce.competition_id = c.id
        GROUP BY c.id
        ORDER BY c.created_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    logger.error('[admin-competitions] Failed to list competitions:', { error: err.message })
    res.status(500).json({ error: 'Failed to load competitions' })
  }
})

// POST /admin/competitions
router.post('/competitions', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const body = req.body || {}
    const title = sanitizeString(String(body.title || '').trim(), 200)
    if (!title) return res.status(400).json({ error: 'Title is required' })

    const startAt = new Date(body.start_at)
    const endAt = new Date(body.end_at)
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) {
      return res.status(400).json({ error: 'Valid start_at and end_at (end after start) are required' })
    }

    const type = ['weekly', 'monthly', 'custom'].includes(body.type) ? body.type : 'custom'
    const rankingMetric = body.ranking_metric === 'profit_usd' ? 'profit_usd' : 'profit_pct'
    const startingBalance = Number.isFinite(parseFloat(body.starting_balance)) ? parseFloat(body.starting_balance) : 10000
    const maxDrawdownPct = Number.isFinite(parseFloat(body.max_drawdown_pct)) ? parseFloat(body.max_drawdown_pct) : 10
    const dailyDrawdownPct = body.daily_drawdown_pct != null && body.daily_drawdown_pct !== '' ? parseFloat(body.daily_drawdown_pct) : null
    const maxParticipants = body.max_participants != null && body.max_participants !== '' ? parseInt(body.max_participants, 10) : null

    let slug = slugify(body.slug || title)
    const existingSlug = await pool.query('SELECT id FROM competitions WHERE slug = $1', [slug])
    if (existingSlug.rows.length > 0) {
      slug = `${slug}-${Date.now().toString(36)}`
    }

    const result = await pool.query(
      `INSERT INTO competitions
         (slug, title, description, type, start_at, end_at, starting_balance, max_participants,
          ranking_metric, max_drawdown_pct, daily_drawdown_pct, rules_json, prize_pool_json, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
       RETURNING *`,
      [
        slug, title, sanitizeString(String(body.description || ''), 2000) || null, type, startAt.toISOString(), endAt.toISOString(),
        startingBalance, maxParticipants, rankingMetric, maxDrawdownPct, dailyDrawdownPct,
        JSON.stringify(body.rules || {}), JSON.stringify(body.prize_pool || []), getAdminActorLabel(req.admin)
      ]
    )

    const competition = result.rows[0]
    await auditLog(req, 'competition_created', competition.id, { title, slug, start_at: startAt, end_at: endAt })
    res.status(201).json(competition)
  } catch (err) {
    logger.error('[admin-competitions] Failed to create competition:', { error: err.message })
    res.status(500).json({ error: 'Failed to create competition' })
  }
})

// GET /admin/competitions/:id
router.get('/competitions/:id', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const competition = await fetchCompetitionBySlugOrId(req.params.id)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })

    const entriesResult = await pool.query(
      `SELECT ce.id, ce.user_id, ce.status, ce.joined_at, ce.final_rank, ce.final_profit_pct, ce.final_profit_usd,
              ce.disqualified_reason, u.full_name, u.email, u.is_bot, a.account_uid, a.current_balance, a.starting_balance
         FROM competition_entries ce
         JOIN users u ON u.id = ce.user_id
         LEFT JOIN accounts a ON a.id = ce.account_id
        WHERE ce.competition_id = $1
        ORDER BY ce.joined_at ASC`,
      [competition.id]
    )

    const leaderboard = competition.status === 'completed'
      ? await fetchCompetitionLeaderboard(competition.id)
      : []

    res.json({ ...competition, entries: entriesResult.rows, leaderboard })
  } catch (err) {
    logger.error('[admin-competitions] Failed to load competition detail:', { error: err.message })
    res.status(500).json({ error: 'Failed to load competition' })
  }
})

// GET /admin/competitions/:id/analytics
router.get('/competitions/:id/analytics', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const analytics = await computeCompetitionAnalytics(req.params.id)
    if (!analytics) return res.status(404).json({ error: 'Competition not found' })
    res.json(analytics)
  } catch (err) {
    logger.error('[admin-competitions] Failed to load competition analytics:', { error: err.message })
    res.status(500).json({ error: 'Failed to load competition analytics' })
  }
})

// PATCH /admin/competitions/:id
router.patch('/competitions/:id', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const competition = await fetchCompetitionBySlugOrId(req.params.id)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })

    const body = req.body || {}
    const isLocked = competition.status !== 'upcoming'
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
      if (body.starting_balance !== undefined) set('starting_balance', parseFloat(body.starting_balance))
      if (body.max_participants !== undefined) set('max_participants', body.max_participants === '' || body.max_participants == null ? null : parseInt(body.max_participants, 10))
      if (body.ranking_metric !== undefined) set('ranking_metric', body.ranking_metric === 'profit_usd' ? 'profit_usd' : 'profit_pct')
      if (body.max_drawdown_pct !== undefined) set('max_drawdown_pct', parseFloat(body.max_drawdown_pct))
      if (body.daily_drawdown_pct !== undefined) set('daily_drawdown_pct', body.daily_drawdown_pct === '' || body.daily_drawdown_pct == null ? null : parseFloat(body.daily_drawdown_pct))
      if (body.rules !== undefined) set('rules_json', JSON.stringify(body.rules))
    }

    if (fields.length === 0) return res.status(400).json({ error: 'No editable fields provided' })

    values.push(competition.id)
    const result = await pool.query(
      `UPDATE competitions SET ${fields.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`,
      values
    )

    await auditLog(req, 'competition_updated', competition.id, { changes: body, was_locked: isLocked })
    res.json(result.rows[0])
  } catch (err) {
    logger.error('[admin-competitions] Failed to update competition:', { error: err.message })
    res.status(500).json({ error: 'Failed to update competition' })
  }
})

// POST /admin/competitions/:id/cancel
router.post('/competitions/:id/cancel', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const competition = await fetchCompetitionBySlugOrId(req.params.id)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })
    if (!['upcoming', 'active'].includes(competition.status)) {
      return res.status(400).json({ error: 'Only upcoming or active competitions can be cancelled' })
    }

    await pool.query(`UPDATE competitions SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [competition.id])
    await pool.query(
      `UPDATE competition_entries SET status = 'withdrawn', updated_at = NOW() WHERE competition_id = $1 AND status = 'active'`,
      [competition.id]
    )
    await pool.query(
      `UPDATE accounts SET status = 'cancelled', updated_at = NOW()
        WHERE id IN (SELECT account_id FROM competition_entries WHERE competition_id = $1) AND status = 'active'`,
      [competition.id]
    )

    await auditLog(req, 'competition_cancelled', competition.id, {})
    res.json({ message: 'Competition cancelled' })
  } catch (err) {
    logger.error('[admin-competitions] Failed to cancel competition:', { error: err.message })
    res.status(500).json({ error: 'Failed to cancel competition' })
  }
})

// POST /admin/competitions/:id/entries/:entryId/disqualify
router.post('/competitions/:id/entries/:entryId/disqualify', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const reason = sanitizeString(String(req.body?.reason || '').trim(), 500)
    if (!reason || reason.length < 5) {
      return res.status(400).json({ error: 'A reason (5+ characters) is required' })
    }

    const entryResult = await pool.query(
      `SELECT id, account_id, competition_id FROM competition_entries WHERE id = $1 AND competition_id = $2 AND status = 'active'`,
      [req.params.entryId, req.params.id]
    )
    const entry = entryResult.rows[0]
    if (!entry) return res.status(404).json({ error: 'Active entry not found' })

    await pool.query(
      `UPDATE competition_entries SET status = 'disqualified', disqualified_reason = $1, updated_at = NOW() WHERE id = $2`,
      [reason, entry.id]
    )
    if (entry.account_id) {
      await pool.query(`UPDATE accounts SET status = 'failed', updated_at = NOW() WHERE id = $1`, [entry.account_id])
    }

    await auditLog(req, 'competition_entry_disqualified', entry.competition_id, { entry_id: entry.id, reason })
    res.json({ message: 'Entry disqualified' })
  } catch (err) {
    logger.error('[admin-competitions] Failed to disqualify entry:', { error: err.message })
    res.status(500).json({ error: 'Failed to disqualify entry' })
  }
})

// POST /admin/competitions/:id/entries/:entryId/correct-balance
// Admin-triggered manual ledger adjustment to nullify detected cheating —
// distinct from /disqualify (which removes the entry entirely). Goes through
// applyBalanceAdjustment() exclusively, never a raw balance UPDATE. If the
// competition has already been finalized, re-ranks every entry since one
// correction can change relative standings, not just the corrected trader's.
router.post('/competitions/:id/entries/:entryId/correct-balance', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  const client = await pool.connect()
  try {
    const reason = sanitizeString(String(req.body?.reason || '').trim(), 500)
    if (!reason || reason.length < 5) {
      return res.status(400).json({ error: 'A reason (5+ characters) is required' })
    }
    const amount = parseFloat(req.body?.amount)
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'A non-zero amount is required' })
    }

    const competition = await fetchCompetitionBySlugOrId(req.params.id)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })
    if (!['active', 'completed'].includes(competition.status)) {
      return res.status(400).json({ error: 'Only active or completed competitions can be corrected' })
    }

    const entryResult = await pool.query(
      `SELECT id, account_id FROM competition_entries WHERE id = $1 AND competition_id = $2`,
      [req.params.entryId, req.params.id]
    )
    const entry = entryResult.rows[0]
    if (!entry || !entry.account_id) return res.status(404).json({ error: 'Entry not found' })

    await client.query('BEGIN')
    const adjustment = await applyBalanceAdjustment(client, {
      accountId: entry.account_id,
      amount,
      source: 'competition_cheat_correction',
      reason,
      createdBy: getAdminActorLabel(req.admin),
      competitionId: competition.id,
      competitionEntryId: entry.id
    })
    if (competition.status === 'completed') {
      await computeAndPersistRanking(client, competition, { computeStats: false })
    }
    await client.query('COMMIT')

    await auditLog(req, 'competition_entry_balance_corrected', competition.id, {
      entry_id: entry.id,
      amount,
      reason,
      balance_before: adjustment.balanceBefore,
      balance_after: adjustment.balanceAfter,
      competition_status: competition.status
    })

    res.json({ message: 'Balance corrected', ...adjustment })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message })
    }
    logger.error('[admin-competitions] Failed to correct entry balance:', { error: err.message })
    res.status(500).json({ error: 'Failed to correct entry balance' })
  } finally {
    client.release()
  }
})

// GET /admin/bots
router.get('/bots', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.country, u.created_at,
              ce.id AS entry_id, ce.competition_id, c.title AS competition_title
         FROM users u
         LEFT JOIN competition_entries ce ON ce.user_id = u.id AND ce.status = 'active'
         LEFT JOIN competitions c ON c.id = ce.competition_id
        WHERE u.is_bot = TRUE
        ORDER BY u.created_at DESC`
    )
    res.json(result.rows)
  } catch (err) {
    logger.error('[admin-competitions] Failed to list bots:', { error: err.message })
    res.status(500).json({ error: 'Failed to list bots' })
  }
})

// ─── Random bot name / country helpers ──────────────────────────────────────
const BOT_FIRST_NAMES = [
  'James','Oliver','Ethan','Noah','Liam','Lucas','Mason','Logan','Aiden','Jackson',
  'Sebastian','Mateo','Henry','Alexander','Daniel','Michael','Benjamin','Owen','Samuel','Jack',
  'Sofia','Emma','Olivia','Ava','Isabella','Mia','Charlotte','Amelia','Harper','Evelyn',
  'Abigail','Emily','Elizabeth','Avery','Sophia','Ella','Madison','Scarlett','Victoria','Aria',
  'Yusuf','Tariq','Arjun','Rahul','Kenji','Hiroshi','Wei','Jing','Andrei','Dmitri'
]
const BOT_LAST_NAMES = [
  'Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Taylor',
  'Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Clark','Lewis','Robinson',
  'Walker','Hall','Allen','Young','King','Wright','Scott','Green','Baker','Adams',
  'Nelson','Carter','Mitchell','Perez','Roberts','Turner','Phillips','Campbell','Parker','Evans',
  'Khan','Patel','Singh','Sharma','Chen','Wang','Kim','Lee','Nguyen','Santos'
]
const BOT_COUNTRIES = [
  'United States','United Kingdom','Canada','Australia','Germany','France','Netherlands',
  'Singapore','United Arab Emirates','Japan','South Korea','Brazil','India','South Africa',
  'Switzerland','Sweden','Norway','Denmark','Spain','Italy','Portugal','Mexico','Argentina',
  'Indonesia','Malaysia','Philippines','Thailand','Nigeria','Kenya','Egypt'
]

function randomBotName() {
  const first = BOT_FIRST_NAMES[Math.floor(Math.random() * BOT_FIRST_NAMES.length)]
  const last  = BOT_LAST_NAMES[Math.floor(Math.random() * BOT_LAST_NAMES.length)]
  return `${first} ${last}`
}

function randomCountry() {
  return BOT_COUNTRIES[Math.floor(Math.random() * BOT_COUNTRIES.length)]
}
// ─────────────────────────────────────────────────────────────────────────────

// POST /admin/bots
// Creates one or more synthetic "demo bot" participants.
// Body:
//   count              {number}  1–50 (default 1)
//   full_name          {string}  optional; if omitted a random name is generated per bot
//   country            {string}  optional; "random" or omitted → random country per bot
//   enter_competition_id {string|number}  optional; immediately enters each created bot
router.post('/bots', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const count   = Math.min(50, Math.max(1, parseInt(req.body?.count, 10) || 1))
    const nameOverride    = sanitizeString(String(req.body?.full_name  || '').trim(), 100) || null
    const countryOverride = sanitizeString(String(req.body?.country    || '').trim(), 100) || null
    const enterCompId     = req.body?.enter_competition_id || null

    // Validate competition if auto-enter requested
    let competition = null
    if (enterCompId) {
      competition = await fetchCompetitionBySlugOrId(enterCompId)
      if (!competition) return res.status(404).json({ error: 'Competition not found for auto-enter' })
      if (!['upcoming', 'active'].includes(competition.status)) {
        return res.status(400).json({ error: 'Competition is no longer accepting entries' })
      }
    }

    const created = []
    for (let i = 0; i < count; i++) {
      const fullName     = nameOverride || randomBotName()
      const country      = (!countryOverride || countryOverride.toLowerCase() === 'random')
                             ? randomCountry()
                             : countryOverride
      const affiliateCode = uuidv4().substring(0, 8).toUpperCase()
      const traderUid     = await generateTraderUid(pool)
      const email         = `bot+${uuidv4().slice(0, 8)}@bots.internal`
      const passwordHash  = await bcrypt.hash(uuidv4(), 10)

      const result = await pool.query(
        `INSERT INTO users
           (email, password_hash, full_name, country, phone, affiliate_code, trader_uid, signup_source, kyc_status, is_bot, is_banned)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin_bot', 'approved', TRUE, FALSE)
         RETURNING id, full_name, email, country, created_at`,
        [email, passwordHash, fullName, country, '+10000000000', affiliateCode, traderUid]
      )
      const bot = result.rows[0]
      created.push(bot)
      await auditLog(req, 'competition_bot_created', bot.id, { full_name: fullName, country })

      // Auto-enter into competition
      if (competition) {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const { entryId, accountId } = await createCompetitionEntry(client, competition, bot.id)
          await client.query('COMMIT')
          bot.entry_id    = entryId
          bot.account_id  = accountId
          bot.competition_id    = competition.id
          bot.competition_title = competition.title
          await auditLog(req, 'competition_bot_entered', competition.id, { bot_user_id: bot.id, entry_id: entryId })
        } catch (entryErr) {
          await client.query('ROLLBACK').catch(() => {})
          logger.warn(`[admin-competitions] Auto-enter failed for bot ${bot.id}:`, { error: entryErr.message })
        } finally {
          client.release()
        }
      }
    }

    res.status(201).json(created)
  } catch (err) {
    logger.error('[admin-competitions] Failed to create bots:', { error: err.message })
    res.status(500).json({ error: 'Failed to create bots' })
  }
})


// POST /admin/competitions/:id/bots/:botUserId/enter
router.post('/competitions/:id/bots/:botUserId/enter', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  const client = await pool.connect()
  try {
    const botResult = await pool.query(`SELECT id, is_bot FROM users WHERE id = $1`, [req.params.botUserId])
    const bot = botResult.rows[0]
    if (!bot || !bot.is_bot) {
      return res.status(400).json({ error: 'Target user is not a bot' })
    }

    const competition = await fetchCompetitionBySlugOrId(req.params.id)
    if (!competition) return res.status(404).json({ error: 'Competition not found' })
    if (!['upcoming', 'active'].includes(competition.status)) {
      return res.status(400).json({ error: 'This competition is no longer accepting entries.' })
    }

    await client.query('BEGIN')
    const { entryId, accountId } = await createCompetitionEntry(client, competition, bot.id)
    await client.query('COMMIT')

    await auditLog(req, 'competition_bot_entered', competition.id, { bot_user_id: bot.id, entry_id: entryId })
    res.json({ message: 'Bot entered competition', entry_id: entryId, account_id: accountId })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message })
    }
    logger.error('[admin-competitions] Failed to enter bot into competition:', { error: err.message })
    res.status(500).json({ error: 'Failed to enter bot into competition' })
  } finally {
    client.release()
  }
})

// POST /admin/competitions/:id/entries/:entryId/withdraw-bot
router.post('/competitions/:id/entries/:entryId/withdraw-bot', authenticateAdmin, requireSuperAdmin, async function (req, res) {
  try {
    const entryResult = await pool.query(
      `SELECT ce.id, ce.account_id, u.is_bot
         FROM competition_entries ce
         JOIN users u ON u.id = ce.user_id
        WHERE ce.id = $1 AND ce.competition_id = $2 AND ce.status = 'active'`,
      [req.params.entryId, req.params.id]
    )
    const entry = entryResult.rows[0]
    if (!entry || !entry.is_bot) return res.status(404).json({ error: 'Active bot entry not found' })

    await pool.query(`UPDATE competition_entries SET status = 'withdrawn', updated_at = NOW() WHERE id = $1`, [entry.id])
    if (entry.account_id) {
      await pool.query(`UPDATE accounts SET status = 'cancelled', updated_at = NOW() WHERE id = $1`, [entry.account_id])
    }

    await auditLog(req, 'competition_bot_withdrawn', req.params.id, { entry_id: entry.id })
    res.json({ message: 'Bot withdrawn from competition' })
  } catch (err) {
    logger.error('[admin-competitions] Failed to withdraw bot:', { error: err.message })
    res.status(500).json({ error: 'Failed to withdraw bot' })
  }
})

module.exports = router
