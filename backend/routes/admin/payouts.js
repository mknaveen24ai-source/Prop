'use strict'
/**
 * Admin Payouts Sub-Router
 * Extracted from routes/admin.js for progressive modularization.
 * All shared helpers imported from the monolith via _internals bridge.
 */
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const logger = require('../../utils/logger')
const { DEFAULT_TENANT_SLUG } = require('../../utils/tenants')
const {
  authenticateAdmin,
  requireAdminCapability,
  requireSuperAdmin,
  requireTenantAdminOrSuperAdmin
} = require('../middleware')
const adminMonolith = require('../admin')
const {
  getScopedTenantId, getAdminActorLabel, buildAdminActorPayload, getAdminOwnerId,
  normalizeEntityId, normalizeAdminTag, normalizeEntityType, normalizeAdminEmail,
  parsePositiveInteger, parseBooleanFilter, parseCsvListParam, parseListPaging,
  buildPagination, paginateRows, facetCounts, toIsoOrNull, wantsAdminListContract,
  computeUserLifecycleStage, computeAccountLifecycleStage, computePayoutComplianceStatus,
  buildSavedViewCapabilities, normalizeAccountSnapshot, normalizeUserSnapshot,
  normalizePayoutSnapshot, buildAllowedAccountActions, buildAllowedUserActions,
  buildAllowedPayoutActions, emitCopierEventSafe, emitCopierEventsAfterCommit,
  buildCopierTradePayload, queueAdminCopierEvent, forceCloseOpenTradesForAccount,
  cancelPendingTradesForAccount, forceCloseTradeById, calcTradePnl,
  upsertAdminEntityMeta, computePhaseEndDateForAccountType, appendImmutableAudit,
  buildKycDocumentPresencePredicate, getExposureData, ensureFeatureTables,
  buildUserListResult, buildAccountListResult
} = adminMonolith._internals
const { enqueuePayoutApprovedEmail, enqueuePayoutRejectedEmail } = require('../../utils/emailQueue')
const { emitAdminEvent } = require('../../utils/realtime')
const Decimal = require('decimal.js')


