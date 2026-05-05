const { AsyncLocalStorage } = require('async_hooks')

const dbContextStorage = new AsyncLocalStorage()

function normalizeTenantId(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeRole(value, fallback = 'public') {
  const normalized = String(value || fallback).trim().toLowerCase()
  return normalized || fallback
}

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'boolean') return value
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function normalizeContext(input = {}) {
  return {
    tenantId: normalizeTenantId(input.tenantId),
    adminRole: normalizeRole(input.adminRole, 'public'),
    actorType: normalizeRole(input.actorType, 'public'),
    bypassRls: normalizeBoolean(input.bypassRls, false)
  }
}

function getDbContext() {
  return normalizeContext(dbContextStorage.getStore() || {})
}

function runWithDbContext(context, fn) {
  return dbContextStorage.run(normalizeContext(context), fn)
}

function runWithSystemDbContext(fn, extraContext = {}) {
  return runWithDbContext(
    {
      tenantId: null,
      adminRole: 'system',
      actorType: 'system',
      bypassRls: true,
      ...extraContext
    },
    fn
  )
}

function updateDbContext(partial = {}) {
  const current = getDbContext()
  const next = normalizeContext({ ...current, ...partial })
  dbContextStorage.enterWith(next)
  return next
}

function attachDbRequestContext(req, res, next) {
  runWithDbContext(
    {
      tenantId: req.tenant?.id || null,
      adminRole: 'public',
      actorType: req.user ? 'user' : req.admin ? 'admin' : 'public',
      bypassRls: false
    },
    next
  )
}

module.exports = {
  attachDbRequestContext,
  getDbContext,
  normalizeTenantId,
  runWithDbContext,
  runWithSystemDbContext,
  updateDbContext
}
