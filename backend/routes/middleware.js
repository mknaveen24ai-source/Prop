const jwt  = require('jsonwebtoken')
const pool = require('../db')
const logger = require('../utils/logger')

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

  // Token version + ban check — always hits DB to ensure instant invalidation
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

    if (decoded.tv !== undefined && decoded.tv < token_version) {
      return res.status(401).json({ error: 'Session expired - please log in again' })
    }
  } catch (dbErr) {
    logger.error('[auth] Token version check failed:', { error: dbErr.message })
    return res.status(503).json({ error: 'Authentication service unavailable' })
  }

  req.user = decoded
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
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' })
    }
  } catch {
    return res.status(403).json({ error: 'Invalid or expired admin token' })
  }

  // FIX: DB-backed admin token version check for instant session invalidation
  try {
    const result = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
    )
    if (result.rows.length > 0) {
      const serverVersion = parseInt(result.rows[0].value, 10)
      const tokenVersion  = decoded.atv || 0
      if (tokenVersion < serverVersion) {
        return res.status(401).json({ error: 'Admin session expired - please log in again' })
      }
    }
    // If the row doesn't exist yet, we allow the request (backwards-compatible)
  } catch (dbErr) {
    logger.error('[admin-auth] Token version check failed:', { error: dbErr.message })
    return res.status(503).json({ error: 'Authentication service unavailable' })
  }

  req.admin = decoded
  next()
}

module.exports = { authenticateToken, authenticateAdmin, authenticatePre2FA, authenticateAdminPre2FA }

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

  req.adminPre2fa = decoded
  next()
}


