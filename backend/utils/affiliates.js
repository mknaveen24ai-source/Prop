const pool = require('../db')
const { getTenantSettingsMap } = require('./tenantSettings')

// Looks up the user who owns a given affiliate_code. Used both at registration
// (soft-validate an incoming referral code) and by the public validate-code
// endpoint (does NOT return this row's PII to the caller — see routes/affiliates.js).
async function resolveAffiliateCode(code) {
  const trimmed = String(code || '').trim().toUpperCase()
  if (!trimmed) return null
  const result = await pool.query(
    `SELECT id, affiliate_code FROM users WHERE affiliate_code = $1`,
    [trimmed]
  )
  return result.rows[0] || null
}

// Resolves the commission tier that should apply to the order currently being
// paid. Called on EVERY paid order (not just the referred user's first), so a
// referrer's rate can rise mid-relationship as their paying-referral count grows.
// Must be called with the transaction client that's about to insert the new
// commission row, since it needs to "see" that this order will make referredUserId
// count as a paying referral for the first time if it isn't one already.
async function computeEffectiveTier(client, referrerUserId, referredUserId) {
  const db = client && typeof client.query === 'function' ? client : pool
  const countResult = await db.query(
    `SELECT COUNT(DISTINCT referred_user_id)::int AS cnt,
            BOOL_OR(referred_user_id = $2) AS already_counted
       FROM affiliate_commissions
      WHERE referrer_user_id = $1 AND referred_user_id IS NOT NULL`,
    [referrerUserId, referredUserId]
  )
  const row = countResult.rows[0] || {}
  const existingCount = parseInt(row.cnt || 0, 10)
  const effectiveCount = row.already_counted ? existingCount : existingCount + 1

  const tierResult = await db.query(
    `SELECT tier_rank, commission_pct FROM affiliate_commission_tiers
      WHERE is_active = TRUE AND min_referrals <= $1
      ORDER BY min_referrals DESC LIMIT 1`,
    [effectiveCount]
  )
  const tierRow = tierResult.rows[0]
  if (tierRow) {
    return {
      tier_rank: tierRow.tier_rank,
      commission_pct: parseFloat(tierRow.commission_pct),
      effective_count: effectiveCount
    }
  }

  const settings = await getTenantSettingsMap(['affiliate_default_commission_pct'])
  return {
    tier_rank: null,
    commission_pct: parseFloat(settings.affiliate_default_commission_pct || 10),
    effective_count: effectiveCount
  }
}

async function fetchAffiliateSummary(userId) {
  const [userRow, referralCounts, balances, pendingPayout, tiers] = await Promise.all([
    pool.query(`SELECT affiliate_code FROM users WHERE id = $1`, [userId]),
    pool.query(
      `SELECT
         COUNT(*)::int AS total_referrals,
         COUNT(*) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM affiliate_commissions c
              WHERE c.referral_id = ar.id AND c.order_id IS NOT NULL
           )
         )::int AS paying_referrals
         FROM affiliate_referrals ar
        WHERE ar.referrer_user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(commission_amount) FILTER (WHERE status IN ('available','adjusted')), 0) AS available_balance,
         COALESCE(SUM(commission_amount) FILTER (WHERE status = 'paid'), 0) AS paid_total,
         COALESCE(SUM(commission_amount), 0) AS lifetime_commission
         FROM affiliate_commissions
        WHERE referrer_user_id = $1`,
      [userId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount_requested), 0) AS pending_amount
         FROM affiliate_payout_requests
        WHERE affiliate_user_id = $1 AND status = 'pending'`,
      [userId]
    ),
    pool.query(
      `SELECT tier_rank, label, min_referrals, commission_pct
         FROM affiliate_commission_tiers
        WHERE is_active = TRUE
        ORDER BY min_referrals ASC`
    )
  ])

  const payingReferrals = referralCounts.rows[0]?.paying_referrals || 0

  let currentTier = null
  let nextTier = null
  for (const tier of tiers.rows) {
    if (tier.min_referrals <= payingReferrals) currentTier = tier
    else { nextTier = tier; break }
  }

  return {
    affiliate_code: userRow.rows[0]?.affiliate_code || null,
    total_referrals: referralCounts.rows[0]?.total_referrals || 0,
    paying_referrals: payingReferrals,
    lifetime_commission: parseFloat(balances.rows[0]?.lifetime_commission || 0),
    available_balance: parseFloat(balances.rows[0]?.available_balance || 0),
    paid_total: parseFloat(balances.rows[0]?.paid_total || 0),
    pending_payout_amount: parseFloat(pendingPayout.rows[0]?.pending_amount || 0),
    current_tier: currentTier ? { ...currentTier, commission_pct: parseFloat(currentTier.commission_pct) } : null,
    next_tier: nextTier ? { ...nextTier, commission_pct: parseFloat(nextTier.commission_pct) } : null
  }
}

async function fetchAffiliateReferrals(userId, { page = 1, pageSize = 20 } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize
  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT
         ar.id, ar.referred_user_id, ar.created_at AS referred_at,
         u.full_name, u.country,
         COALESCE(SUM(c.commission_amount) FILTER (WHERE c.order_id IS NOT NULL), 0) AS total_commission_generated,
         COUNT(c.id) FILTER (WHERE c.order_id IS NOT NULL)::int AS paid_order_count
         FROM affiliate_referrals ar
         JOIN users u ON u.id = ar.referred_user_id
         LEFT JOIN affiliate_commissions c ON c.referral_id = ar.id
        WHERE ar.referrer_user_id = $1
        GROUP BY ar.id, u.full_name, u.country
        ORDER BY ar.created_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM affiliate_referrals WHERE referrer_user_id = $1`, [userId])
  ])

  return {
    rows: result.rows.map(r => ({
      ...r,
      total_commission_generated: parseFloat(r.total_commission_generated || 0),
      is_paying: r.paid_order_count > 0
    })),
    total: countResult.rows[0]?.total || 0,
    page,
    pageSize
  }
}

