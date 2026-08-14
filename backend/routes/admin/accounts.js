// Admin account list, balance adjustment and status overrides.
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
const { emitAdminEvent } = require('../../utils/realtime')
const { fetchProgressionSettings, promotePassedAccount } = require('../../services/progressionService')
const { getTenantSettings } = require('../../services/tenantPolicyService')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  getAdminActorLabel, buildAdminActorPayload, appendImmutableAudit
} = require('./shared/audit')
const {
  requireReasonText,
  parsePositiveInteger, parseBooleanFilter, wantsAdminListContract,
  parseCsvListParam, parseListPaging, computePhaseEndDateForAccountType,
  normalizeAccountSnapshot, buildAllowedAccountActions, fetchAccountForAdmin,
  emitSuperAdminPowerEvent
} = require('./shared/helpers')
const {
  buildAccountListResult,
  createAdminIssuedAccount
} = require('./shared/listBuilders')
const {
  forceCloseOpenTradesForAccount, cancelPendingTradesForAccount
} = require('./shared/tradeOps')

router.get('/accounts', authenticateAdmin, requireAdminCapability('account:read:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const paging = parseListPaging(req)
    const listResult = await buildAccountListResult({
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

router.post('/accounts/:accountId/adjust-balance', authenticateAdmin, requireAdminCapability('account:adjust_balance'), async function(req, res) {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const accountId = String(req.params.accountId || '').trim()
    const amount = parseFloat(req.body?.amount)
    const reason = requireReasonText(req.body?.reason)

    if (!accountId) return res.status(400).json({ error: 'Valid account id is required' })
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ error: 'A non-zero amount is required' })
    }

    await client.query('BEGIN')
    const account = await fetchAccountForAdmin(client, accountId, { forUpdate: true })
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
        RETURNING id, user_id, account_type, current_balance, starting_balance,
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
          before_snapshot: beforeSnapshot,
          after_snapshot: normalizeAccountSnapshot(updated.rows[0])
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(account.user_id)).emit('account_update', {
        message: `Admin balance adjustment applied: ${amount >= 0 ? '+' : ''}$${amount.toFixed(2)}`,
        pnl: amount,
        account_id: account.id,
        event: 'admin_balance_adjustment'
      })
    }

    await emitSuperAdminPowerEvent(req, {
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

    if (!accountId) return res.status(400).json({ error: 'Valid account id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })

    await client.query('BEGIN')
    const account = await fetchAccountForAdmin(client, accountId, { forUpdate: true })
    if (!account) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

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
    let message = ''
    let promoted = null
    let replacementAccount = null
    let updatedAccount = null
    let closeResult = { closedCount: 0, totalPnl: 0 }
    let cancelledCount = 0

    if (action === 'pass' || action === 'promote') {
      if (!['phase1', 'phase2'].includes(account.account_type)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Only challenge accounts can be promoted' })
      }
      if (account.status === 'passed') {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'This account is already marked as passed' })
      }

      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Manual Promotion')

      await client.query(
        `UPDATE accounts
            SET status = 'passed',
                updated_at = NOW()
          WHERE id = $1`,
        [account.id]
      )

      const settings = await fetchProgressionSettings(client)
      promoted = await promotePassedAccount(client, account, settings)
      if (!promoted) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'No promotion path exists for this account' })
      }

      message = `Account passed manually. Closed ${closeResult.closedCount} open trades, cancelled ${cancelledCount} pending orders, and created the next account.`
    } else if (action === 'fail') {
      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Manual Breach')
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
      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Funding Revoked by Admin')
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
      closeResult = await forceCloseOpenTradesForAccount(client, account.id, { source: 'admin_enforcement_force_close_open_trades' })
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

      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Restore With Reset')
      const phaseEndDate = computePhaseEndDateForAccountType(account.account_type, platformSettings)

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

      closeResult = await forceCloseOpenTradesForAccount(client, account.id)
      cancelledCount = await cancelPendingTradesForAccount(client, account.id, 'Admin Replace Account')
      replacementAccount = await createAdminIssuedAccount(client, {
        userId: account.user_id,
        accountType: account.account_type,
        accountSize: account.account_size,
        settings: platformSettings,
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

    updatedAccount = await fetchAccountForAdmin(client, account.id, { forUpdate: false })

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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')

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
      payload_json: {
        closed_trades: closeResult.closedCount,
        cancelled_pending: cancelledCount,
        total_pnl: closeResult.totalPnl,
        replacement_account_id: replacementAccount?.id || null,
        promoted_to_account_id: promoted?.new_account_id || null
      }
    })

    await emitSuperAdminPowerEvent(req, {
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

module.exports = router
