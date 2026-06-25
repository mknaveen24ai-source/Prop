'use strict'
/**
 * Admin Users Sub-Router
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
const { emitAdminEvent } = require('../../utils/realtime')
const { sanitizeString } = require('../../utils/validation')
const { getKycContentType, getOriginalKycExtension, readKycFileBuffer } = require('../../utils/secureKycStorage')
const { invalidateAllUserTokens } = require('../../utils/tokenCache')
const path = require('path')
const fs = require('fs')


// ── Routes ─────────────────────────────────────────────────────────────────────
router.get('/traders', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const paging = parseListPaging(req)
    const listResult = await buildTraderListResult({
      tenantId,
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          kyc_status: req.query?.kyc_status || null,
          is_banned: parseBooleanFilter(req.query?.is_banned),
          has_active_accounts: parseBooleanFilter(req.query?.has_active_accounts),
          funded_only: parseBooleanFilter(req.query?.funded_only),
          country: req.query?.country || null,
          risk_tier: req.query?.risk_tier || null,
          tags: parseCsvListParam(req.query?.tags || [])
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin traders fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch traders' })
  }
})

router.post('/kyc/approve', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    const tenantId = getScopedTenantId(req)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET kyc_status = 'approved'
       WHERE id = $1
         AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
       RETURNING id, email, full_name, tenant_id`,
      [user_id, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_approved',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (_) {}

    // Send automated email to the user
    await enqueueKycApprovedEmail(result.rows[0].email, result.rows[0].full_name, {
      tenantId: result.rows[0].tenant_id,
      userId: result.rows[0].id
    })

    res.json({ message: 'KYC approved successfully' })
  } catch (error) {
    logger.error('KYC approve error:', { error: error.message })
    res.status(500).json({ error: 'Could not approve KYC' })
  }
})

router.post('/kyc/reject', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    const { reason } = req.body
    const tenantId = getScopedTenantId(req)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET kyc_status = 'rejected'
       ${ reason ? `, kyc_rejection_reason = $2` : '' }
       WHERE id = $1
         AND ($${reason ? 3 : 2}::bigint IS NULL OR COALESCE(tenant_id, $${reason ? 3 : 2}) = $${reason ? 3 : 2})
       RETURNING id, email, full_name, tenant_id`,
      reason ? [user_id, String(reason).slice(0, 500), tenantId] : [user_id, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_rejected',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email, reason: reason || '' }
      })
    } catch (_) {}

    // Send automated email to the user
    await enqueueKycRejectedEmail(result.rows[0].email, result.rows[0].full_name, reason, {
      tenantId: result.rows[0].tenant_id,
      userId: result.rows[0].id
    })

    res.json({ message: 'KYC rejected' })
  } catch (error) {
    logger.error('KYC reject error:', { error: error.message })
    res.status(500).json({ error: 'Could not reject KYC' })
  }
})

router.post('/ban', authenticateAdmin, requireAdminCapability('trader:moderate:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    const tenantId = getScopedTenantId(req)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = true
       WHERE id = $1
         AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
       RETURNING id, email`,
      [user_id, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_banned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (_) {}

    res.json({ message: 'Trader banned successfully' })
  } catch (error) {
    logger.error('Ban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not ban trader' })
  }
})

router.post('/unban', authenticateAdmin, requireAdminCapability('trader:moderate:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    const tenantId = getScopedTenantId(req)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = false
       WHERE id = $1
         AND ($2::bigint IS NULL OR COALESCE(tenant_id, $2) = $2)
       RETURNING id, email`,
      [user_id, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_unbanned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (_) {}

    res.json({ message: 'Trader unbanned successfully' })
  } catch (error) {
    logger.error('Unban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not unban trader' })
  }
})

router.post('/users/:userId/revoke-sessions', authenticateAdmin, requireAdminCapability('trader:revoke_sessions'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const userId = normalizeEntityId(req.params.userId)
    const tenantId = getScopedTenantId(req)
    const reason = requireReasonText(req.body?.reason)

    if (!userId) {
      return res.status(400).json({ error: 'Valid user id is required' })
    }

    await client.query('BEGIN')
    const user = await fetchUserForAdmin(client, userId, tenantId, { forUpdate: true })
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }

    const beforeSnapshot = normalizeUserSnapshot(user)
    const result = await client.query(
      `UPDATE users
          SET token_version = COALESCE(token_version, 1) + 1
        WHERE id = $1
        RETURNING id, tenant_id, email, full_name, kyc_status, is_banned, token_version`,
      [userId]
    )
    const updatedUser = result.rows[0]

    await appendImmutableAudit(client, {
      eventType: 'admin_user_sessions_revoked',
      entityType: 'user',
      entityId: String(userId),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        tenant_scope: tenantId,
        before_snapshot: beforeSnapshot,
        after_snapshot: normalizeUserSnapshot(updatedUser)
      }
    })

    await client.query('COMMIT')
    await invalidateAllUserTokens(userId)

    if (req.app.get('io')) {
      req.app.get('io').to(String(userId)).emit('force_logout', {
        message: 'Your session was revoked by platform support. Please log in again.'
      })
    }

    await emitSuperAdminPowerEvent(req, updatedUser.tenant_id || tenantId, {
      entity: 'user',
      entity_id: userId,
      action: 'revoke_sessions'
    })

    res.json({
      message: 'Trader sessions revoked successfully',
      user: updatedUser,
      allowed_actions: buildAllowedUserActions(updatedUser)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin revoke sessions error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not revoke trader sessions' })
  } finally {
    client.release()
  }
})

router.post('/users/:userId/manual-account', authenticateAdmin, requireAdminCapability('account:create_manual'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const userId = normalizeEntityId(req.params.userId)
    const tenantId = getScopedTenantId(req)
    const reason = requireReasonText(req.body?.reason)
    const accountType = String(req.body?.account_type || 'phase1').trim().toLowerCase()
    const accountSize = parseInt(req.body?.account_size, 10)

    if (!userId) {
      return res.status(400).json({ error: 'Valid user id is required' })
    }
    if (!['phase1', 'phase2', 'funded'].includes(accountType)) {
      return res.status(400).json({ error: 'account_type must be phase1, phase2, or funded' })
    }
    if (!Number.isFinite(accountSize) || !ADMIN_VALID_ACCOUNT_SIZES.includes(accountSize)) {
      return res.status(400).json({ error: `account_size must be one of: ${ADMIN_VALID_ACCOUNT_SIZES.join(', ')}` })
    }

    await client.query('BEGIN')
    const user = await fetchUserForAdmin(client, userId, tenantId, { forUpdate: true })
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }

    const settings = await getTenantSettings(user.tenant_id || tenantId || 1, [
      'phase1_day_limit',
      'phase2_day_limit',
      'phase1_profit_target_pct',
      'phase2_profit_target_pct',
      'phase1_max_drawdown_pct',
      'phase2_max_drawdown_pct',
      'funded_max_drawdown_pct'
    ])

    const account = await createAdminIssuedAccount(client, {
      tenantId: user.tenant_id || tenantId || 1,
      userId,
      accountType,
      accountSize,
      settings
    })

    await appendImmutableAudit(client, {
      eventType: 'admin_manual_account_issued',
      entityType: 'account',
      entityId: String(account.id),
      actor: getAdminActorLabel(req.admin),
      payload: {
        reason,
        actor: buildAdminActorPayload(req.admin),
        tenant_scope: tenantId,
        issued_for_user: normalizeUserSnapshot(user),
        after_snapshot: normalizeAccountSnapshot(account),
        bypassed_account_limits: true
      }
    })

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(userId)).emit('account_update', {
        message: `Support issued a new ${accountType.toUpperCase()} account for you.`,
        account_id: account.id,
        event: 'admin_manual_account_issued'
      })
    }

    await emitSuperAdminPowerEvent(req, account.tenant_id || tenantId, {
      entity: 'account',
      entity_id: account.id,
      action: 'manual_account'
    })

    res.json({
      message: 'Manual account issued successfully',
      account,
      bypassed_account_limits: true,
      allowed_actions: buildAllowedAccountActions(account)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin manual account error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not issue manual account' })
  } finally {
    client.release()
  }
})

router.get('/accounts', authenticateAdmin, requireAdminCapability('account:read:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const paging = parseListPaging(req)
    const listResult = await buildAccountListResult({
      tenantId,
      query: {
        search: req.query?.search || req.query?.q || '',
        page: paging.page,
        pageSize: paging.pageSize,
        sort: req.query?.sort,
        order: req.query?.order,
        filters: {
          account_type: req.query?.account_type || null,
          status: req.query?.status || null,
          review_flagged: parseBooleanFilter(req.query?.review_flagged),
          month: req.query?.month || null,
          promotion_review_status: req.query?.promotion_review_status || null,
          tags: parseCsvListParam(req.query?.tags || [])
        }
      }
    })

    if (wantsAdminListContract(req)) {
      return res.json(listResult)
    }

    res.json(listResult.allRows)
  } catch (error) {
    logger.error('Admin accounts fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch accounts' })
  }
})

router.get('/account-batches', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const scopedTenantId = getScopedTenantId(req)
    const requestedTenantId = req.query?.tenant_id ? parseInt(req.query.tenant_id, 10) : null
    const tenantId = scopedTenantId || (Number.isFinite(requestedTenantId) ? requestedTenantId : 1)
    const quotaMonth = getQuotaMonth(req.query?.month || new Date())
    const accountSize = req.query?.account_size ? parseInt(req.query.account_size, 10) : null
    if (String(req.query?.all_sizes || '').toLowerCase() === 'true') {
      const sizes = await Promise.all(
        VALID_ACCOUNT_SIZES.map((size) => getTenantMonthlyQuotaStatus(pool, tenantId, quotaMonth, size))
      )
      return res.json({
        tenant_id: tenantId,
        quota_month: quotaMonth,
        sizes
      })
    }
    const status = await getTenantMonthlyQuotaStatus(pool, tenantId, quotaMonth, accountSize)
    res.json(status)
  } catch (error) {
    logger.error('Admin account batch fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch monthly quota' })
  }
})

router.post('/account-batches', authenticateAdmin, requireAdminCapability('account:promotion_review:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const scopedTenantId = getScopedTenantId(req)
    const requestedTenantId = req.body?.tenant_id ? parseInt(req.body.tenant_id, 10) : null
    const tenantId = scopedTenantId || (Number.isFinite(requestedTenantId) ? requestedTenantId : 1)
    const quotaMonth = getQuotaMonth(req.body?.quota_month || req.body?.month || new Date())
    const accountSize = req.body?.account_size ? parseInt(req.body.account_size, 10) : null
    const rawUnlimited = req.body?.is_unlimited
    const isUnlimited = rawUnlimited === false || rawUnlimited === 'false' || rawUnlimited === 0 || rawUnlimited === '0'
      ? false
      : true
    if (accountSize) {
      await upsertTenantMonthlySizeQuota(pool, {
        tenantId,
        quotaMonth,
        accountSize,
        accountLimit: req.body?.account_limit,
        isUnlimited
      })
    } else {
      await upsertTenantMonthlyQuota(pool, {
        tenantId,
        quotaMonth,
        accountLimit: req.body?.account_limit,
        isUnlimited
      })
    }
    const status = await getTenantMonthlyQuotaStatus(pool, tenantId, quotaMonth, accountSize)
    res.json(status)
  } catch (error) {
    logger.error('Admin account batch save error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not save monthly quota' })
  }
})

router.get('/promotion-reviews', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req) || (req.query?.tenant_id ? parseInt(req.query.tenant_id, 10) : null)
    const status = String(req.query?.status || 'pending').toLowerCase()
    const rows = await listPromotionReviews(pool, {
      tenantId,
      status,
      month: req.query?.month || null
    })
    res.json({
      summary: {
        total: rows.length,
        pending: rows.filter((row) => row.status === 'pending').length,
        approved: rows.filter((row) => row.status === 'approved').length,
        rejected: rows.filter((row) => row.status === 'rejected').length
      },
      rows
    })
  } catch (error) {
    logger.error('Admin promotion reviews fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch promotion reviews' })
  }
})

router.post('/promotion-reviews/:id/approve', authenticateAdmin, requireAdminCapability('account:promotion_review:scoped'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const reviewId = parseInt(req.params.id, 10)
    if (!Number.isFinite(reviewId)) return res.status(400).json({ error: 'Invalid promotion review id' })

    await client.query('BEGIN')
    const review = await getPromotionReviewForUpdate(client, reviewId, tenantId)
    if (!review) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Promotion review not found' })
    }
    const settings = await fetchProgressionSettings(client, review.tenant_id)
    const approved = await approvePromotionReview(client, review, settings, {
      adminId: req.admin?.adminId || null,
      decisionNote: String(req.body?.note || '').trim() || null
    })
    await appendImmutableAudit(client, {
      eventType: 'account_promotion_review_approved',
      entityType: 'promotion_review',
      entityId: String(review.id),
      actor: getAdminActorLabel(req.admin),
      payload: {
        actor: buildAdminActorPayload(req.admin),
        source_account_id: review.source_account_id,
        created_account_id: approved.new_account_id,
        note: req.body?.note || null
      }
    })
    await client.query('COMMIT')

    if (req.app.get('io')) {
      const passMsg = review.from_account_type === 'phase1'
        ? 'Phase 2 account approved and activated.'
        : 'Funded account approved and activated.'
      req.app.get('io').to(String(review.user_id)).emit('account_update', {
        event: approved.event,
        account_id: review.source_account_id,
        new_account_id: approved.new_account_id,
        promotion_review_id: review.id,
        message: passMsg
      })
    }

    res.json({ message: 'Promotion approved and next account created', ...approved })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin promotion review approve error:', { error: error.message })
    if (error.quota) {
      await logQuotaError({ review_id: req.params.id, source: 'promotion_review_approval' }, error)
    }
    res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Could not approve promotion review',
      quota: error.quota || null
    })
  } finally {
    client.release()
  }
})

router.post('/promotion-reviews/:id/reject', authenticateAdmin, requireAdminCapability('account:promotion_review:scoped'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const tenantId = getScopedTenantId(req)
    const reviewId = parseInt(req.params.id, 10)
    const note = requireReasonText(req.body?.note || req.body?.reason, 'rejection note')
    if (!Number.isFinite(reviewId)) return res.status(400).json({ error: 'Invalid promotion review id' })

    await client.query('BEGIN')
    const review = await getPromotionReviewForUpdate(client, reviewId, tenantId)
    if (!review) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Promotion review not found' })
    }
    if (String(review.status || '').toLowerCase() !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Promotion review is not pending' })
    }
    const rejected = await markPromotionReviewRejected(client, review.id, {
      adminId: req.admin?.adminId || null,
      decisionNote: note
    })
    await appendImmutableAudit(client, {
      eventType: 'account_promotion_review_rejected',
      entityType: 'promotion_review',
      entityId: String(review.id),
      actor: getAdminActorLabel(req.admin),
      payload: {
        actor: buildAdminActorPayload(req.admin),
        source_account_id: review.source_account_id,
        note
      }
    })
    await client.query('COMMIT')
    res.json({ message: 'Promotion review rejected', review: rejected })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin promotion review reject error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not reject promotion review' })
  } finally {
    client.release()
  }
})

router.post('/accounts/:accountId/adjust-balance', authenticateAdmin, requireAdminCapability('account:adjust_balance'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const accountId = String(req.params.accountId || '').trim()
    const amount = parseFloat(req.body?.amount)
    const reason = requireReasonText(req.body?.reason)
    const tenantId = getScopedTenantId(req)

    if (!accountId) return res.status(400).json({ error: 'Valid account id is required' })
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'A non-zero amount is required' })
    }

    await client.query('BEGIN')
    const account = await fetchAccountForAdmin(client, accountId, tenantId, { forUpdate: true })
    if (!account) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const beforeSnapshot = normalizeAccountSnapshot(account)
    const updated = await client.query(
      `UPDATE accounts
          SET current_balance = current_balance + $1,
              peak_balance = GREATEST(peak_balance, current_balance + $1),
              updated_at = NOW()
        WHERE id = $2
        RETURNING id, tenant_id, user_id, account_type, current_balance, starting_balance,
                  peak_balance, status, profit_target, max_drawdown_pct, phase_start_date,
                  phase_end_date, account_uid, review_flagged, review_flag_reason`,
      [amount, account.id]
    )

    await client.query(
      `INSERT INTO admin_balance_adjustments
        (account_id, user_id, amount, reason, adjustment_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        String(account.id),
        String(account.user_id),
        amount,
        reason,
        amount > 0 ? 'credit' : 'debit',
        String(req.admin?.role || 'admin')
      ]
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'account_balance_adjusted',
        entityType: 'account',
        entityId: String(account.id),
        actor: getAdminActorLabel(req.admin),
        payload: {
          amount,
          reason,
          actor: buildAdminActorPayload(req.admin),
          tenant_scope: tenantId,
          before_snapshot: beforeSnapshot,
          after_snapshot: normalizeAccountSnapshot(updated.rows[0])
        }
      })
    } catch (_) {}

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(account.user_id)).emit('account_update', {
        message: `Admin balance adjustment applied: ${amount >= 0 ? '+' : ''}$${amount.toFixed(2)}`,
        pnl: amount,
        account_id: account.id,
        event: 'admin_balance_adjustment'
      })
    }

    await emitSuperAdminPowerEvent(req, updated.rows[0].tenant_id || tenantId, {
      entity: 'account',
      entity_id: account.id,
      action: 'adjust_balance'
    })

    res.json({
      message: `Balance adjusted by ${amount >= 0 ? '+' : ''}$${amount.toFixed(2)}`,
      account: updated.rows[0]
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin balance adjustment error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not adjust balance' })
  } finally {
    client.release()
  }
})

router.post('/accounts/:accountId/override', authenticateAdmin, requireAdminCapability('account:override'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const accountId = String(req.params.accountId || '').trim()
    const action = String(req.body?.action || '').trim()
    const reason = requireReasonText(req.body?.reason)
    const extensionDays = parsePositiveInteger(req.body?.days, {
      fallback: action === 'extend_14_days' ? 14 : null,
      min: 1,
      max: 365
    })
    const tenantId = getScopedTenantId(req)

    if (!accountId) return res.status(400).json({ error: 'Valid account id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })

    await client.query('BEGIN')
    const account = await fetchAccountForAdmin(client, accountId, tenantId, { forUpdate: true })
    if (!account) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const beforeSnapshot = normalizeAccountSnapshot(account)
    const normalizedTenantId = account.tenant_id || tenantId || 1
    const tenantSettings = await getTenantSettings(normalizedTenantId, [
      'phase1_day_limit',
      'phase2_day_limit',
      'phase1_profit_target_pct',
      'phase2_profit_target_pct',
      'phase1_max_drawdown_pct',
      'phase2_max_drawdown_pct',
      'funded_max_drawdown_pct'
    ])
    let message = ''
    let promoted = null
    let replacementAccount = null
    let updatedAccount = null
    let closeResult = { closedCount: 0, totalPnl: 0 }
    let cancelledCount = 0
    const copierEvents = []

    if (action === 'pass' || action === 'promote') {
      if (!['phase1', 'phase2'].includes(account.account_type)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only challenge accounts can be promoted' })
      }
      if (account.status === 'passed') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'This account is already marked as passed' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_manual_promotion' })
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Manual Promotion', { copierEvents, source: 'admin_manual_promotion' })

      await client.query(
        `UPDATE accounts
            SET status = 'passed',
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )

      const settings = await fetchProgressionSettings(client, normalizedTenantId)
      promoted = await createPendingPromotionReview(client, account, {
        settings,
        triggeredBy: 'admin_manual_promotion',
        reason,
        requestedByAdminId: req.admin?.adminId || null,
        payload: {
          source: 'admin_account_override',
          closed_open_trades: closeResult.closedCount,
          cancelled_pending_trades: cancelledCount,
          total_pnl: closeResult.totalPnl
        }
      })
      if (!promoted) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'No promotion path exists for this account' })
      }

      message = `Account passed manually. Closed ${closeResult.closedCount} open trades, cancelled ${cancelledCount} pending orders, and queued promotion review #${promoted.id}.`
    } else if (action === 'fail') {
      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_manual_breach' })
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Manual Breach', { copierEvents, source: 'admin_manual_breach' })
      await client.query(
        `UPDATE accounts
            SET status = 'failed',
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )
      message = `Account breached manually. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
    } else if (action === 'extend_14_days' || action === 'extend_days') {
      if (!['phase1', 'phase2'].includes(account.account_type)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only challenge accounts can be extended' })
      }
      if (!extensionDays) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'A valid extension day count is required' })
      }
      await client.query(
        `UPDATE accounts
            SET phase_end_date = (
              CASE
                WHEN phase_end_date IS NULL OR phase_end_date < NOW() THEN NOW()
                ELSE phase_end_date
              END
            ) + ($2 * INTERVAL '1 day'),
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, extensionDays]
      )
      message = `Extended account by ${extensionDays} days.`
    } else if (action === 'revoke_funded') {
      if (account.account_type !== 'funded') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only funded accounts can be revoked' })
      }
      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_revoke_funded' })
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Funding Revoked by Admin', { copierEvents, source: 'admin_revoke_funded' })
      await client.query(
        `UPDATE accounts
            SET status = 'locked',
                review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, reason || 'Funding revoked by admin']
      )
      message = `Funded account revoked. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
    } else if (action === 'force_close_open_trades') {
      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_force_close_open_trades' })
      message = `Force-closed ${closeResult.closedCount} open trades; total P&L ${closeResult.totalPnl >= 0 ? '+' : ''}$${closeResult.totalPnl.toFixed(2)}`
    } else if (action === 'restore_active') {
      if (!['failed', 'locked'].includes(String(account.status || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only failed or locked accounts can be restored to active' })
      }
      await client.query(
        `UPDATE accounts
            SET status = 'active',
                review_flagged = FALSE,
                review_flag_reason = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )
      message = 'Account restored to active status without resetting performance history.'
    } else if (action === 'restore_with_reset') {
      if (!['phase1', 'phase2'].includes(String(account.account_type || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only phase1 and phase2 accounts can be reset and restored' })
      }
      if (!['failed', 'locked', 'expired'].includes(String(account.status || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only failed, locked, or expired accounts can be reset and restored' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_restore_with_reset' })
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Restore With Reset', { copierEvents, source: 'admin_restore_with_reset' })
      const phaseEndDate = computePhaseEndDateForAccountType(account.account_type, tenantSettings)

      await client.query(
        `UPDATE accounts
            SET status = 'active',
                current_balance = starting_balance,
                peak_balance = starting_balance,
                phase_start_date = NOW(),
                phase_end_date = $2,
                review_flagged = FALSE,
                review_flag_reason = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, phaseEndDate]
      )
      message = `Account restored with reset. Closed ${closeResult.closedCount} open trades and cancelled ${cancelledCount} pending orders.`
    } else if (action === 'replace_account') {
      if (['active', 'passed'].includes(String(account.status || '').toLowerCase())) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only closed, breached, expired, or locked accounts can be replaced' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { copierEvents, source: 'admin_replace_account' })
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Replace Account', { copierEvents, source: 'admin_replace_account' })
      replacementAccount = await createAdminIssuedAccount(client, {
        tenantId: normalizedTenantId,
        userId: account.user_id,
        accountType: account.account_type,
        accountSize: account.account_size,
        settings: tenantSettings,
        overrides: {
          profit_target: account.profit_target,
          max_drawdown_pct: account.max_drawdown_pct
        }
      })
      message = `Replacement account created successfully as account #${replacementAccount.id}.`
    } else if (action === 'lock_account') {
      await client.query(
        `UPDATE accounts
            SET status = 'locked',
                review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id, reason]
      )
      message = 'Account locked successfully.'
    } else if (action === 'clear_review_flag') {
      await client.query(
        `UPDATE accounts
            SET review_flagged = FALSE,
                review_flag_reason = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )
      message = 'Review flag cleared.'
    } else {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Unsupported action: ${action}` })
    }

    updatedAccount = await fetchAccountForAdmin(client, account.id, tenantId, { forUpdate: false })

    try {
      await appendImmutableAudit(client, {
        eventType: 'admin_account_override',
        entityType: 'account',
        entityId: String(account.id),
        actor: getAdminActorLabel(req.admin),
        payload: {
          action,
          reason,
          actor: buildAdminActorPayload(req.admin),
          tenant_scope: tenantId,
          before_snapshot: beforeSnapshot,
          after_snapshot: normalizeAccountSnapshot(updatedAccount),
          closed_trades: closeResult.closedCount,
          cancelled_pending: cancelledCount,
          total_pnl: closeResult.totalPnl,
          promoted_to_account_id: promoted?.new_account_id || null,
          replacement_account_id: replacementAccount?.id || null,
          extension_days: extensionDays || null
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    await emitCopierEventsAfterCommit(copierEvents)

    if (req.app.get('io')) {
      req.app.get('io').to(String(account.user_id)).emit('account_update', {
        message,
        pnl: closeResult.totalPnl,
        account_id: account.id,
        new_account_id: replacementAccount?.id || promoted?.new_account_id || null,
        event: action === 'pass' || action === 'promote'
          ? (promoted?.event || 'admin_manual_promotion')
          : `admin_${action}`
      })
    }

    emitAdminEvent('admin_enforcement_event', {
      account_id: account.id,
      user_id: account.user_id,
      action,
      status: 'applied',
      message,
      tenant_id: normalizedTenantId,
      payload_json: {
        closed_trades: closeResult.closedCount,
        cancelled_pending: cancelledCount,
        total_pnl: closeResult.totalPnl,
        replacement_account_id: replacementAccount?.id || null,
        promoted_to_account_id: promoted?.new_account_id || null
      }
    }, normalizedTenantId)

    await emitSuperAdminPowerEvent(req, normalizedTenantId, {
      entity: 'account',
      entity_id: account.id,
      action,
      replacement_account_id: replacementAccount?.id || null,
      promoted_to_account_id: promoted?.new_account_id || null
    })

    res.json({
      message,
      closed_trades: closeResult.closedCount,
      cancelled_pending: cancelledCount,
      total_pnl: closeResult.totalPnl,
      new_account_id: replacementAccount?.id || promoted?.new_account_id || null,
      account: updatedAccount,
      allowed_actions: buildAllowedAccountActions(updatedAccount)
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin account override error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Could not apply admin override' })
  } finally {
    client.release()
  }
})

router.get('/trades', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT t.id,
              t.account_id,
              a.user_id,
              t.instrument AS symbol,
              UPPER(t.direction) AS type,
              t.lot_size AS lots,
              t.open_price,
              t.close_price,
              t.stop_loss AS sl,
              t.take_profit AS tp,
              t.status,
              t.demo_pnl,
              t.commission,
              p.bid,
              p.ask,
              t.open_time,
              t.close_time
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       ORDER BY
         CASE WHEN t.status = 'open' THEN 0 WHEN t.status = 'pending' THEN 1 ELSE 2 END,
         COALESCE(t.close_time, t.open_time) DESC`
    )

    const rows = result.rows.map(row => {
      let pnl = parseFloat(row.demo_pnl || 0)
      if (row.status === 'open') {
        const livePrice = row.type === 'BUY'
          ? parseFloat(row.bid || row.open_price || 0)
          : parseFloat(row.ask || row.open_price || 0)
        pnl = parseFloat((
          calcTradePnl(
            String(row.type || '').toLowerCase(),
            parseFloat(row.open_price || 0),
            livePrice,
            parseFloat(row.lots || 0),
            row.symbol
          ) - parseFloat(row.commission || 0)
        ).toFixed(2))
      }
      return {
        ...row,
        pnl
      }
    })

    res.json(rows)
  } catch (error) {
    logger.error('Admin trades fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trades' })
  }
})


module.exports = router