async function fetchAffiliateCommissions(userId, { page = 1, pageSize = 20 } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize
  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT c.id, c.referred_user_id, u.full_name AS referred_full_name,
              c.order_id, c.tier_rank, c.commission_rate_pct, c.order_amount,
              c.commission_amount, c.status, c.adjustment_note, c.earned_at
         FROM affiliate_commissions c
         LEFT JOIN users u ON u.id = c.referred_user_id
        WHERE c.referrer_user_id = $1
        ORDER BY c.earned_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM affiliate_commissions WHERE referrer_user_id = $1`, [userId])
  ])

  return {
    rows: result.rows.map(r => ({
      ...r,
      order_amount: r.order_amount != null ? parseFloat(r.order_amount) : null,
      commission_amount: parseFloat(r.commission_amount),
      commission_rate_pct: r.commission_rate_pct != null ? parseFloat(r.commission_rate_pct) : null
    })),
    total: countResult.rows[0]?.total || 0,
    page,
    pageSize
  }
}

async function fetchAffiliatePayouts(userId, { page = 1, pageSize = 20 } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize
  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT id, amount_requested, payment_method, status, admin_notes, requested_at, paid_at
         FROM affiliate_payout_requests
        WHERE affiliate_user_id = $1
        ORDER BY requested_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM affiliate_payout_requests WHERE affiliate_user_id = $1`, [userId])
  ])

  return {
    rows: result.rows.map(r => ({ ...r, amount_requested: parseFloat(r.amount_requested) })),
    total: countResult.rows[0]?.total || 0,
    page,
    pageSize
  }
}

// Per-affiliate trend data for the trader-facing Affiliate Analysis tab —
// scoped mirror of the admin-only platform-wide analytics in
// adminAffiliates.js's GET /affiliates/analytics, but grouped per month for
// a single referrer rather than aggregated across all affiliates.
async function fetchAffiliateAnalytics(userId) {
  const [referralsResult, commissionResult] = await Promise.all([
    pool.query(
      `SELECT to_char(date_trunc('month', ar.created_at), 'Mon') AS month,
              date_trunc('month', ar.created_at) AS month_start,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE EXISTS (
                  SELECT 1 FROM affiliate_commissions c
                   WHERE c.referral_id = ar.id AND c.order_id IS NOT NULL
                )
              )::int AS paying
         FROM affiliate_referrals ar
        WHERE ar.referrer_user_id = $1 AND ar.created_at >= NOW() - INTERVAL '6 months'
        GROUP BY date_trunc('month', ar.created_at)
        ORDER BY month_start ASC`,
      [userId]
    ),
    pool.query(
      `SELECT to_char(date_trunc('month', earned_at), 'Mon') AS month,
              date_trunc('month', earned_at) AS month_start,
              COALESCE(SUM(commission_amount) FILTER (WHERE status = 'paid'), 0) AS paid,
              COALESCE(SUM(commission_amount) FILTER (WHERE status != 'paid'), 0) AS pending
         FROM affiliate_commissions
        WHERE referrer_user_id = $1 AND earned_at >= NOW() - INTERVAL '6 months'
        GROUP BY date_trunc('month', earned_at)
        ORDER BY month_start ASC`,
      [userId]
    )
  ])

  return {
    referralsByMonth: referralsResult.rows.map(r => ({ month: r.month, total: r.total, paying: r.paying })),
    commissionByMonth: commissionResult.rows.map(r => ({
      month: r.month,
      paid: parseFloat(r.paid) || 0,
      pending: parseFloat(r.pending) || 0
    }))
  }
}

