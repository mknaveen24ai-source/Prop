const jwt  = require('jsonwebtoken')
const pool = require('../db')
const logger = require('../utils/logger')
const { getCachedTokenData, cacheTokenData } = require('../utils/tokenCache')

const SUPER_ADMIN_PERMISSIONS = [
  'platform:*',
  'trader:*',
  'account:*',
  'payout:*',
  'kyc:*',
  'violation:*',
  'command_center:*',
  'bulk:*',
  'certificate:*'
]

// Least-privileged built-in roles — real capability sets, not the
// super_admin wildcard. Each maps to the exact requireAdminCapability(...)
// strings already gating routes across the app (grep confirmed no invented
// capability names). POST/PATCH /admin-users below is what actually lets an
// admin be created/changed into one of these; before that fix, every admin
// account was forced to be super_admin regardless of this table's existence.
const ROLE_PERMISSIONS = {
  kyc_reviewer: ['kyc:review:scoped', 'trader:read', 'account:read:scoped'],
  support_agent: ['chat:read:scoped', 'chat:reply:scoped', 'trader:read', 'certificate:read:scoped'],
  risk_ops: ['violation:read:scoped', 'violation:resolve:scoped', 'trader:read', 'trader:moderate:scoped', 'account:read:scoped', 'account:override'],
  // certificate:issue/revoke sit with finance_ops because the payout reward
  // certificate is the one they already mint by approving a payout. Registering
  // them here matters: a capability absent from EVERY role entry is reachable
  // only by super_admin via the platform:* wildcard, which is exactly how
  // account:promotion_review:scoped ended up unusable by any scoped role.
  // certificate:template:manage is deliberately NOT listed — changing the
  // artwork every certificate is minted against is a super_admin action.
  finance_ops: ['payout:read:scoped', 'payout:review:scoped', 'payout:flag', 'trader:read', 'account:read:scoped', 'certificate:read:scoped', 'certificate:issue', 'certificate:revoke'],
}
const BUILT_IN_ROLES = ['super_admin', ...Object.keys(ROLE_PERMISSIONS)]

function normalizePermission(value) {
  return String(value || '').trim().toLowerCase()
}

function getAdminPermissionsForRole(role) {
  const normalizedRole = normalizePermission(role)
  if (normalizedRole === 'super_admin') return [...SUPER_ADMIN_PERMISSIONS]
  if (ROLE_PERMISSIONS[normalizedRole]) return [...ROLE_PERMISSIONS[normalizedRole]]
  return []
}

async function getPlatformAdminById(adminId) {
  const result = await pool.query(
    `SELECT id, email, full_name, role, status, token_version,
            totp_enabled, last_login_at
       FROM platform_admins
      WHERE id = $1`,
    [adminId]
  )
  return result.rows[0] || null
}

function hasAdminCapability(admin, capability) {
  if (!admin) return false
  const normalizedCapability = normalizePermission(capability)
  if (!normalizedCapability) return false

  const permissions = Array.isArray(admin.permissions)
    ? admin.permissions.map(normalizePermission).filter(Boolean)
    : getAdminPermissionsForRole(admin.role)

  if (permissions.includes('platform:*') || permissions.includes(normalizedCapability)) {
    return true
  }

  return permissions.some((permission) => {
    if (!permission.endsWith('*')) return false
    const prefix = permission.slice(0, -1)
    return prefix && normalizedCapability.startsWith(prefix)
  })
}

