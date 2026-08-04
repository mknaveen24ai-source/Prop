const pool = require('../db')

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase()
}

function normalizeCouponRow(row) {
  if (!row) return null
  return {
    ...row,
    discount_value: parseFloat(row.discount_value),
    min_order_amount: row.min_order_amount != null ? parseFloat(row.min_order_amount) : null,
    max_redemptions: row.max_redemptions != null ? parseInt(row.max_redemptions, 10) : null,
    redemption_count: parseInt(row.redemption_count, 10)
  }
}

async function fetchAllCoupons() {
  const result = await pool.query(`SELECT * FROM coupon_codes ORDER BY created_at DESC`)
  return result.rows.map(normalizeCouponRow)
}

async function createCoupon({ code, description, discount_type, discount_value, max_redemptions, min_order_amount, expires_at, created_by }) {
  const result = await pool.query(
    `INSERT INTO coupon_codes (code, description, discount_type, discount_value, max_redemptions, min_order_amount, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [normalizeCode(code), description || null, discount_type, discount_value, max_redemptions ?? null, min_order_amount ?? null, expires_at || null, created_by || null]
  )
  return normalizeCouponRow(result.rows[0])
}

// Fetches the current row first and merges rather than building a partial SQL
// SET clause — patch fields can legitimately be set to null (clear an expiry,
// remove a redemption cap), so a simple COALESCE would prevent clearing them.
async function updateCoupon(id, patch) {
  const existingResult = await pool.query(`SELECT * FROM coupon_codes WHERE id = $1`, [id])
  const current = existingResult.rows[0]
  if (!current) return null

  const merged = {
    description: patch.description !== undefined ? patch.description : current.description,
    discount_type: patch.discount_type !== undefined ? patch.discount_type : current.discount_type,
    discount_value: patch.discount_value !== undefined ? patch.discount_value : current.discount_value,
    max_redemptions: patch.max_redemptions !== undefined ? patch.max_redemptions : current.max_redemptions,
    min_order_amount: patch.min_order_amount !== undefined ? patch.min_order_amount : current.min_order_amount,
    expires_at: patch.expires_at !== undefined ? patch.expires_at : current.expires_at,
    is_active: patch.is_active !== undefined ? patch.is_active : current.is_active
  }

  const result = await pool.query(
    `UPDATE coupon_codes SET
       description = $2, discount_type = $3, discount_value = $4, max_redemptions = $5,
       min_order_amount = $6, expires_at = $7, is_active = $8
     WHERE id = $1
     RETURNING *`,
    [id, merged.description, merged.discount_type, merged.discount_value, merged.max_redemptions, merged.min_order_amount, merged.expires_at, merged.is_active]
  )
  return normalizeCouponRow(result.rows[0])
}

async function deleteCoupon(id) {
  const result = await pool.query(`DELETE FROM coupon_codes WHERE id = $1 RETURNING *`, [id])
  return normalizeCouponRow(result.rows[0])
}

// `queryable` is either the shared pool (read-only preview, e.g. Checkout page)
// or a client mid-transaction (authoritative check in accounts.js's POST
// /orders, called after an advisory lock on the code so concurrent redemptions
// can't both pass the max_redemptions check).
async function validateCouponForCheckout(queryable, { code, userId, amount }) {
  const normalized = normalizeCode(code)
  if (!normalized) return { valid: false, error: 'Coupon code is required' }

  const couponResult = await queryable.query(`SELECT * FROM coupon_codes WHERE code = $1`, [normalized])
  const couponRow = couponResult.rows[0]
  if (!couponRow) return { valid: false, error: 'Invalid coupon code' }

  const coupon = normalizeCouponRow(couponRow)
  if (!coupon.is_active) return { valid: false, error: 'This coupon is no longer active' }
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    return { valid: false, error: 'This coupon has expired' }
  }
  if (coupon.max_redemptions != null && coupon.redemption_count >= coupon.max_redemptions) {
    return { valid: false, error: 'This coupon has reached its redemption limit' }
  }
  if (coupon.min_order_amount != null && amount < coupon.min_order_amount) {
    return { valid: false, error: `This coupon requires a minimum order of $${coupon.min_order_amount}` }
  }

  if (userId) {
    const alreadyUsed = await queryable.query(
      `SELECT 1 FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2`,
      [coupon.id, userId]
    )
    if (alreadyUsed.rows.length > 0) return { valid: false, error: 'You have already used this coupon' }
  }

  const rawDiscount = coupon.discount_type === 'percent'
    ? amount * (coupon.discount_value / 100)
    : coupon.discount_value
  const discountAmount = Math.round(Math.max(0, Math.min(rawDiscount, amount)) * 100) / 100
  const finalAmount = Math.round((amount - discountAmount) * 100) / 100

  return { valid: true, coupon, discount_amount: discountAmount, final_amount: finalAmount }
}

async function recordCouponRedemption(client, { couponId, userId, orderId, discountAmount }) {
  await client.query(
    `INSERT INTO coupon_redemptions (coupon_id, user_id, order_id, discount_amount) VALUES ($1, $2, $3, $4)`,
    [couponId, userId, orderId, discountAmount]
  )
  await client.query(`UPDATE coupon_codes SET redemption_count = redemption_count + 1 WHERE id = $1`, [couponId])
}

module.exports = {
  fetchAllCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  validateCouponForCheckout,
  recordCouponRedemption
}
