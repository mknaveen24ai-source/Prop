const { getTenantSettingsMap } = require('../utils/tenantSettings')
const { getTenantPriceFeedConfig } = require('../utils/tenantFeeds')

const DEFAULT_TTL_MS = 3000

let settingsCacheEntry = null
let feedConfigCacheEntry = null

function normalizeKeys(keys = []) {
  if (!Array.isArray(keys) || keys.length === 0) return []
  return [...new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))].sort()
}

function isFresh(entry, ttlMs) {
  return !!entry && (Date.now() - entry.cachedAt) < ttlMs
}

async function getTenantSettings(keys = [], options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS
  const normalizedKeys = normalizeKeys(keys)
  const cacheKey = normalizedKeys.join(',') || '*'

  if (!options.forceRefresh && isFresh(settingsCacheEntry, ttlMs) && settingsCacheEntry.key === cacheKey) {
    return settingsCacheEntry.value
  }

  const value = await getTenantSettingsMap(normalizedKeys)
  settingsCacheEntry = { key: cacheKey, value, cachedAt: Date.now() }
  return value
}

async function getTenantFeedConfig(options = {}) {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS

  if (!options.forceRefresh && isFresh(feedConfigCacheEntry, ttlMs)) {
    return feedConfigCacheEntry.value
  }

  const value = await getTenantPriceFeedConfig()
  feedConfigCacheEntry = { value, cachedAt: Date.now() }
  return value
}

function clearTenantPolicyCache() {
  settingsCacheEntry = null
  feedConfigCacheEntry = null
}

module.exports = {
  clearTenantPolicyCache,
  getTenantFeedConfig,
  getTenantSettings
}
