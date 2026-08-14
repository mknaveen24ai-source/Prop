// Admin command-centre bulk actions and the suspicious-account sweep.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireAdminCapability,
  requireSuperAdmin
} = require('../middleware')
const Decimal = require('decimal.js')
const logger = require('../../utils/logger')
const { invalidateAllUserTokens } = require('../../utils/tokenCache')
const { emitAdminEvent } = require('../../utils/realtime')
const { ensureViolationTables } = require('../../services/violationEngine')
const { getTenantSettings } = require('../../services/tenantPolicyService')
const { ensureDisputesInfrastructure } = require('../disputes')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  getAdminActorLabel, buildAdminActorPayload, appendImmutableAudit
} = require('./shared/audit')
const {
  ADMIN_VALID_ACCOUNT_SIZES, requireReasonText, createHttpError,
  parsePositiveInteger, computePhaseEndDateForAccountType,
  normalizeAccountSnapshot, normalizeUserSnapshot, normalizePayoutSnapshot,
  normalizeViolationSnapshot, fetchAccountForAdmin, fetchUserForAdmin, fetchPayoutForAdmin,
  emitSuperAdminPowerEvent
} = require('./shared/helpers')
const {
  createAdminIssuedAccount
} = require('./shared/listBuilders')
const {
  forceCloseOpenTradesForAccount, cancelPendingTradesForAccount
} = require('./shared/tradeOps')

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

