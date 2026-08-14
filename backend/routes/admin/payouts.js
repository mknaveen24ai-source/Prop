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
const Decimal = require('decimal.js')
const logger = require('../../utils/logger')
const {
  enqueuePayoutApprovedEmail,
  enqueuePayoutRejectedEmail
} = require('../../utils/emailQueue')
const { createUserNotification } = require('../../utils/userNotifications')
const { ensureDisputesInfrastructure } = require('../disputes')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
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

    // Fetch payout details and user email/name first
    const payoutData = await client.query(
      `SELECT p.amount_requested, p.amount_payable, p.payment_method, p.account_id, p.status,
              u.id::text AS user_id, u.email, u.full_name
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

    const { amount_requested, amount_payable, payment_method, account_id, status, user_id, email, full_name } = payoutData.rows[0]
    if (status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Payout is not pending' })
    }

    const accountData = await client.query(
      `SELECT current_balance, starting_balance FROM accounts WHERE id = $1 FOR UPDATE`,
      [account_id]
    )
    if (accountData.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const availableProfit = new Decimal(accountData.rows[0].current_balance).minus(accountData.rows[0].starting_balance)
    if (availableProfit.lt(amount_requested)) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Insufficient realized profit for payout' })
    }

    await client.query(
      `UPDATE accounts SET current_balance = current_balance - $1 WHERE id = $2`,
      [amount_requested, account_id]
    )

    await client.query(
      `UPDATE payouts SET
       status = 'paid',
       paid_at = NOW(),
       transaction_id = $1
       WHERE id = $2`,
      [transaction_id, payout_id]
    )

    await client.query('COMMIT')

    // Send automated email to the user
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

    res.json({ message: 'Payout marked as paid and user notified' })
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    logger.error('Could not mark payout as paid:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
  } finally {
    if (client) client.release()
  }
})

router.post('/payouts/reject', authenticateAdmin, requireAdminCapability('payout:review:scoped'), async function(req, res) {
  try {
    const { payout_id, reason } = req.body

    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    // Fetch payout details and user email/name
    const payoutData = await pool.query(
      `SELECT p.amount_requested, u.id::text AS user_id, u.email, u.full_name
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`,
      [payout_id]
    )

    if (payoutData.rows.length === 0) {
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, user_id, email, full_name } = payoutData.rows[0]

    await pool.query(
      `UPDATE payouts SET
       status = 'rejected',
       updated_at = NOW(),
       admin_notes = $1
       WHERE id = $2`,
      [reason || 'Rejected by admin', payout_id]
    )

    // Send automated email to the user
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

    res.json({ message: 'Payout rejected and user notified' })
  } catch (error) {
    logger.error('Could not reject payout:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
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