// Settles a SPECIFIC amount (v2: partial withdrawals allowed) against an
// approved payout request. Rather than marking/splitting individual earn
// rows, this posts one negative 'adjusted' ledger entry for the settled
// amount — same mechanism as insertBalanceAdjustment below — which keeps
// every original commission row's order_id/earned_at history intact while
// still reducing available_balance (SUM of 'available'+'adjusted' rows) by
// exactly the amount paid out. Any remainder stays available for a future
// payout request. Returns the amount settled (for the admin approval
// response/audit log).
async function settleAffiliatePayoutAmount(client, referrerUserId, payoutRequestId, amount) {
  const settled = Math.round(Math.abs(parseFloat(amount) || 0) * 100) / 100
  const result = await client.query(
    `INSERT INTO affiliate_commissions
       (referrer_user_id, commission_amount, status, adjustment_note, adjusted_at, earned_at, payout_request_id)
     VALUES ($1, $2, 'adjusted', $3, NOW(), NOW(), $4)
     RETURNING commission_amount`,
    [referrerUserId, -settled, `Payout settlement for request #${payoutRequestId}`, payoutRequestId]
  )
  return Math.abs(parseFloat(result.rows[0].commission_amount))
}

// Manual admin correction — no automatic refund/chargeback clawback exists (v1
// decision), so this is the only way an affiliate's balance is ever adjusted
// outside of normal commission-earning. amount may be negative.
async function insertBalanceAdjustment(client, { referrerUserId, amount, note, adjustedBy }) {
  const db = client && typeof client.query === 'function' ? client : pool
  const result = await db.query(
    `INSERT INTO affiliate_commissions
       (referrer_user_id, commission_amount, status, adjustment_note, adjusted_by, adjusted_at, earned_at)
     VALUES ($1, $2, 'adjusted', $3, $4, NOW(), NOW())
     RETURNING *`,
    [referrerUserId, amount, note, adjustedBy]
  )
  return result.rows[0]
}

async function fetchAllAffiliatesForAdmin({ search = '', page = 1, pageSize = 20 } = {}) {
  const offset = (Math.max(1, page) - 1) * pageSize
  const term = String(search || '').trim()
  const pattern = term ? `%${term}%` : null

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT
         u.id AS user_id, u.full_name, u.email, u.affiliate_code, u.created_at AS joined_at,
         COUNT(DISTINCT ar.referred_user_id)::int AS total_referrals,
         COUNT(DISTINCT c.referral_id) FILTER (WHERE c.order_id IS NOT NULL)::int AS paying_referrals,
         COALESCE(SUM(c.commission_amount), 0) AS lifetime_commission,
         COALESCE(SUM(c.commission_amount) FILTER (WHERE c.status IN ('available','adjusted')), 0) AS available_balance
         FROM users u
         JOIN affiliate_referrals ar ON ar.referrer_user_id = u.id
         LEFT JOIN affiliate_commissions c ON c.referrer_user_id = u.id
        WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1 OR u.affiliate_code ILIKE $1)
        GROUP BY u.id
        ORDER BY lifetime_commission DESC
        LIMIT $2 OFFSET $3`,
      [pattern, pageSize, offset]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT u.id)::int AS total
         FROM users u
         JOIN affiliate_referrals ar ON ar.referrer_user_id = u.id
        WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1 OR u.affiliate_code ILIKE $1)`,
      [pattern]
    )
  ])

  return {
    rows: result.rows.map(r => ({
      ...r,
      lifetime_commission: parseFloat(r.lifetime_commission || 0),
      available_balance: parseFloat(r.available_balance || 0)
    })),
    total: countResult.rows[0]?.total || 0,
    page,
    pageSize
  }
}

async function fetchAffiliateTiers({ includeInactive = false } = {}) {
  const result = await pool.query(
    `SELECT id, tier_rank, label, min_referrals, commission_pct, is_active, updated_at
       FROM affiliate_commission_tiers
       ${includeInactive ? '' : 'WHERE is_active = TRUE'}
      ORDER BY tier_rank ASC`
  )
  return result.rows.map(r => ({
    ...r,
    min_referrals: parseInt(r.min_referrals, 10),
    commission_pct: parseFloat(r.commission_pct)
  }))
}

async function createAffiliateTier({ tier_rank, label, min_referrals, commission_pct }) {
  const result = await pool.query(
    `INSERT INTO affiliate_commission_tiers (tier_rank, label, min_referrals, commission_pct)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [tier_rank, label || null, min_referrals, commission_pct]
  )
  return result.rows[0]
}

async function updateAffiliateTier(id, { label, min_referrals, commission_pct, is_active }) {
  const result = await pool.query(
    `UPDATE affiliate_commission_tiers
        SET label = COALESCE($2, label),
            min_referrals = COALESCE($3, min_referrals),
            commission_pct = COALESCE($4, commission_pct),
            is_active = COALESCE($5, is_active)
      WHERE id = $1
      RETURNING *`,
    [id, label ?? null, min_referrals ?? null, commission_pct ?? null, is_active ?? null]
  )
  return result.rows[0] || null
}

module.exports = {
  resolveAffiliateCode,
  computeEffectiveTier,
  fetchAffiliateSummary,
  fetchAffiliateReferrals,
  fetchAffiliateCommissions,
  fetchAffiliatePayouts,
  fetchAffiliateAnalytics,
  settleAffiliatePayoutAmount,
  insertBalanceAdjustment,
  fetchAllAffiliatesForAdmin,
  fetchAffiliateTiers,
  createAffiliateTier,
  updateAffiliateTier
}