router.post('/command-center/bulk-action', authenticateAdmin, requireAdminCapability('command_center:bulk'), async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    await ensureViolationTables()
    await ensureDisputesInfrastructure()

    const entity = String(req.body?.entity || '').trim().toLowerCase()
    const action = String(req.body?.action || '').trim().toLowerCase()
    const reason = requireReasonText(req.body?.reason)
    const options = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {}
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map((value) => String(value || '').trim()).filter(Boolean))]
      : []

    if (!['account', 'user', 'payout', 'violation'].includes(entity)) {
      return res.status(400).json({ error: 'entity must be account, user, payout, or violation' })
    }
    if (!action) {
      return res.status(400).json({ error: 'action is required' })
    }
    if (ids.length === 0 || ids.length > 100) {
      return res.status(400).json({ error: 'ids must contain between 1 and 100 items' })
    }

    const results = []

    for (const rawId of ids) {
      let postCommitInvalidateUserId = null

      try {
        await client.query('BEGIN')

        if (entity === 'account') {
          const account = await fetchAccountForAdmin(client, rawId, { forUpdate: true })
          if (!account) throw createHttpError('Account not found', 404)

          const beforeSnapshot = normalizeAccountSnapshot(account)
          const platformSettings = await getTenantSettings([
            'phase1_day_limit',
            'phase2_day_limit',
            'phase1_profit_target_pct',
            'phase2_profit_target_pct',
            'phase1_max_drawdown_pct',
            'phase2_max_drawdown_pct',
            'funded_max_drawdown_pct'
          ])
          let closeResult = { closedCount: 0, totalPnl: 0 }
          let cancelledCount = 0
          let linkedAccountId = null
          let message = ''

          if (action === 'restore_active') {
            if (!['failed', 'locked'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only failed or locked accounts can be restored to active', 400)
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
            message = 'Account restored to active'
          } else if (action === 'restore_with_reset') {
            if (!['phase1', 'phase2'].includes(String(account.account_type || '').toLowerCase())) {
              throw createHttpError('Only phase1 and phase2 accounts can be reset and restored', 400)
            }
            if (!['failed', 'locked', 'expired'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only failed, locked, or expired accounts can be reset and restored', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Bulk Restore With Reset')
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
              [account.id, computePhaseEndDateForAccountType(account.account_type, platformSettings)]
            )
            message = 'Account restored with reset'
          } else if (action === 'replace_account') {
            if (['active', 'passed'].includes(String(account.status || '').toLowerCase())) {
              throw createHttpError('Only non-active accounts can be replaced', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Bulk Replace Account')
            const replacement = await createAdminIssuedAccount(client, {
              userId: account.user_id,
              accountType: account.account_type,
              accountSize: account.account_size,
              settings: platformSettings,
              overrides: {
                profit_target: account.profit_target,
                max_drawdown_pct: account.max_drawdown_pct
              }
            })
            linkedAccountId = replacement.id
            message = `Replacement account created (#${replacement.id})`
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
            message = 'Account locked'
          } else if (action === 'clear_review_flag') {
            await client.query(
              `UPDATE accounts
                  SET review_flagged = FALSE,
                      review_flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1`,
              [account.id]
            )
            message = 'Review flag cleared'
          } else if (action === 'extend_days') {
            const extensionDays = parsePositiveInteger(options?.days, { fallback: null, min: 1, max: 365 })
            if (!extensionDays) throw createHttpError('options.days must be provided for extend_days', 400)
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
            message = `Extended account by ${extensionDays} days`
          } else if (action === 'force_close_open_trades') {
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            message = `Force-closed ${closeResult.closedCount} open trades`
          } else if (action === 'revoke_funded') {
            if (account.account_type !== 'funded') {
              throw createHttpError('Only funded accounts can be revoked', 400)
            }
            closeResult = await forceCloseOpenTradesForAccount(client, account.id)
            cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Funding Revoked by Admin (Bulk)')
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
          } else {
            throw createHttpError(`Unsupported bulk account action: ${action}`, 400)
          }

          const afterAccount = await fetchAccountForAdmin(client, rawId)
          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'account',
            entityId: String(rawId),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeAccountSnapshot(afterAccount),
              closed_trades: closeResult.closedCount,
              cancelled_pending: cancelledCount,
              total_pnl: closeResult.totalPnl,
              linked_account_id: linkedAccountId
            }
          })

          await client.query('COMMIT')
          emitAdminEvent('admin_enforcement_event', {
            account_id: account.id,
            user_id: account.user_id,
            action,
            status: 'applied',
            message
          })
          await emitSuperAdminPowerEvent(req, {
            entity,
            entity_id: account.id,
            action,
            linked_account_id: linkedAccountId
          })

          results.push({
            id: rawId,
            success: true,
            message,
            new_account_id: linkedAccountId || null
          })
        } else if (entity === 'user') {
          const user = await fetchUserForAdmin(client, rawId, { forUpdate: true })
          if (!user) throw createHttpError('User not found', 404)

          const beforeSnapshot = normalizeUserSnapshot(user)
          let message = ''
          let createdAccount = null
          let updatedUser = user

          if (action === 'ban') {
            const result = await client.query(
              `UPDATE users SET is_banned = TRUE WHERE id = $1
               RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'Trader banned'
          } else if (action === 'unban') {
            const result = await client.query(
              `UPDATE users SET is_banned = FALSE WHERE id = $1
               RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'Trader unbanned'
          } else if (action === 'revoke_sessions') {
            const result = await client.query(
              `UPDATE users
                  SET token_version = COALESCE(token_version, 1) + 1
                WHERE id = $1
                RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            postCommitInvalidateUserId = user.id
            message = 'Trader sessions revoked'
          } else if (action === 'approve_kyc') {
            const result = await client.query(
              `UPDATE users
                  SET kyc_status = 'approved',
                      kyc_rejection_reason = NULL
                WHERE id = $1
                RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id]
            )
            updatedUser = result.rows[0]
            message = 'KYC approved'
          } else if (action === 'reject_kyc') {
            const result = await client.query(
              `UPDATE users
                  SET kyc_status = 'rejected',
                      kyc_rejection_reason = $2
                WHERE id = $1
                RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
              [user.id, reason]
            )
            updatedUser = result.rows[0]
            message = 'KYC rejected'
          } else if (action === 'manual_account') {
            const accountType = String(options?.account_type || 'phase1').trim().toLowerCase()
            const accountSize = parseInt(options?.account_size, 10)
            if (!['phase1', 'phase2', 'phase3', 'funded'].includes(accountType)) {
              throw createHttpError('options.account_type must be phase1, phase2, phase3, or funded', 400)
            }
            if (!Number.isFinite(accountSize) || !ADMIN_VALID_ACCOUNT_SIZES.includes(accountSize)) {
              throw createHttpError(`options.account_size must be one of: ${ADMIN_VALID_ACCOUNT_SIZES.join(', ')}`, 400)
            }
            const settings = await getTenantSettings([
              'phase1_day_limit',
              'phase2_day_limit',
              'phase1_profit_target_pct',
              'phase2_profit_target_pct',
              'phase1_max_drawdown_pct',
              'phase2_max_drawdown_pct',
              'funded_max_drawdown_pct'
            ])
            createdAccount = await createAdminIssuedAccount(client, {
              userId: user.id,
              accountType,
              accountSize,
              settings
            })
            message = `Manual ${accountType} account issued`
          } else {
            throw createHttpError(`Unsupported bulk user action: ${action}`, 400)
          }

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'user',
            entityId: String(user.id),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeUserSnapshot(updatedUser),
              linked_account_id: createdAccount?.id || null
            }
          })

          await client.query('COMMIT')

          if (postCommitInvalidateUserId) {
            await invalidateAllUserTokens(postCommitInvalidateUserId)
          }
          await emitSuperAdminPowerEvent(req, {
            entity,
            entity_id: user.id,
            action,
            linked_account_id: createdAccount?.id || null
          })

          results.push({
            id: rawId,
            success: true,
            message,
            new_account_id: createdAccount?.id || null
          })
        } else if (entity === 'payout') {
          const payout = await fetchPayoutForAdmin(client, rawId, { forUpdate: true })
          if (!payout) throw createHttpError('Payout not found', 404)

          const beforeSnapshot = normalizePayoutSnapshot(payout)
          let updatedPayout = payout
          let message = ''

          if (action === 'flag_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET is_flagged = TRUE,
                      flag_reason = $2,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, reason]
            )
            updatedPayout = result.rows[0]
            message = 'Payout flagged'
          } else if (action === 'unflag_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET is_flagged = FALSE,
                      flag_reason = NULL,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id]
            )
            updatedPayout = result.rows[0]
            message = 'Payout unflagged'
          } else if (action === 'approve_payout') {
            if (String(payout.status || '').toLowerCase() !== 'pending') {
              throw createHttpError('Only pending payouts can be approved', 400)
            }
            const accountBalance = await client.query(
              `SELECT current_balance, starting_balance FROM accounts WHERE id = $1 FOR UPDATE`,
              [payout.account_id]
            )
            if (accountBalance.rows.length === 0) throw createHttpError('Account not found for payout', 404)
            const availableProfit = new Decimal(accountBalance.rows[0].current_balance).minus(accountBalance.rows[0].starting_balance)
            if (availableProfit.lt(payout.amount_requested)) {
              throw createHttpError('Insufficient realized profit for payout', 400)
            }
            await client.query(
              `UPDATE accounts SET current_balance = current_balance - $1 WHERE id = $2`,
              [payout.amount_requested, payout.account_id]
            )
            const result = await client.query(
              `UPDATE payouts
                  SET status = 'paid',
                      paid_at = NOW(),
                      transaction_id = COALESCE($2, transaction_id),
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, options?.transaction_id ? String(options.transaction_id) : null]
            )
            updatedPayout = result.rows[0]
            message = 'Payout approved'
          } else if (action === 'reject_payout') {
            const result = await client.query(
              `UPDATE payouts
                  SET status = 'rejected',
                      admin_notes = $2,
                      updated_at = NOW()
                WHERE id = $1
                RETURNING id, user_id, account_id, amount_requested, amount_payable,
                          status, is_flagged, flag_reason, admin_notes`,
              [payout.id, reason]
            )
            updatedPayout = result.rows[0]
            message = 'Payout rejected'
          } else {
            throw createHttpError(`Unsupported bulk payout action: ${action}`, 400)
          }

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'payout',
            entityId: String(payout.id),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizePayoutSnapshot(updatedPayout)
            }
          })

          await client.query('COMMIT')
          await emitSuperAdminPowerEvent(req, {
            entity,
            entity_id: payout.id,
            action
          })

          results.push({
            id: rawId,
            success: true,
            message
          })
        } else if (entity === 'violation') {
          const violationId = parseInt(rawId, 10)
          if (!Number.isFinite(violationId) || violationId <= 0) {
            throw createHttpError('Invalid violation id', 400)
          }

          const violationResult = await client.query(
            `SELECT *
               FROM admin_rule_violations
              WHERE id = $1
              FOR UPDATE`,
            [violationId]
          )
          if (violationResult.rows.length === 0) throw createHttpError('Violation not found', 404)

          const violation = violationResult.rows[0]
          const beforeSnapshot = normalizeViolationSnapshot(violation)
          const resolutionType = action === 'waive_violation'
            ? 'waived'
            : action === 'false_positive'
              ? 'false_positive'
              : action === 'resolve_violation'
                ? 'resolved'
                : null

          if (!resolutionType) {
            throw createHttpError(`Unsupported bulk violation action: ${action}`, 400)
          }

          const updateResult = await client.query(
            `UPDATE admin_rule_violations
                SET status = 'resolved',
                    resolved_at = NOW(),
                    resolution_note = $2,
                    resolution_type = $3,
                    payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
                      'resolution_type', $3,
                      'resolved_by_role', $4
                    )
              WHERE id = $1
              RETURNING *`,
            [violationId, reason, resolutionType, req.admin?.role || 'admin']
          )
          const updatedViolation = updateResult.rows[0]

          await appendImmutableAudit(client, {
            eventType: 'admin_bulk_action',
            entityType: 'violation',
            entityId: String(violationId),
            actor: getAdminActorLabel(req.admin),
            payload: {
              entity,
              action,
              reason,
              actor: buildAdminActorPayload(req.admin),
              before_snapshot: beforeSnapshot,
              after_snapshot: normalizeViolationSnapshot(updatedViolation)
            }
          })

          await client.query('COMMIT')
          emitAdminEvent('admin_violation_updated', updatedViolation)

          results.push({
            id: rawId,
            success: true,
            message: `Violation marked ${resolutionType.replace(/_/g, ' ')}`
          })
        }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        results.push({
          id: rawId,
          success: false,
          error: error.statusCode ? error.message : 'Bulk action failed'
        })
      }
    }

    res.json({
      entity,
      action,
      total: ids.length,
      succeeded: results.filter((row) => row.success).length,
      failed: results.filter((row) => !row.success).length,
      results
    })
  } catch (error) {
    logger.error('Command center bulk action error:', { error: error.message })
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to run bulk action' })
  } finally {
    client.release()
  }
})

router.get('/suspicious-accounts', authenticateAdmin, requireSuperAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real DB query — returns genuinely flagged/banned accounts
    const result = await pool.query(`
      SELECT
        a.id, a.user_id, a.account_type, a.account_size, a.status,
        a.review_flagged, a.review_flag_reason, a.created_at,
        u.email, u.full_name, u.is_banned
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE (a.review_flagged = true OR u.is_banned = true)
      ORDER BY a.created_at DESC
      LIMIT 500
    `);
    res.json({
      total_flags: result.rows.filter(r => r.review_flagged).length,
      flagged: result.rows
    });
  } catch (err) {
    logger.error('Suspicious accounts error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load suspicious accounts' });
  }
});

module.exports = router
