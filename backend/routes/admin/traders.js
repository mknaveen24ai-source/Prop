// Admin trader list, KYC decisions, invites, ban/unban, session revocation.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const { adminModerationLimiter } = require('./shared/rateLimiters')
const {
  authenticateAdmin,
  requireAdminCapability
} = require('../middleware')
const logger = require('../../utils/logger')
const { invalidateAllUserTokens } = require('../../utils/tokenCache')
const {
  enqueueKycApprovedEmail,
  enqueueKycRejectedEmail
} = require('../../utils/emailQueue')
const { sanitizeString, isValidEmail } = require('../../utils/validation')
const { sendEmailMessage, htmlWrap, resolveMailContext } = require('../../mailer')
const { createUserNotification } = require('../../utils/userNotifications')
const { getTenantSettings } = require('../../services/tenantPolicyService')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  getAdminActorLabel, buildAdminActorPayload, appendImmutableAudit
} = require('./shared/audit')
const {
  ADMIN_VALID_ACCOUNT_SIZES, requireReasonText, parseBooleanFilter, wantsAdminListContract,
  parseCsvListParam, parseListPaging,
  normalizeAccountSnapshot, normalizeUserSnapshot, buildAllowedAccountActions, buildAllowedUserActions,
  normalizeEntityId, fetchUserForAdmin,
  emitSuperAdminPowerEvent
} = require('./shared/helpers')
const {
  buildTraderListResult,
  createAdminIssuedAccount
} = require('./shared/listBuilders')

router.get('/traders', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const paging = parseListPaging(req)
    const listResult = await buildTraderListResult({
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

// GET /api/admin/traders/:userId/activity-spark — 30-day cumulative realized
// P&L across all of a trader's accounts, for the isAdminUsers drawer's
// `row.spark` (Modern Gazette handoff spec). Computed on read, no new table.
router.get('/traders/:userId/activity-spark', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    const { userId } = req.params
    const result = await pool.query(
      `SELECT DATE(t.close_time) AS day, COALESCE(SUM(t.demo_pnl), 0) AS pnl
         FROM trades t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.user_id = $1 AND t.status = 'closed' AND t.close_time >= NOW() - INTERVAL '30 days'
        GROUP BY day ORDER BY day ASC`,
      [userId]
    )
    const byDay = new Map(result.rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), parseFloat(r.pnl) || 0]))
    let running = 0
    const spark = []
    for (let i = 29; i >= 0; i -= 1) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10)
      running += byDay.get(d) || 0
      spark.push({ value: parseFloat(running.toFixed(2)) })
    }
    res.json({ spark })
  } catch (error) {
    logger.error('Admin trader activity-spark error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trader activity' })
  }
})

// "Request more" — the prototype's isAdminKyc review actions are Reject /
// Request more / Approve. Reject and Approve already existed for real;
// Request more didn't (no status change makes sense — the trader stays
// pending — so it's a real trader-facing email + an internal note, reusing
// the same admin_entity_notes table AdminEntityDrawer already writes to).
router.post('/kyc/request-info', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    await ensureFeatureTables()
    const userId = normalizeEntityId(req.body?.user_id)
    const message = sanitizeString(String(req.body?.message || ''), 1000)
    if (!userId) return res.status(400).json({ error: 'user_id is required' })
    if (message.length < 5) return res.status(400).json({ error: 'Please describe what additional information is needed' })

    const userResult = await pool.query('SELECT id, email, full_name FROM users WHERE id = $1', [userId])
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found' })
    const user = userResult.rows[0]

    const context = resolveMailContext()
    const result = await sendEmailMessage({
      to: user.email,
      subject: `Action needed on your ${context.firmName} identity verification`,
      html: htmlWrap('More information needed', `
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">Hi ${user.full_name || 'there'},</p>
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">
          Our team reviewed your identity verification submission and needs a bit more before we can approve it:
        </p>
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;background:#132436;padding:14px;border-radius:4px;">${message}</p>
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">
          Sign in and resubmit your documents from the Identity Verification page whenever you're ready.
        </p>
      `),
      text: `Hi ${user.full_name || 'there'}, our team needs more information on your identity verification: ${message}`
    })
    if (!result.ok) return res.status(502).json({ error: 'Could not send the request email' })

    await pool.query(
      `INSERT INTO admin_entity_notes (entity_type, entity_id, note_text, created_by, created_at)
       VALUES ('user', $1, $2, $3, NOW())`,
      [String(userId), `Requested more KYC info: ${message}`, getAdminActorLabel(req.admin)]
    )

    res.json({ message: 'Request sent' })
  } catch (error) {
    logger.error('KYC request-info error:', { error: error.message })
    res.status(500).json({ error: 'Could not send request' })
  }
})

