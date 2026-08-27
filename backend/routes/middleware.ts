import type {
  AdminClaimsV1,
  AdminPreTwoFactorClaimsV1,
  LegacyErrorResponse,
  PreTwoFactorClaimsV1,
  UserClaimsV1
} from '@propfirm/contracts'
import type {
  NextFunction,
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse
} from 'express'
import jwt from 'jsonwebtoken'
import type { QueryResultRow } from 'pg'
import pool = require('../db')
import type { PlatformAdminRow, UserTokenStateRow } from '../types/database'
import logger = require('../utils/logger')
import { cacheTokenData, getCachedTokenData } from '../utils/tokenCache'
import {
  isAdminClaims,
  isAdminPreTwoFactorClaims,
  isPreTwoFactorClaims,
  isUserClaims
} from '../validation/auth'

interface PlatformSettingRow extends QueryResultRow {
  value: string
}

interface PlatformAdminAuthRow extends QueryResultRow {
  id: PlatformAdminRow['id']
  email: PlatformAdminRow['email']
  full_name: PlatformAdminRow['full_name']
  role: PlatformAdminRow['role']
  status: PlatformAdminRow['status']
  token_version: PlatformAdminRow['token_version']
  totp_enabled: PlatformAdminRow['totp_enabled']
  last_login_at: PlatformAdminRow['last_login_at']
}

interface EmailVerifiedRow extends QueryResultRow {
  email_verified: boolean
}

type EmailVerificationError = { error: string; code: 'EMAIL_NOT_VERIFIED' }

