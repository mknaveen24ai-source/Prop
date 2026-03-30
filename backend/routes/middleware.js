const jwt  = require('jsonwebtoken')
const pool = require('../db')

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// authenticateToken
//
// Verifies JWT and checks server-side token version (instant session
// invalidation without waiting for JWT expiry).
//
// DB requirement:
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER DEFAULT 1;
//   ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function authenticateToken(req, res, next) {
  const authHeader  = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const cookieToken = req.cookies ? req.cookies.token : null
  const token       = headerToken || cookieToken

  if (!token) {
    return res.status(401).json({ error: 'Access token required' })
  }

  if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set in environment')
    return res.status(500).json({ error: 'Server configuration error' })
  }

  let decoded
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET)
  } catch {
    return res.status(403).json({ error: 'Invalid or expired token' })
  }

  // Token version + ban check â€” always hits DB to ensure instant invalidation
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
    console.error('[auth] Token version check failed:', dbErr.message)
    return res.status(503).json({ error: 'Authentication service unavailable' })
  }

  req.user = decoded
  next()
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function authenticateAdmin(req, res, next) {
  const authHeader  = req.headers['authorization']
  const headerToken = authHeader && authHeader.split(' ')[1]
  const cookieToken = req.cookies ? req.cookies.admin_token : null
  const token       = headerToken || cookieToken

  if (!token) {
    return res.status(401).json({ error: 'Admin token required' })
  }

  if (!process.env.ADMIN_JWT_SECRET) {
    console.error('FATAL: ADMIN_JWT_SECRET is not set in environment')
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
    console.error('[admin-auth] Token version check failed:', dbErr.message)
    return res.status(503).json({ error: 'Authentication service unavailable' })
  }

  req.admin = decoded
  next()
}

module.exports = { authenticateToken, authenticateAdmin }
