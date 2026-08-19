/**
 * Payout aggregate.
 *
 * Approval existed twice — routes/admin/payouts.js and
 * routes/admin/commandCenterActions.js — as near-identical copies, and both
 * copies enforced only two things: that the payout was still `pending`, and
 * that realised profit covered the requested amount.
 *
 * The trader-side request path (routes/payouts.js) enforces considerably more:
 * funded account, KYC approved, status active, no open or pending trades, no
 * other pending payout. Time passes between request and approval, so an
 * account that failed, was locked, or had its KYC revoked in the interim could
 * still be approved and debited. Nothing re-checked.
 *
 * This module is the one approval path. Both admin routes call it, and it
 * re-runs the full eligibility rules from domain/payoutEligibility.js — the
 * same predicate the request path and the trader-facing blockers list use, so
 * the three cannot drift apart again.
 */

const Decimal = require('decimal.js')
const { loadForUpdate } = require('./account')
const { evaluatePayoutEligibility } = require('./payoutEligibility')
const { InvariantViolation, NotFound } = require('./errors')
const logger = require('../utils/logger')
const { issueCertificate, buildCertificateTitle } = require('../services/certificateService')

/**
 * Approve and pay a pending payout, inside the caller's transaction.
 *
 * Locks the payout, then the account, then re-validates from scratch. The debit
 * goes through the Account aggregate so it lands in the canonical ledger and
 * shifts the drawdown anchors — a payout is a capital withdrawal, so leaving
 * `eod_peak_equity` at the pre-payout high made the trader's own withdrawal eat
 * their drawdown buffer.
 *
 * @param {import('pg').PoolClient} client must already be inside a transaction
 * @param {string|number} payoutId
 * @param {{transactionId?:string|null, actor?:string, skipRecheck?:boolean}} [opts]
 * @returns {Promise<object>} the updated payout row
 */
async function approvePayout(client, payoutId, {
  transactionId = null,
  actor = 'admin'
} = {}) {
  const payoutResult = await client.query(
    `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.amount_payable,
            p.payment_method, p.status, p.is_flagged, p.flag_reason, p.admin_notes,
            u.email, u.full_name, u.kyc_status
       FROM payouts p
       JOIN users u ON p.user_id = u.id
      WHERE p.id = $1
      FOR UPDATE OF p`,
    [payoutId]
  )
  if (payoutResult.rows.length === 0) throw new NotFound('Payout not found')

  const payout = payoutResult.rows[0]
  if (String(payout.status || '').toLowerCase() !== 'pending') {
    throw new InvariantViolation('Only pending payouts can be approved', 400)
  }

  const account = await loadForUpdate(client, payout.account_id)

  // Open exposure is counted at approval time, not trusted from the request.
  const exposure = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'open')::int    AS open_count,
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_count
     FROM trades WHERE account_id = $1`,
    [payout.account_id]
  )

  const { blockers } = evaluatePayoutEligibility({
    account: account.row,
    kycStatus: payout.kyc_status,
    openTradeCount: exposure.rows[0]?.open_count || 0,
    pendingOrderCount: exposure.rows[0]?.pending_count || 0,
    // The payout being approved is itself the pending one, so it must not
    // count against its own approval.
    pendingPayoutCount: 0,
    requestedAmount: payout.amount_requested
  })
  if (blockers.length > 0) {
    throw new InvariantViolation(blockers[0].message, 400)
  }

  // Decimal throughout — the trader path used parseFloat while the admin path
  // used Decimal, so the two could disagree at the boundary on a value the
  // other had already accepted.
  const debit = new Decimal(payout.amount_requested).negated().toNumber()
  await account.adjustBalance({
    amount: debit,
    source: 'payout',
    reason: `Payout ${payout.id} approved`,
    createdBy: actor,
    metadata: { payout_id: String(payout.id), payment_method: payout.payment_method }
  })

  const updated = await client.query(
    `UPDATE payouts
        SET status = 'paid',
            paid_at = NOW(),
            transaction_id = COALESCE($2, transaction_id),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, user_id, account_id, amount_requested, amount_payable,
                status, is_flagged, flag_reason, admin_notes`,
    [payout.id, transactionId ? String(transactionId) : null]
  )

  const award = await awardPayoutCertificate(client, payout)

  return {
    payout: updated.rows[0],
    certificate: award.certificate,
    certificateCreated: award.created,
    recipient: {
      userId: payout.user_id,
      email: payout.email,
      fullName: payout.full_name,
      amountPayable: payout.amount_payable,
      paymentMethod: payout.payment_method
    }
  }
}

/**
 * Mint the payout reward certificate inside the approval transaction.
 *
 * SAVEPOINT-wrapped for the same reason as the promotion award: the
 * certificate must not survive a rolled-back approval, but it must also never
 * be the reason a payout fails. Money has moved by this point in the
 * transaction — a broken renderer must not undo it. Any failed statement aborts
 * the whole Postgres transaction, so the savepoint is what makes "log it and
 * carry on" actually possible here.
 */
async function awardPayoutCertificate(client, payout) {
  // approvePayout documents that `client` must already be inside a transaction,
  // so the savepoint normally succeeds. Probing rather than assuming means a
  // caller that broke that contract loses the rollback protection it never had,
  // not the certificate itself.
  let savepointHeld = false
  try {
    await client.query('SAVEPOINT payout_certificate')
    savepointHeld = true
  } catch {
    savepointHeld = false
  }

  try {
    const { certificate, created } = await issueCertificate(client, {
      userId: payout.user_id,
      accountId: payout.account_id,
      kind: 'payout',
      title: buildCertificateTitle({ kind: 'payout', amount: payout.amount_payable }),
      recipientName: payout.full_name,
      amount: payout.amount_payable,
      metadata: { payout_id: String(payout.id), payment_method: payout.payment_method },
      sourceKey: `payout:${payout.id}`
    })

    if (savepointHeld) await client.query('RELEASE SAVEPOINT payout_certificate')
    return { certificate, created }
  } catch (error) {
    if (savepointHeld) await client.query('ROLLBACK TO SAVEPOINT payout_certificate').catch(() => {})
    logger.error('[payout] Certificate award failed; payout approval continues', {
      payout_id: String(payout.id),
      error: error.message
    })
    return { certificate: null, created: false }
  }
}

module.exports = { approvePayout }
