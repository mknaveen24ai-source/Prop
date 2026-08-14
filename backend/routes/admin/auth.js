// Admin login, logout, 2FA enrolment/validation, session and security status.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  authenticateAdminPre2FA,
  buildAdminSessionPayload
} = require('../middleware')
const bcrypt = require('bcryptjs')
const rateLimit = require('express-rate-limit')
const qrcode = require('qrcode')
const logger = require('../../utils/logger')
const totp   = require('../../utils/totp')
require('../../loadEnv')

const { ensureFeatureTables } = require('./shared/schema')
const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  normalizeAdminEmail, isBcryptHash, setAdminCookie,
  getActivePlatformAdminCount, getPlatformAdminByEmail, getPlatformAdminById, signAdminToken,
  buildAdminAuditActor, buildAdminSecurityStatus
} = require('./shared/helpers')

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts total per IP
  message: { error: 'Too many admin login attempts. Please wait 15 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // don't count successful logins against the limit
})





// FIX (BUG-C3): adminLoginLimiter applied before the handler (defined above)
router.post('/login', adminLoginLimiter, async function(req, res) {
  try {
    await ensureFeatureTables()

    const { email, password } = req.body
    const normalizedEmail = normalizeAdminEmail(email)

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

    const adminPassword = process.env.ADMIN_PASSWORD

    if (!adminPassword) {
      return res.status(500).json({ error: 'Admin password not configured' })
    }

    // FIX (CRITICAL #3): Enforce bcrypt hashing in production.
    // Plain-text admin passwords are a security risk. In production, we reject
    // plain-text passwords outright to prevent accidental misconfiguration.
    const envPasswordIsHash = isBcryptHash(adminPassword)

    const isProduction = String(process.env.NODE_ENV || '').toLowerCase() === 'production'

    if (!envPasswordIsHash && isProduction) {
      return res.status(500).json({
        error: 'Admin password must be a bcrypt hash. Run: node -e "require(\'bcrypt\').hash(\'YourPass\',12).then(console.log)"'
      })
    }

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

    // NOTE: ~40 lines of legacy `admin_totp_secret` 2FA handling used to sit
    // here, after the `return res.json(...)` above — permanently unreachable,
    // and flagged by eslint's no-unreachable.
    //
    // It was safe to delete rather than restore. This env-fallback branch is
    // reachable only when `activePlatformAdminCount === 0` (see the guard
    // above), i.e. first-boot bootstrap before any DB-backed admin exists —
    // there is no admin account for 2FA to protect yet, and the response says
    // `requires_platform_admin_bootstrap: true` precisely to push the operator
    // into creating one. Real 2FA lives on the `platform_admins` path above and
    // is enforced there. `deploy-preflight` additionally refuses to pass unless
    // at least one active DB-backed admin exists with TOTP enrolled.

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
  const platformAdmin = await getPlatformAdminById(admin.adminId)
  return platformAdmin ? { ...platformAdmin, auth_source: 'platform_admin' } : null
}

async function getAdminRecordForPre2faSession(adminPre2fa) {
  if (!adminPre2fa?.adminId) return null
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


function buildAdminSessionAdmin(record) {
  if (!record) return null
  return {
    adminId: record.id || record.adminId || null,
    role: record.role || null,
    email: record.email || null,
    full_name: record.full_name || null,
    auth_source: record.auth_source || null,
    totp_enabled: !!record.totp_enabled
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
    return { ok: false, used_backup_code: false, backup_codes: backupCodes }
  }

  const consumed = await totp.consumeBackupCode(token, backupCodes)
  if (!consumed.matched) {
    return { ok: false, used_backup_code: false, backup_codes: backupCodes }
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
  } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }
  return adminTokenVersion
}


const adminTwoFaValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many admin 2FA attempts. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false
})

router.get('/2fa/status', authenticateAdmin, async function(req, res) {
  try {
    const record = await getAuthenticatedAdminRecord(req.admin)
    res.json({
      ...getAdmin2faStatusPayload(req.admin, record),
      email: req.admin?.email || null
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

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
      token_version: record.token_version || req.adminPre2fa.atv || 1,
      email: record.email,
      full_name: record.full_name,
      role: record.role || 'super_admin',
      auth_source: record.auth_source || 'platform_admin'
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
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

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

module.exports = router
