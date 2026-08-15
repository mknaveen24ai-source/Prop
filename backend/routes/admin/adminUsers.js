// Admin platform_admins CRUD (super-admin only).
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const { adminAccountActionLimiter } = require('./shared/rateLimiters')
const {
  authenticateAdmin,
  requireSuperAdmin,
  BUILT_IN_ROLES
} = require('../middleware')
const bcrypt = require('bcryptjs')
const logger = require('../../utils/logger')
const {
  ensureTenantSettingsInfrastructure
} = require('../../utils/tenantSettings')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  normalizeAdminEmail, getPlatformAdminByEmail, getPlatformAdminById,
  buildAdminAuditActor, sanitizePlatformAdminRecord, buildAdminSecurityStatus
} = require('./shared/helpers')

router.get('/admin-users', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureTenantSettingsInfrastructure()

    const [platformResult, securityStatus] = await Promise.all([
      pool.query(
        `SELECT id, email, full_name, role, status, token_version, totp_enabled,
                last_login_at, created_at, updated_at
           FROM platform_admins
          ORDER BY created_at ASC`
      ),
      buildAdminSecurityStatus(req.admin)
    ])

    res.json({
      summary: securityStatus,
      platform_admins: platformResult.rows.map(sanitizePlatformAdminRecord).filter(Boolean)
    })
  } catch (err) {
    logger.error('[admin/admin-users] list error:', { error: err.message })
    res.status(500).json({ error: 'Could not load admin access data' })
  }
})

router.post('/admin-users', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const email = normalizeAdminEmail(req.body?.email)
    const password = String(req.body?.password || '')
    const fullName = String(req.body?.full_name || '').trim() || null
    // Default to the least-privileged real role rather than super_admin —
    // this used to be hardcoded to super_admin regardless of input, so
    // every admin account ever created had full platform access.
    const requestedRole = String(req.body?.role || '').trim().toLowerCase() || 'support_agent'
    const role = BUILT_IN_ROLES.includes(requestedRole) ? requestedRole : null

    if (!email) return res.status(400).json({ error: 'Admin email is required' })
    if (!role) return res.status(400).json({ error: `role must be one of: ${BUILT_IN_ROLES.join(', ')}` })
    if (password.length < 10) {
      return res.status(400).json({ error: 'Admin password must be at least 10 characters' })
    }

    const existing = await getPlatformAdminByEmail(email)
    if (existing) {
      return res.status(409).json({ error: 'A platform admin with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const insert = await pool.query(
      `INSERT INTO platform_admins
        (email, full_name, password_hash, role, status, token_version, totp_enabled, created_at, updated_at)
       VALUES (LOWER($1), $2, $3, $4, 'active', 1, FALSE, NOW(), NOW())
       RETURNING id, email, full_name, role, status, token_version, totp_enabled, last_login_at, created_at, updated_at`,
      [email, fullName, passwordHash, role]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_created',
        entityType: 'platform_admin',
        entityId: String(insert.rows[0].id),
        payload: { email, role }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.status(201).json({
      message: 'Platform admin created',
      admin_user: sanitizePlatformAdminRecord(insert.rows[0])
    })
  } catch (err) {
    logger.error('[admin/admin-users] create error:', { error: err.message })
    res.status(500).json({ error: 'Could not create platform admin' })
  }
})

router.patch('/admin-users/:id', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    const nextFullName = Object.prototype.hasOwnProperty.call(req.body || {}, 'full_name')
      ? (String(req.body?.full_name || '').trim() || null)
      : current.full_name
    const nextStatus = Object.prototype.hasOwnProperty.call(req.body || {}, 'status')
      ? String(req.body?.status || '').trim().toLowerCase()
      : current.status
    const nextRole = Object.prototype.hasOwnProperty.call(req.body || {}, 'role')
      ? String(req.body?.role || '').trim().toLowerCase()
      : current.role

    if (!['active', 'disabled'].includes(nextStatus)) {
      return res.status(400).json({ error: 'status must be active or disabled' })
    }
    if (!BUILT_IN_ROLES.includes(nextRole)) {
      return res.status(400).json({ error: `role must be one of: ${BUILT_IN_ROLES.join(', ')}` })
    }

    if (current.status === 'active' && nextStatus !== 'active') {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM platform_admins
          WHERE status = 'active'`
      )
      const activeCount = parseInt(countResult.rows[0]?.count || 0, 10) || 0
      if (activeCount <= 1) {
        return res.status(400).json({ error: 'You must keep at least one active platform admin' })
      }
    }

    // Same floor, extended to role demotion (not just disabling): losing
    // the last active super_admin locks the platform out of super-admin-only
    // routes just as effectively as disabling their account would.
    const losesActiveSuperAdmin = current.role === 'super_admin' && current.status === 'active'
      && (nextStatus !== 'active' || nextRole !== 'super_admin')
    if (losesActiveSuperAdmin) {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM platform_admins
          WHERE status = 'active' AND role = 'super_admin'`
      )
      const activeSuperAdmins = parseInt(countResult.rows[0]?.count || 0, 10) || 0
      if (activeSuperAdmins <= 1) {
        return res.status(400).json({ error: 'You must keep at least one active super_admin' })
      }
    }

    const update = await pool.query(
      `UPDATE platform_admins
          SET full_name = $2,
              status = $3,
              role = $4,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, full_name, role, status, token_version, totp_enabled, last_login_at, created_at, updated_at`,
      [adminId, nextFullName, nextStatus, nextRole]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_updated',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { status: nextStatus, full_name: nextFullName }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({
      message: 'Platform admin updated',
      admin_user: sanitizePlatformAdminRecord(update.rows[0])
    })
  } catch (err) {
    logger.error('[admin/admin-users] update error:', { error: err.message })
    res.status(500).json({ error: 'Could not update platform admin' })
  }
})

