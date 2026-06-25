'use strict'
/**
 * Admin Auth Sub-Router
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles: /login, /logout, /2fa/*, /session, /security/status,
 *          /admin-users (CRUD), /admin-users/:id/reset-password
 *
 * Extracted from routes/admin.js (lines 2077-3233)
 * All shared helpers imported from the monolith via _internals bridge.
 */
const express = require('express')
const router = express.Router()
const pool = require('../../db')
const rateLimit = require('express-rate-limit')
const bcrypt = require('bcryptjs')
const { v4: uuidv4 } = require('uuid')
const logger = require('../../utils/logger')
const totp = require('../../utils/totp')
const qrcode = require('qrcode')
const { invalidateAllUserTokens } = require('../../utils/tokenCache')
const { sanitizeString } = require('../../utils/validation')
const { DEFAULT_TENANT_SLUG } = require('../../utils/tenants')
const { ensureTenantSettingsInfrastructure } = require('../../utils/tenantSettings')
const {
  authenticateAdmin,
  authenticateAdminPre2FA,
  buildAdminSessionPayload,
  requireAdminCapability,
  requireSuperAdmin,
  requireTenantAdminOrSuperAdmin
} = require('../middleware')

// Import shared helpers from admin.js monolith bridge
const adminMonolith = require('../admin')
const {
  signAdminToken, setAdminCookie, isBcryptHash, looksLikeDefaultSecret,
  normalizeAdminEmail, getActivePlatformAdminCount, getPlatformAdminByEmail,
  getPlatformAdminById, buildAdminJwtPayload, ensureFeatureTables,
} = adminMonolith._internals

// Auth-specific limiters
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  message: { error: 'Too many admin login attempts. Please wait 15 minutes before trying again.' },
  standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true
})
const adminTwoFaValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many 2FA attempts. Wait 15 minutes.' },
  standardHeaders: true, legacyHeaders: false
})

