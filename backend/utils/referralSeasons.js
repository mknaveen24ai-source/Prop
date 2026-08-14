const pool = require('../db')

async function fetchReferralSeasonBySlugOrId(idOrSlug) {
  const isNumeric = /^\d+$/.test(String(idOrSlug))
  const result = await pool.query(
    isNumeric
      ? `SELECT * FROM referral_seasons WHERE id = $1`
      : `SELECT * FROM referral_seasons WHERE slug = $1`,
    [idOrSlug]
  )
  return result.rows[0] || null
}

// Ranks referrers by distinct new paying referrals whose FIRST paid
// commission (affiliate_commissions.earned_at) falls inside [start_at, end_at)
// — same dimension (referral count, not $) as the existing lifetime tier
// ladder in utils/affiliates.js, just windowed to one season. A referred user
// who pays again in a later season doesn't count again; they're attributed
// to whichever season contains their first-ever paid order.
async function computeReferralSeasonStandings(db, season, { persist = false } = {}) {
  const result = await db.query(
    `WITH first_payment AS (
       SELECT referrer_user_id, referred_user_id, MIN(earned_at) AS first_paid_at
         FROM affiliate_commissions
        WHERE order_id IS NOT NULL AND referred_user_id IS NOT NULL
        GROUP BY referrer_user_id, referred_user_id
     )
     SELECT fp.referrer_user_id, u.full_name, u.email,
            COUNT(*)::int AS new_paying_referrals,
            MIN(fp.first_paid_at) AS earliest_paid_at
       FROM first_payment fp
       JOIN users u ON u.id = fp.referrer_user_id
      WHERE fp.first_paid_at >= $1 AND fp.first_paid_at < $2
        AND COALESCE(u.is_banned, FALSE) = FALSE
      GROUP BY fp.referrer_user_id, u.full_name, u.email
      ORDER BY new_paying_referrals DESC, earliest_paid_at ASC`,
    [season.start_at, season.end_at]
  )

  const ranked = result.rows.map((row, index) => ({
    referrer_user_id: row.referrer_user_id,
    full_name: row.full_name,
    email: row.email,
    new_paying_referrals: row.new_paying_referrals,
    rank: index + 1
  }))

  if (persist) {
    for (const entry of ranked) {
      await db.query(
        `INSERT INTO referral_season_entries (season_id, referrer_user_id, new_paying_referrals, final_rank)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (season_id, referrer_user_id)
         DO UPDATE SET new_paying_referrals = EXCLUDED.new_paying_referrals, final_rank = EXCLUDED.final_rank, updated_at = NOW()`,
        [season.id, entry.referrer_user_id, entry.new_paying_referrals, entry.rank]
      )
    }
  }

  return ranked
}

// Frozen leaderboard for a completed season (reads the persisted
// referral_season_entries rows instead of recomputing).
async function fetchReferralSeasonLeaderboard(seasonId) {
  const result = await pool.query(
    `SELECT rse.final_rank AS rank, rse.referrer_user_id, rse.new_paying_referrals,
            u.full_name, u.trader_uid
       FROM referral_season_entries rse
       JOIN users u ON u.id = rse.referrer_user_id
      WHERE rse.season_id = $1
      ORDER BY rse.final_rank ASC NULLS LAST, rse.new_paying_referrals DESC`,
    [seasonId]
  )
  return result.rows
}

module.exports = {
  fetchReferralSeasonBySlugOrId,
  computeReferralSeasonStandings,
  fetchReferralSeasonLeaderboard
}