router.post('/admin-users/:id/reset-password', authenticateAdmin, adminAccountActionLimiter, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    const password = String(req.body?.password || '')
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })
    if (password.length < 10) {
      return res.status(400).json({ error: 'New password must be at least 10 characters' })
    }

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    const passwordHash = await bcrypt.hash(password, 12)
    await pool.query(
      `UPDATE platform_admins
          SET password_hash = $2,
              token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId, passwordHash]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_password_reset',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { email: current.email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Platform admin password reset successfully' })
  } catch (err) {
    logger.error('[admin/admin-users] reset-password error:', { error: err.message })
    res.status(500).json({ error: 'Could not reset platform admin password' })
  }
})

router.post('/admin-users/:id/revoke-sessions', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    await pool.query(
      `UPDATE platform_admins
          SET token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_sessions_revoked',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { email: current.email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Platform admin sessions revoked' })
  } catch (err) {
    logger.error('[admin/admin-users] revoke-sessions error:', { error: err.message })
    res.status(500).json({ error: 'Could not revoke platform admin sessions' })
  }
})

router.post('/admin-users/:id/disable', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    const adminId = String(req.params.id || '').trim()
    if (!adminId) return res.status(400).json({ error: 'Invalid admin id' })

    const current = await getPlatformAdminById(adminId)
    if (!current) return res.status(404).json({ error: 'Platform admin not found' })

    if (current.status === 'active') {
      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM platform_admins
          WHERE status = 'active'`
      )
      const activeCount = parseInt(countResult.rows[0]?.count || 0, 10) || 0
      if (activeCount <= 1) {
        return res.status(400).json({ error: 'You must keep at least one active platform admin' })
      }
    }

    await pool.query(
      `UPDATE platform_admins
          SET status = 'disabled',
              token_version = token_version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [adminId]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_disabled',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { email: current.email }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    res.json({ message: 'Platform admin disabled' })
  } catch (err) {
    logger.error('[admin/admin-users] disable error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable platform admin' })
  }
})

module.exports = router
