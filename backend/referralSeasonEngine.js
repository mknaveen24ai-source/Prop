const pool = require('./db')
const crypto = require('crypto')
const logger = require('./utils/logger')
const { computeReferralSeasonStandings } = require('./utils/referralSeasons')
const { getTenantSettingsMap } = require('./utils/tenantSettings')
const { enqueueReferralSeasonPrizeVoucherEmail } = require('./utils/emailQueue')
const { createUserNotification } = require('./utils/userNotifications')

// ─────────────────────────────────────────────────────────────────────────────
// Referral Season Engine
//
// Runs on a scheduler tick (see services/schedulerService.js) and drives the
// referral_seasons.status state machine: upcoming -> active -> completed.
// Mirrors competitionEngine.js's activate/finalize/issue-vouchers shape, but
// ranks affiliates by new paying referrals instead of trading P&L — see
// utils/referralSeasons.js and migration 026 for why this is a parallel
// engine rather than reusing the trading-competition tables.
// ─────────────────────────────────────────────────────────────────────────────

function generateSeasonVoucherCode() {
  return `SEASON-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
}

async function activateDueSeasons() {
  const result = await pool.query(
    `UPDATE referral_seasons
        SET status = 'active', updated_at = NOW()
      WHERE status = 'upcoming' AND start_at <= NOW()
      RETURNING id, title`
  )
  for (const row of result.rows) {
    logger.info(`Referral season engine: "${row.title}" (#${row.id}) is now ACTIVE`)
  }
}

// Issues a referral_season_prize_vouchers row to each ranked entry whose
// matching prize_pool_json slot (by rank) carries a structured `voucher`
// field — identical shape/idempotency guard to
// competitionEngine.js's issueCompetitionPrizeVouchers().
async function issueReferralSeasonPrizeVouchers(season, ranked, io) {
  const prizePool = Array.isArray(season.prize_pool_json) ? season.prize_pool_json : []
  const voucherByRank = new Map()
  for (const prize of prizePool) {
    if (prize && prize.voucher && Number.isFinite(Number(prize.rank))) {
      voucherByRank.set(Number(prize.rank), prize.voucher)
    }
  }
  if (voucherByRank.size === 0) return

  const settings = await getTenantSettingsMap(['referral_season_voucher_expiry_days'])
  const expiryDays = Math.max(1, parseInt(settings.referral_season_voucher_expiry_days, 10) || 90)

  const entriesResult = await pool.query(
    `SELECT rse.id AS entry_id, rse.final_rank, rse.referrer_user_id, u.email, u.full_name
       FROM referral_season_entries rse
       JOIN users u ON u.id = rse.referrer_user_id
      WHERE rse.season_id = $1 AND rse.final_rank IS NOT NULL`,
    [season.id]
  )

  for (const winner of entriesResult.rows) {
    const voucherSpec = voucherByRank.get(Number(winner.final_rank))
    if (!voucherSpec) continue

    const accountSize = parseFloat(voucherSpec.account_size)
    const challengeModelSlug = String(voucherSpec.challenge_model_slug || '').trim()
    if (!Number.isFinite(accountSize) || accountSize <= 0 || !challengeModelSlug) {
      logger.warn(`Referral season engine: skipping malformed voucher spec for rank ${winner.final_rank} in season #${season.id}`)
      continue
    }

    const existing = await pool.query(
      `SELECT id FROM referral_season_prize_vouchers WHERE season_entry_id = $1`,
      [winner.entry_id]
    )
    if (existing.rows.length > 0) continue

    let voucher = null
    for (let attempt = 0; attempt < 5 && !voucher; attempt++) {
      try {
        const insertResult = await pool.query(
          `INSERT INTO referral_season_prize_vouchers
             (code, season_id, season_entry_id, user_id, account_size, challenge_model_slug, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::interval)
           RETURNING *`,
          [generateSeasonVoucherCode(), season.id, winner.entry_id, winner.referrer_user_id, accountSize, challengeModelSlug, expiryDays]
        )
        voucher = insertResult.rows[0]
      } catch (err) {
        if (err.code !== '23505') throw err // unique code collision — retry with a new code
      }
    }
    if (!voucher) {
      logger.error(`Referral season engine: failed to generate a unique voucher code for entry ${winner.entry_id} after 5 attempts`)
      continue
    }

    logger.info(`Referral season engine: issued voucher ${voucher.code} to user ${winner.referrer_user_id} for rank ${winner.final_rank} in season #${season.id}`)

    // Persisted, cross-device notification — competitionEngine.js's
    // finalizeCompetition() never calls this for winners (only email + an
    // unscoped socket broadcast); closing that gap here rather than leaving
    // season winners without an in-app record of what they won.
    try {
      await createUserNotification(io, winner.referrer_user_id, {
        type: 'success',
        title: 'You won the referral season!',
        message: `You ranked #${winner.final_rank} in "${season.title}" and won a free $${accountSize.toLocaleString()} challenge account. Redeem code ${voucher.code} at checkout.`
      })
    } catch (notifyErr) {
      logger.warn('Referral season engine: failed to create winner notification:', { error: notifyErr.message })
    }

    if (winner.email) {
      try {
        await enqueueReferralSeasonPrizeVoucherEmail(winner.email, winner.full_name, season.title, voucher.code, accountSize, voucher.expires_at, { userId: winner.referrer_user_id })
      } catch (emailErr) {
        logger.warn('Referral season engine: failed to enqueue prize voucher email:', { error: emailErr.message })
      }
    }
  }
}

async function finalizeSeason(season, io) {
  const ranked = await computeReferralSeasonStandings(pool, season, { persist: true })

  await pool.query(`UPDATE referral_seasons SET status = 'completed', updated_at = NOW() WHERE id = $1`, [season.id])

  try {
    await issueReferralSeasonPrizeVouchers(season, ranked, io)
  } catch (err) {
    logger.error(`Referral season engine: prize voucher issuance failed for season #${season.id}:`, { error: err.message })
  }

  logger.info(`Referral season engine: "${season.title}" (#${season.id}) COMPLETED — ${ranked.length} entries ranked`)

  if (io) {
    io.emit('referral_season_ended', { season_id: season.id, slug: season.slug })
  }
}

async function closeDueSeasons(io) {
  const dueResult = await pool.query(
    `SELECT * FROM referral_seasons WHERE status = 'active' AND end_at <= NOW()`
  )
  for (const season of dueResult.rows) {
    await finalizeSeason(season, io)
  }
}

async function runReferralSeasonEngine(io) {
  try {
    await activateDueSeasons()
    await closeDueSeasons(io)
  } catch (err) {
    logger.error('Referral season engine tick failed:', { error: err.message })
  }
}

module.exports = { runReferralSeasonEngine }