// ── Routes (extracted verbatim from admin.js lines 2077-3233) ─────────────────
router.post('/login', adminLoginLimiter, async function(req, res) {
  try {
    if (req.tenant?.id && req.tenant?.slug !== DEFAULT_TENANT_SLUG && String(req.tenant.status || '').toLowerCase() !== 'active') {
      return res.status(403).json({ error: 'This tenant portal is currently unavailable' })
    }
    await ensureFeatureTables()

    const { email, password } = req.body
    const normalizedEmail = normalizeAdminEmail(email)
    const tenantId = req.tenant?.id && req.tenant?.slug !== DEFAULT_TENANT_SLUG
      ? req.tenant.id
      : null
    if (normalizedEmail && tenantId) {
      await ensureTenantSettingsInfrastructure()
      const tenantAdminResult = await pool.query(
        `SELECT id, tenant_id, email, full_name, password_hash, role, status, token_version,
                totp_enabled, totp_secret, totp_temp_secret, totp_backup_codes
           FROM tenant_admins
          WHERE tenant_id = $1
            AND LOWER(email) = LOWER($2)
          LIMIT 1`,
        [tenantId, normalizedEmail]
      )

      if (tenantAdminResult.rows.length > 0) {
        const tenantAdmin = tenantAdminResult.rows[0]
        if (tenantAdmin.status !== 'active') {
          return res.status(403).json({ error: 'Tenant admin account is inactive' })
        }

        const tenantPasswordOk = await bcrypt.compare(String(password || ''), tenantAdmin.password_hash)
        if (!tenantPasswordOk) {
          return res.status(401).json({ error: 'Invalid tenant admin credentials' })
        }

        if (tenantAdmin.totp_enabled && tenantAdmin.totp_secret) {
          const pre2faToken = signAdminToken(
            {
              id: tenantAdmin.id,
              tenant_id: tenantAdmin.tenant_id,
              token_version: tenantAdmin.token_version || 1,
              email: tenantAdmin.email,
              full_name: tenantAdmin.full_name,
              role: tenantAdmin.role || 'tenant_admin',
              auth_source: 'tenant_admin'
            },
            { type: 'pre_2fa_admin' },
            '5m'
          )
          return res.json({ requires2FA: true, pre2faToken, role: tenantAdmin.role || 'tenant_admin' })
        }

        const token = signAdminToken({
          id: tenantAdmin.id,
          tenant_id: tenantAdmin.tenant_id,
          token_version: tenantAdmin.token_version || 1,
          email: tenantAdmin.email,
          full_name: tenantAdmin.full_name,
          role: tenantAdmin.role || 'tenant_admin',
          auth_source: 'tenant_admin'
        })

        await pool.query(
          `UPDATE tenant_admins
              SET last_login_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1`,
          [tenantAdmin.id]
        )

        setAdminCookie(res, token)

        return res.json({
          message: 'Tenant admin login successful',
          token,
          admin: {
            id: tenantAdmin.id,
            email: tenantAdmin.email,
            full_name: tenantAdmin.full_name,
            role: tenantAdmin.role || 'tenant_admin',
            tenant_id: tenantAdmin.tenant_id,
            auth_source: 'tenant_admin',
            totp_enabled: !!tenantAdmin.totp_enabled
          }
        })
      }
    }

    const activePlatformAdminCount = await getActivePlatformAdminCount()
    const platformAdmin = normalizedEmail ? await getPlatformAdminByEmail(normalizedEmail) : null

    if (platformAdmin) {
      if (platformAdmin.status !== 'active') {
        return res.status(403).json({ error: 'Platform admin account is inactive' })
      }

      const passwordOk = await bcrypt.compare(String(password || ''), platformAdmin.password_hash)
      if (!passwordOk) {
        return res.status(401).json({ error: 'Invalid admin credentials' })
      }

      if (platformAdmin.totp_enabled && platformAdmin.totp_secret) {
        const pre2faToken = signAdminToken(
          {
            id: platformAdmin.id,
            token_version: platformAdmin.token_version || 1,
            email: platformAdmin.email,
            full_name: platformAdmin.full_name,
            role: platformAdmin.role || 'super_admin',
            auth_source: 'platform_admin'
          },
          { type: 'pre_2fa_admin' },
          '5m'
        )
        return res.json({ requires2FA: true, pre2faToken, role: platformAdmin.role || 'super_admin' })
      }

      const token = signAdminToken({
        id: platformAdmin.id,
        token_version: platformAdmin.token_version || 1,
        email: platformAdmin.email,
        full_name: platformAdmin.full_name,
        role: platformAdmin.role || 'super_admin',
        auth_source: 'platform_admin'
      })

      await pool.query(
        `UPDATE platform_admins
            SET last_login_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [platformAdmin.id]
      )

      setAdminCookie(res, token)

      return res.json({
        message: 'Admin login successful',
        token,
        admin: {
          id: platformAdmin.id,
          email: platformAdmin.email,
          full_name: platformAdmin.full_name,
          role: platformAdmin.role || 'super_admin',
          auth_source: 'platform_admin',
          totp_enabled: !!platformAdmin.totp_enabled
        }
      })
    }

    if (activePlatformAdminCount > 0) {
      if (!normalizedEmail) {
        return res.status(400).json({ error: 'Admin email is required' })
      }
      return res.status(401).json({ error: 'Invalid admin credentials' })
    }

    const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production'
    if (isProduction) {
      return res.status(500).json({
        error: 'Production admin login requires at least one active DB-backed platform admin.'
      })
    }

    const adminPassword = process.env.ADMIN_PASSWORD

    if (!adminPassword) {
      return res.status(500).json({ error: 'Bootstrap admin password not configured' })
    }

    const envPasswordIsHash = isBcryptHash(adminPassword)
    const isValidPassword = envPasswordIsHash
      ? await bcrypt.compare(String(password || ''), adminPassword)
      : String(password || '') === String(adminPassword)

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid admin password' })
    }

    const adminTokenVersion = await getLegacyAdminTokenVersion()

    const token = signAdminToken({
      token_version: adminTokenVersion,
      email: normalizedEmail || process.env.ADMIN_EMAIL || null,
      full_name: 'Platform Owner',
      role: 'super_admin',
      auth_source: 'env_fallback'
    })

    setAdminCookie(res, token)

    return res.json({
      message: 'Admin login successful',
      token,
      admin: {
        role: 'super_admin',
        email: normalizedEmail || process.env.ADMIN_EMAIL || null,
        full_name: 'Platform Owner',
        auth_source: 'env_fallback',
        requires_platform_admin_bootstrap: true,
        totp_enabled: false
      }
    })

  } catch (error) {
    logger.error('[admin/login] error:', { error: error.message })
    res.status(500).json({ error: 'Admin login error' })
  }
})


router.post('/logout', function(req, res) {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict', // FIX AUDIT: match set cookie flags
    path: '/'
  })
  res.json({ message: 'Admin logout successful' })
})

// ─────────────────────────────────────────────────────────────────────────────
// Admin 2FA routes
// ─────────────────────────────────────────────────────────────────────────────

async function getAuthenticatedAdminRecord(admin) {
  if (!admin) return null
  if (String(admin.auth_source || '') === 'env_fallback' || !admin.adminId) {
    return null
  }
  if (String(admin.role || '') === 'tenant_admin') {
    await ensureTenantSettingsInfrastructure()
    const result = await pool.query(
      `SELECT id, tenant_id, email, full_name, password_hash, role, status, token_version,
              totp_secret, totp_temp_secret, totp_backup_codes, totp_enabled, last_login_at
         FROM tenant_admins
        WHERE id = $1`,
      [admin.adminId]
    )
    if (result.rows.length === 0) return null
    return { ...result.rows[0], auth_source: 'tenant_admin' }
  }

  const platformAdmin = await getPlatformAdminById(admin.adminId)
  return platformAdmin ? { ...platformAdmin, auth_source: 'platform_admin' } : null
}

async function getAdminRecordForPre2faSession(adminPre2fa) {
  if (!adminPre2fa?.adminId) return null
  if (String(adminPre2fa.role || '') === 'tenant_admin') {
    await ensureTenantSettingsInfrastructure()
    const result = await pool.query(
      `SELECT id, tenant_id, email, full_name, password_hash, role, status, token_version,
              totp_secret, totp_temp_secret, totp_backup_codes, totp_enabled, last_login_at
         FROM tenant_admins
        WHERE id = $1`,
      [adminPre2fa.adminId]
    )
    if (result.rows.length === 0) return null
    return { ...result.rows[0], auth_source: 'tenant_admin' }
  }

  const platformAdmin = await getPlatformAdminById(adminPre2fa.adminId)
  return platformAdmin ? { ...platformAdmin, auth_source: 'platform_admin' } : null
}

function getAdmin2faStatusPayload(admin, record) {
  return {
    role: admin?.role || record?.role || null,
    auth_source: admin?.auth_source || record?.auth_source || null,
    totp_enabled: !!record?.totp_enabled,
    totp_setup_available: !!record,
    legacy_env_fallback: String(admin?.auth_source || '') === 'env_fallback',
    backup_codes_configured: !!record?.totp_backup_codes
  }
}

function parseStoredBackupCodes(raw) {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (_) {
    return []
  }
}

function buildAdminAuditActor(admin) {
  return String(admin?.email || admin?.full_name || admin?.role || 'admin')
}

function buildAdminSessionAdmin(record) {
  if (!record) return null
  return {
    adminId: record.id || record.adminId || null,
    role: record.role || null,
    tenantId: record.tenant_id || record.tenantId || null,
    email: record.email || null,
    full_name: record.full_name || null,
    auth_source: record.auth_source || null,
    totp_enabled: !!record.totp_enabled
  }
}

function sanitizePlatformAdminRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role || 'super_admin',
    status: row.status || 'active',
    token_version: row.token_version || 1,
    totp_enabled: !!row.totp_enabled,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  }
}

function sanitizeTenantAdminAccessRecord(row) {
  if (!row) return null
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    tenant_name: row.tenant_name || null,
    tenant_slug: row.tenant_slug || null,
    email: row.email,
    full_name: row.full_name,
    role: row.role || 'tenant_admin',
    status: row.status || 'active',
    token_version: row.token_version || 1,
    totp_enabled: !!row.totp_enabled,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null
  }
}

async function persistAdminSecurityFields(record, patch = {}) {
  if (!record?.id) return

  const {
    totp_secret = null,
    totp_temp_secret = null,
    totp_backup_codes = null,
    totp_enabled = false,
    token_version = null,
    status = null,
    password_hash = null,
    full_name = null,
    last_login_at = null
  } = patch

  const isTenantAdmin = String(record.auth_source || '') === 'tenant_admin' || String(record.role || '') === 'tenant_admin'
  const params = [
    record.id,
    totp_secret,
    totp_temp_secret,
    totp_backup_codes,
    !!totp_enabled,
    token_version,
    status,
    password_hash,
    full_name,
    last_login_at
  ]

  if (isTenantAdmin) {
    await pool.query(
      `UPDATE tenant_admins
          SET totp_secret = $2,
              totp_temp_secret = $3,
              totp_backup_codes = $4,
              totp_enabled = $5,
              token_version = COALESCE($6, token_version),
              status = COALESCE($7, status),
              password_hash = COALESCE($8, password_hash),
              full_name = COALESCE($9, full_name),
              last_login_at = COALESCE($10, last_login_at),
              updated_at = NOW()
        WHERE id = $1`,
      params
    )
    return
  }

  await pool.query(
    `UPDATE platform_admins
        SET totp_secret = $2,
            totp_temp_secret = $3,
            totp_backup_codes = $4,
            totp_enabled = $5,
            token_version = COALESCE($6, token_version),
            status = COALESCE($7, status),
            password_hash = COALESCE($8, password_hash),
            full_name = COALESCE($9, full_name),
            last_login_at = COALESCE($10, last_login_at),
            updated_at = NOW()
      WHERE id = $1`,
    params
  )
}

async function verifyAdmin2faTokenOrBackup(record, token) {
  if (!record?.totp_secret) {
    return { ok: false, used_backup_code: false, backup_codes: null }
  }

  const plainSecret = totp.decryptSecret(record.totp_secret)
  if (totp.verifyToken(plainSecret, token)) {
    return { ok: true, used_backup_code: false, backup_codes: null }
  }

  const backupCodes = parseStoredBackupCodes(record.totp_backup_codes)
  if (backupCodes.length === 0) {
    return { ok: false, used_backup_code: false, backup_codes }
  }

  const consumed = await totp.consumeBackupCode(token, backupCodes)
  if (!consumed.matched) {
    return { ok: false, used_backup_code: false, backup_codes }
  }

  return {
    ok: true,
    used_backup_code: true,
    backup_codes: consumed.updated
  }
}

async function getLegacyAdminTokenVersion() {
  let adminTokenVersion = 1
  try {
    const tv = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
    )
    if (tv.rows.length > 0) {
      const parsed = parseInt(tv.rows[0].value, 10)
      if (!Number.isNaN(parsed)) adminTokenVersion = parsed
    } else {
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ('admin_token_version', '1', NOW())
         ON CONFLICT (key) DO NOTHING`
      )
    }
  } catch (_) {}
  return adminTokenVersion
}

async function buildAdminSecurityStatus(currentAdmin) {
  await ensureFeatureTables()
  await ensureTenantSettingsInfrastructure()
  const isProduction = String(process.env.NODE_ENV || 'development').toLowerCase() === 'production'
  const adminTotpRequiredSetting = await pool.query(
    `SELECT value FROM platform_settings WHERE key = 'admin_totp_required'`
  ).catch(() => ({ rows: [] }))
  const adminTotpRequired = adminTotpRequiredSetting.rows.length > 0
    ? ['true', '1', 'yes', 'on'].includes(String(adminTotpRequiredSetting.rows[0].value || '').toLowerCase())
    : isProduction

  const [platformResult, tenantResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE status = 'active' AND totp_enabled = TRUE)::int AS totp_enabled
       FROM platform_admins`
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE status = 'active' AND totp_enabled = TRUE)::int AS totp_enabled
       FROM tenant_admins`
    )
  ])

  const platformCounts = platformResult.rows[0] || {}
  const tenantCounts = tenantResult.rows[0] || {}
  const activePlatformAdmins = parseInt(platformCounts.active || 0, 10) || 0
  const activeTenantAdmins = parseInt(tenantCounts.active || 0, 10) || 0

  const base = {
    checked_at: new Date().toISOString(),
    current_admin: {
      admin_id: currentAdmin?.adminId || null,
      role: currentAdmin?.role || null,
      email: currentAdmin?.email || null,
      tenant_id: currentAdmin?.tenantId || null,
      auth_source: currentAdmin?.auth_source || null,
      totp_enabled: currentAdmin?.totp_enabled === true
    },
    session_revocation: {
      supported: true,
      token_versioned: true
    }
  }

  if (String(currentAdmin?.role || '') !== 'super_admin') {
    return {
      ...base,
      totp: {
        current_admin_totp_enabled: currentAdmin?.totp_enabled === true
      }
    }
  }

  return {
    ...base,
    migration: {
      platform_admin_bootstrap_complete: activePlatformAdmins > 0,
      env_fallback_enabled: !isProduction && activePlatformAdmins === 0,
      env_fallback_disabled: isProduction || activePlatformAdmins > 0,
      platform_admin_count: parseInt(platformCounts.total || 0, 10) || 0,
      active_platform_admin_count: activePlatformAdmins,
      tenant_admin_count: parseInt(tenantCounts.total || 0, 10) || 0,
      active_tenant_admin_count: activeTenantAdmins
    },
    totp: {
      required: adminTotpRequired,
      coverage_complete: !adminTotpRequired || (
        parseInt(platformCounts.totp_enabled || 0, 10) >= activePlatformAdmins
        && parseInt(tenantCounts.totp_enabled || 0, 10) >= activeTenantAdmins
      ),
      platform_admins_enabled: parseInt(platformCounts.totp_enabled || 0, 10) || 0,
      platform_admins_total: activePlatformAdmins,
      tenant_admins_enabled: parseInt(tenantCounts.totp_enabled || 0, 10) || 0,
      tenant_admins_total: activeTenantAdmins,
      current_admin_totp_enabled: currentAdmin?.totp_enabled === true
    },
    secrets: {
      admin_password_needs_rotation: !isBcryptHash(process.env.ADMIN_PASSWORD) || looksLikeDefaultSecret(process.env.ADMIN_PASSWORD),
      jwt_secret_needs_rotation: looksLikeDefaultSecret(process.env.JWT_SECRET),
      admin_jwt_secret_needs_rotation: looksLikeDefaultSecret(process.env.ADMIN_JWT_SECRET),
      totp_encryption_configured: !!String(process.env.TOTP_ENCRYPTION_KEY || '').trim() && String(process.env.TOTP_ENCRYPTION_KEY || '').trim().length >= 64,
      node_env: String(process.env.NODE_ENV || 'development')
    }
  }
}


