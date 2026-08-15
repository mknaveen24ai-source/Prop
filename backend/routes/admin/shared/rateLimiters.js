'use strict'
/**
 * Rate limiters for destructive admin actions.
 *
 * Keyed on the acting admin, not the IP. Admins routinely share an office
 * egress IP, so an IP-keyed limiter would either be so loose it protects
 * nothing or so tight that one admin's bulk run locks out the rest of the desk.
 *
 * These are a blast-radius guard, not an authorisation check — capability
 * checks (requireAdminCapability / requireSuperAdmin) still do that job. The
 * point is that a mis-scripted integration or a compromised admin session
 * cannot ban ten thousand traders in a minute before anyone notices.
 *
 * Mount order matters: these must come AFTER authenticateAdmin, because the
 * key generator reads req.admin.
 */

const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')

// authenticateAdmin populates adminId on the platform-admin path and only
// email on the legacy env-backed fallback token, so try both before giving up
// and keying on IP.
function adminKey(req) {
  const id = req.admin?.adminId ?? req.admin?.id
  if (id !== undefined && id !== null && String(id).trim() !== '') return `admin:${id}`
  if (req.admin?.email) return `admin:${String(req.admin.email).toLowerCase()}`
  return ipKeyGenerator(req.ip)
}

function buildAdminLimiter({ max, message }) {
  return rateLimit({
    windowMs: 60 * 1000,
    max,
    keyGenerator: adminKey,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false
  })
}

// Moderation of individual traders. The loosest of the three: working through
// a flagged list one trader at a time is normal.
const adminModerationLimiter = buildAdminLimiter({
  max: 10,
  message: 'Too many moderation actions. Please slow down.'
})

// Anything that rewrites an account's state or money: overrides, resets,
// forced pass/fail. Irreversible without a manual correction.
const adminAccountActionLimiter = buildAdminLimiter({
  max: 5,
  message: 'Too many account actions. Please slow down.'
})

// Fan-out operations — one request touches many rows.
const adminBulkLimiter = buildAdminLimiter({
  max: 3,
  message: 'Too many bulk operations. Please wait before running another.'
})

// Row deletion (rules, saved views, and similar configuration).
const adminDeleteLimiter = buildAdminLimiter({
  max: 5,
  message: 'Too many delete operations. Please slow down.'
})

module.exports = {
  adminKey,
  buildAdminLimiter,
  adminModerationLimiter,
  adminAccountActionLimiter,
  adminBulkLimiter,
  adminDeleteLimiter
}
