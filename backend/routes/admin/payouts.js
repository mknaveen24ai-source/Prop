// Admin payout list, approve/reject and fraud flagging.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireAdminCapability
} = require('../middleware')
const logger = require('../../utils/logger')
const {
  enqueuePayoutApprovedEmail,
  enqueuePayoutRejectedEmail
} = require('../../utils/emailQueue')
const { createUserNotification } = require('../../utils/userNotifications')
const { ensureDisputesInfrastructure } = require('../disputes')
require('../../loadEnv')

const { emitAdminEvent } = require('../../utils/realtime')
const { ensureFeatureTables } = require('./shared/schema')

// Approvals at or above this trigger an operator alert and an extra audit
// entry. Not a block — see the approval-alerting note in the handler.
const PAYOUT_ALERT_THRESHOLD = 2500
const {
  getAdminActorLabel, buildAdminActorPayload, appendImmutableAudit
} = require('./shared/audit')
const {
  requireReasonText, parseBooleanFilter, wantsAdminListContract,
  parseCsvListParam, parseListPaging, normalizePayoutSnapshot,
  buildAllowedPayoutActions, fetchPayoutForAdmin,
  emitSuperAdminPowerEvent
} = require('./shared/helpers')
const {
  buildPayoutListResult
} = require('./shared/listBuilders')
const { approvePayout } = require('../../domain/payout')
const { deliverCertificate } = require('../../services/certificateService')