function requireAdminCapability(capability) {
  const normalizedCapability = normalizePermission(capability)
  return function enforceAdminCapability(req, res, next) {
    if (!hasAdminCapability(req.admin, normalizedCapability)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' })
    }
    next()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// authenticateToken
//
// Verifies JWT and checks server-side token version (instant session
// invalidation without waiting for JWT expiry).
//
// DB requirement:
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 1;
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateToken(req, res, next) {
  const authHeader  = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const cookieToken = req.cookies ? req.cookies.token : null
  const token       = headerToken || cookieToken

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  if (!process.env.JWT_SECRET) {
    logger.error('FATAL: JWT_SECRET is not set in environment')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' })
  }

  // FIX (C2): Token version + ban check with Redis caching
  // Try cache first (5-minute TTL) to avoid DB hit on every request
  let tokenData = await getCachedTokenData(decoded.userId)

  if (!tokenData) {
    // Cache miss or Redis unavailable - query database
    try {
      const result = await pool.query(
        'SELECT token_version, is_banned FROM users WHERE id = $1',
        [decoded.userId]
      )
      if (result.rows.length === 0) {
        return res.status(403).json({ error: 'User not found' })
      }

      tokenData = result.rows[0]
      // Populate cache for next request
      await cacheTokenData(decoded.userId, tokenData.token_version, tokenData.is_banned)
    } catch (dbErr) {
      logger.error('[auth] Token version check failed:', { error: dbErr.message })
      return res.status(503).json({ error: 'Authentication service unavailable' })
    }
  }

  const { token_version, is_banned } = tokenData

  if (is_banned) {
    return res.status(403).json({ error: 'Account has been suspended' })
  }

  // FIX (H-07): `decoded.tv !== undefined &&` meant a token with no `tv` claim
  // skipped the version check entirely and could never be revoked. Every token
  // this app issues carries `tv`, so treating its absence as invalid costs
  // nothing and closes the hole.
  if (decoded.tv === undefined || decoded.tv < token_version) {
    return res.status(401).json({ error: 'Session expired - please log in again' })
  }

  req.user = { ...decoded }
  next()
}

// ─────────────────────────────────────────────────────────────────────────────
// authenticateAdmin
//
// FIX: Previously had no DB lookup, so compromised admin JWTs could not be
// invalidated until the 8-hour expiry. Now checks admin_token_version in
// the platform_settings table, giving admins a "revoke all admin sessions"
// mechanism via the DB.
//
// DB requirement (run once):
//   INSERT INTO platform_settings (key, value)
//   VALUES ('admin_token_version', '1')
//   ON CONFLICT (key) DO NOTHING;
//
// To revoke all admin sessions immediately:
//   UPDATE platform_settings SET value = (value::int + 1)::text
//   WHERE key = 'admin_token_version';
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateAdmin(req, res, next) {
  const authHeader  = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const cookieToken = req.cookies ? req.cookies.admin_token : null
  const token       = headerToken || cookieToken

  if (!token) {
    return res.status(401).json({ error: 'Admin token required' })
  }

  if (!process.env.ADMIN_JWT_SECRET) {
    logger.error('FATAL: ADMIN_JWT_SECRET is not set in environment')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET)
  } catch {
    return res.status(403).json({ error: 'Invalid or expired admin token' })
  }

  // FIX (C-03): this gate previously accepted only the literal strings 'admin'
  // and 'super_admin', and ran BEFORE the platform_admins lookup below. Every
  // scoped role in BUILT_IN_ROLES — kyc_reviewer, support_agent, risk_ops,
  // finance_ops — was therefore rejected with 403 on every admin route, so the
  // only usable admin was a super_admin holding platform:*. The capability
  // system existed but could never be reached.
  //
  // Authority is decided by the platform_admins row plus
  // requireAdminCapability(...) on each route. All this gate has to do is
  // reject a role it does not recognise.
  const tokenRole = normalizePermission(decoded.role)
  if (tokenRole !== 'admin' && !BUILT_IN_ROLES.includes(tokenRole)) {
    return res.status(403).json({ error: 'Admin access required' })
  }

  try {
    const normalizedRole = tokenRole === 'admin' ? 'super_admin' : tokenRole
    if (decoded.adminId) {
      const platformAdmin = await getPlatformAdminById(decoded.adminId)
      if (!platformAdmin) {
        return res.status(403).json({ error: 'Platform admin not found' })
      }
      if (platformAdmin.status !== 'active') {
        return res.status(403).json({ error: 'Platform admin account is inactive' })
      }
      if ((decoded.atv || 0) < parseInt(platformAdmin.token_version || 1, 10)) {
        return res.status(401).json({ error: 'Admin session expired - please log in again' })
      }

      req.admin = {
        ...decoded,
        adminId: platformAdmin.id,
        email: platformAdmin.email,
        full_name: platformAdmin.full_name,
        role: platformAdmin.role || normalizedRole,
        auth_source: decoded.src || 'platform_admin',
        totp_enabled: !!platformAdmin.totp_enabled,
        permissions: getAdminPermissionsForRole(platformAdmin.role || normalizedRole)
      }
      return next()
    }

    // Legacy env-backed super-admin fallback token version check.
    //
    // FIX (H-07): this used to be `if (result.rows.length > 0) { ...check... }`,
    // so a missing admin_token_version row skipped revocation entirely — and no
    // migration created that row; its INSERT existed only as a comment above.
    // A leaked super-admin token was therefore valid to its 24h expiry with no
    // kill switch. Migration 029 seeds the row; this now fails closed if it is
    // ever absent again.
    const result = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
    )
    if (result.rows.length === 0) {
      logger.error('[admin-auth] admin_token_version is missing — refusing env-fallback admin token')
      return res.status(503).json({ error: 'Admin session cannot be verified' })
    }
    const serverVersion = parseInt(result.rows[0].value, 10)
    if (!Number.isFinite(serverVersion)) {
      logger.error('[admin-auth] admin_token_version is not a number — refusing env-fallback admin token')
      return res.status(503).json({ error: 'Admin session cannot be verified' })
    }
    if ((decoded.atv || 0) < serverVersion) {
      return res.status(401).json({ error: 'Admin session expired - please log in again' })
    }
  } catch (dbErr) {
    logger.error('[admin-auth] Token version check failed:', { error: dbErr.message })
    return res.status(503).json({ error: 'Authentication service unavailable' })
  }

  const fallbackRole = tokenRole === 'admin' ? 'super_admin' : tokenRole
  req.admin = {
    ...decoded,
    role: fallbackRole,
    email: decoded.email || process.env.ADMIN_EMAIL || null,
    full_name: decoded.full_name || 'Platform Owner',
    auth_source: decoded.src || 'env_fallback',
    totp_enabled: false,
    permissions: getAdminPermissionsForRole(fallbackRole)
  }
  next()
}