// ── Routes ─────────────────────────────────────────────────────────────────────
router.post('/trades/:tradeId/close', authenticateAdmin, requireAdminCapability('trader:write:scoped'), async function(req, res) {
  const client = await pool.connect()
  try {
    const tradeId = String(req.params.tradeId || '').trim()
    if (!tradeId) return res.status(400).json({ error: 'Valid trade id is required' })

    const copierEvents = []
    await client.query('BEGIN')
    const closed = await forceCloseTradeById(client, tradeId, 'Admin Force Close', { copierEvents, source: 'admin_force_close_trade' })
    if (!closed) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    try {
      await appendImmutableAudit(client, {
        eventType: 'admin_trade_force_closed',
        entityType: 'trade',
        entityId: String(closed.trade_id),
        payload: {
          account_id: String(closed.account_id),
          instrument: closed.instrument,
          pnl: closed.pnl
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    await emitCopierEventsAfterCommit(copierEvents)

    if (req.app.get('io')) {
      req.app.get('io').to(String(closed.user_id)).emit('account_update', {
        message: `Admin force-closed ${closed.instrument}: ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`,
        pnl: closed.pnl,
        account_id: closed.account_id,
        event: 'admin_trade_force_closed'
      })
    }

    res.json({
      message: 'Trade force-closed successfully',
      pnl: closed.pnl,
      close_price: closed.close_price
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin trade force-close error:', { error: error.message })
    res.status(500).json({ error: 'Could not force close trade' })
  } finally {
    client.release()
  }
})

router.get('/payouts', authenticateAdmin, requireAdminCapability('payout:read:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const paging = parseListPaging(req)
    const listResult = await buildPayoutListResult({
      tenantId,
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
    const tenantId = getScopedTenantId(req)

    client = await pool.connect()
    await client.query('BEGIN')

    // Fetch payout details and user email/name first
    const payoutData = await client.query(
      `SELECT p.amount_requested, p.amount_payable, p.payment_method, p.account_id, p.status,
              u.id::text AS user_id, u.email, u.full_name, u.tenant_id
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1
         AND ($2::bigint IS NULL OR COALESCE(u.tenant_id, $2) = $2)
       FOR UPDATE`,
      [payout_id, tenantId]
    )

    if (payoutData.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, amount_payable, payment_method, account_id, status, user_id, email, full_name, tenant_id } = payoutData.rows[0]
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

    try {
      await appendImmutableAudit(client, {
        eventType: 'admin_payout_approved',
        entityType: 'payout',
        entityId: String(payout_id),
        actor: getAdminActorLabel(req.admin),
        payload: {
          actor: buildAdminActorPayload(req.admin),
          tenant_id,
          user_id,
          account_id,
          amount_requested,
          amount_payable,
          payment_method,
          transaction_id: transaction_id || null
        }
      })
    } catch (auditError) {
      logger.warn('Could not append payout approval audit event:', { error: auditError.message, payout_id })
    }

    await client.query('COMMIT')

    // Send automated email to the user
    await enqueuePayoutApprovedEmail(email, full_name, amount_payable, payment_method, {
      tenantId: tenant_id,
      userId: user_id || null
    })

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
    const tenantId = getScopedTenantId(req)

    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    // Fetch payout details and user email/name
    const payoutData = await pool.query(
      `SELECT p.amount_requested, u.id::text AS user_id, u.email, u.full_name, u.tenant_id
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1
         AND ($2::bigint IS NULL OR COALESCE(u.tenant_id, $2) = $2)`,
      [payout_id, tenantId]
    )

    if (payoutData.rows.length === 0) {
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, user_id, email, full_name, tenant_id } = payoutData.rows[0]

    await pool.query(
      `UPDATE payouts SET
       status = 'rejected',
       updated_at = NOW(),
       admin_notes = $1
       WHERE id = $2`,
      [reason || 'Rejected by admin', payout_id]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'admin_payout_rejected',
        entityType: 'payout',
        entityId: String(payout_id),
        actor: getAdminActorLabel(req.admin),
        payload: {
          actor: buildAdminActorPayload(req.admin),
          tenant_id,
          user_id,
          amount_requested,
          reason: reason || 'Rejected by admin'
        }
      })
    } catch (auditError) {
      logger.warn('Could not append payout rejection audit event:', { error: auditError.message, payout_id })
    }

    // Send automated email to the user
    await enqueuePayoutRejectedEmail(email, full_name, amount_requested, reason, {
      tenantId: tenant_id,
      userId: user_id || null
    })

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
    const tenantId = getScopedTenantId(req)
    const reason = requireReasonText(req.body?.reason, 'flag reason')

    if (!Number.isFinite(payoutId) || payoutId <= 0) {
      return res.status(400).json({ error: 'Valid payout id is required' })
    }

    await client.query('BEGIN')
    const payout = await fetchPayoutForAdmin(client, payoutId, tenantId, { forUpdate: true })
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
        RETURNING id, tenant_id, user_id, account_id, amount_requested, amount_payable,
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
        tenant_scope: tenantId,
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizePayoutSnapshot(updatedPayout)
      }
    })

    await client.query('COMMIT')
    await emitSuperAdminPowerEvent(req, updatedPayout.tenant_id || tenantId, {
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
    const tenantId = getScopedTenantId(req)
    const reason = requireReasonText(req.body?.reason, 'unflag reason')

    if (!Number.isFinite(payoutId) || payoutId <= 0) {
      return res.status(400).json({ error: 'Valid payout id is required' })
    }

    await client.query('BEGIN')
    const payout = await fetchPayoutForAdmin(client, payoutId, tenantId, { forUpdate: true })
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
        RETURNING id, tenant_id, user_id, account_id, amount_requested, amount_payable,
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
        tenant_scope: tenantId,
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizePayoutSnapshot(updatedPayout)
      }
    })

    await client.query('COMMIT')
    await emitSuperAdminPowerEvent(req, updatedPayout.tenant_id || tenantId, {
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

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────


module.exports = router