router.get('/payouts', authenticateAdmin, requireAdminCapability('payout:read:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureDisputesInfrastructure()
    const paging = parseListPaging(req)
    const listResult = await buildPayoutListResult({
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          status: req.query?.status || null,
          is_flagged: parseBooleanFilter(req.query?.is_flagged),
          dispute_linked: parseBooleanFilter(req.query?.dispute_linked),
          tags: parseCsvListParam(req.query?.tags || [])
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin payouts fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch payouts' })
  }
})

router.post('/payouts/approve', authenticateAdmin, requireAdminCapability('payout:review:scoped'), async function(req, res) {
  let client
  try {
    const { payout_id, transaction_id } = req.body

    client = await pool.connect()
    await client.query('BEGIN')

    // Approval, eligibility re-check and the ledger-backed debit all live in
    // domain/payout.js, shared with the command-centre bulk action. Both call
    // sites previously carried their own copy of this logic, and both checked
    // only that the payout was pending and that profit covered it — never that
    // the account was still funded, active and KYC-approved at approval time.
    const approval = await approvePayout(client, payout_id, {
      transactionId: transaction_id,
      actor: getAdminActorLabel(req.admin)
    })

    // Above the dual-approval threshold the first approval only records intent:
    // no money has moved and the payout is still pending, so nothing below this
    // point applies — the trader must not be told they have been paid, and no
    // certificate is minted. A second, distinct admin completes it.
    if (approval.awaitingSecondApproval) {
      await client.query('COMMIT')

      await appendImmutableAudit(pool, {
        actor: buildAdminActorPayload(req.admin),
        eventType: 'payout_first_approval_recorded',
        entityType: 'payout',
        entityId: String(payout_id),
        payload: { threshold: approval.threshold, first_approver: approval.firstApprover }
      }).catch((auditErr) => {
        logger.error('[payouts] Could not audit first approval; approval stands', { error: auditErr.message })
      })

      emitAdminEvent('payout_awaiting_second_approval', {
        payout_id: String(payout_id),
        first_approver: approval.firstApprover,
        threshold: approval.threshold
      })

      return res.json({
        message: 'First approval recorded. A second admin must approve this payout before it is paid.',
        awaiting_second_approval: true,
        first_approver: approval.firstApprover,
        threshold: approval.threshold
      })
    }

    const { recipient } = approval
    const { email, full_name, amountPayable: amount_payable, paymentMethod: payment_method, userId: user_id } = recipient

    await client.query('COMMIT')

    // ── Approval alerting ───────────────────────────────────────────────────
    //
    // Dual control (migration 045) now covers approvals at or above
    // payout_dual_approval_threshold. Alerting is the complement, not a
    // substitute: it covers everything BELOW that threshold, where one admin
    // still signs alone, and every flagged payout at any amount. Both the
    // immutable audit trail and a live admin-channel event fire, so an abuse is
    // noticed in minutes rather than at the next reconciliation.
    //
    // Best-effort and after COMMIT, for the same reason the notifications below
    // are: alerting must never be able to fail a payout that has already moved
    // money.
    try {
      const alertAmount = parseFloat(amount_payable) || 0
      const isLarge = alertAmount >= PAYOUT_ALERT_THRESHOLD
      const wasFlagged = approval.payout?.is_flagged === true
      if (isLarge || wasFlagged) {
        const reasons = []
        if (isLarge) reasons.push(`amount $${alertAmount.toFixed(2)} at or above the $${PAYOUT_ALERT_THRESHOLD} alert threshold`)
        if (wasFlagged) reasons.push(`payout was flagged: ${approval.payout?.flag_reason || 'no reason recorded'}`)

        logger.warn('[payouts] High-attention payout approved', {
          payoutId: String(payout_id),
          amountPayable: alertAmount,
          approvedBy: getAdminActorLabel(req.admin),
          reasons
        })

        emitAdminEvent('payout_approved_alert', {
          payout_id: String(payout_id),
          amount_payable: alertAmount,
          approved_by: getAdminActorLabel(req.admin),
          is_flagged: wasFlagged,
          reasons
        })

        await appendImmutableAudit(pool, {
          actor: buildAdminActorPayload(req.admin),
          eventType: 'payout_approved_high_attention',
          entityType: 'payout',
          entityId: String(payout_id),
          payload: { amount_payable: alertAmount, is_flagged: wasFlagged, reasons }
        })
      }
    } catch (alertErr) {
      logger.error('[payouts] Approval alerting failed; payout stands', {
        error: alertErr.message, payoutId: String(payout_id)
      })
    }

    // FIX (M-09): these ran outside any try/catch, so a mail or socket failure
    // hit the outer handler and returned HTTP 500 for a payout that had already
    // committed and already debited the balance. The admin then saw an error
    // for successful work, retried, and got a confusing 400 from the status
    // guard. Notification is best-effort; the money movement is not.
    try {
      await enqueuePayoutApprovedEmail(email, full_name, amount_payable, payment_method, {
        userId: user_id || null
      })

      const io = req.app.get('io')
      if (io && user_id) {
        io.to(String(user_id)).emit('payout_approved', { amount: amount_payable })
        await createUserNotification(io, user_id, {
          type: 'success',
          title: 'Payout Approved',
          message: `Your payout of $${parseFloat(amount_payable).toFixed(2)} has been approved and paid.`
        })
      }

      // The certificate row committed with the payout above; only its delivery
      // is best-effort, and only when this approval is what minted it — a
      // retried approval must not email the trader a second time.
      if (approval.certificateCreated) {
        await deliverCertificate(io, approval.certificate, { email })
      }
    } catch (notifyErr) {
      logger.error('Payout paid but trader could not be notified:', {
        error: notifyErr.message, payoutId: payout_id
      })
    }

    res.json({ message: 'Payout marked as paid and user notified' })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not mark payout as paid:', { error: error.message })
    // Domain refusals (payout not pending, account no longer eligible, unknown
    // payout) carry their own status code and a message safe to show the admin.
    // Collapsing them all into a 500 told the admin the platform had broken
    // when in fact it had correctly refused the approval.
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    res.status(500).json({ error: 'Could not update payout' })
  } finally {
    if (client) client.release()
  }
})

// FIX (H-05): this handler had no status check, no transaction and no row
// lock, while /payouts/paid above has all three. Rejecting an already-`paid`
// payout therefore flipped its status after the money had been sent and the
// balance debited — every `WHERE status = 'paid'` aggregate (public landing
// stats, transparency page, b-book reconciliation) silently lost the record,
// and no compensating credit exists to undo the debit.
//
// Now mirrors /payouts/paid exactly: BEGIN, SELECT ... FOR UPDATE, reject
// anything not still pending, COMMIT.
router.post('/payouts/reject', authenticateAdmin, requireAdminCapability('payout:review:scoped'), async function(req, res) {
  let client
  try {
    const { payout_id, reason } = req.body

    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    client = await pool.connect()
    await client.query('BEGIN')

    const payoutData = await client.query(
      `SELECT p.amount_requested, p.status, u.id::text AS user_id, u.email, u.full_name
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1
       FOR UPDATE`,
      [payout_id]
    )

    if (payoutData.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, status, user_id, email, full_name } = payoutData.rows[0]

    if (status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({
        error: status === 'paid'
          ? 'This payout has already been paid and cannot be rejected.'
          : `Payout is not pending (current status: ${status}).`
      })
    }

    await client.query(
      `UPDATE payouts SET
       status = 'rejected',
       updated_at = NOW(),
       admin_notes = $1
       WHERE id = $2`,
      [reason || 'Rejected by admin', payout_id]
    )

    await client.query('COMMIT')

    // Notification is best-effort and deliberately outside the transaction: a
    // mail or socket failure must not report an error for a rejection that has
    // already committed (the mistake M-09 flags in /payouts/paid).
    try {
      await enqueuePayoutRejectedEmail(email, full_name, amount_requested, reason, {
        userId: user_id || null
      })

      const io = req.app.get('io')
      if (io && user_id) {
        await createUserNotification(io, user_id, {
          type: 'error',
          title: 'Payout Rejected',
          message: reason ? `Your payout request was rejected: ${reason}` : 'Your payout request was rejected.'
        })
      }
    } catch (notifyErr) {
      logger.error('Payout rejected but trader could not be notified:', {
        error: notifyErr.message, payoutId: payout_id
      })
    }

    res.json({ message: 'Payout rejected and user notified' })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not reject payout:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
  } finally {
    if (client) client.release()
  }
})

router.post('/payouts/:payoutId/flag', authenticateAdmin, requireAdminCapability('payout:flag'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const payoutId = parseInt(req.params.payoutId, 10)
    const reason = requireReasonText(req.body?.reason, 'flag reason')

    if (!Number.isFinite(payoutId) || payoutId <= 0) {
      return res.status(400).json({ error: 'Valid payout id is required' })
    }

    await client.query('BEGIN')
    const payout = await fetchPayoutForAdmin(client, payoutId, { forUpdate: true })
    if (!payout) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const beforeSnapshot = normalizePayoutSnapshot(payout)
    const updatedResult = await client.query(
      `UPDATE payouts
          SET is_flagged = TRUE,
              flag_reason = $2,
              admin_notes = COALESCE(NULLIF(admin_notes, ''), '') ||
                CASE WHEN COALESCE(NULLIF(admin_notes, ''), '') = '' THEN '' ELSE E'\n' END ||
                $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, user_id, account_id, amount_requested, amount_payable,
                  status, is_flagged, flag_reason, admin_notes`,
      [payoutId, reason, `[FLAGGED ${new Date().toISOString()}] ${reason}`]
    )
    const updatedPayout = updatedResult.rows[0]

    await appendImmutableAudit(client, {
      eventType: 'admin_payout_flagged',
      entityType: 'payout',
      entityId: String(payoutId),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizePayoutSnapshot(updatedPayout)
      }
    })

    await client.query('COMMIT')
    await emitSuperAdminPowerEvent(req, {
      entity: 'payout',
      entity_id: payoutId,
      action: 'flag_payout'
    })

    res.json({
      message: 'Payout flagged for review',
      payout: updatedPayout,
      allowed_actions: buildAllowedPayoutActions(updatedPayout)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not flag payout:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not flag payout' })
  } finally {
    client.release()
  }
})

router.post('/payouts/:payoutId/unflag', authenticateAdmin, requireAdminCapability('payout:flag'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const payoutId = parseInt(req.params.payoutId, 10)
    const reason = requireReasonText(req.body?.reason, 'unflag reason')

    if (!Number.isFinite(payoutId) || payoutId <= 0) {
      return res.status(400).json({ error: 'Valid payout id is required' })
    }

    await client.query('BEGIN')
    const payout = await fetchPayoutForAdmin(client, payoutId, { forUpdate: true })
    if (!payout) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const beforeSnapshot = normalizePayoutSnapshot(payout)
    const updatedResult = await client.query(
      `UPDATE payouts
          SET is_flagged = FALSE,
              flag_reason = NULL,
              admin_notes = COALESCE(NULLIF(admin_notes, ''), '') ||
                CASE WHEN COALESCE(NULLIF(admin_notes, ''), '') = '' THEN '' ELSE E'\n' END ||
                $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, user_id, account_id, amount_requested, amount_payable,
                  status, is_flagged, flag_reason, admin_notes`,
      [payoutId, `[UNFLAGGED ${new Date().toISOString()}] ${reason}`]
    )
    const updatedPayout = updatedResult.rows[0]

    await appendImmutableAudit(client, {
      eventType: 'admin_payout_unflagged',
      entityType: 'payout',
      entityId: String(payoutId),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizePayoutSnapshot(updatedPayout)
      }
    })

    await client.query('COMMIT')
    await emitSuperAdminPowerEvent(req, {
      entity: 'payout',
      entity_id: payoutId,
      action: 'unflag_payout'
    })

    res.json({
      message: 'Payout unflagged successfully',
      payout: updatedPayout,
      allowed_actions: buildAllowedPayoutActions(updatedPayout)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not unflag payout:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not unflag payout' })
  } finally {
    client.release()
  }
})

module.exports = router