function requireSuperAdmin(req, res, next) {
  if (!req.admin || String(req.admin.role || '') !== 'super_admin') {
    return res.status(403).json({ error: 'Super-admin access required' })
  }
  next()
}

function buildAdminSessionPayload(admin) {
  const role = String(admin?.role || '')
  return {
    authenticated: !!admin,
    adminId: admin?.adminId || null,
    role: role || null,
    permissions: Array.isArray(admin?.permissions)
      ? admin.permissions
      : getAdminPermissionsForRole(role),
    email: admin?.email || null,
    full_name: admin?.full_name || null,
    auth_source: admin?.auth_source || null,
    totp_enabled: admin?.totp_enabled === true
  }
}

// (Functions authenticatePre2FA and authenticateAdminPre2FA are defined below)
// module.exports is at the bottom of this file after all definitions.

// ─────────────────────────────────────────────────────────────────────────────
// authenticatePre2FA
//
// Accepts ONLY a short-lived pre_2fa JWT (type: 'pre_2fa').
// Does NOT grant access to regular authenticated routes.
// Used exclusively by POST /api/auth/2fa/validate.
// ─────────────────────────────────────────────────────────────────────────────
async function authenticatePre2FA(req, res, next) {
  const authHeader  = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const token       = headerToken

  if (!token) {
    return res.status(401).json({ error: '2FA token required' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(403).json({ error: 'Invalid or expired 2FA session' })
  }

  if (decoded.type !== 'pre_2fa') {
    return res.status(403).json({ error: 'Invalid token type' })
  }

  try {
    const result = await pool.query(
      'SELECT token_version, is_banned FROM users WHERE id = $1',
      [decoded.userId]
    )
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'User not found' })
    }
    const { token_version, is_banned } = result.rows[0]
    if (is_banned) {
      return res.status(403).json({ error: 'Account has been suspended' })
    }
    // FIX (H-07): same as authenticateToken — a missing `tv` claim used to skip
    // the check. All four jwt.sign sites in routes/auth.js include it.
    if (decoded.tv === undefined || decoded.tv < token_version) {
      return res.status(401).json({ error: 'Session expired - please log in again' })
    }
  } catch (dbErr) {
    logger.error('[auth] Pre-2FA token version check failed:', { error: dbErr.message })
    return res.status(503).json({ error: 'Authentication service unavailable' })
  }

  req.pre2fa = decoded
  next()
}

// ─────────────────────────────────────────────────────────────────────────────
// authenticateAdminPre2FA
//
// Accepts ONLY a short-lived admin pre_2fa JWT.
// Used exclusively by POST /api/admin/2fa/validate.
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateAdminPre2FA(req, res, next) {
  const authHeader  = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const token       = headerToken

  if (!token) {
    return res.status(401).json({ error: '2FA token required' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET)
  } catch {
    return res.status(403).json({ error: 'Invalid or expired admin 2FA session' })
  }

  if (decoded.type !== 'pre_2fa_admin') {
    return res.status(403).json({ error: 'Invalid admin token type' })
  }

  // FIX (H-07): this performed no status or version check at all, unlike its
  // user-side counterpart authenticatePre2FA. A deactivated admin holding a
  // pre-2FA token could still complete the second factor and get a full
  // session, so deactivation did not take effect until the token expired.
  if (decoded.adminId) {
    try {
      const platformAdmin = await getPlatformAdminById(decoded.adminId)
      if (!platformAdmin) {
        return res.status(403).json({ error: 'Platform admin not found' })
      }
      if (platformAdmin.status !== 'active') {
        return res.status(403).json({ error: 'Platform admin account is inactive' })
      }
      if ((decoded.atv || 0) < parseInt(platformAdmin.token_version || 1, 10)) {
        return res.status(401).json({ error: 'Admin session expired - please log in again' })
      }
    } catch (dbErr) {
      logger.error('[admin-auth] Pre-2FA admin check failed:', { error: dbErr.message })
      return res.status(503).json({ error: 'Authentication service unavailable' })
    }
  }

  req.adminPre2fa = decoded
  next()
}

module.exports = {
  authenticateToken,
  authenticateAdmin,
  authenticatePre2FA,
  authenticateAdminPre2FA,
  buildAdminSessionPayload,
  getAdminPermissionsForRole,
  ROLE_PERMISSIONS,
  BUILT_IN_ROLES,
  hasAdminCapability,
  requireAdminCapability,
  requireSuperAdmin
}
