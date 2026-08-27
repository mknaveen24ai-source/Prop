interface TenantSettingsApi {
  getTenantSettingsMap: (keys?: string[]) => Promise<Record<string, string>>
}

interface TenantFeedConfig extends Record<string, unknown> {
  tenant_id: null
  feed_mode: string
  source_key: string
  fallback_to_shared: boolean
  effective_source_key: string
  effective_feed_mode: string
}

interface TenantFeedsApi {
  getTenantPriceFeedConfig: () => Promise<TenantFeedConfig>
}

interface CacheOptions {
  ttlMs?: number
  forceRefresh?: boolean
}

interface CacheEntry<Value> {
  key?: string
  value: Value
  cachedAt: number
}

const { getTenantSettingsMap } = require('../utils/tenantSettings') as TenantSettingsApi
const { getTenantPriceFeedConfig } = require('../utils/tenantFeeds') as TenantFeedsApi

const DEFAULT_TTL_MS = 3000

let settingsCacheEntry: CacheEntry<Record<string, string>> | null = null
let feedConfigCacheEntry: CacheEntry<TenantFeedConfig> | null = null

function normalizeKeys(keys: unknown = []): string[] {
  if (!Array.isArray(keys) || keys.length === 0) return []
  return [...new Set(keys.map((key) => String(key || '').trim()).filter(Boolean))].sort()
}

function isFresh<Value>(entry: CacheEntry<Value> | null, ttlMs: number): entry is CacheEntry<Value> {
  return !!entry && (Date.now() - entry.cachedAt) < ttlMs
}

async function getTenantSettings(
  keys: unknown = [],
  options: CacheOptions = {}
): Promise<Record<string, string>> {
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

async function getTenantFeedConfig(options: CacheOptions = {}): Promise<TenantFeedConfig> {
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS

  if (!options.forceRefresh && isFresh(feedConfigCacheEntry, ttlMs)) {
    return feedConfigCacheEntry.value
  }

  const value = await getTenantPriceFeedConfig()
  feedConfigCacheEntry = { value, cachedAt: Date.now() }
  return value
}

function clearTenantPolicyCache(): void {
  settingsCacheEntry = null
  feedConfigCacheEntry = null
}

export {
  clearTenantPolicyCache,
  getTenantFeedConfig,
  getTenantSettings
}
