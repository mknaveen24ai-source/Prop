const { getTenantSettingsMap } = require('../utils/tenantSettings')
const { getTenantPriceFeedConfig } = require('../utils/tenantFeeds')

const DEFAULT_TTL_MS = 3000

const settingsCache = new Map()
const feedConfigCache = new Map()

function normalizeTenantId(tenantId) {
  const parsed = parseInt(tenantId, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function normalizeKeys(keys = []) {
  if (!Array.isArray(keys) || keys.length === 0) return []
  return [...new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))].sort()
}

function buildSettingsCacheKey(tenantId, keys = []) {
  const normalizedKeys = normalizeKeys(keys)
  return `${tenantId || 'default'}:${normalizedKeys.join(',') || '*'}`
}

function isFresh(entry, ttlMs) {
  return !!entry && (Date.now() - entry.cachedAt) < ttlMs
}

async function getTenantSettings(tenantId, keys = [], options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS
  const normalizedTenantId = normalizeTenantId(tenantId)
  const normalizedKeys = normalizeKeys(keys)
  const cacheKey = buildSettingsCacheKey(normalizedTenantId, normalizedKeys)
  const cached = settingsCache.get(cacheKey)
  if (!options.forceRefresh && isFresh(cached, ttlMs)) {
    return cached.value
  }

  const value = await getTenantSettingsMap(normalizedTenantId, normalizedKeys)
  settingsCache.set(cacheKey, { value, cachedAt: Date.now() })
  return value
}

async function getTenantFeedConfig(tenantId, options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS
  const normalizedTenantId = normalizeTenantId(tenantId)
  const cacheKey = String(normalizedTenantId || 'default')
  const cached = feedConfigCache.get(cacheKey)
  if (!options.forceRefresh && isFresh(cached, ttlMs)) {
    return cached.value
  }

  const value = await getTenantPriceFeedConfig(normalizedTenantId)
  feedConfigCache.set(cacheKey, { value, cachedAt: Date.now() })
  return value
}

function clearTenantPolicyCache(tenantId = null) {
  const normalizedTenantId = normalizeTenantId(tenantId)
  if (normalizedTenantId == null) {
    settingsCache.clear()
    feedConfigCache.clear()
    return
  }

  for (const key of settingsCache.keys()) {
    if (key.startsWith(`${normalizedTenantId}:`)) {
      settingsCache.delete(key)
    }
  }
  feedConfigCache.delete(String(normalizedTenantId))
}

module.exports = {
  clearTenantPolicyCache,
  getTenantFeedConfig,
  getTenantSettings
}