interface AdminSessionPayload {
  authenticated: boolean
  adminId: string | null
  role: string | null
  permissions: string[]
  email: string | null
  full_name: string | null
  auth_source: string | null
  totp_enabled: boolean
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function cookieToken(req: ExpressRequest, name: string): string | undefined {
  const cookies: unknown = req.cookies
  if (typeof cookies !== 'object' || cookies === null || Array.isArray(cookies)) return undefined
  const value = (cookies as Record<string, unknown>)[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function headerToken(req: ExpressRequest): string | undefined {
  return req.headers.authorization?.split(' ')[1]
}

function sendError(res: ExpressResponse, status: number, error: string): void {
  res.status(status).json({ error })
}

const SUPER_ADMIN_PERMISSIONS: readonly string[] = [
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
const ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
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
const BUILT_IN_ROLES: readonly string[] = ['super_admin', ...Object.keys(ROLE_PERMISSIONS)]

function normalizePermission(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function getAdminPermissionsForRole(role: unknown): string[] {
  const normalizedRole = normalizePermission(role)
  if (normalizedRole === 'super_admin') return [...SUPER_ADMIN_PERMISSIONS]
  if (ROLE_PERMISSIONS[normalizedRole]) return [...ROLE_PERMISSIONS[normalizedRole]]
  return []
}

async function getPlatformAdminById(adminId: string): Promise<PlatformAdminAuthRow | null> {
  const result = await pool.query<PlatformAdminAuthRow>(
    `SELECT id, email, full_name, role, status, token_version,
            totp_enabled, last_login_at
       FROM platform_admins
      WHERE id = $1`,
    [adminId]
  )
  return result.rows[0] || null
}

function hasAdminCapability(
  admin: Express.AuthenticatedAdmin | undefined,
  capability: unknown
): boolean {
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

function requireAdminCapability(capability: unknown): RequestHandler {
  const normalizedCapability = normalizePermission(capability)
  return function enforceAdminCapability(req: ExpressRequest, res: ExpressResponse, next: NextFunction): void {
    if (!hasAdminCapability(req.admin, normalizedCapability)) {
      sendError(res, 403, 'You do not have permission to perform this action')
      return
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
async function authenticateToken(
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
): Promise<void> {
  const token = headerToken(req) || cookieToken(req, 'token')

  if (!token) {
    sendError(res, 401, 'Access token required')
    return
  }

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    logger.error('FATAL: JWT_SECRET is not set in environment')
    sendError(res, 500, 'Server configuration error')
    return
  }

  let verified: unknown
  try {
    verified = jwt.verify(token, jwtSecret)
  } catch {
    sendError(res, 403, 'Invalid or expired token')
    return
  }
  if (!isUserClaims(verified)) {
    sendError(res, 403, 'Invalid or expired token')
    return
  }
  const decoded: UserClaimsV1 = verified

  // FIX (C2): Token version + ban check with Redis caching
  // Try cache first (5-minute TTL) to avoid DB hit on every request
  let tokenData = await getCachedTokenData(decoded.userId)

  if (!tokenData) {
    // Cache miss or Redis unavailable - query database
    try {
      const result = await pool.query<UserTokenStateRow>(
        'SELECT token_version, is_banned FROM users WHERE id = $1',
        [decoded.userId]
      )
      if (result.rows.length === 0) {
        sendError(res, 403, 'User not found')
        return
      }

      const row = result.rows[0]
      if (!row) {
        sendError(res, 403, 'User not found')
        return
      }
      tokenData = {
        token_version: row.token_version ?? 1,
        is_banned: row.is_banned === true
      }
      // Populate cache for next request
      await cacheTokenData(decoded.userId, tokenData.token_version, tokenData.is_banned)
    } catch (dbErr: unknown) {
      logger.error('[auth] Token version check failed:', { error: errorMessage(dbErr) })
      sendError(res, 503, 'Authentication service unavailable')
      return
    }
  }

  const { token_version, is_banned } = tokenData

  if (is_banned) {
    sendError(res, 403, 'Account has been suspended')
    return
  }

  // FIX (H-07): `decoded.tv !== undefined &&` meant a token with no `tv` claim
  // skipped the version check entirely and could never be revoked. Every token
  // this app issues carries `tv`, so treating its absence as invalid costs
  // nothing and closes the hole.
  if (decoded.tv === undefined || decoded.tv < token_version) {
    sendError(res, 401, 'Session expired - please log in again')
    return
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
async function authenticateAdmin(
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
): Promise<void> {
  const token = headerToken(req) || cookieToken(req, 'admin_token')

  if (!token) {
    sendError(res, 401, 'Admin token required')
    return
  }

  const adminJwtSecret = process.env.ADMIN_JWT_SECRET
  if (!adminJwtSecret) {
    logger.error('FATAL: ADMIN_JWT_SECRET is not set in environment')
    sendError(res, 500, 'Server configuration error')
    return
  }

  let verified: unknown
  try {
    verified = jwt.verify(token, adminJwtSecret)
  } catch {
    sendError(res, 403, 'Invalid or expired admin token')
    return
  }
  if (!isAdminClaims(verified)) {
    sendError(res, 403, 'Invalid or expired admin token')
    return
  }
  const decoded: AdminClaimsV1 = verified

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
    sendError(res, 403, 'Admin access required')
    return
  }

  try {
    const normalizedRole = tokenRole === 'admin' ? 'super_admin' : tokenRole
    if (decoded.adminId) {
      const platformAdmin = await getPlatformAdminById(decoded.adminId)
      if (!platformAdmin) {
        sendError(res, 403, 'Platform admin not found')
        return
      }
      if (platformAdmin.status !== 'active') {
        sendError(res, 403, 'Platform admin account is inactive')
        return
      }
      if ((decoded.atv || 0) < parseInt(String(platformAdmin.token_version || 1), 10)) {
        sendError(res, 401, 'Admin session expired - please log in again')
        return
      }

      req.admin = {
        ...decoded,
        adminId: String(platformAdmin.id),
        email: platformAdmin.email,
        full_name: platformAdmin.full_name,
        role: platformAdmin.role || normalizedRole,
        auth_source: decoded.src || 'platform_admin',
        totp_enabled: !!platformAdmin.totp_enabled,
        permissions: getAdminPermissionsForRole(platformAdmin.role || normalizedRole)
      }
      next()
      return
    }

    // Legacy env-backed super-admin fallback token version check.
    //
    // FIX (H-07): this used to be `if (result.rows.length > 0) { ...check... }`,
    // so a missing admin_token_version row skipped revocation entirely — and no
    // migration created that row; its INSERT existed only as a comment above.
    // A leaked super-admin token was therefore valid to its 24h expiry with no
    // kill switch. Migration 029 seeds the row; this now fails closed if it is
    // ever absent again.
    const result = await pool.query<PlatformSettingRow>(
      `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
    )
    if (result.rows.length === 0) {
      logger.error('[admin-auth] admin_token_version is missing — refusing env-fallback admin token')
      sendError(res, 503, 'Admin session cannot be verified')
      return
    }
    const setting = result.rows[0]
    if (!setting) {
      sendError(res, 503, 'Admin session cannot be verified')
      return
    }
    const serverVersion = parseInt(setting.value, 10)
    if (!Number.isFinite(serverVersion)) {
      logger.error('[admin-auth] admin_token_version is not a number — refusing env-fallback admin token')
      sendError(res, 503, 'Admin session cannot be verified')
      return
    }
    if ((decoded.atv || 0) < serverVersion) {
      sendError(res, 401, 'Admin session expired - please log in again')
      return
    }
  } catch (dbErr: unknown) {
    logger.error('[admin-auth] Token version check failed:', { error: errorMessage(dbErr) })
    sendError(res, 503, 'Authentication service unavailable')
    return
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

function requireSuperAdmin(req: ExpressRequest, res: ExpressResponse, next: NextFunction): void {
  if (!req.admin || String(req.admin.role || '') !== 'super_admin') {
    sendError(res, 403, 'Super-admin access required')
    return
  }
  next()
}

function buildAdminSessionPayload(
  admin: Express.AuthenticatedAdmin | undefined
): AdminSessionPayload {
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
async function authenticatePre2FA(
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
): Promise<void> {
  const token = headerToken(req)

  if (!token) {
    sendError(res, 401, '2FA token required')
    return
  }

  let verified: unknown
  try {
    verified = jwt.verify(token, process.env.JWT_SECRET ?? '')
  } catch {
    sendError(res, 403, 'Invalid or expired 2FA session')
    return
  }

  if (!isPreTwoFactorClaims(verified)) {
    sendError(res, 403, 'Invalid token type')
    return
  }
  const decoded: PreTwoFactorClaimsV1 = verified

  try {
    const result = await pool.query<UserTokenStateRow>(
      'SELECT token_version, is_banned FROM users WHERE id = $1',
      [decoded.userId]
    )
    if (result.rows.length === 0) {
      sendError(res, 403, 'User not found')
      return
    }
    const row = result.rows[0]
    if (!row) {
      sendError(res, 403, 'User not found')
      return
    }
    const token_version = row.token_version ?? 1
    const is_banned = row.is_banned === true
    if (is_banned) {
      sendError(res, 403, 'Account has been suspended')
      return
    }
    // FIX (H-07): same as authenticateToken — a missing `tv` claim used to skip
    // the check. All four jwt.sign sites in routes/auth.js include it.
    if (decoded.tv === undefined || decoded.tv < token_version) {
      sendError(res, 401, 'Session expired - please log in again')
      return
    }
  } catch (dbErr: unknown) {
    logger.error('[auth] Pre-2FA token version check failed:', { error: errorMessage(dbErr) })
    sendError(res, 503, 'Authentication service unavailable')
    return
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
async function authenticateAdminPre2FA(
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
): Promise<void> {
  const token = headerToken(req)

  if (!token) {
    sendError(res, 401, '2FA token required')
    return
  }

  let verified: unknown
  try {
    verified = jwt.verify(token, process.env.ADMIN_JWT_SECRET ?? '')
  } catch {
    sendError(res, 403, 'Invalid or expired admin 2FA session')
    return
  }

  if (!isAdminPreTwoFactorClaims(verified)) {
    sendError(res, 403, 'Invalid admin token type')
    return
  }
  const decoded: AdminPreTwoFactorClaimsV1 = verified

  // FIX (H-07): this performed no status or version check at all, unlike its
  // user-side counterpart authenticatePre2FA. A deactivated admin holding a
  // pre-2FA token could still complete the second factor and get a full
  // session, so deactivation did not take effect until the token expired.
  if (decoded.adminId) {
    try {
      const platformAdmin = await getPlatformAdminById(decoded.adminId)
      if (!platformAdmin) {
        sendError(res, 403, 'Platform admin not found')
        return
      }
      if (platformAdmin.status !== 'active') {
        sendError(res, 403, 'Platform admin account is inactive')
        return
      }
      if ((decoded.atv || 0) < parseInt(String(platformAdmin.token_version || 1), 10)) {
        sendError(res, 401, 'Admin session expired - please log in again')
        return
      }
    } catch (dbErr: unknown) {
      logger.error('[admin-auth] Pre-2FA admin check failed:', { error: errorMessage(dbErr) })
      sendError(res, 503, 'Authentication service unavailable')
      return
    }
  }

  req.adminPre2fa = decoded
  next()
}

// ─────────────────────────────────────────────────────────────────────────────
// requireVerifiedEmail
//
// Runs AFTER authenticateToken. Gates the paths where an unverified address is
// worth real money to an abuser: paid checkout, affiliate commission, and
// competition entry (which awards vouchers). Everything else — browsing,
// the dashboard, support, KYC upload — stays open, because the point of the
// verification step is to stop farming, not to add a wall in front of the
// product.
//
// Not cached in tokenCache alongside token_version/is_banned on purpose: that
// cache has a 5-minute TTL, and a trader who has just clicked their
// verification link should not be told to wait five minutes before they can
// pay. These routes are low-frequency, so the extra read is cheap.
// ─────────────────────────────────────────────────────────────────────────────
async function requireVerifiedEmail(
  req: ExpressRequest,
  res: ExpressResponse<LegacyErrorResponse | EmailVerificationError>,
  next: NextFunction
): Promise<void> {
  if (!req.user?.userId) {
    sendError(res, 401, 'Access token required')
    return
  }
  try {
    const result = await pool.query<EmailVerifiedRow>(
      'SELECT email_verified FROM users WHERE id = $1',
      [req.user.userId]
    )
    if (result.rows.length === 0) {
      sendError(res, 403, 'User not found')
      return
    }
    const row = result.rows[0]
    if (!row) {
      sendError(res, 403, 'User not found')
      return
    }
    if (row.email_verified !== true) {
      res.status(403).json({
        error: 'Please confirm your email address first. We sent you a link when you signed up — you can request a new one from your profile.',
        code: 'EMAIL_NOT_VERIFIED'
      })
      return
    }
    next()
  } catch (dbErr: unknown) {
    logger.error('[auth] Email verification check failed:', { error: errorMessage(dbErr) })
    sendError(res, 503, 'Verification service unavailable')
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// authenticateAdminEnrolmentOrSession
//
// Accepts EITHER a full admin session OR a short-lived enrolment token issued
// by /admin/login to an admin who has no TOTP configured yet.
//
// This is what makes admin 2FA mandatory without locking anyone out. Admin 2FA
// used to be optional — `if (platformAdmin.totp_enabled && ...)` in
// routes/admin/auth.js — so an admin who never enrolled logged in with a
// password alone and kept full capability, including payout approval and
// ledger-backed balance adjustment. Refusing those logins outright would have
// locked every existing admin out of the panel they enrol through, so instead
// the login now hands back a token that can reach the TOTP setup routes and
// NOTHING else.
//
// The enrolment token carries `enrol: true` alongside `type: 'pre_2fa_admin'`,
// so it cannot be replayed against /2fa/validate (which requires a token
// belonging to an admin that already HAS a secret) or against any capability
// -gated route (which all use authenticateAdmin and reject this token type).
// ─────────────────────────────────────────────────────────────────────────────
async function authenticateAdminEnrolmentOrSession(
  req: ExpressRequest,
  res: ExpressResponse,
  next: NextFunction
): Promise<void> {
  const token = headerToken(req) || cookieToken(req, 'admin_token')

  if (!token) {
    sendError(res, 401, 'Admin token required')
    return
  }
  const adminJwtSecret = process.env.ADMIN_JWT_SECRET
  if (!adminJwtSecret) {
    logger.error('FATAL: ADMIN_JWT_SECRET is not set in environment')
    sendError(res, 500, 'Server configuration error')
    return
  }

  let verified: unknown
  try {
    verified = jwt.verify(token, adminJwtSecret)
  } catch {
    sendError(res, 403, 'Invalid or expired admin token')
    return
  }

  // Not an enrolment token — fall through to the normal session check so a
  // fully-authenticated admin can still visit the 2FA screens voluntarily.
  if (!isAdminPreTwoFactorClaims(verified) || verified.enrol !== true) {
    await authenticateAdmin(req, res, next)
    return
  }
  const decoded: AdminPreTwoFactorClaimsV1 = verified

  if (!decoded.adminId) {
    sendError(res, 403, 'Invalid enrolment token')
    return
  }

  try {
    const platformAdmin = await getPlatformAdminById(decoded.adminId)
    if (!platformAdmin) {
      sendError(res, 403, 'Platform admin not found')
      return
    }
    if (platformAdmin.status !== 'active') {
      sendError(res, 403, 'Platform admin account is inactive')
      return
    }
    if ((decoded.atv || 0) < parseInt(String(platformAdmin.token_version || 1), 10)) {
      sendError(res, 401, 'Enrolment session expired - please log in again')
      return
    }
    // Already enrolled: the token has served its purpose and must not be a
    // second way in.
    if (platformAdmin.totp_enabled) {
      sendError(res, 403, 'Two-factor authentication is already enabled. Please log in again.')
      return
    }

    req.admin = {
      ...decoded,
      adminId: String(platformAdmin.id),
      email: platformAdmin.email,
      full_name: platformAdmin.full_name,
      role: platformAdmin.role || 'super_admin',
      auth_source: 'platform_admin',
      totp_enabled: false,
      // No capabilities. Any requireAdminCapability() gate this token somehow
      // reached would refuse it.
      permissions: [],
      enrolment_only: true
    }
    next()
  } catch (dbErr: unknown) {
    logger.error('[admin-auth] Enrolment token check failed:', { error: errorMessage(dbErr) })
    sendError(res, 503, 'Authentication service unavailable')
  }
}

export {
  authenticateToken,
  authenticateAdminEnrolmentOrSession,
  requireVerifiedEmail,
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