router.get('/2fa/status', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    res.json({
      ...getAdmin2faStatusPayload(req.admin, record),
      email: req.admin?.email || null,
      tenant_id: req.admin?.tenantId || null
    })
  } catch (err) {
    logger.error('[admin/2fa/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not load admin 2FA status' })
  }
})

router.post('/2fa/setup', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    if (!record) {
      return res.status(403).json({ error: '2FA setup is only available for DB-backed admin accounts' })
    }

    const label = `${record.email || record.full_name || 'admin'}`
    const { base32, otpauthUrl } = totp.generateSecret(label)
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl)
    const encTemp = totp.encryptSecret(base32)
    await persistAdminSecurityFields(record, {
      totp_secret: record.totp_secret || null,
      totp_temp_secret: encTemp,
      totp_backup_codes: record.totp_backup_codes || null,
      totp_enabled: !!record.totp_enabled,
      token_version: record.token_version || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: record.last_login_at || null
    })

    res.json({ qr: qrDataUrl, secret: base32 })
  } catch (err) {
    logger.error('[admin/2fa/setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not set up admin 2FA' })
  }
})

// POST /api/admin/2fa/verify-setup — confirm first code, activate admin 2FA
router.post('/2fa/verify-setup', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    if (!record) {
      return res.status(403).json({ error: '2FA setup is only available for DB-backed admin accounts' })
    }

    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    if (!record.totp_temp_secret) {
      return res.status(400).json({ error: 'Run /api/admin/2fa/setup first' })
    }

    const plainTemp = totp.decryptSecret(record.totp_temp_secret)
    const valid = totp.verifyToken(plainTemp, token)
    if (!valid) return res.status(401).json({ error: 'Invalid code. Please try again.' })

    const backup = await totp.generateBackupCodes()
    const encLive = totp.encryptSecret(plainTemp)
    const storedBackupCodes = backup.hashes.map((hash) => ({ hash, used: false }))

    await persistAdminSecurityFields(record, {
      totp_secret: encLive,
      totp_temp_secret: null,
      totp_backup_codes: JSON.stringify(storedBackupCodes),
      totp_enabled: true,
      token_version: record.token_version || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: record.last_login_at || null
    })

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'admin_2fa_enabled',
        entityType: String(req.admin?.role || 'admin'),
        entityId: String(record.id),
        payload: { auth_source: record.auth_source || null }
      })
    } catch (_) {}

    logger.info('[admin/2fa] Admin 2FA enabled', { adminId: record.id, role: req.admin?.role })
    res.json({
      message: 'Admin 2FA enabled successfully.',
      backup_codes: backup.plain
    })
  } catch (err) {
    logger.error('[admin/2fa/verify-setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not activate admin 2FA' })
  }
})

