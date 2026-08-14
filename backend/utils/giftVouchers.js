const crypto = require('crypto')
const logger = require('./logger')
const { getTenantSettingsMap } = require('./tenantSettings')
const { fetchStepModelBySlug } = require('./stepModels')
const { enqueueGiftChallengeVoucherEmail } = require('./emailQueue')

function generateGiftVoucherCode() {
  return `GIFT-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
}

// Issues a gift_vouchers row for a paid, is_gift challenge_orders row and
// emails the recipient. Called from both the synchronous $0-order path
// (accounts.js POST /orders, coupon/referral discount brought price to $0)
// and the async Stripe webhook path (billing.js markChallengeOrderPaid) —
// both already run inside an open transaction, so `client` is required and
// this never opens/commits one itself, matching applyBalanceAdjustment's
// convention in utils/balanceAdjustments.js.
async function issueGiftVoucherForOrder(client, order) {
  if (!order || !order.is_gift) return null
  const recipientEmail = String(order.gift_recipient_email || '').trim().toLowerCase()
  if (!recipientEmail) {
    logger.warn(`giftVouchers: order ${order.id} is marked is_gift but has no gift_recipient_email`)
    return null
  }

  const existing = await client.query(`SELECT id FROM gift_vouchers WHERE order_id = $1`, [order.id])
  if (existing.rows.length > 0) return existing.rows[0]

  const settings = await getTenantSettingsMap(['gift_voucher_expiry_days'])
  const expiryDays = Math.max(1, parseInt(settings.gift_voucher_expiry_days, 10) || 30)

  const purchaserResult = await client.query(`SELECT email, full_name FROM users WHERE id = $1::uuid`, [order.user_id])
  const purchaser = purchaserResult.rows[0] || {}

  const recipientLookup = await client.query(
    `SELECT id, full_name FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [recipientEmail]
  )
  const recipientUserId = recipientLookup.rows[0]?.id || null
  const recipientName = recipientLookup.rows[0]?.full_name || null

  const metadata = order.metadata_json && typeof order.metadata_json === 'object'
    ? order.metadata_json
    : (() => { try { return JSON.parse(order.metadata_json || '{}') } catch { return {} } })()
  const giftMessage = String(metadata.gift_message || '').trim() || null

  let voucher = null
  for (let attempt = 0; attempt < 5 && !voucher; attempt++) {
    try {
      const insertResult = await client.query(
        `INSERT INTO gift_vouchers (
           code, purchaser_user_id, order_id, recipient_email, recipient_user_id,
           account_size, challenge_model_slug, amount_paid, gift_message, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + ($10 || ' days')::interval)
         RETURNING *`,
        [
          generateGiftVoucherCode(),
          order.user_id,
          order.id,
          recipientEmail,
          recipientUserId,
          order.account_size,
          order.challenge_model_slug,
          order.amount,
          giftMessage,
          expiryDays
        ]
      )
      voucher = insertResult.rows[0]
    } catch (err) {
      if (err.code !== '23505') throw err // unique code collision — retry with a new code
    }
  }
  if (!voucher) {
    logger.error(`giftVouchers: failed to generate a unique voucher code for order ${order.id} after 5 attempts`)
    return null
  }

  logger.info(`giftVouchers: issued voucher ${voucher.code} for order ${order.id} to ${recipientEmail}`)

  try {
    await enqueueGiftChallengeVoucherEmail(
      recipientEmail,
      recipientName,
      purchaser.full_name || 'A friend',
      voucher.code,
      parseFloat(order.account_size),
      giftMessage,
      voucher.expires_at,
      { userId: recipientUserId }
    )
  } catch (emailErr) {
    logger.warn('giftVouchers: failed to enqueue gift voucher email:', { error: emailErr.message })
  }

  return voucher
}

// Redeems a gift voucher into a pre-paid challenge_orders row for the
// claiming user, gated by an email match against gift_vouchers.recipient_email
// (the gift-voucher analog of competition vouchers' user_id scoping, needed
// because the recipient may not have existed as a user at issuance time).
// Mirrors the INSERT shape of the competition-voucher redemption branch in
// accounts.js POST /orders so the same downstream POST /accounts/create gate
// works unchanged. Caller must already be inside an open transaction on
// `client` (advisory lock + FOR UPDATE happen here).
async function redeemGiftVoucher(client, { code, userEmail, userId }) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('gift_voucher'), hashtext($1))`, [code])

  const voucherResult = await client.query(`SELECT * FROM gift_vouchers WHERE code = $1 FOR UPDATE`, [code])
  const voucher = voucherResult.rows[0]
  if (!voucher) {
    return { ok: false, status: 404, error: 'Voucher not found' }
  }

  if (voucher.status === 'issued' && voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
    await client.query(`UPDATE gift_vouchers SET status = 'expired', updated_at = NOW() WHERE id = $1`, [voucher.id])
    return { ok: false, status: 410, error: 'This gift has expired' }
  }

  if (voucher.status !== 'issued') {
    return { ok: false, status: 409, error: 'This gift has already been claimed or is no longer valid' }
  }

  if (String(voucher.recipient_email).toLowerCase() !== String(userEmail || '').trim().toLowerCase()) {
    return { ok: false, status: 403, error: 'This gift was sent to a different email address. Log in with that email to claim it.' }
  }

  const stepModel = await fetchStepModelBySlug(voucher.challenge_model_slug)
  if (!stepModel) {
    return { ok: false, status: 400, error: 'The challenge model for this gift is no longer available. Please contact support.' }
  }

  const orderInsert = await client.query(
    `INSERT INTO challenge_orders (
       user_id, account_size, amount, currency, status, checkout_mode, payment_provider, paid_via, paid_at,
       challenge_model_id, challenge_model_slug, metadata_json
     ) VALUES (
       $1, $2, 0, 'USD', 'paid', 'voucher', NULL, 'gift_voucher', NOW(), $3, $4, $5::jsonb
     )
     RETURNING *`,
    [
      userId,
      voucher.account_size,
      stepModel.id,
      voucher.challenge_model_slug,
      JSON.stringify({ voucher_code: voucher.code, gift_voucher_id: voucher.id })
    ]
  )

  await client.query(
    `UPDATE gift_vouchers
        SET status = 'claimed', claimed_at = NOW(), claimed_order_id = $1, recipient_user_id = $2, updated_at = NOW()
      WHERE id = $3`,
    [orderInsert.rows[0].id, userId, voucher.id]
  )

  return { ok: true, order: orderInsert.rows[0] }
}

module.exports = {
  generateGiftVoucherCode,
  issueGiftVoucherForOrder,
  redeemGiftVoucher
}