router.post('/kyc/approve', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET kyc_status = 'approved'
       WHERE id = $1
       RETURNING id, email, full_name`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_approved',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    // Send automated email to the user
    await enqueueKycApprovedEmail(result.rows[0].email, result.rows[0].full_name, {
      userId: result.rows[0].id
    })

    const io = req.app.get('io')
    if (io) {
      io.to(String(user_id)).emit('kyc_status_changed', { status: 'approved' })
      await createUserNotification(io, user_id, {
        type: 'success',
        title: 'Identity Verified',
        message: 'Your identity verification was approved. You can now request payouts.'
      })
    }

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
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET kyc_status = 'rejected'
       ${ reason ? `, kyc_rejection_reason = $2` : '' }
       WHERE id = $1
       RETURNING id, email, full_name`,
      reason ? [user_id, String(reason).slice(0, 500)] : [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_rejected',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email, reason: reason || '' }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    // Send automated email to the user
    await enqueueKycRejectedEmail(result.rows[0].email, result.rows[0].full_name, reason, {
      userId: result.rows[0].id
    })

    const io = req.app.get('io')
    if (io) {
      io.to(String(user_id)).emit('kyc_status_changed', { status: 'rejected', reason: reason || '' })
      await createUserNotification(io, user_id, {
        type: 'error',
        title: 'Identity Verification Rejected',
        message: reason ? `Your identity verification was rejected: ${reason}` : 'Your identity verification was rejected.'
      })
    }

    res.json({ message: 'KYC rejected' })
  } catch (error) {
    logger.error('KYC reject error:', { error: error.message })
    res.status(500).json({ error: 'Could not reject KYC' })
  }
})

// Trader invites — the prototype's isAdminUsers block has a "+ Invite"
// button with no real backend capability behind it anywhere in this app
// (registration is already open/public, so an "invite" is a nudge email +
// an audit trail, not an access-gated flow). Built for real rather than
// left as a dead button: sends a real email, tracked in a lightweight table.
let traderInvitesTablePromise = null
async function ensureTraderInvitesTable() {
  if (traderInvitesTablePromise) return traderInvitesTablePromise
  traderInvitesTablePromise = pool.query(`
    CREATE TABLE IF NOT EXISTS admin_trader_invites (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      invited_by TEXT NOT NULL,
      invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch((err) => { traderInvitesTablePromise = null; throw err })
  return traderInvitesTablePromise
}

router.post('/traders/invite', authenticateAdmin, requireAdminCapability('trader:write:scoped'), async function(req, res) {
  try {
    await ensureTraderInvitesTable()
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!isValidEmail(email)) return res.status(400).json({ error: 'A valid email address is required' })

    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = $1', [email])
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'This email already has an account' })
    }

    const context = resolveMailContext()
    const signupUrl = `${context.baseUrl}/register`
    const result = await sendEmailMessage({
      to: email,
      subject: `You're invited to trade with ${context.firmName}`,
      html: htmlWrap('You have been invited', `
        <p style="color:#e8e0d0;font-size:14px;line-height:1.6;">
          An admin at ${context.firmName} invited you to start a funded trading challenge.
        </p>
        <p style="margin:24px 0;">
          <a href="${signupUrl}" style="background:#c9a84c;color:#0d1b2a;padding:12px 24px;border-radius:4px;text-decoration:none;font-weight:700;">Create your account</a>
        </p>
      `),
      text: `You've been invited to trade with ${context.firmName}. Create your account: ${signupUrl}`
    })
    if (!result.ok) return res.status(502).json({ error: 'Could not send the invite email' })

    await pool.query(
      `INSERT INTO admin_trader_invites (email, invited_by) VALUES ($1, $2)`,
      [email, getAdminActorLabel(req.admin)]
    )

    res.json({ message: 'Invite sent', email })
  } catch (error) {
    logger.error('Trader invite error:', { error: error.message })
    res.status(500).json({ error: 'Could not send invite' })
  }
})

router.post('/ban', authenticateAdmin, adminModerationLimiter, requireAdminCapability('trader:moderate:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = true
       WHERE id = $1
       RETURNING id, email`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_banned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Trader banned successfully' })
  } catch (error) {
    logger.error('Ban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not ban trader' })
  }
})

router.post('/unban', authenticateAdmin, adminModerationLimiter, requireAdminCapability('trader:moderate:scoped'), async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = normalizeEntityId(req.body.user_id)
    if (!user_id) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users
       SET is_banned = false
       WHERE id = $1
       RETURNING id, email`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_unbanned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

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
    const reason = requireReasonText(req.body?.reason)

    if (!userId) {
      return res.status(400).json({ error: 'Valid user id is required' })
    }

    await client.query('BEGIN')
    const user = await fetchUserForAdmin(client, userId, { forUpdate: true })
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
    }

    const beforeSnapshot = normalizeUserSnapshot(user)
    const result = await client.query(
      `UPDATE users
          SET token_version = COALESCE(token_version, 1) + 1
        WHERE id = $1
        RETURNING id, email, full_name, kyc_status, is_banned, token_version`,
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

    await emitSuperAdminPowerEvent(req, {
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
    const reason = requireReasonText(req.body?.reason)
    const accountType = String(req.body?.account_type || 'phase1').trim().toLowerCase()
    const accountSize = parseInt(req.body?.account_size, 10)

    if (!userId) {
      return res.status(400).json({ error: 'Valid user id is required' })
    }
    if (!['phase1', 'phase2', 'phase3', 'funded'].includes(accountType)) {
      return res.status(400).json({ error: 'account_type must be phase1, phase2, phase3, or funded' })
    }
    if (!Number.isFinite(accountSize) || !ADMIN_VALID_ACCOUNT_SIZES.includes(accountSize)) {
      return res.status(400).json({ error: `account_size must be one of: ${ADMIN_VALID_ACCOUNT_SIZES.join(', ')}` })
    }

    await client.query('BEGIN')
    const user = await fetchUserForAdmin(client, userId, { forUpdate: true })
    if (!user) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'User not found' })
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

    const account = await createAdminIssuedAccount(client, {
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

    await emitSuperAdminPowerEvent(req, {
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

module.exports = router