router.post('/2fa/validate', adminTwoFaValidateLimiter, authenticateAdminPre2FA, async function(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'admin_ip'
  const rl = totp.checkRateLimit(`admin:${ip}`)
  if (rl.blocked) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${rl.remaining} minute(s).` })
  }

  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const record = await getAdminRecordForPre2faSession(req.adminPre2fa)
    if (!record || record.status !== 'active') {
      return res.status(403).json({ error: 'Admin account is unavailable' })
    }

    if (!record.totp_enabled || !record.totp_secret) {
      return res.status(400).json({ error: 'Admin 2FA is not configured' })
    }

    const validation = await verifyAdmin2faTokenOrBackup(record, token)
    if (!validation.ok) {
      totp.recordFailure(`admin:${ip}`)
      return res.status(401).json({ error: 'Invalid code. Please try again.' })
    }

    if (validation.used_backup_code) {
      await persistAdminSecurityFields(record, {
        totp_secret: record.totp_secret,
        totp_temp_secret: record.totp_temp_secret || null,
        totp_backup_codes: JSON.stringify(validation.backup_codes || []),
        totp_enabled: !!record.totp_enabled,
        token_version: record.token_version || 1,
        status: record.status || 'active',
        password_hash: record.password_hash || null,
        full_name: record.full_name || null,
        last_login_at: record.last_login_at || null
      })
    }

    totp.clearAttempts(`admin:${ip}`)

    const fullToken = signAdminToken({
      id: record.id,
      tenant_id: record.tenant_id || null,
      token_version: record.token_version || req.adminPre2fa.atv || 1,
      email: record.email,
      full_name: record.full_name,
      role: record.role || (record.tenant_id ? 'tenant_admin' : 'super_admin'),
      auth_source: record.auth_source || (record.tenant_id ? 'tenant_admin' : 'platform_admin')
    })

    await persistAdminSecurityFields(record, {
      totp_secret: record.totp_secret,
      totp_temp_secret: record.totp_temp_secret || null,
      totp_backup_codes: validation.used_backup_code ? JSON.stringify(validation.backup_codes || []) : (record.totp_backup_codes || null),
      totp_enabled: !!record.totp_enabled,
      token_version: record.token_version || req.adminPre2fa.atv || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: new Date().toISOString()
    })

    setAdminCookie(res, fullToken)

    res.json({
      message: 'Admin login successful',
      token: fullToken,
      admin: buildAdminSessionPayload(buildAdminSessionAdmin(record))
    })
  } catch (err) {
    logger.error('[admin/2fa/validate] error:', { error: err.message })
    res.status(500).json({ error: 'Could not verify admin 2FA token' })
  }
})

router.post('/2fa/disable', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    if (!record) {
      return res.status(403).json({ error: '2FA management is only available for DB-backed admin accounts' })
    }

    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    if (!record.totp_enabled || !record.totp_secret) {
      return res.status(400).json({ error: 'Admin 2FA is not configured' })
    }

    const validation = await verifyAdmin2faTokenOrBackup(record, token)
    if (!validation.ok) return res.status(401).json({ error: 'Invalid 2FA code' })

    await persistAdminSecurityFields(record, {
      totp_secret: null,
      totp_temp_secret: null,
      totp_backup_codes: null,
      totp_enabled: false,
      token_version: record.token_version || 1,
      status: record.status || 'active',
      password_hash: record.password_hash || null,
      full_name: record.full_name || null,
      last_login_at: record.last_login_at || null
    })

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'admin_2fa_disabled',
        entityType: String(req.admin?.role || 'admin'),
        entityId: String(record.id),
        payload: { auth_source: record.auth_source || null }
      })
    } catch (_) {}

    logger.info('[admin/2fa] Admin 2FA disabled')
    res.json({ message: 'Admin 2FA disabled' })
  } catch (err) {
    logger.error('[admin/2fa/disable] error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable admin 2FA' })
  }
})

router.get('/session', authenticateAdmin, async function(req, res) {
  res.json(buildAdminSessionPayload(req.admin))
})

router.get('/security/status', authenticateAdmin, async function(req, res) {
  try {
    res.json(await buildAdminSecurityStatus(req.admin))
  } catch (err) {
    logger.error('[admin/security/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not load admin security status' })
  }
})

router.get('/admin-users', authenticateAdmin, requireSuperAdmin, async function(req, res) {
  try {
    await ensureFeatureTables()
    await ensureTenantSettingsInfrastructure()

    const [platformResult, tenantResult, securityStatus] = await Promise.all([
      pool.query(
        `SELECT id, email, full_name, role, status, token_version, totp_enabled,
                last_login_at, created_at, updated_at
           FROM platform_admins
          ORDER BY created_at ASC`
      ),
      pool.query(
        `SELECT ta.id, ta.tenant_id, ta.email, ta.full_name, ta.role, ta.status, ta.token_version,
                ta.totp_enabled, ta.last_login_at, ta.created_at, ta.updated_at,
                t.name AS tenant_name, t.slug AS tenant_slug
           FROM tenant_admins ta
           JOIN tenants t ON t.id = ta.tenant_id
          ORDER BY t.created_at ASC, ta.created_at ASC`
      ),
      buildAdminSecurityStatus(req.admin)
    ])

    res.json({
      summary: securityStatus,
      platform_admins: platformResult.rows.map(sanitizePlatformAdminRecord).filter(Boolean),
      tenant_admins: tenantResult.rows.map(sanitizeTenantAdminAccessRecord).filter(Boolean)
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
    const role = 'super_admin'

    if (!email) return res.status(400).json({ error: 'Admin email is required' })
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
    } catch (_) {}

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

    if (!['active', 'disabled'].includes(nextStatus)) {
      return res.status(400).json({ error: 'status must be active or disabled' })
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

    const update = await pool.query(
      `UPDATE platform_admins
          SET full_name = $2,
              status = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, full_name, role, status, token_version, totp_enabled, last_login_at, created_at, updated_at`,
      [adminId, nextFullName, nextStatus]
    )

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'platform_admin_updated',
        entityType: 'platform_admin',
        entityId: adminId,
        payload: { status: nextStatus, full_name: nextFullName }
      })
    } catch (_) {}

    res.json({
      message: 'Platform admin updated',
      admin_user: sanitizePlatformAdminRecord(update.rows[0])
    })
  } catch (err) {
    logger.error('[admin/admin-users] update error:', { error: err.message })
    res.status(500).json({ error: 'Could not update platform admin' })
  }
})

router.post('/admin-users/:id/reset-password', authenticateAdmin, requireSuperAdmin, async function(req, res) {
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
    } catch (_) {}

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
    } catch (_) {}

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
    } catch (_) {}

    res.json({ message: 'Platform admin disabled' })
  } catch (err) {
    logger.error('[admin/admin-users] disable error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable platform admin' })
  }
})

router.get('/overview', authenticateAdmin, requireTenantAdminOrSuperAdmin, async function(req, res) {

  try {
    const tenantId = getScopedTenantId(req)
    const accounts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase1') AS phase1_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase2') AS phase2_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded') AS funded_active,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE status = 'passed') AS total_passed,
        COUNT(*) FILTER (WHERE status = 'expired') AS total_expired
       FROM accounts
       WHERE ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)`,
      [tenantId]
    )

    const users = await pool.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE kyc_status = 'pending') AS kyc_pending,
        COUNT(*) FILTER (WHERE kyc_status = 'approved') AS kyc_approved
       FROM users
       WHERE ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)`,
      [tenantId]
    )

    const pnl = await pool.query(
      `SELECT
        COALESCE(SUM(t.demo_pnl), 0) AS total_demo_pnl,
        COALESCE(SUM(t.broker_pnl), 0) AS total_broker_pnl,
        COUNT(*) FILTER (WHERE t.status = 'closed') AS total_closed_trades,
        COUNT(*) FILTER (WHERE t.status = 'open') AS total_open_trades
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       WHERE ($1::bigint IS NULL OR COALESCE(a.tenant_id, $1) = $1)`,
      [tenantId]
    )

    const payouts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_payouts,
        COALESCE(SUM(amount_payable) FILTER (WHERE status = 'paid'), 0) AS total_paid_out
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       WHERE ($1::bigint IS NULL OR COALESCE(u.tenant_id, $1) = $1)`,
      [tenantId]
    )

    const bannedUsers = await pool.query(
      `SELECT COUNT(*) as banned
       FROM users
       WHERE is_banned = true
         AND ($1::bigint IS NULL OR COALESCE(tenant_id, $1) = $1)`,
      [tenantId]
    );
    const flaggedPayouts = await pool.query(
      `SELECT COUNT(*) as flagged
       FROM payouts p
       JOIN users u ON u.id = p.user_id
       WHERE p.status = 'flagged'
         AND ($1::bigint IS NULL OR COALESCE(u.tenant_id, $1) = $1)`,
      [tenantId]
    );

    const { exposureData } = await getExposureData(pool, tenantId);

    res.json({
      accounts: {
        phase1: parseInt(accounts.rows[0].phase1_active || 0),
        phase2: parseInt(accounts.rows[0].phase2_active || 0),
        funded: parseInt(accounts.rows[0].funded_active || 0),
        failed: parseInt(accounts.rows[0].total_failed || 0),
        passed: parseInt(accounts.rows[0].total_passed || 0),
        expired: parseInt(accounts.rows[0].total_expired || 0)
      },
      users: {
        total: parseInt(users.rows[0].total_users || 0),
        pending_kyc: parseInt(users.rows[0].kyc_pending || 0),
        approved_kyc: parseInt(users.rows[0].kyc_approved || 0),
        banned: parseInt(bannedUsers.rows[0].banned || 0)
      },
      trades: {
        open: parseInt(pnl.rows[0].total_open_trades || 0),
        total_pnl: parseFloat(pnl.rows[0].total_demo_pnl || 0)
      },
      payouts: {
        pending: parseInt(payouts.rows[0].pending_payouts || 0),
        total_paid: parseFloat(payouts.rows[0].total_paid_out || 0),
        flagged_count: parseInt(flaggedPayouts.rows[0].flagged || 0)
      },
      exposure: exposureData,
      settings: {}
    })

  } catch (error) {
    logger.error('Admin overview error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch overview' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/signup-trends
// Real 30-day signup + challenge data for AdminDashboard charts.
// FIX (BUG-2): Added so dashboard charts show real data, not mock constants.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = router
